import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { prepareGeneration, prepareStructureChange } from '../src/creation-workflow.js'
import { emptySceneContinuity, sceneContentFingerprint, sceneContinuityContext, validateSceneContinuity } from '../src/scene-continuity.js'
import { validateWorkspace } from '../src/project-store.js'
import { createEntity, createEntityState } from '../src/continuity-assets.js'
import { validateCandidateDrafts } from '../src/candidate-drafts.js'

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
const productionFunction = name => {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(app)
  assert.ok(match)
  const rest = app.slice(match.index)
  return rest.slice(0, /^\}$/m.exec(rest).index + 1)
}
function fixture() {
  const onDeck = createEntityState({ id: 'deck', name: '船尾', description: '背包放在船尾木箱上' })
  const carried = createEntityState({ id: 'carried', name: '背着', description: '人物背着背包', basedOnStateId: 'deck', sourceDocumentIds: ['s2'] })
  const bag = createEntity({ id: 'bag', name: '背包', kind: 'prop', traits: '两个黄铜扣，深蓝帆布', sourceDocumentIds: ['s1', 's2'], states: [onDeck, carried], defaultStateId: 'deck' })
  const documents = {
    ep: { title: '第一集', content: '她在船上取回背包。' },
    s1: { title: '第一场', content: '她把背包放在船尾木箱上。' },
    s2: { title: '第二场', content: '她从木箱上拿起背包。' },
    s3: { title: '第三场', content: '未来尚未发生：登上月球。' }
  }
  documents.s1.sceneContinuity = { ...emptySceneContinuity(), exitState: '背包放在船尾', exitBindings: [{ entityId: 'bag', stateId: 'deck' }], sourceFingerprint: sceneContentFingerprint(documents.s1.content) }
  documents.s2.sceneContinuity = { ...emptySceneContinuity(), transition: 'continuous', entryState: '背包位于船尾', changes: '她拿起背包并背上', exitState: '人物背着背包', entryBindings: [{ entityId: 'bag', stateId: 'deck' }], exitBindings: [{ entityId: 'bag', stateId: 'carried' }], sourceFingerprint: sceneContentFingerprint(documents.s2.content) }
  return { schemaVersion: 2, project: { name: '状态衔接测试', type: '短剧' }, currentDocId: 's2', activeTab: 'script', documents,
    tabContents: { ep: {}, s1: {}, s2: {}, s3: {} }, versions: {}, versionCounters: {}, candidateDrafts: [],
    structure: { acts: [{ id: 'act', title: '第一幕', episodeIds: ['ep'] }], episodes: { ep: { sceneIds: ['s1', 's2', 's3'] } } },
    storyboard: { revision: 0, shots: [], continuity: { version: 1, style: '写实', entities: [bag] } } }
}
const request = (workspace, overrides = {}) => prepareGeneration({ ...workspace, documentId: 's2', tabName: 'script', prompt: '生成本场剧本', ...overrides })

test('普通分场创作自动携带完整固定特征及前场出口，不读取未来或修改项目', () => {
  const w = fixture(), before = structuredClone(w), result = request(w)
  const text = result.messages.map(message => message.content).join('\n')
  for (const value of ['两个黄铜扣', '深蓝帆布', '背包放在船尾', '人物背着背包', '她拿起背包并背上']) assert.ok(text.includes(value), value)
  assert.doesNotMatch(text, /登上月球/)
  assert.equal(result.summary.find(item => item.key === 'scene-constraints').required, true)
  assert.equal(result.characters, result.messages.reduce((sum, message) => sum + message.content.length, 0))
  assert.deepEqual(w, before)
})

test('明确入口冲突出现在发送预览，超预算约束拒绝提交而不截断', () => {
  const w = fixture()
  w.documents.s2.sceneContinuity.entryBindings[0].stateId = 'carried'
  const result = request(w)
  assert.ok(result.sceneContinuityConflicts.length)
  assert.ok(result.contextWarnings.some(message => message.includes('连续动作衔接冲突')))
  assert.match(result.messages[1].content, /连续动作衔接冲突/)
  w.storyboard.continuity.entities[0].traits = '必须保留的特征'.repeat(1500)
  w.storyboard.continuity.entities[0].description = '既有结构说明'.repeat(1000)
  assert.throws(() => request(w, { prompt: '要求'.repeat(5900) }), /预算.*未截断约束/)
})

test('分镜的全项目素材目录不被当成本场出场对象', () => {
  const w = fixture()
  w.storyboard.continuity.entities.push(createEntity({ id: 'unused', name: '无关飞船', kind: 'prop', traits: '不应出现在当前场' }))
  const result = request(w, { prompt: '请拆镜。全项目素材目录：无关飞船、背包。', sceneConstraintPrompt: '' })
  assert.doesNotMatch(result.summary.find(item => item.key === 'scene-constraints').content, /无关飞船|不应出现在当前场/)
})

test('完整约束挤掉当前正文时明确拒绝生成', () => {
  const w = fixture()
  w.documents.s2.content = '必要的剧本正文'.repeat(70)
  w.storyboard.continuity.entities[0].description = '设'.repeat(11000)
  w.storyboard.continuity.entities[0].traits = '定'.repeat(10000)
  w.storyboard.continuity.entities[0].states[1].description = '态'.repeat(2160)
  assert.throws(() => request(w), /预算|正文.*必要片段/)
})

