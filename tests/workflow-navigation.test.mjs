import test from 'node:test'
import assert from 'node:assert/strict'
import { creationSteps, currentCreationStep, initializeCreationNavigation } from '../src/workflow-navigation.js'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { sceneNavigation } from '../src/creation-workflow.js'

const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(appSource)
  assert.ok(match)
  const tail = appSource.slice(match.index)
  return tail.slice(0, /^\}$/m.exec(tail).index + 1)
}

const context = (overrides = {}) => ({
  projectId: 'project-a', view: 'workspace', step: null, documentId: 'scene-a',
  workflow: { preset: 'script' }, connections: [], knowledgeCount: 0,
  documents: { idea: { title: '灵感', content: '已有灵感' }, 'scene-a': { title: '海面', content: '已有分场' } },
  structure: { acts: [], episodes: { 'episode-a': { sceneIds: ['scene-a'] } } },
  storyboard: { shots: [{ id: 'shot-a', selectedImageVersionId: 'fixed-image' }] },
  ...overrides,
})

test('剧本与已有剧本路径共用四阶段，并保留已有导航 ID', () => {
  const script = creationSteps('script'), storyboard = creationSteps('storyboard')
  assert.deepEqual(script.map(step => step.id), ['script', 'references', 'storyboard', 'export'])
  assert.deepEqual(storyboard.map(step => step.id), ['source', 'references', 'storyboard', 'export'])
  assert.deepEqual(script.map(step => step.label), ['写剧本', '定形象', '做分镜', '导出'])
  assert.deepEqual(storyboard.map(step => step.label), script.map(step => step.label))
  assert.deepEqual(creationSteps('text').map(step => step.id), ['idea', 'brief', 'outline', 'draft', 'export'])
})

test('旧的图片和视频入口、参考页与可选前期资料准确落在四阶段', () => {
  const data = context(), before = structuredClone(data)
  for (const step of ['storyboard', 'images', 'videos', null]) {
    assert.equal(currentCreationStep({ ...data, view: 'storyboard', step }).id, 'storyboard')
  }
  assert.equal(currentCreationStep({ ...data, view: 'assets', step: 'references' }).id, 'references')
  assert.equal(currentCreationStep({ ...data, view: 'storyboard', step: 'export' }).id, 'export')
  for (const documentId of ['idea', 'brief', 'world', 'characters', 'outline', 'episode-a', 'scene-a', 'imported-draft']) {
    assert.equal(currentCreationStep({ ...data, documentId }).id, 'script')
    assert.equal(currentCreationStep({ ...data, documentId, workflow: { preset: 'storyboard' } }).id, 'source')
  }
  assert.equal(currentCreationStep({ ...data, view: 'connections' }), null)
  assert.deepEqual(data, before, 'displaying a stage cannot change documents, selected media or project structure')
})

test('文字项目按文档导航，媒体旁路不会伪装成文字步骤', () => {
  const data = context({ workflow: { preset: 'text' } })
  assert.equal(currentCreationStep({ ...data, documentId: 'idea' }).id, 'idea')
  assert.equal(currentCreationStep({ ...data, documentId: 'draft' }).id, 'draft')
  assert.equal(currentCreationStep({ ...data, documentId: 'scene-a' }), undefined)
  assert.equal(currentCreationStep({ ...data, view: 'storyboard', step: 'images' }), undefined)
  assert.equal(currentCreationStep({ ...data, view: 'workspace', step: 'export' }).id, 'export')
})

class Element {
  constructor() { this.children = []; this.listeners = new Map(); this.attributes = {}; this.open = false }
  replaceChildren(...children) { this.children = children }
  addEventListener(type, listener) { this.listeners.set(type, listener) }
  setAttribute(name, value) { this.attributes[name] = value }
  removeAttribute(name) { delete this.attributes[name] }
  querySelector(selector) { return this.controls.get(selector) }
  emit(type) { return this.listeners.get(type)?.({}) }
}

function harness() {
  const previous = { document: globalThis.document, Option: globalThis.Option }
  const data = context(), calls = [], notices = []
  const root = new Element()
  root.controls = new Map(['#creationStep', '#creationStages', '[data-workflow-previous]', '[data-workflow-next]', 'details', '#creationPath', '#creationStepHint', '#creationStepInput', '#creationStepExecutor', '#creationStepOutput'].map(id => [id, new Element()]))
  globalThis.document = { querySelector: () => root, createElement: () => new Element() }
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value } }
  const controls = { gate: null, fail: false }
  const ui = initializeCreationNavigation({ getContext: () => data, notify: message => notices.push(message), navigate: async step => {
    calls.push(step)
    if (controls.gate) await controls.gate
    if (controls.fail) throw new Error('保存失败，保留当前内容')
    if (data.projectId !== 'project-a') return true
    data.view = step.view || 'storyboard'; data.step = step.id
    return true
  } })
  ui.render()
  return { data, ui, calls, controls, notices, root, stages: root.controls.get('#creationStages'), details: root.controls.get('details'),
    cleanup() { globalThis.document = previous.document; globalThis.Option = previous.Option } }
}

