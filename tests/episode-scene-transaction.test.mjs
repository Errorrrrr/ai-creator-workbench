import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { prepareEpisodeScenes, prepareAssignShots } from '../src/episode-scenes.js'
import { createShot, contentFingerprint } from '../src/storyboard.js'
import { removeCandidateDraft } from '../src/candidate-drafts.js'
import { validateWorkspace } from '../src/project-store.js'

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(app)
  assert.ok(match, `production function ${name} must exist`)
  const rest = app.slice(match.index), end = /^\}$/m.exec(rest)
  assert.ok(end)
  return rest.slice(0, end.index + 1)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
function candidate(id, documentId, purpose = 'text') {
  return { id, documentId, tabName: 'script', prompt: '核对剧本', text: '保留的候选内容', createdAt: '2026-11-04T02:00:00.000Z', status: 'complete',
    context: { projectId: 'project-1', documentId, tabName: 'script', purpose, title: documentId, baseContent: '第一场原文。\n第二场原文。', ...(purpose === 'scene-plan' ? { sourceDocumentIds: ['s1'] } : {}) } }
}
function fixture() {
  const legacy = createShot({ title: '旧整集镜头', visual: '既有画面', duration: 8 }, { documentId: 'ep', fingerprint: 'original-fingerprint' })
  legacy.id = 'shot-legacy'
  legacy.references = [{ versionId: 'reference-v1', role: 'reference', origin: 'manual' }, { versionId: 'auto-v1', role: 'reference', origin: 'auto', scope: 'continuity', entityId: 'character-1', stateId: 'state-1' }]
  legacy.selectedImageVersionId = 'image-v1'; legacy.selectedVideoVersionId = 'video-v1'
  legacy.reviewedVideoVersionId = 'video-v1'; legacy.reviewedInputFingerprint = 'old-review-proof'
  const sceneShot = createShot({ title: '本场镜头', visual: '原来的分场画面' }, { documentId: 's1', fingerprint: contentFingerprint('已有分场剧本。') })
  sceneShot.id = 'shot-scene'; sceneShot.selectedImageVersionId = 'scene-image-v1'
  return { schemaVersion: 2, project: { name: '分场事务回归', type: '短剧' }, currentDocId: 'ep', activeTab: 'script',
    documents: { ep: { title: '第一集', content: '第一场原文。\n第二场原文。' }, s1: { title: '既有分场', content: '已有分场剧本。' } },
    tabContents: { ep: { outline: '整集原大纲', references: '集引用' }, s1: { outline: '本场原大纲', references: '场引用' } },
    versions: { ep: [], s1: [] }, versionCounters: { ep: 0, s1: 0 },
    structure: { acts: [{ id: 'act', title: '第一幕', episodeIds: ['ep'] }], episodes: { ep: { sceneIds: ['s1'] } } },
    storyboard: { revision: 12, shots: [legacy, sceneShot], sourceVersions: [{ id: 'history-1', sourceDocumentId: 'ep', label: '旧整集分镜', createdAt: '2026-11-04T01:00:00.000Z', shots: [structuredClone(legacy)] }] },
    candidateDrafts: [candidate('scene-plan', 'ep', 'scene-plan'), candidate('unrelated', 's1')] }
}