test('启动及项目切换恢复保留分场状态，复制和JSON备份同样保留且互不共享引用', () => {
  const w = fixture(), sandbox = { structuredClone, validateSceneContinuity }
  vm.createContext(sandbox); vm.runInContext(productionFunction('mergeStoredDocument'), sandbox)
  const merged = sandbox.mergeStoredDocument({ title: '默认', content: '' }, JSON.parse(JSON.stringify(w.documents.s2)))
  assert.deepEqual(merged.sceneContinuity, w.documents.s2.sceneContinuity)
  merged.sceneContinuity.entryState = '副本变化'
  assert.equal(w.documents.s2.sceneContinuity.entryState, '背包位于船尾')
  assert.doesNotThrow(() => validateWorkspace(JSON.parse(JSON.stringify(w))))
  const copy = prepareStructureChange(w, { type: 'duplicate', documentId: 's2', newId: 's2-copy' }).workspace
  assert.deepEqual(copy.documents['s2-copy'].sceneContinuity, w.documents.s2.sceneContinuity)
  assert.doesNotThrow(() => validateWorkspace(copy))
  const invalid = structuredClone(w); invalid.documents.s2.sceneContinuity.transition = 'unknown'
  assert.throws(() => validateWorkspace(invalid), /衔接方式无效/)
})

function saveHarness() {
  const workspace = fixture(), state = { ...structuredClone(workspace), knowledge: { index: null }, candidateApplying: false, isGenerating: false }
  let accept, fail
  const gate = new Promise((resolve, reject) => { accept = resolve; fail = reject })
  const writes = [], statuses = []
  const sandbox = { state, activeProjectId: 'project', projectTransition: false, editRevision: 0, unsavedEdits: false, structuredClone,
    contentFingerprint: sceneContentFingerprint, validateWorkspace,
    setProjectTransition: value => { sandbox.projectTransition = value }, saveImmediately: async () => true,
    workspaceSnapshot: () => Object.fromEntries(Object.keys(workspace).map(key => [key, state[key]])),
    saveProject: async (owner, next) => { writes.push({ owner, next }); await gate },
    renderContextPreview() {}, mediaWorkbench: { refresh() {} }, setSaveStatus: value => statuses.push(value) }
  vm.createContext(sandbox); vm.runInContext(productionFunction('saveSceneContinuity'), sandbox)
  const next = { ...state.documents.s2.sceneContinuity, exitState: '背包已背稳' }
  const run = () => sandbox.saveSceneContinuity('s2', next, { projectId: 'project', contentFingerprint: sceneContentFingerprint(state.documents.s2.content) })
  return { sandbox, state, writes, statuses, accept, fail, next, run }
}
test('状态保存先持久化后发布；保存失败保留原状态并释放锁', async () => {
  const h = saveHarness(), old = structuredClone(h.state.documents.s2.sceneContinuity), pending = h.run()
  await new Promise(setImmediate)
  assert.deepEqual(h.state.documents.s2.sceneContinuity, old)
  assert.equal(h.writes.length, 1)
  h.accept(); assert.equal(await pending, true)
  assert.equal(h.state.documents.s2.sceneContinuity.exitState, '背包已背稳')
  assert.equal(h.sandbox.projectTransition, false)
  const failed = saveHarness(), prior = structuredClone(failed.state.documents.s2.sceneContinuity), attempt = failed.run()
  await new Promise(setImmediate); failed.fail(new Error('disk full'))
  await assert.rejects(attempt, /disk full/)
  assert.deepEqual(failed.state.documents.s2.sceneContinuity, prior)
  assert.equal(failed.state.candidateApplying, false)
})

test('候选记录保存实际分场约束依据；相关设定改变后阻止旧文字候选写入', async () => {
  const w = fixture(), result = request(w), context = { projectId: 'project', purpose: 'text', documentId: 's2', tabName: 'script', title: '第二场', baseContent: w.documents.s2.content,
    sceneContinuityFingerprint: result.sceneContinuityFingerprint, sceneContinuityPrompt: '生成本场剧本', sceneContinuityIncludePrevious: true }
  assert.doesNotThrow(() => validateCandidateDrafts([{ id: 'draft', documentId: 's2', tabName: 'script', prompt: '生成本场剧本', text: '候选保留', createdAt: new Date().toISOString(), status: 'complete', context }]))
  const notices = []
  w.storyboard.continuity.entities[0].traits = '固定特征已改'
  const sandbox = { state: { ...w, candidateApplying: false, isGenerating: false, generationContext: context }, elements: { candidateContent: { textContent: '候选保留' } },
    sceneContinuityContext, showToast: message => notices.push(message), readableError: error => error.message }
  vm.createContext(sandbox); vm.runInContext(productionFunction('applyCandidate'), sandbox)
  await sandbox.applyCandidate('replace')
  assert.match(notices[0], /相关素材设定或分场衔接已变化/)
  assert.equal(w.documents.s2.content, '她从木箱上拿起背包。')
  assert.equal(sandbox.elements.candidateContent.textContent, '候选保留')
})