test('阶段点击只导航一次，等待期间禁用；刷新保留按钮节点与已选阶段', async () => {
  const h = harness()
  try {
    const buttons = [...h.stages.children]
    assert.equal(buttons.length, 4)
    assert.equal(buttons[0].attributes['aria-current'], 'step')
    let release
    h.controls.gate = new Promise(resolve => { release = resolve })
    const pending = buttons[1].emit('click')
    assert.ok(h.stages.children.every(button => button.disabled))
    await buttons[2].emit('click')
    assert.equal(h.calls.length, 1)
    release(); await pending
    assert.equal(h.data.view, 'assets')
    assert.equal(buttons[1].attributes['aria-current'], 'step')
    assert.equal(buttons[0].attributes['aria-current'], undefined)
    assert.ok(buttons.every((button, index) => button === h.stages.children[index]))
    assert.ok(buttons.every(button => !button.disabled))
    h.data.view = 'storyboard'; h.data.step = 'videos'; h.ui.render()
    assert.equal(buttons[2].attributes['aria-current'], 'step')
    assert.equal(h.root.controls.get('#creationStep').value, 'storyboard')
  } finally { h.cleanup() }
})

test('导航保存失败不切换阶段并恢复操作；旧项目的迟到导航不展开新项目说明', async () => {
  const h = harness()
  try {
    const original = structuredClone(h.data)
    h.controls.fail = true
    await h.stages.children[1].emit('click')
    assert.deepEqual(h.data, original)
    assert.deepEqual(h.notices, ['保存失败，保留当前内容'])
    assert.ok(h.stages.children.every(button => !button.disabled))
    h.controls.fail = false
    let release
    h.controls.gate = new Promise(resolve => { release = resolve })
    const pending = h.stages.children[3].emit('click')
    h.data.projectId = 'project-b'; h.ui.render()
    assert.equal(h.details.open, false)
    release(); await pending
    assert.equal(h.details.open, false)
    assert.equal(h.stages.children[0].attributes['aria-current'], 'step')
  } finally { h.cleanup() }
})

test('剧本和分镜预设前期资料均直达剧本，分集仍保留先整理真实分场的要求', async () => {
  for (const preset of ['script', 'storyboard']) {
    const visited = [], created = [], organized = []
    const sandbox = {
      state: { workflow: { preset }, currentDocId: 'idea', structure: { episodes: { episode: { sceneIds: [] } } } },
      creationSteps, getDocumentKind: id => id === 'episode' ? 'episode' : 'core',
      navigateCreationStep: async step => visited.push(step.id), selectDocument: async id => visited.push(id),
      openNewContentDialog: options => created.push(options), organizeEpisodeScenes: async options => organized.push(options.episodeId),
    }
    vm.createContext(sandbox); vm.runInContext(productionFunction('advanceStage'), sandbox)
    for (const id of ['idea', 'brief', 'world', 'characters', 'outline']) { sandbox.state.currentDocId = id; await sandbox.advanceStage() }
    assert.deepEqual(visited, Array(5).fill('script'))
    sandbox.state.currentDocId = 'episode'; await sandbox.advanceStage()
    assert.deepEqual(organized, ['episode']); assert.deepEqual(created, [])
    sandbox.state.structure.episodes.episode.sceneIds.push('existing-scene'); await sandbox.advanceStage()
    assert.equal(visited.at(-1), 'existing-scene')
  }
})

test('文字主按钮仍依次进入简报、大纲、正文和导出，不跳到媒体阶段', async () => {
  const visited = []
  const sandbox = { state: { workflow: { preset: 'text' }, currentDocId: 'idea' }, creationSteps,
    navigateCreationStep: async step => visited.push(step.id) }
  vm.createContext(sandbox); vm.runInContext(productionFunction('advanceStage'), sandbox)
  for (const id of ['idea', 'brief', 'outline', 'draft']) { sandbox.state.currentDocId = id; await sandbox.advanceStage() }
  assert.deepEqual(visited, ['brief', 'outline', 'draft', 'export'])
})

test('主按钮标签与四阶段行为一致，前后场按钮和手动新增入口保留', () => {
  const controls = new Map(['#previousSceneButton', '#newSceneButton', '#organizeScenesButton', '#sceneStoryboardButton'].map(id => [id, {}]))
  const label = {}, main = { querySelector: () => label, setAttribute(name, value) { this[name] = value } }
  const sandbox = {
    state: { workflow: { preset: 'script' }, currentDocId: 'idea', structure: { acts: [{ episodeIds: ['ep'] }], episodes: { ep: { sceneIds: ['scene-a', 'scene-b'] } } } },
    elements: { stageAdvanceButton: main }, document: { querySelector: id => controls.get(id) }, sceneNavigation,
    getDocumentKind: id => id === 'ep' ? 'episode' : id.startsWith('scene-') ? 'scene' : 'core',
  }
  vm.createContext(sandbox); vm.runInContext(productionFunction('updateStageAdvanceButton'), sandbox)
  sandbox.updateStageAdvanceButton(); assert.equal(label.textContent, '去写剧本')
  sandbox.state.currentDocId = 'scene-b'; sandbox.updateStageAdvanceButton()
  assert.equal(label.textContent, '确认人物与场景')
  assert.equal(main['aria-label'], label.textContent)
  assert.equal(controls.get('#previousSceneButton').hidden, false)
  assert.equal(controls.get('#previousSceneButton').disabled, false)
  assert.equal(controls.get('#newSceneButton').hidden, false)
  sandbox.state.currentDocId = 'ep'; sandbox.updateStageAdvanceButton(); assert.equal(label.textContent, '进入第一场')
  sandbox.state.structure.episodes.ep.sceneIds = []; sandbox.updateStageAdvanceButton(); assert.equal(label.textContent, '整理本集分场')
  sandbox.state.workflow.preset = 'text'; sandbox.state.currentDocId = 'outline'; sandbox.updateStageAdvanceButton()
  assert.equal(label.textContent, '开始正文')
})
