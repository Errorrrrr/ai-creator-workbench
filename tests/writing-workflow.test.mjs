import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { prepareGeneration, prepareVersionRestore, previousSceneId } from '../src/creation-workflow.js'
import { validateWorkspace } from '../src/project-store.js'

const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(appSource)
  assert.ok(match)
  const rest = appSource.slice(match.index)
  return rest.slice(0, /^\}$/m.exec(rest).index + 1)
}

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function writingWorkspace() {
  return {
    schemaVersion: 2, project: { name: '连续性回归', type: '短剧' }, currentDocId: 'scene-b', activeTab: 'history',
    documents: {
      world: { title: '世界规则', content: '钟楼在午夜之后不能进入。' }, characters: { title: '人物', content: '主角怕水。' },
      'episode-a': { title: '甲集', content: '甲集情节' }, 'episode-b': { title: '乙集', content: '乙集情节' },
      'scene-a': { title: '甲场', content: '上一场最新正文：她带着钥匙离开钟楼。' },
      'scene-b': { title: '乙场', content: '当前手写正文，尚未存过快照。' },
      'scene-c': { title: '丙场', content: '未来情节不得自动发送。' }
    },
    tabContents: { 'scene-b': { outline: '手写大纲', references: '手写参考笔记', history: '旧历史说明' } },
    versions: { 'scene-b': [{ number: 4, tabName: 'script', content: '历史正文', source: '手写快照', createdAt: '2026-10-20' }] },
    versionCounters: { 'scene-b': 8 }, candidateDrafts: [],
    structure: { acts: [{ id: 'act', title: '第一幕', episodeIds: ['episode-a', 'episode-b'] }], episodes: { 'episode-a': { sceneIds: ['scene-a'] }, 'episode-b': { sceneIds: ['scene-b', 'scene-c'] } } }
  }
}

