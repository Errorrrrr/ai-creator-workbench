import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import {
  GENERATION_CHARACTER_LIMIT,
  prepareGeneration,
  orderedDocuments,
  projectMarkdown,
  planKnowledgeFiles,
} from '../src/creation-workflow.js'

const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')

function generationInput(overrides = {}) {
  return {
    project: { name: '回归测试故事', type: '短剧' },
    documentId: 'scene-1',
    tabName: 'script',
    documents: {
      'scene-1': { title: '第一场', content: '主角推开了门。' },
      'episode-1': { title: '第一集', content: '第一集的故事走向。' },
      outline: { title: '全剧大纲', content: '全剧的核心冲突。' },
      characters: { title: '人物设定', content: '主角想守住一家旧书店。' },
    },
    tabContents: { 'scene-1': { outline: '这一场的大纲', references: '引用资料的检查笔记' } },
    structure: { acts: [{ episodeIds: ['episode-1'] }], episodes: { 'episode-1': { sceneIds: ['scene-1'] } } },
    prompt: '检查动机是否与设定冲突。',
    ...overrides,
  }
}

test('引用检查请求包含真正正文、引用笔记和选中的资料', () => {
  const input = generationInput({ tabName: 'references' })
  input.documents['scene-1'].content = '正文独有：主角决定关闭书店，离开故乡。'
  input.tabContents['scene-1'].references = '笔记独有：核对主角承诺。'
  input.knowledgeChunks = [{ id: 'book-keeper', name: '人物资料', path: '人物/主角.md', content: '资料独有：主角曾承诺永远保留书店。' }]
  const prepared = prepareGeneration(input)
  const request = prepared.messages.find(message => message.role === 'user').content
  assert.ok(request.includes(`【当前正文】\n${input.documents['scene-1'].content}`))
  assert.ok(request.includes(`【引用笔记】\n${input.tabContents['scene-1'].references}`))
  assert.ok(request.includes(input.knowledgeChunks[0].content))
  assert.ok(!request.includes(input.tabContents['scene-1'].outline))
  assert.deepEqual(prepared.knowledgeChunks, input.knowledgeChunks)
  assert.equal(prepared.characters, prepared.messages.reduce((sum, message) => sum + message.content.length, 0))
})

test('24k 上下文预算保留完整创作要求，并准确标记截断及实际发送的知识引用', () => {
  const input = generationInput({ prompt: `最重要的创作要求开始：${'保留人物动机。'.repeat(720)}结尾必须保留这个验收标记。` })
  input.documents['scene-1'].content = '正文'.repeat(6500)
  input.documents['episode-1'].content = '分集'.repeat(2200)
  input.documents.outline.content = '大纲'.repeat(2200)
  input.documents.characters.content = '人物'.repeat(2200)
  input.knowledgeChunks = Array.from({ length: 7 }, (_, index) => ({
    id: `source-${index + 1}`, name: `资料${index + 1}`, path: `设定/${index + 1}.md`, content: `${index + 1}`.repeat(1400),
  }))
  const prepared = prepareGeneration(input)
  const request = prepared.messages.find(message => message.role === 'user').content
  const actualCharacters = prepared.messages.reduce((sum, message) => sum + message.content.length, 0)
  assert.ok(actualCharacters <= GENERATION_CHARACTER_LIMIT, `${actualCharacters} exceeds ${GENERATION_CHARACTER_LIMIT}`)
  assert.equal(prepared.characters, actualCharacters)
  assert.ok(request.endsWith(`\n创作要求：\n${input.prompt}`), 'the last section must contain the whole original instruction')
  assert.equal(prepared.truncated, true)
  assert.match(request, /\[此项上下文已截断\]/)
  assert.ok(prepared.summary.some(item => item.label === '当前正文' && item.truncated && item.characters < item.originalCharacters))
  assert.ok(prepared.knowledgeChunks.length > 0, 'the fixture must leave room for at least one knowledge excerpt')
  assert.ok(prepared.knowledgeChunks.length < 6, 'the fixture must exhaust the budget before every selected citation is sent')
  assert.ok(prepared.knowledgeChunks.some(chunk => chunk.content.length < 900), 'the final sent excerpt must be partially truncated')
  for (const source of input.knowledgeChunks.slice(0, 6)) {
    const sent = prepared.knowledgeChunks.find(chunk => chunk.id === source.id)
    const label = `K${input.knowledgeChunks.indexOf(source) + 1} · ${source.name} / ${source.path}`
    const summary = prepared.summary.find(item => item.label === label)
    assert.ok(summary, 'every considered excerpt must be represented in the preview')
    if (sent) {
      assert.equal(sent.content, source.content.slice(0, summary.characters))
      assert.ok(request.includes(`【${label}】\n${sent.content}`))
      assert.ok(sent.content.length > 0)
    } else {
      assert.equal(summary.characters, 0)
      assert.ok(!request.includes(`【${label}】`), 'unsent excerpts must not appear in the request or citation snapshot')
    }
  }
  assert.ok(!prepared.knowledgeChunks.some(chunk => chunk.id === 'source-7'), 'at most six knowledge selections are considered')
})

