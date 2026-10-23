import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { prepareGeneration, projectMarkdown, prepareStructureChange, sceneNavigation } from '../src/creation-workflow.js'
import { validateWorkspace } from '../src/project-store.js'
import { upsertCandidateDraft, validateCandidateDrafts } from '../src/candidate-drafts.js'
import { renderWritingPreview } from '../src/writing-preview.js'

const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source)
  const tail = source.slice(match.index)
  return tail.slice(0, /^\}$/m.exec(tail).index + 1)
}
const doc = (title, content = '') => ({ title, content, meta: [], kicker: '1-1 · 夜', labels: ['正文', '大纲', '参考', '历史'] })
function workspace() {
  return {
    schemaVersion: 2, project: { name: '结构事务验证', type: '短剧' }, currentDocId: 'scene-b', activeTab: 'script',
    documents: { outline: doc('全剧大纲'), ep: doc('第一集'), 'scene-a': doc('第一场', '上场结尾'), 'scene-b': doc('第二场', '当前手稿') },
    structure: { acts: [{ id: 'act', title: '第一幕', episodeIds: ['ep'] }], episodes: { ep: { sceneIds: ['scene-a', 'scene-b'] } } },
    tabContents: Object.fromEntries(['outline', 'ep', 'scene-a', 'scene-b'].map(id => [id, { outline: `大纲-${id}`, references: `笔记-${id}`, history: '' }])),
    versions: {}, versionCounters: {}, candidateDrafts: []
  }
}
function gate() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function transactionHarness() {
  const before = workspace(), state = { ...structuredClone(before), knowledge: { index: null } }, saves = [], toasts = [], disk = gate(), entered = gate()
  const sandbox = {
    state, activeProjectId: 'project-a', projectTransition: false, mediaWorkbench: null, editRevision: 0, unsavedEdits: false,
    prepareStructureChange, validateWorkspace: next => validateWorkspace(structuredClone(next)),
    saveImmediately: async () => true, workspaceSnapshot: () => structuredClone(Object.fromEntries(Object.keys(before).map(key => [key, state[key]]))),
    saveProject: async (id, snapshot) => { saves.push(structuredClone(snapshot)); entered.resolve(); await disk.promise },
    setProjectTransition: value => { sandbox.projectTransition = value }, setSaveStatus() {}, showToast: text => toasts.push(text), readableError: error => error.message,
    abandonCandidateOnContextChange() {}, renderProjectIdentity() {}, updateDocumentView() {}
  }
  vm.createContext(sandbox); vm.runInContext(productionFunction('commitStructureChange'), sandbox)
  return { before, state, sandbox, saves, toasts, disk, entered }
}

test('结构创建/移动/复制/删除仅修改独立快照，恢复保留手稿与历史', () => {
  const original = workspace(), before = structuredClone(original)
  for (const action of [
    { type: 'create', kind: 'scene', documentId: 'new-scene', document: doc('新场'), parentId: 'ep', tabContents: { outline: '', references: '', history: '' } },
    { type: 'move', documentId: 'scene-b', direction: -1 },
    { type: 'duplicate', documentId: 'scene-b', newId: 'copy-b' },
    { type: 'delete', documentId: 'ep' }
  ]) {
    const result = prepareStructureChange(original, action)
    validateWorkspace(result.workspace)
    assert.deepEqual(original, before)
    if (action.type === 'delete') {
      assert.equal(result.workspace.documents['scene-b'], undefined)
      const restored = prepareStructureChange(result.workspace, { type: 'restore', documentId: 'ep', removed: result.result }).workspace
      assert.deepEqual(restored.documents['scene-b'].content, original.documents['scene-b'].content)
      assert.deepEqual(restored.tabContents, original.tabContents)
      assert.deepEqual(restored.structure, original.structure)
    }
  }
})

test('结构保存等待期间保持原内容并阻止重复操作；失败不更新内存也不报告成功', async () => {
  const h = transactionHarness()
  const pending = h.sandbox.commitStructureChange({ type: 'delete', documentId: 'ep' })
  await h.entered.promise
  assert.equal(h.saves.length, 1, JSON.stringify(h.toasts))
  assert.deepEqual(h.state.documents, h.before.documents)
  assert.equal(await h.sandbox.commitStructureChange({ type: 'move', documentId: 'scene-b', direction: -1 }), null)
  h.disk.reject(new Error('磁盘已满'))
  assert.equal(await pending, null)
  assert.deepEqual(h.state.documents, h.before.documents)
  assert.deepEqual(h.state.structure, h.before.structure)
  assert.equal(h.sandbox.projectTransition, false)
  assert.ok(h.toasts.at(-1).includes('原内容和结构已保留'))
  assert.equal(h.toasts.some(text => /已删除|已创建|已上移/.test(text)), false)
})