function restoreHarness() {
  const initial = writingWorkspace(), gate = deferred()
  const state = { ...structuredClone(initial), selectedVersionByDocument: { 'scene-b': 4 }, knowledge: { index: null }, candidateApplying: false, storageFailed: false }
  const history = { undo: [{ before: '之前', after: '当前' }], redo: [{ before: '当前', after: '之后' }] }
  const calls = { saves: [], toasts: [], statuses: [], updates: 0, preliminarySave: true }
  const sandbox = {
    state, activeProjectId: 'project-1', projectTransition: false, editRevision: 0, unsavedEdits: true,
    structuredClone, prepareVersionRestore,
    validateWorkspace: workspace => validateWorkspace(structuredClone(workspace)),
    workspaceSnapshot: () => structuredClone(Object.fromEntries(Object.keys(initial).map(key => [key, state[key]]))),
    getSelectedHistoryVersion: () => state.versions['scene-b'].find(entry => entry.number === state.selectedVersionByDocument['scene-b']),
    getContentAt: (id, tab) => tab === 'script' ? state.documents[id].content : state.tabContents[id][tab],
    setContentAt: (id, tab, text) => { if (tab === 'script') state.documents[id].content = text; else state.tabContents[id][tab] = text },
    getEditHistory: () => history,
    setProjectTransition: value => { sandbox.projectTransition = value },
    saveImmediately: async () => calls.preliminarySave,
    saveProject: async (owner, snapshot) => { calls.saves.push({ owner, snapshot: structuredClone(snapshot) }); await gate.promise },
    setSaveStatus: status => calls.statuses.push(status), showToast: text => calls.toasts.push(text),
    readableError: error => error.message, abandonCandidateOnContextChange() {},
    updateDocumentView: () => { calls.updates += 1 }, tabFallbacks: { history: '' }
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(`${productionFunction('formatVersionHistory')}\n${productionFunction('restoreSelectedVersion')}`, context)
  return { initial, state, history, calls, gate, context }
}

test('恢复历史先持久保存恢复前与恢复后快照，成功后才切换正文，重复点击只提交一次', async () => {
  const h = restoreHarness(), previous = h.state.documents['scene-b'].content
  const pending = h.context.restoreSelectedVersion()
  await Promise.resolve()
  await h.context.restoreSelectedVersion()
  assert.equal(h.calls.saves.length, 1)
  assert.equal(h.state.documents['scene-b'].content, previous)
  assert.equal(h.state.activeTab, 'history')
  assert.equal(h.history.undo.length, 1)
  const snapshot = h.calls.saves[0].snapshot
  assert.equal(snapshot.documents['scene-b'].content, '历史正文')
  assert.deepEqual(snapshot.versions['scene-b'].map(entry => entry.number), [10, 9, 4])
  assert.equal(snapshot.versions['scene-b'][1].content, previous)
  assert.match(snapshot.versions['scene-b'][1].source, /恢复.*前快照/)
  assert.match(snapshot.tabContents['scene-b'].history, /v10/)
  h.gate.resolve()
  await pending
  assert.equal(h.state.activeTab, 'script')
  assert.equal(h.state.documents['scene-b'].content, '历史正文')
  assert.equal(h.state.selectedVersionByDocument['scene-b'], 10)
  assert.deepEqual(structuredClone(h.history.undo.at(-1)), { before: previous, after: '历史正文' })
  assert.equal(h.history.redo.length, 0)
  assert.equal(h.state.candidateApplying, false)
  assert.equal(h.context.projectTransition, false)
  assert.match(h.calls.toasts.at(-1), /恢复前内容保留在 v9/)
})

test('恢复落盘失败保留原正文、历史选择和撤销栈，也不误报恢复成功', async () => {
  const h = restoreHarness(), before = structuredClone(h.state), history = structuredClone(h.history)
  const pending = h.context.restoreSelectedVersion()
  await Promise.resolve()
  h.gate.reject(new Error('磁盘写入失败'))
  await pending
  assert.deepEqual(h.state.documents, before.documents)
  assert.deepEqual(h.state.versions, before.versions)
  assert.deepEqual(h.state.versionCounters, before.versionCounters)
  assert.deepEqual(h.state.selectedVersionByDocument, before.selectedVersionByDocument)
  assert.deepEqual(h.history, history)
  assert.equal(h.state.activeTab, 'history')
  assert.equal(h.state.storageFailed, true)
  assert.equal(h.context.projectTransition, false)
  assert.match(h.calls.toasts.at(-1), /恢复未保存/)
  assert.equal(h.calls.updates, 0)
})

test('恢复前的当前编辑保存失败则不创建恢复事务', async () => {
  const h = restoreHarness()
  h.calls.preliminarySave = false
  await h.context.restoreSelectedVersion()
  assert.equal(h.calls.saves.length, 0)
  assert.equal(h.state.activeTab, 'history')
  assert.equal(h.state.candidateApplying, false)
})

test('恢复参考笔记支持空白旧内容，并在 50 份上限内保留两个新快照', () => {
  const workspace = writingWorkspace()
  workspace.tabContents['scene-b'].references = ''
  workspace.versions['scene-b'] = Array.from({ length: 50 }, (_, index) => ({ number: index + 1, tabName: 'references', content: `笔记 ${index}`, source: '测试', createdAt: '2026-10-20' }))
  workspace.versionCounters['scene-b'] = 50
  const before = structuredClone(workspace)
  const prepared = prepareVersionRestore(workspace, 'scene-b', workspace.versions['scene-b'][0])
  assert.deepEqual(workspace, before)
  assert.equal(prepared.workspace.tabContents['scene-b'].references, '笔记 0')
  assert.equal(prepared.workspace.versions['scene-b'].length, 50)
  assert.equal(prepared.workspace.versions['scene-b'][1].content, '')
  assert.equal(prepared.workspace.versionCounters['scene-b'], 52)
  validateWorkspace(prepared.workspace)
})

test('前往下一阶段等保存成功才提示；失败不宣称已进入', async () => {
  for (const outcome of [false, true]) {
    const gate = deferred(), toasts = []
    const context = vm.createContext({
      state: { currentDocId: 'idea', workflow: { preset: 'script' }, documents: { brief: { title: '创作简报' } } },
      selectDocument: () => gate.promise, showToast: message => toasts.push(message)
    })
    vm.runInContext(productionFunction('advanceStage'), context)
    const pending = context.advanceStage()
    assert.equal(toasts.length, 0)
    gate.resolve(outcome)
    await pending
    assert.equal(toasts.length, outcome ? 1 : 0)
  }
})

function element() {
  return { children: [], hidden: false, open: false, textContent: '', append(...nodes) { this.children.push(...nodes) }, replaceChildren(...nodes) { this.children = nodes } }
}

test('自动知识引用单独渲染，重开和取消引用不会改写手写参考笔记', () => {
  const state = writingWorkspace(), note = state.tabContents['scene-b'].references
  state.activeTab = 'references'
  let panel = null, chunks = [{ name: '设定', path: '人物.md', content: '<script>只作为文本显示</script>' }]
  const context = vm.createContext({
    state, elements: { scriptEditor: { closest: () => ({ before: node => { panel = node } }) } },
    getSelectedKnowledgeChunks: () => chunks,
    document: { createElement: element, querySelector: () => panel }
  })
  vm.runInContext(productionFunction('syncCurrentDocumentReferences'), context)
  context.syncCurrentDocumentReferences()
  assert.equal(state.tabContents['scene-b'].references, note)
  assert.equal(panel.children[0].textContent, '已选知识资料 · 1 条（只读）')
  assert.equal(panel.children[2].children[1].textContent, chunks[0].content)
  panel.open = true
  chunks = []
  context.syncCurrentDocumentReferences()
  assert.equal(state.tabContents['scene-b'].references, note)
  assert.equal(panel.open, true)
  assert.equal(panel.children[0].textContent, '已选知识资料 · 0 条（只读）')
  state.activeTab = 'script'
  context.syncCurrentDocumentReferences()
  assert.equal(panel.hidden, true)
})

function continuityInput(overrides = {}) {
  const workspace = writingWorkspace()
  return { ...workspace, documentId: workspace.currentDocId, tabName: 'script', prompt: '检查动机、世界规则和上一场的衔接。', creativeAction: 'continuity', ...overrides }
}

test('连续性动作按幕集场顺序自动加入世界观和上一场最新正文，不读取未来场景', () => {
  const input = continuityInput({ includeUpstream: false })
  const prepared = prepareGeneration(input)
  const request = prepared.messages[1].content
  assert.equal(previousSceneId('scene-b', input.structure), 'scene-a')
  assert.ok(request.includes(input.documents.world.content))
  assert.ok(request.includes(input.documents['scene-a'].content))
  assert.ok(!request.includes(input.documents['scene-c'].content))
  assert.ok(prepared.summary.some(item => item.key === 'continuity:world'))
  assert.ok(prepared.summary.some(item => item.key === 'continuity:previous:scene-a'))
  input.structure.acts[0].episodeIds = ['episode-b', 'episode-a']
  assert.equal(previousSceneId('scene-a', input.structure), 'scene-c')
  assert.equal(previousSceneId('scene-b', input.structure), null)
})

test('连续性范围允许分别排除世界观和上一场，普通创作不默认携带两者', () => {
  const input = continuityInput({ excludedContextKeys: ['continuity:world', 'continuity:previous:scene-a'] })
  const prepared = prepareGeneration(input), request = prepared.messages[1].content
  assert.ok(!request.includes(input.documents.world.content))
  assert.ok(!request.includes(input.documents['scene-a'].content))
  const regular = prepareGeneration({ ...input, creativeAction: '' })
  assert.ok(!regular.summary.some(item => item.key.startsWith('continuity:')))
  assert.equal(regular.creativeAction, '')
})

test('上一场超过预算时保留末尾，预览显示真实片段且总请求不超过预算', () => {
  const input = continuityInput()
  input.documents['scene-a'].content = `上一场开头不发送${'中段'.repeat(5000)}关键结尾不能丢`
  const prepared = prepareGeneration(input)
  const previous = prepared.summary.find(item => item.key === 'continuity:previous:scene-a')
  assert.equal(previous.characters, 3200)
  assert.equal(previous.truncated, true)
  assert.ok(previous.content.endsWith('关键结尾不能丢'))
  assert.ok(!previous.content.startsWith('上一场开头'))
  assert.ok(prepared.messages[1].content.includes(previous.content))
  input.prompt = '要求'.repeat(6000)
  input.documents['scene-b'].content = '正文'.repeat(6000)
  const bounded = prepareGeneration(input)
  assert.ok(bounded.messages.reduce((total, message) => total + message.content.length, 0) <= 24000)
  assert.equal(bounded.characters, bounded.messages.reduce((total, message) => total + message.content.length, 0))
  assert.ok(bounded.messages[1].content.endsWith(input.prompt))
})

test('缺少世界观或前场明确提示检查范围不足', () => {
  const input = continuityInput({ documentId: 'scene-a' })
  input.documents.world.content = ''
  const prepared = prepareGeneration(input)
  assert.equal(prepared.contextWarnings.length, 2)
  assert.match(prepared.messages[0].content, /未提供的内容不能视为已核实/)
})

test('连续性快捷操作只准备可审阅的请求，不直接调用模型；普通动作保留发送行为', () => {
  const nodes = new Map(), toasts = [], started = []
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { value: '', hidden: false, open: false, closest() { return this } }); return nodes.get(selector) }
  const state = { currentDocId: 'scene-b', activeTab: 'script' }, elements = { promptInput: { value: '' } }
  const context = vm.createContext({ state, elements, activeProjectId: 'project-1', document: { querySelector: node }, focusAssistant() {}, renderContextPreview() {}, renderFollowupContext() {}, showToast: message => toasts.push(message), startGeneration: prompt => started.push(prompt) })
  vm.runInContext(productionFunction('prepareAssistantAction'), context)
  context.prepareAssistantAction('核对连续性', 'continuity')
  assert.deepEqual(started, [])
  assert.equal(state.creativeActionContext.action, 'continuity')
  assert.equal(node('#assistantRequestMode').value, 'discussion')
  assert.equal(node('#assistantContextSettings').open, true)
  assert.equal(node('#contextPreviewSummary').open, true)
  context.prepareAssistantAction('继续写')
  assert.deepEqual(started, ['继续写'])
  assert.equal(state.creativeActionContext, null)
})

