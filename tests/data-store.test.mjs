import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { chunkDocument, createKnowledgeIndex, deserializeKnowledgeIndex } from '../src/knowledge-index.js'
import { pruneSemanticIndex, semanticIndexCoverage } from '../src/semantic-search.js'
import { createShot } from '../src/storyboard.js'

if (!globalThis.crypto) globalThis.crypto = webcrypto

let storeSequence = 0
async function memoryStore() {
  const saved = { current: null, archives: '[]', previous: null, previousArchives: '[]', failNext: false, writes: [] }
  globalThis.window = { __TAURI__: { core: { invoke: async (command, args = {}) => {
    if (command === 'library_read') return saved.current
    if (command === 'library_read_archives') return saved.archives
    if (command === 'library_read_previous') return saved.previous
    if (command === 'library_read_previous_archives') return saved.previousArchives
    if (command === 'library_current_revision') return saved.revision || 0
    if (command !== 'library_write') throw new Error(`Unexpected command: ${command}`)
    saved.writes.push(structuredClone(args))
    if (saved.gate) await saved.gate
    if (saved.failNext) { saved.failNext = false; throw new Error('simulated disk failure') }
    assert.equal(args.expectedRevision, saved.revision || 0, 'optimistic revision matches')
    assert.equal(JSON.parse(args.payload).revision, args.expectedRevision + 1)
    saved.previous = saved.current
    saved.previousArchives = saved.archives
    saved.current = args.payload
    if (args.archivePayload !== undefined) saved.archives = args.archivePayload
    saved.revision = args.expectedRevision + 1
  } } } }
  globalThis.localStorage = { getItem: () => null }
  const store = await import(`../src/project-store.js?test=${++storeSequence}`)
  await store.initializeProjects()
  return { store, saved }
}

function workspace(name = '测试项目') {
  return {
    schemaVersion: 2, project: { name, type: '短剧' }, currentDocId: 'idea', activeTab: 'script',
    documents: { idea: { title: '创作灵感', content: '需要保护的创作正文' } },
    structure: { acts: [], episodes: {} }, versions: {}, versionCounters: { idea: 0 }, tabContents: {},
    knowledge: { sources: [], selectedChunkIds: [] }
  }
}

function indexedWorkspace() {
  const value = workspace()
  const index = createKnowledgeIndex([{ id: 'source:doc', sourceId: 'source', name: '资料', path: '资料.md', content: '她在旧图书馆发现了失踪多年的档案。', updatedAt: '2026-10-05T00:00:00Z' }])
  value.knowledge.sources = [{ id: 'source', name: '资料' }]
  value.knowledge.selectedChunkIds = [index.chunks[0].id]
  value.knowledge.semantic = { model: 'test-model', vectors: { [index.chunks[0].id]: { content: index.chunks[0].content, vector: Array.from({ length: 1024 }, (_, i) => Math.sin(i)) } } }
  return { workspace: value, index }
}

test('unchanged text keeps chunk identities when timestamps change', () => {
  const doc = { id: 'world', sourceId: 'setting', name: '世界观', path: '世界观.md', content: '月亮是一座会移动的图书馆。'.repeat(150), updatedAt: '2026-01-01' }
  const original = chunkDocument(doc)
  const refreshed = chunkDocument({ ...doc, updatedAt: '2026-10-05' })
  assert.deepEqual(refreshed.map(chunk => chunk.id), original.map(chunk => chunk.id))
  assert.notEqual(chunkDocument({ ...doc, content: '新的设定内容' })[0].id, original[0].id)
})

test('semantic pruning deletes removed and edited content while reusing unchanged vectors', () => {
  const index = { chunks: [{ id: 'keep', content: '相同内容' }, { id: 'changed', content: '新内容' }, { id: 'invalid', content: '坏向量' }] }
  const semantic = { model: 'local', vectors: { keep: { content: '相同内容', vector: [1, 2] }, removed: { content: '已移除的秘密正文', vector: [2, 3] }, changed: { content: '旧内容', vector: [1, 1] }, invalid: { content: '坏向量', vector: [NaN] } } }
  const pruned = pruneSemanticIndex(index, semantic)
  assert.deepEqual(Object.keys(pruned.vectors), ['keep'])
  assert.equal(JSON.stringify(pruned).includes('已移除的秘密正文'), false)
  assert.deepEqual(semanticIndexCoverage(index, semantic), { indexed: 1, total: 3, pending: 2 })
})

