import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { contentFingerprint, validateStoryboard } from '../src/storyboard.js'
import { emptyContinuity, createEntity } from '../src/continuity-assets.js'
import { MAX_CANDIDATE_DRAFTS, candidateDraftsFor, upsertCandidateDraft, removeCandidateDraft, validateCandidateDrafts } from '../src/candidate-drafts.js'
import { validateWorkspace, projectBackup, parseBackup } from '../src/project-store.js'

if (!globalThis.crypto) globalThis.crypto = webcrypto
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(app)
  assert.ok(match, `${name} exists`)
  const body = app.slice(match.index), end = /^\}/m.exec(body)
  return body.slice(0, end.index + 1)
}
function node() {
  const children = new Map()
  return { textContent: '', value: '', hidden: false, disabled: false, selectionStart: 0, selectionEnd: 0, lastElementChild: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, focus() {}, querySelectorAll: () => [], querySelector(selector) { if (!children.has(selector)) children.set(selector, node()); return children.get(selector) } }
}
function harness() {
  const calls = { received: [], cleared: [], persisted: [], candidateSaves: [], toasts: [], opened: 0 }, queries = new Map()
  const state = { project: { name: '设定提取测试', type: '短剧' }, currentDocId: 's1', activeTab: 'script', documents: { s1: { title: '第一场', content: '平板木筏漂浮。' }, s2: { title: '第二场', content: '木筏绳索松开。' } }, connections: [{}], workflow: {}, storyboard: { revision: 2, shots: [], continuity: emptyContinuity() }, candidateDrafts: [], activeCandidateId: null, candidateCreatedAt: null, candidateStatus: 'partial', generationContext: null, generationText: '', activeGenerationId: null, generationSequence: 0, isGenerating: false, candidateApplying: false, knowledge: { index: {} } }
  const elements = Object.fromEntries(['sendButton', 'generationState', 'candidateActions', 'generationError', 'candidateContent', 'a11yAnnouncements', 'candidateCard', 'welcome', 'conversationThread', 'userMessage', 'promptInput', 'scriptEditor', 'candidateCitations'].map(key => [key, node()]))
  const controls = [node(), node()]; elements.candidateActions.querySelectorAll = () => controls
  const snapshot = () => structuredClone({ schemaVersion: 2, project: state.project, currentDocId: state.currentDocId, activeTab: state.activeTab, documents: state.documents, tabContents: {}, storyboard: state.storyboard, candidateDrafts: state.candidateDrafts })
  const env = {
    state, elements, activeProjectId: 'p', projectTransition: false, isDesktopRuntime: false, creationNavigation: null, MAX_CANDIDATE_DRAFTS, structuredClone, crypto: webcrypto, unsavedEdits: false, editRevision: 0,
    document: { querySelector(selector) { if (!queries.has(selector)) queries.set(selector, node()); return queries.get(selector) } },
    window: { clearInterval() {}, clearTimeout() {} }, getCurrentDocument: () => state.documents[state.currentDocId], getCurrentContent: () => state.documents[state.currentDocId].content,
    resolveConnectionRoute: () => ({ connection: state.connections[0] }), generationDraft: () => ({ messages: [{ role: 'user', content: '提取素材设定' }], knowledgeChunks: [] }),
    getAssistantProfileKey: () => 'writing', assistantProfiles: { writing: { progress: '生成中' } }, generateWithConnection() {}, renderContextPreview() {}, renderFollowupContext() {}, updateCandidateCitations() {}, renderCandidateDrafts() {},
    showToast: value => calls.toasts.push(value), readableError: error => error.message,
    upsertCandidateDraft: (drafts, draft) => upsertCandidateDraft(structuredClone(drafts), structuredClone(draft)), removeCandidateDraft: (drafts, id) => removeCandidateDraft(structuredClone(drafts), id), candidateDraftsFor: (drafts, id, tab) => candidateDraftsFor(structuredClone(drafts), id, tab),
    scheduleCandidateSave: () => calls.candidateSaves.push(snapshot()), scheduleSave() {},
    initializeMediaWorkbench: options => options, connectionSecret() {}, stopGeneration() {}, switchView() {}, organizeEpisodeScenes() {}, renderProjectTree() {},
    workspaceSnapshot: snapshot, saveImmediately: async () => true, validateWorkspace: next => validateWorkspace(structuredClone(next)), validateStoryboard: next => validateStoryboard(structuredClone(next)),
    saveProject: async (projectId, next) => calls.persisted.push({ projectId, snapshot: structuredClone(next) }), setSaveStatus() {}, setProjectTransition: value => { env.projectTransition = value },
    mediaWorkbench: { receiveEntityCandidate: (...args) => calls.received.push(args), clearEntityCandidate: id => calls.cleared.push(id), clearCandidate() {}, openContinuity: () => { calls.opened++ } },
  }
  vm.createContext(env)
  vm.runInContext(['startGeneration', 'finishGeneration', 'failGeneration', 'rememberCurrentCandidate', 'showSavedCandidate', 'restoreDocumentCandidate', 'discardCandidate', 'initializeProjectMediaWorkbench'].map(productionFunction).join('\n'), env)
  const start = () => env.startGeneration('提取人物、场景和关键物品', { purpose: 'asset-extraction', sourceDocumentIds: ['s1', 's2'], sourceFingerprints: { s1: contentFingerprint(state.documents.s1.content), s2: contentFingerprint(state.documents.s2.content) }, sourceFingerprint: contentFingerprint(state.documents.s1.content), storyboardRevision: 2 })
  const output = () => { const text = JSON.stringify({ entities: [{ kind: 'prop', name: '木筏', traits: '平板结构', sourceDocumentIds: ['s1', 's2'], states: [{ name: '初始', sourceDocumentIds: ['s1'] }, { name: '松绳', sourceDocumentIds: ['s2'] }] }] }); state.generationText = text; elements.candidateContent.textContent = text; return text }
  return { env, state, calls, elements, start, output, snapshot }
}

