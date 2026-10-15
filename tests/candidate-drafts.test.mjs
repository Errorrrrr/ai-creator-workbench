import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CANDIDATE_DRAFTS, validateCandidateDrafts, candidateDraftsFor, upsertCandidateDraft, removeCandidateDraft } from '../src/candidate-drafts.js'
import { projectBackup, parseBackup, validateWorkspace } from '../src/project-store.js'
import { captureOperationContext } from '../src/project-operations.js'
import { prepareGeneration } from '../src/creation-workflow.js'
import { createKnowledgeIndex } from '../src/knowledge-index.js'
import { createShot } from '../src/storyboard.js'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) globalThis.crypto = webcrypto

function draft(id = 'candidate-1', documentId = 'idea', tabName = 'script') {
  return {
    id, documentId, tabName, prompt: '把这段写得更自然', text: '她停在门前，迟迟没有敲门。',
    createdAt: '2026-10-15T09:00:00.000Z', status: 'complete',
    context: {
      projectId: 'project-original', purpose: 'text', sourceFingerprint: '', storyboardRevision: null, operationContext: null,
      documentId, tabName, title: '创作灵感', baseContent: '她站在门前。', selectionStart: 0, selectionEnd: 0,
      knowledgeChunks: [], messages: [{ role: 'system', content: '协助创作' }, { role: 'user', content: '把这段写得更自然' }]
    }
  }
}

function workspace() {
  return {
    schemaVersion: 2, project: { name: '测试项目', type: '短剧' }, currentDocId: 'idea', activeTab: 'script',
    documents: { idea: { title: '创作灵感', content: '她站在门前。' } }, tabContents: {},
    storyboard: { revision: 0, shots: [] }, candidateDrafts: []
  }
}

test('candidates are isolated by document and tab and retries retain earlier writing', () => {
  let drafts = upsertCandidateDraft([], draft())
  drafts = upsertCandidateDraft(drafts, draft('candidate-2', 'idea', 'outline'))
  drafts = upsertCandidateDraft(drafts, draft('candidate-3', 'scene-1'))
  drafts = upsertCandidateDraft(drafts, { ...draft('candidate-retry'), text: '重试生成的新文本' })
  assert.deepEqual(candidateDraftsFor(drafts, 'idea', 'script').map(value => value.id), ['candidate-1', 'candidate-retry'])
  assert.deepEqual(candidateDraftsFor(drafts, 'idea', 'outline').map(value => value.id), ['candidate-2'])
  assert.deepEqual(candidateDraftsFor(drafts, 'scene-1', 'script').map(value => value.id), ['candidate-3'])
  assert.equal(drafts[0].text, draft().text)
})

test('updates and removals return independent snapshots without mutating callers', () => {
  const source = draft()
  const original = upsertCandidateDraft([], source)
  source.context.messages[0].content = '外部修改'
  const next = upsertCandidateDraft(original, { ...draft(), status: 'partial', text: '已生成的一部分' })
  assert.equal(original[0].status, 'complete')
  assert.equal(original[0].context.messages[0].content, '协助创作')
  next[0].context.messages[0].content = '修改副本'
  assert.equal(original[0].context.messages[0].content, '协助创作')
  const visible = candidateDraftsFor(original, 'idea', 'script')
  visible[0].context.baseContent = '不能改变原始快照'
  assert.equal(original[0].context.baseContent, draft().context.baseContent)
  const retained = removeCandidateDraft(original, 'missing')
  retained[0].text = '独立副本'
  assert.equal(original[0].text, draft().text)
  assert.deepEqual(removeCandidateDraft(original, source.id), [])
})