// Keep production validation and preparation; replace only the storage gate and UI.
function harness({ preSave = null } = {}) {
  const original = fixture(), keys = Object.keys(original)
  validateWorkspace(original)
  const state = { ...structuredClone(original), knowledge: { index: null }, candidateApplying: false, isGenerating: false, generationInFlight: false, activeCandidateId: 'scene-plan', storageFailed: false }
  const gate = deferred(), writes = [], events = [], discarded = []
  const sandbox = { state, activeProjectId: 'project-1', projectTransition: false, editRevision: 0, unsavedEdits: true, structuredClone,
    prepareEpisodeScenes, prepareAssignShots,
    removeCandidateDraft: (drafts, id) => removeCandidateDraft(structuredClone(drafts), id),
    validateWorkspace: value => { events.push('validate'); validateWorkspace(structuredClone(value)) },
    setProjectTransition: value => { sandbox.projectTransition = value },
    saveImmediately: async () => { events.push('pre-save'); return preSave ? preSave.promise : true },
    workspaceSnapshot: () => Object.fromEntries(keys.map(key => [key, state[key]])),
    saveProject: async (owner, next) => { writes.push({ owner, next: structuredClone(next) }); events.push('save-start'); await gate.promise; events.push('save-complete') },
    discardCandidate: options => { discarded.push(structuredClone(options)); state.activeCandidateId = null },
    renderProjectIdentity: () => events.push('render-project'), updateDocumentView: () => events.push('render-document'),
    mediaWorkbench: { hasPendingWork: () => false, isStoryboardBusy: () => false, refresh: () => events.push('refresh-media') },
    sceneContinuityUI: { hasPendingWork: () => false }, setSaveStatus: status => events.push(`status:${status}`), renderCandidateDrafts: () => events.push('render-candidates') }
  vm.createContext(sandbox); vm.runInContext(productionFunction('commitEpisodeScenes'), sandbox)
  const action = { type: 'scenes', projectId: 'project-1', episodeId: 'ep', sourceId: 'ep', sourceContent: original.documents.ep.content,
    expectedContent: original.documents.ep.content, expectedSceneIds: ['s1'], candidateId: 'scene-plan',
    scenes: [{ title: '新增第二场', content: '第二场原文。' }], idFactory: () => 's2' }
  return { original, state, sandbox, gate, writes, events, discarded, action, run: (value = action) => sandbox.commitEpisodeScenes(value) }
}
const tick = () => new Promise(setImmediate)

test('追加分场先原子持久化再发布，候选删除与新分场在同一次保存中完成', async () => {
  const h = harness(), before = structuredClone(h.original), pending = h.run()
  await tick()
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0].owner, 'project-1')
  assert.deepEqual(h.writes[0].next.structure.episodes.ep.sceneIds, ['s1', 's2'])
  assert.deepEqual(h.writes[0].next.candidateDrafts.map(item => item.id), ['unrelated'])
  assert.deepEqual(h.state.structure, before.structure, '存储尚未成功时不能发布结构')
  assert.deepEqual(h.state.candidateDrafts, before.candidateDrafts, '存储尚未成功时不能移除候选')
  assert.equal(h.discarded.length, 0)
  assert.equal(h.state.candidateApplying, true)
  assert.equal(h.sandbox.projectTransition, true)
  h.gate.resolve(); const result = await pending
  assert.deepEqual(result.sceneIds, ['s2'])
  assert.deepEqual(h.state.structure.episodes.ep.sceneIds, ['s1', 's2'])
  assert.deepEqual(h.state.candidateDrafts.map(item => item.id), ['unrelated'])
  assert.deepEqual(h.discarded, [{ silent: true, remove: false, persist: false }])
  assert.ok(h.events.indexOf('render-project') > h.events.indexOf('save-complete'))
  assert.equal(h.state.candidateApplying, false); assert.equal(h.sandbox.projectTransition, false)
  assert.equal(h.sandbox.unsavedEdits, false); assert.equal(h.sandbox.editRevision, 1)
})

test('分场保存失败保留全部原剧本、结构、候选和媒体，释放锁允许重试', async () => {
  const h = harness(), pending = h.run(), rejected = assert.rejects(pending, /disk full/)
  await tick(); h.gate.reject(new Error('disk full')); await rejected
  for (const key of Object.keys(h.original)) assert.deepEqual(h.state[key], h.original[key], key)
  assert.equal(h.state.activeCandidateId, 'scene-plan'); assert.equal(h.discarded.length, 0)
  assert.equal(h.state.candidateApplying, false); assert.equal(h.sandbox.projectTransition, false)
  assert.equal(h.state.storageFailed, true); assert.equal(h.sandbox.unsavedEdits, true)
  assert.ok(h.events.includes('status:error')); assert.ok(!h.events.includes('render-project'))
})

test('原项目尚未保存成功时不写入新结构，候选和预览依据保持可重试', async () => {
  const preSave = deferred(), h = harness({ preSave }), pending = h.run()
  preSave.resolve(false)
  await assert.rejects(pending, /原项目保存失败/)
  assert.equal(h.writes.length, 0)
  for (const key of Object.keys(h.original)) assert.deepEqual(h.state[key], h.original[key], key)
  assert.equal(h.discarded.length, 0)
  assert.equal(h.state.candidateApplying, false); assert.equal(h.sandbox.projectTransition, false)
})