test('超长创作要求明确拒绝，不悄悄截断要求', () => {
  assert.throws(() => prepareGeneration(generationInput({ prompt: '要求'.repeat(6001) })), /12000/)
})

test('导出遵循幕、集、场的用户顺序，并保留核心文档、大纲和孤立内容', () => {
  const document = (title) => ({ title, content: `${title}的正文` })
  const workspace = {
    project: { name: '结构重排后的故事' },
    documents: {
      'scene-a': document('甲场'), 'episode-a': document('甲集'), orphan: document('待归类素材'),
      characters: document('人物'), 'scene-b': document('乙场'), 'episode-b': document('乙集'),
      idea: document('灵感'), outline: document('全剧大纲'), brief: document('简报'), world: document('世界'),
      'episode-c': document('丙集'), 'scene-c': document('丙场'),
    },
    tabContents: { 'scene-b': { outline: '乙场自己的大纲' } },
    structure: {
      acts: [{ id: 'act-b', episodeIds: ['episode-b', 'episode-a'] }, { id: 'act-a', episodeIds: ['episode-c', 'episode-b'] }],
      episodes: {
        'episode-a': { sceneIds: ['scene-a'] },
        'episode-b': { sceneIds: ['scene-c', 'scene-b'] },
        'episode-c': { sceneIds: [] },
      },
    },
  }
  const expected = ['idea', 'brief', 'world', 'characters', 'outline', 'episode-b', 'scene-c', 'scene-b', 'episode-a', 'scene-a', 'episode-c', 'orphan']
  assert.deepEqual(orderedDocuments(workspace).map(([id]) => id), expected)
  const markdown = projectMarkdown(workspace)
  assert.deepEqual([...markdown.matchAll(/^## (.+)$/gm)].map(match => match[1]), expected.map(id => workspace.documents[id].title))
  assert.ok(markdown.includes('### 大纲\n\n乙场自己的大纲'))
  assert.equal((markdown.match(/乙集的正文/g) || []).length, 1, 'duplicate structural references cannot duplicate exported chapters')
  assert.ok(markdown.endsWith('待归类素材的正文'), 'recoverable orphan documents cannot disappear from export')
})

test('跳过超大或不支持文件后继续补齐 80 个可导入文件，并列出每项原因', () => {
  const small = Array.from({ length: 83 }, (_, index) => ({ name: `${index}.MD`, webkitRelativePath: `资料/${index}.MD`, size: 100 }))
  const files = [{ name: '过大.md', size: 1024 * 1024 + 1 }, { name: '图片.png', size: 20 }, ...small]
  const plan = planKnowledgeFiles(files)
  assert.equal(plan.selectedCount, 85)
  assert.equal(plan.accepted.length, 80)
  assert.deepEqual(plan.accepted, small.slice(0, 80))
  assert.equal(plan.totalBytes, 8000)
  assert.deepEqual(plan.skipped, [
    { path: '过大.md', reason: '超过单文件 1 MiB' },
    { path: '图片.png', reason: '格式不支持' },
    ...small.slice(80).map(file => ({ path: file.webkitRelativePath, reason: '超过 80 个文件' })),
  ])
})

test('达到总字节预算的文件被跳过后，仍可收录后面的较小文件', () => {
  const MiB = 1024 * 1024
  const files = [
    { name: '1.md', size: MiB }, { name: '2.md', size: MiB }, { name: '3.txt', size: MiB },
    { name: '4.markdown', size: MiB * .75 }, { name: '超预算.md', size: MiB * .5 }, { name: '小文件.md', size: MiB * .125 },
  ]
  const plan = planKnowledgeFiles(files)
  assert.deepEqual(plan.accepted, [files[0], files[1], files[2], files[3], files[5]])
  assert.deepEqual(plan.skipped, [{ path: '超预算.md', reason: '超过本次 4 MiB' }])
  assert.equal(plan.totalBytes, MiB * 3.875)
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Execute the production function itself, without booting unrelated DOM or provider code.
function productionFunction(name) {
  const declaration = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(appSource)
  assert.ok(declaration, `production function ${name} must exist`)
  const next = /^(?:async )?function \w+\(/m.exec(appSource.slice(declaration.index + declaration[0].length))
  return appSource.slice(declaration.index, next ? declaration.index + declaration[0].length + next.index : undefined)
}

function candidateHarness() {
  const save = deferred()
  const content = { value: '采纳前正文' }
  const candidate = 'AI 新段落'
  const history = { undo: [{ before: '更早正文', after: content.value }], redo: [{ before: content.value, after: '曾撤销的正文' }] }
  const controls = Array.from({ length: 5 }, () => ({ disabled: false }))
  const busyAttributes = new Map()
  const calls = { persist: [], discarded: 0, statuses: [], toasts: [] }
  const versionLabel = { textContent: 'v1' }
  const state = {
    candidateApplying: false, isGenerating: false, currentDocId: 'scene-1', activeTab: 'script',
    generationContext: { documentId: 'scene-1', tabName: 'script', baseContent: content.value, knowledgeChunks: [] },
    versions: { 'scene-1': [{ version: 1, tabName: 'script', content: '更早正文' }] },
    versionCounters: { 'scene-1': 1 }, selectedVersionByDocument: { 'scene-1': 1 }, tabContents: { 'scene-1': {} },
  }
  const elements = {
    candidateContent: { textContent: candidate },
    scriptEditor: { value: content.value, selectionStart: content.value.length, selectionEnd: content.value.length },
    candidateActions: { setAttribute: (key, value) => busyAttributes.set(key, value), removeAttribute: key => busyAttributes.delete(key) },
    generationError: { hidden: true, textContent: '' },
  }
  const sandbox = {
    state, elements, structuredClone, activeProjectId: 'project-1', editRevision: 4, unsavedEdits: false,
    document: { querySelectorAll: () => controls, querySelector: () => versionLabel },
    getContentAt: () => content.value,
    setContentAt: (_documentId, _tabName, text) => { content.value = text },
    getEditHistory: () => history,
    addVersion: (id, text, source, options = {}) => {
      const version = ++state.versionCounters[id]
      state.versions[id].push({ version, content: text, source, ...options })
      state.selectedVersionByDocument[id] = version
      return version
    },
    persistWorkspace: () => { calls.persist.push(content.value); return save.promise },
    formatVersionHistory: () => state.versions['scene-1'].map(entry => entry.content).join('\n'),
    updateDocumentView: () => { elements.scriptEditor.value = content.value },
    discardCandidate: () => { calls.discarded++; elements.candidateContent.textContent = ''; state.generationContext = null },
    updateEditorMetrics: () => {}, renderProjectIdentity: () => {}, renderCandidateDrafts: () => {},
    setSaveStatus: status => calls.statuses.push(status),
    showToast: (message, options) => calls.toasts.push({ message, options }),
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(`${productionFunction('applyCandidate')}\nglobalThis.applyUnderTest = applyCandidate`, context)
  return { context, save, content, candidate, state, elements, calls, controls, busyAttributes, history, versionLabel }
}

test('重复点击 AI 采纳只提交一次；完成后同一候选不能再次应用', async () => {
  const harness = candidateHarness()
  const original = harness.content.value
  const first = harness.context.applyUnderTest('append')
  const second = harness.context.applyUnderTest('replace')
  await second
  assert.deepEqual(harness.calls.persist, [`${original}\n\n${harness.candidate}`])
  assert.equal(harness.state.candidateApplying, true)
  assert.equal(harness.busyAttributes.get('aria-busy'), 'true')
  assert.ok(harness.controls.every(button => button.disabled))
  harness.save.resolve(true)
  await first
  assert.equal(harness.content.value, `${original}\n\n${harness.candidate}`)
  assert.equal(harness.calls.discarded, 1)
  assert.equal(harness.state.versions['scene-1'].filter(entry => entry.content.includes(harness.candidate)).length, 1)
  assert.equal(harness.state.candidateApplying, false)
  assert.equal(harness.busyAttributes.has('aria-busy'), false)
  assert.ok(harness.controls.every(button => !button.disabled))
  await harness.context.applyUnderTest('append')
  assert.equal(harness.calls.persist.length, 1)
})

test('采纳保存失败且没有继续输入时，恢复正文、撤销栈和版本，保留候选重试', async () => {
  const harness = candidateHarness()
  const original = harness.content.value
  const versions = structuredClone(harness.state.versions['scene-1'])
  const history = structuredClone(harness.history)
  const pending = harness.context.applyUnderTest('replace')
  assert.equal(harness.content.value, harness.candidate)
  harness.save.resolve(false)
  await pending
  assert.equal(harness.content.value, original)
  assert.equal(harness.elements.scriptEditor.value, original)
  assert.deepEqual(harness.history, history)
  assert.deepEqual(harness.state.versions['scene-1'], versions)
  assert.equal(harness.state.versionCounters['scene-1'], 1)
  assert.equal(harness.state.selectedVersionByDocument['scene-1'], 1)
  assert.equal(harness.elements.candidateContent.textContent, harness.candidate)
  assert.ok(harness.state.generationContext)
  assert.equal(harness.calls.discarded, 0)
  assert.equal(harness.elements.generationError.hidden, false)
  assert.ok(harness.elements.generationError.textContent.includes('保存失败'))
  assert.deepEqual(harness.calls.statuses, ['error'])
  assert.equal(harness.state.candidateApplying, false)
  assert.ok(harness.controls.every(button => !button.disabled))
})

test('采纳保存失败时保留等待期间的新输入，明确维持未保存状态', async () => {
  const harness = candidateHarness()
  const pending = harness.context.applyUnderTest('append')
  const userEdit = `${harness.content.value}\n保存等待期间继续写下的新句子。`
  harness.context.editRevision += 1
  harness.content.value = userEdit
  harness.elements.scriptEditor.value = userEdit
  harness.save.resolve(false)
  await pending
  assert.equal(harness.content.value, userEdit)
  assert.equal(harness.elements.scriptEditor.value, userEdit)
  assert.equal(harness.context.unsavedEdits, true)
  assert.deepEqual(harness.calls.statuses, ['error'])
  assert.equal(harness.calls.discarded, 1, 'invalidate the already-applied candidate so it cannot be applied again')
  assert.equal(harness.state.generationContext, null)
  assert.equal(harness.state.candidateApplying, false)
  assert.ok(harness.calls.toasts.some(({ message }) => message.includes('后续输入') && message.includes('保留')))
  assert.ok(harness.controls.every(button => !button.disabled))
})

function nativeCloseHarness({ inspirationDirty = true } = {}) {
  const inspirationSave = deferred()
  const projectSave = deferred()
  let dirty = inspirationDirty
  let callback
  const events = []
  const appWindow = {
    onCloseRequested: handler => { callback = handler; return Promise.resolve() },
    destroy: async () => { events.push('destroy') },
  }
  const context = vm.createContext({
    isDesktopRuntime: true, projectTransition: false, state: { candidateApplying: false, knowledgeBusy: false },
    activeProjectId: 'p1', listProjects: () => [{ id: 'p1' }], listArchivedProjects: () => [],
    requestAssetDraftDecision: async () => 'cancel',
    mediaWorkbench: { hasPendingWork: () => false, pendingAssetDraft: () => null },
    window: { __TAURI__: { window: { getCurrentWindow: () => appWindow } } },
    inspirationUI: {
      dirty: () => dirty,
      save: async () => { events.push('inspiration-save'); const saved = await inspirationSave.promise; if (saved) dirty = false; return saved },
    },
    saveImmediately: () => { events.push('project-save'); return projectSave.promise },
    unsavedEdits: false, pendingSaves: 0,
    switchView: name => events.push(`view:${name}`),
    showToast: text => events.push(`toast:${text}`), readableError: error => String(error),
  })
  const start = appSource.indexOf('if (isDesktopRuntime && window.__TAURI__.window?.getCurrentWindow) {')
  const end = appSource.indexOf("document.querySelectorAll('svg.icon')", start)
  assert.ok(start >= 0 && end > start, 'the actual native-close registration must be extractable')
  vm.runInContext(`${productionFunction('resolveAssetDraftsBeforeClose')}\n${appSource.slice(start, end)}`, context)
  assert.equal(typeof callback, 'function')
  return { inspirationSave, projectSave, events, context, close: () => callback({ preventDefault: () => events.push('prevent-close') }), setDirty: value => { dirty = value } }
}

test('原生关闭先等待灵感保存，再等待项目保存，两者成功才销毁窗口', async () => {
  const harness = nativeCloseHarness()
  let finished = false
  const pending = harness.close().then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(harness.events, ['prevent-close', 'inspiration-save'])
  assert.equal(finished, false)
  harness.inspirationSave.resolve(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(harness.events, ['prevent-close', 'inspiration-save', 'project-save'])
  assert.equal(finished, false)
  harness.projectSave.resolve(true)
  await pending
  assert.deepEqual(harness.events, ['prevent-close', 'inspiration-save', 'project-save', 'destroy'])
})

test('原生关闭遇到灵感保存失败，留在灵感页且不保存项目或销毁窗口', async () => {
  const harness = nativeCloseHarness()
  const pending = harness.close()
  harness.inspirationSave.resolve(false)
  await pending
  assert.ok(harness.events.includes('view:inspirations'))
  assert.ok(harness.events.some(event => event.startsWith('toast:')))
  assert.ok(!harness.events.includes('project-save'))
  assert.ok(!harness.events.includes('destroy'))
})

test('原生关闭遇到项目保存失败也保留窗口', async () => {
  const harness = nativeCloseHarness({ inspirationDirty: false })
  const pending = harness.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(harness.events, ['prevent-close', 'project-save'])
  harness.projectSave.resolve(false)
  await pending
  assert.ok(!harness.events.includes('destroy'))
})

test('关闭保存期间再次出现灵感修改时，不销毁窗口', async () => {
  const harness = nativeCloseHarness({ inspirationDirty: false })
  const pending = harness.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(harness.events.includes('project-save'))
  harness.setDirty(true)
  harness.projectSave.resolve(true)
  await pending
  assert.ok(!harness.events.includes('destroy'))
})

test('项目正在切换或恢复时，原生关闭不能插入保存或销毁窗口', async () => {
  const harness = nativeCloseHarness({ inspirationDirty: false })
  harness.context.projectTransition = true
  await harness.close()
  assert.ok(harness.events.some(event => event.startsWith('toast:')))
  assert.ok(!harness.events.includes('project-save'))
  assert.ok(!harness.events.includes('destroy'))
})


test('原生关闭定位未保存素材，保存期间新出现草稿也不销毁窗口', async () => {
  const h = nativeCloseHarness({ inspirationDirty: false })
  h.context.activeProjectId = 'p1'
  h.context.mediaWorkbench = { hasPendingWork: () => false, pendingAssetDraft: () => ({ projectId: 'p1', assetId: 'a1' }), refresh: async () => {}, showAssetDraft: id => h.events.push(`asset:${id}`) }
  await h.close()
  assert.ok(h.events.includes('asset:a1'))
  assert.ok(!h.events.includes('destroy'))
  assert.ok(!h.events.includes('project-save'))
  h.context.mediaWorkbench.pendingAssetDraft = () => null
  const closing = h.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(h.events.includes('project-save'))
  h.context.mediaWorkbench.pendingAssetDraft = () => ({ projectId: 'p1', assetId: 'a1' })
  h.projectSave.resolve(true); await closing
  assert.ok(!h.events.includes('destroy'))
})