test('compact project backups exclude vectors and connections, and restore searchable text and references', async () => {
  const { store, saved } = await memoryStore()
  const data = indexedWorkspace()
  data.workspace.connections = [{ id: 'do-not-export', baseUrl: 'https://endpoint.invalid' }]
  const text = store.projectBackup(data.workspace, data.index)
  const json = JSON.parse(text)
  assert.equal(json.workspace.connections, undefined)
  assert.equal(json.workspace.knowledge.semantic, undefined)
  assert.equal(json.index.chunks[0].vector, undefined)
  assert.ok(text.length < JSON.stringify(data).length / 5)
  const parsed = store.parseBackup(text)
  assert.deepEqual(parsed.workspace.knowledge.selectedChunkIds, data.workspace.knowledge.selectedChunkIds)
  assert.equal(parsed.index.chunks[0].vector.length, 384)
  assert.equal(parsed.index.chunks[0].content, data.index.chunks[0].content)
  assert.ok(deserializeKnowledgeIndex(json.index).chunks[0].vector.every((value, i) => Math.abs(value - data.index.chunks[0].vector[i]) < 1e-12))
  await store.createProject(data.workspace, data.index)
  const persisted = JSON.parse(saved.current).projects[0]
  assert.equal(persisted.index.chunks[0].vector, undefined)
  assert.ok(persisted.workspace.knowledge.semantic.vectors[data.index.chunks[0].id])
  assert.equal(deserializeKnowledgeIndex(store.getActiveProject().index).chunks[0].vector.length, 384)
  assert.equal(data.index.chunks[0].vector.length, 384, 'saving never mutates the editor index')
})

test('backup schema rejects malformed counters, history, cross-document and knowledge references', async () => {
  const { store } = await memoryStore()
  for (const invalid of ['1', -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const value = workspace(); value.versionCounters.idea = invalid
    assert.throws(() => store.projectBackup(value, null), /版本计数/)
  }
  const versions = workspace()
  versions.versions.idea = [{ number: 3, content: '历史正文', createdAt: '10/05 10:00', source: '手动保存' }]
  assert.throws(() => store.projectBackup(versions, null), /版本计数/)
  versions.versionCounters.idea = 3
  assert.doesNotThrow(() => store.projectBackup(versions, null))
  versions.versions.idea.push({ ...versions.versions.idea[0] })
  assert.throws(() => store.projectBackup(versions, null), /重复/)
  const tabs = workspace(); tabs.tabContents.missing = { outline: '不能被静默丢掉' }
  assert.throws(() => store.projectBackup(tabs, null), /不存在的文档/)
  const structure = workspace(); structure.structure = { acts: [{ id: 'act', title: '第一幕', episodeIds: ['missing'] }], episodes: {} }
  assert.throws(() => store.projectBackup(structure, null), /分集引用/)
  const knowledge = indexedWorkspace(); knowledge.workspace.knowledge.sources = []
  assert.throws(() => store.projectBackup(knowledge.workspace, knowledge.index), /不存在的来源/)
  const prototype = store.projectBackup(workspace(), null).replace('"schemaVersion":2', '"schemaVersion":2,"__proto__":{}')
  assert.throws(() => store.parseBackup(prototype), /非法字段/)
})

test('archiving moves the project out of the active payload and restores all content atomically', async () => {
  const { store, saved } = await memoryStore()
  const first = await store.createProject(workspace('第一项目'), null)
  const large = workspace('待归档项目'); large.documents.idea.content = '大量正文'.repeat(10000)
  const second = await store.createProject(large, null)
  const before = store.getStorageMetrics()
  assert.equal(await store.archiveProject(second), first)
  const after = store.getStorageMetrics()
  assert.ok(after.activeBytes < before.activeBytes / 10)
  assert.ok(after.archiveBytes > after.activeBytes)
  assert.equal(JSON.parse(saved.current).projects.some(item => item.id === second), false)
  assert.equal(JSON.parse(saved.archives)[0].workspace.documents.idea.content, large.documents.idea.content)
  assert.equal(store.listArchivedProjects()[0].id, second)
  await store.restoreProject(second)
  assert.equal(store.getActiveProject().workspace.documents.idea.content, large.documents.idea.content)
  assert.equal(store.listArchivedProjects().length, 0)
  assert.equal(store.listProjects().length, 2)
})

test('failed archive commits leave the library and archive lists unchanged', async () => {
  const { store, saved } = await memoryStore()
  const id = await store.createProject(workspace(), null)
  const persisted = saved.current
  saved.failNext = true
  await assert.rejects(store.archiveProject(id), /disk failure/)
  assert.equal(saved.current, persisted)
  assert.equal(store.getActiveProject().id, id)
  assert.equal(store.listArchivedProjects().length, 0)
  await store.archiveProject(id)
  assert.equal(store.listArchivedProjects().length, 1)
})

test('whole-library import preserves active/archived projects and inspirations using independent IDs', async () => {
  const { store } = await memoryStore()
  const activeId = await store.createProject(workspace('保留当前项目'), null)
  const archivedId = await store.createProject(workspace('旧项目'), null)
  await store.archiveProject(archivedId)
  const inspiration = await store.saveInspiration({ title: '待写故事', content: '在废弃车站相遇' })
  await store.saveInspiration({ title: '另一个故事', content: '一封寄往未来的信' })
  await store.archiveInspiration(inspiration.id)
  assert.equal(store.listInspirations().length, 1)
  assert.equal(store.listInspirations({ archived: true }).length, 1)
  const backup = store.libraryBackup()
  assert.equal(JSON.parse(backup).inspirations.length, 2)
  const result = await store.importLibraryBackup(backup)
  assert.deepEqual(result, { projects: 1, archives: 1, inspirations: 2, activeId })
  assert.equal(store.listProjects().length, 2)
  assert.equal(store.listArchivedProjects().length, 2)
  assert.equal(store.listInspirations({ archived: null }).length, 4)
  assert.equal(new Set([...store.listProjects(), ...store.listArchivedProjects()].map(item => item.id)).size, 4)
  assert.equal(store.getActiveProject().id, activeId)
  await store.restoreInspiration(inspiration.id)
  assert.equal(store.listInspirations().length, 3)
})

test('previous library recovery includes archives and can be undone by recovering again', async () => {
  const { store } = await memoryStore()
  const id = await store.createProject(workspace(), null)
  await store.archiveProject(id)
  const snapshot = await store.readPreviousLibrary()
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.activeProjects, 1)
  const restored = await store.restorePreviousLibrary()
  assert.equal(restored.id, id)
  assert.equal(store.listArchivedProjects().length, 0)
  assert.equal((await store.readPreviousLibrary()).archivedProjects, 1)
  await store.restorePreviousLibrary()
  assert.equal(store.listProjects().length, 0)
  assert.equal(store.listArchivedProjects().length, 1)
})