test('设定提取完成先保存完整候选再交接，传递范围、来源指纹与生成时间', async () => {
  for (const stopped of [false, true]) {
    const h = harness(), id = h.start(), text = h.output()
    await h.env.finishGeneration({ generationId: id, stopped })
    assert.equal(h.state.isGenerating, false); assert.equal(h.state.candidateDrafts[0].status, stopped ? 'partial' : 'complete')
    assert.equal(h.calls.received.length, 1)
    const [received, metadata, draftId] = h.calls.received[0]
    assert.equal(received, text); assert.equal(draftId, id); assert.equal(metadata.createdAt, h.state.candidateCreatedAt)
    assert.deepEqual([...metadata.sourceDocumentIds], ['s1', 's2']); assert.equal(metadata.sourceFingerprints.s2, contentFingerprint(h.state.documents.s2.content))
    assert.equal(h.calls.candidateSaves.at(-1).candidateDrafts[0].status, stopped ? 'partial' : 'complete')
    assert.equal(h.state.storyboard.continuity.entities.length, 0, '交接只展示预览，不自动采纳')
  }
})

test('提取快速失败、部分失败都保存error候选并把真实错误交接给面板', () => {
  for (const partial of [false, true]) {
    const h = harness(), id = h.start(), text = partial ? h.output() : ''
    h.env.failGeneration('执行端连接中断', id)
    assert.equal(h.state.isGenerating, false); assert.equal(h.state.candidateDrafts[0].status, 'error'); assert.equal(h.state.candidateDrafts[0].text, text)
    assert.equal(h.calls.received.length, 1); assert.equal(h.calls.received[0][0], text); assert.equal(h.calls.received[0][1].error, '执行端连接中断')
    assert.match(h.elements.generationError.textContent, /执行端连接中断/)
    assert.equal(h.state.storyboard.continuity.entities.length, 0)
  }
})