test('结构落盘成功后才切换新场，取消锁并更新保存状态', async () => {
  const h = transactionHarness()
  const pending = h.sandbox.commitStructureChange({ type: 'duplicate', documentId: 'scene-b', newId: 'copy-b' })
  await h.entered.promise
  assert.equal(h.state.documents['copy-b'], undefined)
  h.disk.resolve(); const result = await pending
  assert.equal(result.result, 'copy-b')
  assert.equal(h.state.currentDocId, 'copy-b')
  assert.equal(h.state.documents['copy-b'].content, '当前手稿')
  assert.equal(h.sandbox.projectTransition, false)
  assert.equal(h.state.storageFailed, false)
})

test('已有分场导航按幕集顺序，下一场直接进入而不触发新建', async () => {
  const data = workspace(), opened = [], created = []
  const sandbox = { state: { ...data, workflow: { preset: 'script' }, currentDocId: 'scene-a' }, sceneNavigation,
    getDocumentKind: () => 'scene', selectDocument: async id => { opened.push(id); return true }, openNewContentDialog: options => created.push(options), getParentEpisodeId: () => 'ep' }
  vm.createContext(sandbox); vm.runInContext(productionFunction('advanceStage'), sandbox)
  await sandbox.advanceStage()
  assert.deepEqual(opened, ['scene-b']); assert.deepEqual(created, [])
  sandbox.state.currentDocId = 'scene-b'; await sandbox.advanceStage()
  assert.equal(created[0].type, 'scene'); assert.equal(sceneNavigation('scene-b', data.structure).previous, 'scene-a')
})

test('长文续写优先结尾，选区仍在预算内，常规改写继续读取当前正文', () => {
  const data = workspace(); data.documents['scene-b'].content = '起点'.repeat(6000) + '不可遗漏的最后一句'
  const args = { ...data, documentId: 'scene-b', tabName: 'script', prompt: '继续结尾', creativeAction: 'continuation', selectedText: '指定修改段落'.repeat(1000) }
  const continued = prepareGeneration(args)
  assert.ok(continued.messages[1].content.includes('不可遗漏的最后一句'))
  assert.ok(continued.summary.find(item => item.key === 'current').label.includes('结尾'))
  assert.ok(continued.messages.reduce((sum, item) => sum + item.content.length, 0) <= 24000)
  assert.equal(prepareGeneration({ ...args, creativeAction: '', selectedText: '' }).messages[1].content.includes('不可遗漏的最后一句'), false)
})

test('继续候选冻结已选回答，普通新请求不混入，存储与重试保留归属', () => {
  const data = workspace(), followup = { candidateId: 'candidate-old', projectId: 'project-a', documentId: 'scene-b', tabName: 'script', purpose: 'text', prompt: '上一轮要求', text: '选中的候选结尾' }
  const args = { ...data, documentId: 'scene-b', tabName: 'script', prompt: '结尾改短一点', followup }
  const next = prepareGeneration(args)
  assert.ok(next.messages[1].content.includes('选中的候选结尾'))
  followup.text = '已被另一个候选覆盖'
  assert.equal(next.followup.text, '选中的候选结尾')
  assert.equal(prepareGeneration({ ...args, followup: null }).messages[1].content.includes('选中的候选结尾'), false)
  const draft = { id: 'candidate-new', documentId: 'scene-b', tabName: 'script', prompt: args.prompt, text: '新结果', createdAt: new Date().toISOString(), status: 'complete', context: { projectId: 'project-a', documentId: 'scene-b', tabName: 'script', purpose: 'text', title: '第二场', baseContent: '当前手稿', messages: next.messages, followup: next.followup, creativeAction: 'continuation' } }
  const stored = JSON.parse(JSON.stringify(upsertCandidateDraft([], draft)))
  validateCandidateDrafts(stored)
  assert.equal(stored[0].context.followup.text, '选中的候选结尾')
  const corrupted = structuredClone(stored); corrupted[0].context.followup.documentId = 'scene-a'
  assert.throws(() => validateCandidateDrafts(corrupted), /归属/)
})