test('invalid startup data is preserved and the validated previous snapshot can recover it', async () => {
  const { store, saved } = await memoryStore()
  await store.createProject(workspace(), null)
  await store.saveInspiration({ title: '独立灵感', content: '最新的灵感内容' })
  saved.current = '{broken JSON'
  await assert.rejects(store.initializeProjects())
  assert.equal(saved.current, '{broken JSON')
  const snapshot = await store.readPreviousLibrary()
  assert.equal(snapshot.activeProjects, 1)
  await store.restorePreviousLibrary()
  assert.equal(store.listProjects().length, 1)
  assert.equal(saved.previous, '{broken JSON')
})

test('no-op saves preserve the useful previous snapshot and settings can save without a project', async () => {
  const { store, saved } = await memoryStore()
  await store.saveProject(null, { project: { name: '' }, connections: [], theme: 'dark' }, null)
  assert.equal(store.listProjects().length, 0)
  assert.equal(store.getActiveProject().workspace.theme, 'dark')
  const id = await store.createProject(workspace(), null)
  const active = store.getActiveProject()
  await store.saveProject(id, active.workspace, active.index)
  const revision = saved.revision
  const previous = saved.previous
  await store.saveProject(id, active.workspace, active.index)
  await store.activateProject(id)
  assert.equal(saved.revision, revision)
  assert.equal(saved.previous, previous)
})

test('ordinary saves omit unchanged archives and coalesce only adjacent pending saves of one project', async () => {
  const { store, saved } = await memoryStore()
  const a = await store.createProject(workspace('A'), null)
  const b = await store.createProject(workspace('B'), null)
  const before = saved.writes.length
  const first = workspace('A'); first.documents.idea.content = 'A 的中间值'
  const latest = workspace('A'); latest.documents.idea.content = 'A 的最终值'
  const one = store.saveProject(a, first, null, { coalesce: true })
  const two = store.saveProject(a, latest, null, { coalesce: true })
  assert.equal(one, two, 'pending saves share the result of the latest snapshot')
  await Promise.all([one, two])
  assert.equal(saved.writes.length, before + 1)
  assert.equal(Object.hasOwn(saved.writes.at(-1), 'archivePayload'), false)
  assert.equal(saved.archives, '[]')
  const different = workspace('B'); different.documents.idea.content = 'B 的内容'
  await Promise.all([
    store.saveProject(a, first, null, { coalesce: true }),
    store.saveProject(b, different, null, { coalesce: true }),
    store.saveProject(a, latest, null, { coalesce: true })
  ])
  assert.equal(saved.writes.length, before + 4, 'different projects keep queue ordering')
  const projects = JSON.parse(saved.current).projects
  assert.equal(projects.find(p => p.id === a).workspace.documents.idea.content, 'A 的最终值')
  assert.equal(projects.find(p => p.id === b).workspace.documents.idea.content, 'B 的内容')
})