test('连续性操作只作用于对应文档和视图，显式重试仍保留操作', () => {
  const input = continuityInput(), state = {
    project: input.project, currentDocId: input.documentId, activeTab: 'script', documents: input.documents,
    tabContents: input.tabContents, structure: input.structure, contextReferenceKeys: [], excludedContextKeys: new Map(),
    includeCurrentContext: true, creativeActionContext: { action: 'continuity', projectId: 'project-1', documentId: 'scene-b', tabName: 'script' }
  }
  const context = vm.createContext({
    state, activeProjectId: 'project-1', prepareGeneration, GENERATION_CHARACTER_LIMIT: 24000,
    contextObjects: () => [], getSelectedKnowledgeChunks: () => [],
    document: { querySelectorAll: () => [{ getAttribute: () => 'true' }, { getAttribute: () => 'true' }] }
  })
  vm.runInContext(productionFunction('generationDraft'), context)
  assert.equal(context.generationDraft('自定义检查要求', 'discussion').creativeAction, 'continuity')
  state.currentDocId = 'scene-c'
  assert.equal(context.generationDraft('另一个文档', 'discussion').creativeAction, '')
  state.creativeActionContext = null
  state.currentDocId = 'scene-b'
  assert.equal(context.generationDraft('恢复后重新检查', 'discussion', 'continuity').creativeAction, 'continuity')
})