test('来源与范围通过JSON、工作区备份恢复，旧提取候选不自动打开，仅显式选择后展示', async () => {
  const h = harness(), id = h.start(); h.output(); await h.env.finishGeneration({ generationId: id })
  const restored = parseBackup(projectBackup(h.snapshot())).workspace
  validateCandidateDrafts(restored.candidateDrafts)
  const next = harness(); next.state.candidateDrafts = restored.candidateDrafts
  next.env.restoreDocumentCandidate(); assert.equal(next.calls.received.length, 0); assert.equal(next.state.activeCandidateId, null); assert.equal(next.calls.opened, 0)
  const candidate = next.state.candidateDrafts[0]
  next.env.showSavedCandidate(candidate); assert.equal(next.calls.received.length, 1); assert.equal(next.calls.opened, 1)
  assert.deepEqual(next.calls.received[0][1].sourceFingerprints, candidate.context.sourceFingerprints); assert.equal(next.calls.received[0][1].createdAt, candidate.createdAt)
  next.env.activeProjectId = 'other'; next.env.showSavedCandidate(candidate); assert.equal(next.calls.received.length, 1, '导入候选保留原项目归属')
})

test('采纳设定与删除对应候选在同次原子保存完成，后续快照不会复活已采纳候选', async () => {
  const h = harness(), id = h.start(); h.output(); await h.env.finishGeneration({ generationId: id })
  const media = h.env.initializeProjectMediaWorkbench(), continuity = { ...emptyContinuity(), entities: [createEntity({ kind: 'prop', name: '木筏', traits: '平板结构' })] }
  await media.commit({ storyboard: { ...h.state.storyboard, revision: 3, continuity } }, { projectId: 'p', revision: 2, resolvedCandidateId: id, atomic: true })
  assert.equal(h.calls.persisted.length, 1); assert.equal(h.calls.persisted[0].snapshot.candidateDrafts.length, 0); assert.equal(h.calls.persisted[0].snapshot.storyboard.continuity.entities[0].name, '木筏')
  assert.equal(h.state.activeCandidateId, null); assert.equal(h.state.candidateDrafts.length, 0); assert.deepEqual(h.calls.cleared, [id])
  h.env.rememberCurrentCandidate(); assert.equal(h.snapshot().candidateDrafts.length, 0)
  assert.equal(h.state.candidateApplying, false); assert.equal(h.env.projectTransition, false)
})

test('采纳保存失败保留原设定和候选，手动移除只清对应候选', async () => {
  const h = harness(), id = h.start(); h.output(); await h.env.finishGeneration({ generationId: id })
  const old = structuredClone(h.state.storyboard), media = h.env.initializeProjectMediaWorkbench()
  h.env.saveProject = async () => { throw new Error('磁盘不可写') }
  await assert.rejects(media.commit({ storyboard: { ...old, revision: 3 } }, { projectId: 'p', revision: 2, resolvedCandidateId: id, atomic: true }), /磁盘不可写/)
  assert.deepEqual(h.state.storyboard, old); assert.equal(h.state.candidateDrafts.length, 1); assert.equal(h.state.activeCandidateId, id); assert.equal(h.calls.cleared.length, 0)
  assert.equal(h.state.candidateApplying, false); assert.equal(h.env.projectTransition, false)
  h.env.discardCandidate(); assert.equal(h.state.candidateDrafts.length, 0); assert.deepEqual(h.calls.cleared, [id])
})

test('提取候选要求每个来源都有快照，拒绝缺失、非法范围和伪造连接字段', async () => {
  const h = harness(), id = h.start(); h.output(); await h.env.finishGeneration({ generationId: id })
  const original = h.state.candidateDrafts[0]
  for (const patch of [{ sourceDocumentIds: [] }, { sourceFingerprints: {} }, { sourceDocumentIds: ['bad/id'] }, { connectionId: 'secret-connection' }]) {
    const draft = structuredClone(original); Object.assign(draft.context, patch)
    assert.throws(() => validateCandidateDrafts([draft]))
  }
})