test('explicit mutations split coalescing; failed merged saves keep stored state and allow retry', async () => {
  const { store, saved } = await memoryStore()
  const id = await store.createProject(workspace(), null)
  const first = workspace(); first.documents.idea.content = '第一步'
  const final = workspace(); final.documents.idea.content = '最后一步'
  const before = saved.writes.length
  await Promise.all([
    store.saveProject(id, first, null, { coalesce: true }),
    store.saveInspiration({ title: '明确事务', content: '必须按顺序保存' }),
    store.saveProject(id, final, null, { coalesce: true })
  ])
  assert.equal(saved.writes.length, before + 3)
  assert.equal(JSON.parse(saved.writes[before + 1].payload).projects[0].workspace.documents.idea.content, '第一步')
  const previous = saved.current
  saved.failNext = true
  const failed = store.saveProject(id, first, null, { coalesce: true })
  const failedAgain = store.saveProject(id, { ...first, project: { name: '合并后' } }, null, { coalesce: true })
  await assert.rejects(failed, /disk failure/)
  await assert.rejects(failedAgain, /disk failure/)
  assert.equal(saved.current, previous)
  await store.saveProject(id, first, null, { coalesce: true })
  assert.equal(JSON.parse(saved.current).projects[0].workspace.documents.idea.content, '第一步')
})

test('an in-flight save completes before the latest coalesced snapshot and deletion remains a barrier', async () => {
  const { store, saved } = await memoryStore()
  const id = await store.createProject(workspace(), null)
  let release
  saved.gate = new Promise(resolve => { release = resolve })
  const first = workspace(); first.documents.idea.content = '正在写入'
  const mid = workspace(); mid.documents.idea.content = '等待中的中间内容'
  const last = workspace(); last.documents.idea.content = '等待中的最新内容'
  const before = saved.writes.length
  const active = store.saveProject(id, first, null, { coalesce: true })
  await new Promise(resolve => setImmediate(resolve))
  const waiting = store.saveProject(id, mid, null, { coalesce: true })
  const latest = store.saveProject(id, last, null, { coalesce: true })
  assert.equal(waiting, latest)
  saved.gate = null; release()
  await Promise.all([active, waiting, latest])
  assert.equal(saved.writes.length, before + 2)
  assert.equal(JSON.parse(saved.current).projects[0].workspace.documents.idea.content, '等待中的最新内容')
  const earlier = store.saveProject(id, mid, null, { coalesce: true })
  const deleted = store.deleteProject(id)
  const tooLate = store.saveProject(id, last, null, { coalesce: true })
  await earlier; await deleted
  await assert.rejects(tooLate, /项目不存在/)
  assert.equal(store.listProjects().length, 0)
})

test('text backups keep storyboard history writing but drop current and historical media claims on restore', async () => {
  const { store } = await memoryStore()
  const draft = workspace()
  const shot = createShot({ title: '保留的旧镜头', visual: '画面' }, { documentId: 'idea' })
  Object.assign(shot, { references: [{ versionId: 'original-image', role: 'reference' }], selectedImageVersionId: 'original-image', selectedVideoVersionId: 'original-video', reviewedVideoVersionId: 'original-video', reviewedInputFingerprint: 'old-review' })
  draft.storyboard = { revision: 1, shots: [shot], sourceVersions: [{ id: 'history', createdAt: '2026-10-23T00:00:00Z', sourceDocumentId: 'idea', label: '替换前', shots: [structuredClone(shot)] }] }
  const backup = store.projectBackup(draft, null)
  const restored = store.parseBackup(backup).workspace.storyboard
  for (const value of [restored.shots[0], restored.sourceVersions[0].shots[0]]) {
    assert.equal(value.title, '保留的旧镜头')
    assert.equal(value.sourceDocumentId, 'idea')
    assert.deepEqual(value.references, [])
    assert.equal(value.selectedVideoVersionId, '')
    assert.equal(value.reviewedVideoVersionId, '')
    assert.equal(value.reviewedInputFingerprint, undefined)
  }
  assert.equal(draft.storyboard.shots[0].selectedVideoVersionId, 'original-video', 'export/restore never edits the source project')
})