test('capacity rejects a new generation without evicting drafts and allows an existing stream to finish', () => {
  const full = Array.from({ length: MAX_CANDIDATE_DRAFTS }, (_, index) => draft(`candidate-${index}`))
  const before = structuredClone(full)
  assert.throws(() => upsertCandidateDraft(full, draft('new-candidate')), /100/)
  assert.deepEqual(full, before)
  const updated = upsertCandidateDraft(full, { ...draft('candidate-20'), text: '流式生成完成' })
  assert.equal(updated.length, MAX_CANDIDATE_DRAFTS)
  assert.equal(updated[20].text, '流式生成完成')
  assert.equal(updated[19].text, before[19].text)
})

test('streaming, stopped and failed candidates can preserve empty or partial output up to the output cap', () => {
  for (const status of ['partial', 'error', 'complete']) assert.doesNotThrow(() => validateCandidateDrafts([{ ...draft(), text: '', status }]))
  assert.doesNotThrow(() => validateCandidateDrafts([{ ...draft(), text: '文'.repeat(2 * 1024 * 1024) }]))
  assert.throws(() => validateCandidateDrafts([{ ...draft(), text: '文'.repeat(2 * 1024 * 1024 + 1) }]), /文本/)
  const largeBaseline = draft()
  largeBaseline.context.baseContent = '文'.repeat(2 * 1024 * 1024 + 1)
  assert.doesNotThrow(() => validateCandidateDrafts([largeBaseline]), 'existing source documents retain their complete conflict-check baseline')
})

test('candidate schema rejects malformed fields, unknown fields and mismatched context', () => {
  const invalid = [
    { id: '' }, { id: '__proto__' }, { documentId: 'bad/id' }, { tabName: 'history' }, { prompt: 5 },
    { text: null }, { createdAt: 'not-a-date' }, { status: 'generating' }, { ignored: 'never silently drop' }
  ]
  for (const patch of invalid) assert.throws(() => validateCandidateDrafts([{ ...draft(), ...patch }]))
  assert.throws(() => validateCandidateDrafts([draft(), draft()]), /重复/)
  for (const patch of [
    { projectId: '' }, { documentId: 'other' }, { tabName: 'outline' }, { purpose: 'execute' },
    { selectionStart: -1 }, { selectionEnd: 500 }, { storyboardRevision: -1 },
    { sourceFingerprint: {} }, { unknownContext: 'preserve or reject' },
    { messages: [{ role: 'user', content: '正文', tool_calls: [] }] },
    { messages: [{ role: 'tool', content: '正文' }] }, { knowledgeChunks: null }
  ]) assert.throws(() => validateCandidateDrafts([{ ...draft(), context: { ...draft().context, ...patch } }]))
})

test('structured credentials and connection configuration never enter saved candidates', () => {
  for (const key of ['apiKey', 'authorization', 'connections', 'baseUrl']) {
    assert.throws(() => validateCandidateDrafts([{ ...draft(), [key]: 'sensitive' }]), /未知字段/)
    assert.throws(() => validateCandidateDrafts([{ ...draft(), context: { ...draft().context, [key]: 'sensitive' } }]), /未知字段/)
  }
  const context = { ...draft().context, purpose: 'project-plan', operationContext: {
    projectId: 'project-original', storyboardRevision: 0, documents: { idea: { title: '合法标题', script: '正文' } }, shots: {}, mediaVersions: {}
  } }
  for (const key of ['api_key', 'Authorization', 'refreshToken', 'cookie', 'headers', 'privateKey', 'env']) {
    const malicious = structuredClone(context)
    malicious.operationContext.documents.idea[key] = 'sensitive'
    assert.throws(() => validateCandidateDrafts([{ ...draft(), context: malicious }]), /凭据|连接配置/)
  }
})