test('参考笔记可按请求关闭，Markdown按交付选项包含大纲和笔记', () => {
  const data = workspace(), args = { ...data, documentId: 'scene-b', tabName: 'script', prompt: '润色' }
  assert.ok(prepareGeneration(args).messages[1].content.includes('笔记-scene-b'))
  assert.equal(prepareGeneration({ ...args, includeReferenceNotes: false }).messages[1].content.includes('笔记-scene-b'), false)
  const minimal = projectMarkdown(data, { includeOutline: false, includeReferences: false })
  assert.equal(minimal.includes('大纲-scene-b'), false); assert.equal(minimal.includes('笔记-scene-b'), false)
  assert.ok(projectMarkdown(data, { includeReferences: true }).includes('笔记-scene-b'))
})

class Node {
  constructor(tag = '#text', text = '') { this.tagName = tag; this.children = []; this.content = text }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  set textContent(value) { this.content = value; this.children = [] }
  get textContent() { return this.content + this.children.map(child => typeof child === 'string' ? child : child.textContent).join('') }
}
const dom = { createElement: tag => new Node(tag), createTextNode: text => new Node('#text', text), createDocumentFragment: () => new Node('#fragment') }
const descendants = node => [node, ...node.children.flatMap(child => typeof child === 'string' ? [] : descendants(child))]

test('阅读预览支持标题、强调、表格、列表及代码，HTML与脚本链接不可执行，也不加载图片', () => {
  const host = new Node('article')
  renderWritingPreview(host, '# 标题\n\n**粗体** 与 *斜体*\n\n| 人物 | 动作 |\n| --- | --- |\n| 甲 | 走入 |\n\n- 第一步\n\n<script>alert(1)</script>\n\n[危险](javascript:alert) ![外图](https://example.test/track.png) [资料](https://example.test/doc)\n\n```js\n<script>code</script>\n```', dom)
  const all = descendants(host), tags = all.map(node => node.tagName)
  for (const tag of ['h1', 'strong', 'em', 'table', 'li', 'pre', 'code']) assert.ok(tags.includes(tag), tag)
  assert.equal(tags.includes('script'), false); assert.equal(tags.includes('img'), false)
  assert.equal(all.filter(node => node.tagName === 'a').length, 1)
  assert.equal(all.find(node => node.tagName === 'a').rel, 'noopener noreferrer')
  assert.ok(host.textContent.includes('<script>alert(1)</script>'))
  assert.ok(host.textContent.includes('[危险](javascript:alert)'))
})

test('实际请求准备拒绝跨文档追问，显式新请求解除绑定，重试仍使用原快照', () => {
  const data = workspace(), followup = { candidateId: 'candidate-old', projectId: 'project-a', documentId: 'scene-b', tabName: 'script', purpose: 'text', prompt: '保留悬念', text: '这一版候选' }
  const state = { ...data, contextReferenceKeys: [], excludedContextKeys: new Map(), includeCurrentContext: true, includeReferenceNotes: true, followupContext: followup }
  const sandbox = { state, activeProjectId: 'project-a', prepareGeneration, GENERATION_CHARACTER_LIMIT: 24000, contextObjects: () => [], getSelectedKnowledgeChunks: () => [], document: { querySelectorAll: () => [{ getAttribute: () => 'true' }, { getAttribute: () => 'true' }] } }
  vm.createContext(sandbox); vm.runInContext(productionFunction('generationDraft'), sandbox)
  assert.ok(sandbox.generationDraft('改短', 'text').messages[1].content.includes('这一版候选'))
  assert.equal(sandbox.generationDraft('新请求', 'text', '', null).followup, null)
  state.currentDocId = 'scene-a'
  assert.throws(() => sandbox.generationDraft('追问', 'text'), /其他文档/)
  state.currentDocId = 'scene-b'; state.followupContext = null
  assert.equal(sandbox.generationDraft('重试', 'text', '', followup).followup.text, '这一版候选')
})

test('制作进度打开文稿走安全selectDocument且默认离开分镜视图', async () => {
  assert.match(productionFunction('initializeProjectMediaWorkbench'), /openDocument: async documentId => selectDocument\(documentId\)/)
  const views = [], state = { documents: { 'scene-a': doc('场一') }, currentDocId: 'scene-a', activeTab: 'script', currentView: 'storyboard' }
  const sandbox = { state, activeProjectId: 'project-a', projectTransition: false, mediaWorkbench: null, saveImmediately: async () => true, abandonCandidateOnContextChange() {}, switchView: view => views.push(view), updateDocumentView() {}, persistWorkspace: async () => true, closeDrawers() {} }
  vm.createContext(sandbox); vm.runInContext(productionFunction('selectDocument'), sandbox)
  assert.equal(await sandbox.selectDocument('scene-a'), true)
  assert.deepEqual(views, ['workspace'])
})