test('错项目或保存前切换项目都拒绝整理，不向其他项目发布或写入', async () => {
  const h = harness()
  await assert.rejects(h.run({ ...h.action, projectId: 'other-project' }), /项目已切换/)
  assert.equal(h.writes.length, 0)
  const preSave = deferred(), switching = harness({ preSave }), pending = switching.run()
  switching.sandbox.activeProjectId = 'other-project'; preSave.resolve(true)
  await assert.rejects(pending, /项目已切换/)
  assert.equal(switching.writes.length, 0)
  assert.deepEqual(switching.state.documents, switching.original.documents)
  assert.deepEqual(switching.state.candidateDrafts, switching.original.candidateDrafts)
  assert.equal(switching.sandbox.projectTransition, false)
})

test('过期原文或分场快照拒绝追加，已有正文和候选继续保留', async () => {
  const edited = harness(); edited.state.documents.ep.content += '\n用户刚修改的原文。'
  const content = edited.state.documents.ep.content
  await assert.rejects(edited.run(), /原文已变化/)
  assert.equal(edited.state.documents.ep.content, content); assert.equal(edited.writes.length, 0)
  assert.deepEqual(edited.state.candidateDrafts, edited.original.candidateDrafts)
  const stale = harness(); stale.action.expectedSceneIds = []
  await assert.rejects(stale.run(), /分场已变化|快照/)
  assert.equal(stale.writes.length, 0); assert.deepEqual(stale.state.structure, stale.original.structure)
})

test('新增分场保留所有既有镜头标识、固定参考、图片视频选用与历史分镜', async () => {
  const h = harness(), pending = h.run()
  await tick(); h.gate.resolve(); await pending
  assert.deepEqual(h.state.storyboard, h.original.storyboard)
  for (const id of ['ep', 's1']) {
    assert.equal(h.state.documents[id].content, h.original.documents[id].content)
    assert.deepEqual(h.state.tabContents[id], h.original.tabContents[id])
    assert.deepEqual(h.state.versions[id], h.original.versions[id])
  }
})

test('归场只改选中镜头来源并固定自动参考，媒体版本和其他镜头不变', async () => {
  const h = harness(), action = { type: 'assign', projectId: 'project-1', shotIds: ['shot-legacy'], targetSceneId: 's1', expectedSources: { 'shot-legacy': 'ep' } }
  const pending = h.run(action)
  await tick()
  assert.deepEqual(h.state.storyboard, h.original.storyboard)
  assert.equal(h.writes[0].next.storyboard.shots[0].sourceDocumentId, 's1')
  h.gate.resolve(); const result = await pending
  const expected = structuredClone(h.original.storyboard)
  expected.shots[0].sourceDocumentId = 's1'; expected.revision += 1
  expected.shots[0].references[1].origin = 'manual'
  assert.deepEqual(h.state.storyboard, expected)
  assert.deepEqual(h.state.storyboard.shots[0].references.map(({ origin, ...ref }) => ref), h.original.storyboard.shots[0].references.map(({ origin, ...ref }) => ref), '固定参考只转换来源标记，所有参考版本和元数据保留')
  assert.deepEqual(h.state.documents, h.original.documents)
  assert.deepEqual(h.state.candidateDrafts, h.original.candidateDrafts)
  assert.equal(h.discarded.length, 0)
  assert.equal(result.warnings.length, 3)
  assert.equal(h.state.storyboard.shots[0].sourceFingerprint, 'original-fingerprint', '不伪造新来源复核证据')
})

test('旧镜头已被他处归场时拒绝过期操作，不覆盖新归属或清理候选', async () => {
  const h = harness()
  h.state.storyboard.shots[0].sourceDocumentId = 's1'
  const before = structuredClone(h.state.storyboard)
  await assert.rejects(h.run({ type: 'assign', projectId: 'project-1', shotIds: ['shot-legacy'], targetSceneId: 's1', expectedSources: { 'shot-legacy': 'ep' } }), /归属已变化/)
  assert.equal(h.writes.length, 0)
  assert.deepEqual(h.state.storyboard, before)
  assert.deepEqual(h.state.candidateDrafts, h.original.candidateDrafts)
})