test('version 1 library records without optional archive or inspiration fields still load', async () => {
  const { store, saved } = await memoryStore()
  const value = workspace()
  delete value.schemaVersion
  delete value.knowledge
  const legacy = { version: 1, revision: 1, activeId: 'legacy', projects: [{ id: 'legacy', workspace: value, index: null, updatedAt: '2026-10-05T00:00:00Z' }], settings: {} }
  saved.current = JSON.stringify(legacy)
  saved.revision = 1
  saved.archives = null
  const loaded = await store.initializeProjects()
  assert.equal(loaded.id, 'legacy')
  assert.equal(store.listArchivedProjects().length, 0)
  assert.equal(store.listInspirations().length, 0)
  assert.equal(saved.current, JSON.stringify(legacy))
})

test('the audited 1500 chunk / 1024 dimension case now produces a restorable compact backup', async () => {
  const { store } = await memoryStore()
  const data = indexedWorkspace()
  const baseChunk = data.index.chunks[0]
  const text = '甲'.repeat(600)
  data.index.chunks = Array.from({ length: 1500 }, (_, i) => ({ ...baseChunk, id: `doc:${i}`, content: text, end: 600 }))
  const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.01)
  data.workspace.knowledge.selectedChunkIds = []
  data.workspace.knowledge.semantic.vectors = Object.fromEntries(data.index.chunks.map(chunk => [chunk.id, { content: chunk.content, vector }]))
  const savedBytes = Buffer.byteLength(JSON.stringify(data))
  assert.ok(savedBytes < store.MAX_LIBRARY_BYTES)
  const backup = store.projectBackup(data.workspace, data.index)
  assert.ok(Buffer.byteLength(backup) < savedBytes / 5)
  const restored = store.parseBackup(backup)
  assert.equal(restored.index.chunks.length, 1500)
  assert.equal(restored.index.chunks[1499].content, text)
  assert.equal(restored.workspace.documents.idea.content, data.workspace.documents.idea.content)
  assert.equal(restored.workspace.knowledge.semantic, undefined)
})

test('archive accepts a latest draft in the same transaction without saving it into the active budget first', async () => {
  const { store, saved } = await memoryStore()
  const id = await store.createProject(workspace(), null)
  const revision = saved.revision
  const draft = workspace()
  draft.documents.idea.content = '这是还未成功保存的最新正文，归档时必须保留。'
  await store.archiveProject(id, draft, null)
  assert.equal(saved.revision, revision + 1, 'archive and latest draft use one commit')
  assert.equal(JSON.parse(saved.current).projects.length, 0)
  assert.equal(JSON.parse(saved.archives)[0].workspace.documents.idea.content, draft.documents.idea.content)
  assert.equal(JSON.parse(saved.previous).projects[0].workspace.documents.idea.content, workspace().documents.idea.content)
  await store.restoreProject(id)
  assert.equal(store.getActiveProject().workspace.documents.idea.content, draft.documents.idea.content)
})

test('project deletion covers active, archived and last projects without changing unrelated content', async () => {
  const { store, saved } = await memoryStore()
  const first = await store.createProject(workspace('保留项目'), null)
  const second = await store.createProject(workspace('删除项目'), null)
  await store.saveInspiration({ title: '保留灵感', content: '独立灵感内容' })
  const before = JSON.parse(store.libraryBackup())
  await store.deleteProject(second)
  assert.equal(store.getActiveProject().id, first)
  assert.equal(store.listProjects().length, 1)
  assert.equal(JSON.parse(store.libraryBackup()).inspirations.length, 1)
  assert.deepEqual(JSON.parse(store.libraryBackup()).projects[0].workspace, before.projects[0].workspace)
  await store.archiveProject(first)
  await store.deleteProject(first)
  assert.equal(store.listArchivedProjects().length, 0)
  assert.equal(store.getActiveProject().id, null)
  assert.deepEqual(JSON.parse(saved.current).projects, [])
  await store.initializeProjects()
  assert.equal(store.listProjects().length, 0)
  assert.equal(store.listArchivedProjects().length, 0)
  await assert.rejects(store.deleteProject('missing'), /未找到项目/)
})

test('a failed deletion leaves the current project and archives intact and can be retried', async () => {
  const { store, saved } = await memoryStore()
  const id = await store.createProject(workspace('删除失败测试'), null)
  const before = await store.rawLibrarySnapshot()
  saved.failNext = true
  await assert.rejects(store.deleteProject(id), /simulated disk failure/)
  assert.deepEqual(await store.rawLibrarySnapshot(), before)
  assert.equal(store.getActiveProject().id, id)
  await store.deleteProject(id)
  assert.equal(store.listProjects().length, 0)
})