test('JSON validation rejects unsafe objects, accessors, cycles, sparse arrays and prototype fields', () => {
  const getter = draft()
  let accessed = false
  Object.defineProperty(getter.context, 'baseContent', { enumerable: true, get() { accessed = true; return 'text' } })
  assert.throws(() => validateCandidateDrafts([getter]), /JSON/)
  assert.equal(accessed, false)
  const cyclic = draft()
  cyclic.context.messages.push(cyclic.context.messages)
  assert.throws(() => validateCandidateDrafts([cyclic]), /循环/)
  const date = draft(); date.context.messages = new Date()
  assert.throws(() => validateCandidateDrafts([date]), /JSON/)
  assert.throws(() => validateCandidateDrafts(new Array(1)), /JSON/)
  const invalid = draft(); invalid.context.messages[0].content = undefined
  assert.throws(() => validateCandidateDrafts([invalid]), /JSON/)
  const polluted = JSON.parse(JSON.stringify(draft()).replace('"baseContent":', '"__proto__":{},"baseContent":'))
  assert.throws(() => validateCandidateDrafts([polluted]), /未知字段/)
})

test('real generation snapshots retain knowledge and operation baselines without rewriting project IDs', () => {
  const data = workspace()
  const shot = createShot({ title: '门前', visual: '她站在门前' }, { documentId: 'idea', fingerprint: 'fingerprint' })
  data.storyboard.shots.push(shot)
  // A valid document ID may itself resemble a credential name.
  data.documents.token = { title: '令牌道具', content: '故事中的令牌' }
  const index = createKnowledgeIndex([{ id: 'reference', sourceId: 'source', name: '人物', path: '人物.md', content: '她迟疑了很久。', updatedAt: '2026-10-15T00:00:00Z' }])
  const prepared = prepareGeneration({ ...data, documentId: 'idea', tabName: 'script', prompt: '继续', knowledgeChunks: index.chunks })
  const base = captureOperationContext({ projectId: 'project-original', workspace: data, media: { projectId: 'project-original', versions: [{ id: 'media-1', assetId: 'asset-1', name: '门口', kind: 'image', mimeType: 'image/png', bytes: 1024 }] } }, [
    { key: 'current', characters: 5 }, { key: 'object:document:token', characters: 5 }, { key: `object:shot:${shot.id}`, characters: 5 }, { key: 'object:asset:media-1', characters: 5 }
  ])
  const candidate = { ...draft(), context: { ...draft().context, purpose: 'project-plan', knowledgeChunks: prepared.knowledgeChunks, messages: prepared.messages, operationContext: base } }
  const stored = upsertCandidateDraft([], candidate)
  assert.deepEqual(stored[0].context.operationContext, base)
  assert.deepEqual(stored[0].context.knowledgeChunks, prepared.knowledgeChunks)
  const wrongProject = structuredClone(candidate)
  wrongProject.context.operationContext.projectId = 'other-project'
  assert.throws(() => validateCandidateDrafts([wrongProject]), /项目不一致/)
})

test('project backup and restore preserve candidates for deleted documents with their original ownership', () => {
  const data = workspace()
  data.candidateDrafts = [draft(), draft('orphan-candidate', 'deleted-scene', 'outline')]
  data.connections = [{ id: 'private-connection', baseUrl: 'https://provider.invalid' }]
  const original = structuredClone(data.candidateDrafts)
  const serialized = projectBackup(data, null)
  const restored = parseBackup(serialized)
  assert.deepEqual(restored.workspace.candidateDrafts, original)
  assert.equal(restored.workspace.candidateDrafts[1].documentId, 'deleted-scene')
  assert.equal(restored.workspace.candidateDrafts[1].context.projectId, 'project-original')
  assert.equal(restored.workspace.connections, undefined)
  assert.equal(restored.workspace.candidateDrafts[0].context.messages[1].content, draft().context.messages[1].content)
  assert.doesNotThrow(() => validateWorkspace({ ...data, candidateDrafts: undefined }))
  assert.throws(() => parseBackup(serialized.replace('"status":"complete"', '"status":"complete","authorization":"Bearer test"')), /未知字段/)
  assert.throws(() => validateWorkspace({ ...data, candidateDrafts: null }), /待审稿/)
})
