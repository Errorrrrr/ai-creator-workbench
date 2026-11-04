import test from 'node:test'
import assert from 'node:assert/strict'
import { initializeEpisodeScenesUI } from '../src/episode-scenes-ui.js'
import { prepareEpisodeScenes, prepareAssignShots } from '../src/episode-scenes.js'
import { scriptLines } from '../src/scene-planning.js'

class Node {
  constructor(tag, text = '') { this.tagName = tag; this.children = []; this.listeners = {}; this.attrs = {}; this._text = text; this.value = ''; this.open = false; this.disabled = false; this.isConnected = true }
  set textContent(value) { this._text = String(value); this.children = [] }
  get textContent() { return this._text + this.children.map(child => child.textContent || '').join('') }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this._text = ''; this.children = children }
  setAttribute(name, value) { this.attrs[name] = value }
  removeAttribute(name) { delete this.attrs[name] }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener) }
  async emit(name) { for (const listener of this.listeners[name] || []) await listener({ preventDefault() {}, stopPropagation() {} }) }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]) }
  querySelectorAll(selector) { const tags = selector.split(',').map(tag => tag.trim()); return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => tags.includes('*') || tags.includes(child.tagName)) }
  focus() {}
  showModal() { this.open = true }
  close() { this.open = false }
}

function fixture({ noEpisode = false } = {}) {
  const previous = { document: globalThis.document, window: globalThis.window, Option: globalThis.Option }
  const body = new Node('body')
  globalThis.document = { body, activeElement: null, createElement: tag => new Node(tag) }
  globalThis.Option = class extends Node { constructor(text, value) { super('option', text); this.value = value } }
  const controls = { fail: false, gate: null, confirm: true, requestAccepted: true }
  globalThis.window = { confirm: () => controls.confirm }
  const content = '必须保留的前言\r\n## S01 | 咖啡馆 | 日\r\n甲：走吧。\n## S02 | 街道 | 夜\r乙：等等。'
  const data = {
    projectId: 'project', currentDocId: noEpisode ? 'draft' : 'e1',
    documents: noEpisode ? { draft: { title: '导入剧本', content } } : {
      e1: { title: '第一集', content }, existing: { title: '已有分场', content: '已写好的原场景。' },
      e2: { title: '第二集', content: '第二集正文保留。' }, target: { title: '目标分场', content: '目标分场正文保留。' }
    },
    structure: noEpisode ? { acts: [], episodes: {} } : { acts: [{ id: 'act-1', title: '第一幕', episodeIds: ['e1', 'e2'] }], episodes: { e1: { sceneIds: ['existing'] }, e2: { sceneIds: ['target'] } } },
    tabContents: {}, versions: {}, versionCounters: {},
    storyboard: { revision: 7, shots: noEpisode ? [] : [
      { id: 'legacy-a', title: '旧镜头甲', sourceDocumentId: 'e1', sourceFingerprint: 'old-source', references: [{ versionId: 'fixed-reference', role: 'reference' }], selectedImageVersionId: 'selected-image', selectedVideoVersionId: 'selected-video', reviewedVideoVersionId: 'reviewed-video' },
      { id: 'legacy-b', title: '旧镜头乙', sourceDocumentId: 'e1', sourceFingerprint: 'old-source-b', references: [], selectedImageVersionId: 'image-b', selectedVideoVersionId: 'video-b' }
    ] }
  }
  const calls = { commits: [], notices: [], opened: [], requests: [], created: [] }
  let sequence = 0
  const ui = initializeEpisodeScenesUI({
    getContext: () => ({ ...data }), notify: text => calls.notices.push(text),
    commit: async action => {
      calls.commits.push(structuredClone(action))
      if (controls.gate) await controls.gate
      if (controls.fail) throw new Error('测试：磁盘不可写')
      const result = action.type === 'scenes'
        ? prepareEpisodeScenes(data, { ...action, idFactory: () => `new-scene-${++sequence}` })
        : prepareAssignShots(data, action)
      Object.assign(data, result.workspace)
      return result
    },
    openScene: async (id, options) => calls.opened.push({ id, options }),
    requestPlan: async snapshot => { calls.requests.push(structuredClone(snapshot)); return controls.requestAccepted },
    createEpisode: async () => {
      const id = `created-episode-${calls.created.length + 1}`
      data.documents = { ...data.documents, [id]: { title: '新建分集', content: '' } }
      data.structure = { acts: [{ id: 'act-1', title: '第一幕', episodeIds: [id] }], episodes: { [id]: { sceneIds: [] } } }
      calls.created.push(id); return id
    }
  })
  const dialog = body.all('dialog')[0]
  const input = label => [...dialog.all('input'), ...dialog.all('textarea'), ...dialog.all('select')].find(item => item.attrs['aria-label'] === label)
  const findButton = label => dialog.all('button').find(item => item.textContent === label)
  const click = async label => { const item = findButton(label); assert.ok(item, label); await item.emit('click') }
  const edit = async (label, value, event = 'input') => { const item = input(label); assert.ok(item, label); item.value = value; await item.emit(event) }
  const cleanup = () => { globalThis.document = previous.document; globalThis.window = previous.window; globalThis.Option = previous.Option }
  const candidate = (title = '候选分场') => JSON.stringify({ scenes: [{ title, startLine: 1, endLine: scriptLines(content).length }] })
  const candidateContext = () => ({ projectId: data.projectId, documentId: 'e1', baseContent: content, sourceDocumentIds: ['existing'] })
  return { ui, dialog, data, content, controls, calls, input, findButton, click, edit, cleanup, candidate, candidateContext }
}

test('分场保存失败保持弹窗与编辑草稿，重试保存后才关闭并进入新分场', async () => {
  const h = fixture()
  try {
    await h.ui.open({ episodeId: 'e1' })
    const before = structuredClone(h.data), originalCount = h.data.structure.episodes.e1.sceneIds.length
    await h.edit('第 1 场标题', '用户确认的第一场')
    await h.edit('第 1 场剧本', '用户保留的分场草稿。')
    h.controls.fail = true; await h.click('确认追加分场')
    assert.equal(h.dialog.open, true)
    assert.equal(h.ui.hasPendingWork(), true)
    assert.equal(h.input('第 1 场标题').value, '用户确认的第一场')
    assert.equal(h.input('第 1 场剧本').value, '用户保留的分场草稿。')
    assert.match(h.dialog.textContent, /磁盘不可写/)
    assert.deepEqual(h.data, before)
    assert.equal(h.calls.opened.length, 0)
    assert.ok(h.calls.notices.every(text => !/已追加/.test(text)))
    h.controls.fail = false; await h.click('确认追加分场')
    assert.equal(h.dialog.open, false)
    assert.equal(h.ui.hasPendingWork(), false)
    assert.equal(h.data.structure.episodes.e1.sceneIds.length, originalCount + 2)
    assert.equal(h.data.documents['new-scene-1'].content, '用户保留的分场草稿。')
    assert.equal(h.data.documents.e1.content, h.content)
    assert.deepEqual(h.data.storyboard, before.storyboard)
    assert.deepEqual(h.calls.opened, [{ id: 'new-scene-1', options: undefined }])
  } finally { h.cleanup() }
})

test('异步保存期间重复点击和迟到分场候选都不能覆盖正在保存的预览', async () => {
  const h = fixture()
  try {
    await h.ui.open({ episodeId: 'e1' })
    await h.edit('第 1 场标题', '正在保存的标题')
    let release
    h.controls.gate = new Promise(resolve => { release = resolve })
    const pending = h.click('确认追加分场'); await Promise.resolve()
    assert.equal(h.ui.hasPendingWork(), true)
    assert.equal(h.findButton('关闭').disabled, true)
    await h.click('确认追加分场')
    h.ui.receiveCandidate(h.candidate('迟到候选不覆盖'), h.candidateContext(), 'late-candidate')
    assert.equal(h.calls.commits.length, 1)
    assert.equal(h.input('第 1 场标题').value, '正在保存的标题')
    assert.match(h.calls.notices.at(-1), /候选已保存在待审稿.*保存完成后打开/)
    assert.equal(h.calls.commits[0].candidateId, null)
    release(); await pending
    assert.equal(h.data.documents['new-scene-1'].title, '正在保存的标题')
    assert.equal(h.dialog.open, false)
    assert.equal(h.calls.commits.length, 1)
  } finally { h.cleanup() }
})

test('归场必须明确目标与镜头选择，只移动勾选镜头且保留所有媒体引用', async () => {
  const h = fixture()
  try {
    const original = structuredClone(h.data)
    await h.ui.open({ episodeId: 'e1', shotIds: ['legacy-a', 'legacy-b'] })
    await h.click('确认归入分场')
    assert.equal(h.calls.commits.length, 0)
    assert.match(h.dialog.textContent, /请选择目标分场和至少一个镜头/)
    const checks = h.dialog.all('input').filter(item => item.type === 'checkbox')
    checks[1].checked = false; await checks[1].emit('change')
    await h.edit('目标分场', 'target', 'change')
    await h.click('确认归入分场')
    assert.equal(h.calls.commits.length, 1)
    assert.equal(h.calls.commits[0].targetSceneId, 'target')
    assert.deepEqual(h.calls.commits[0].shotIds, ['legacy-a'])
    assert.deepEqual(h.calls.commits[0].expectedSources, { 'legacy-a': 'e1', 'legacy-b': 'e1' })
    assert.deepEqual(h.data.storyboard.shots[0], { ...original.storyboard.shots[0], sourceDocumentId: 'target' })
    assert.deepEqual(h.data.storyboard.shots[1], original.storyboard.shots[1])
    assert.deepEqual(h.data.documents, original.documents)
    assert.equal(h.data.storyboard.revision, original.storyboard.revision + 1)
    assert.deepEqual(h.calls.opened, [{ id: 'target', options: { storyboard: true } }])
  } finally { h.cleanup() }
})

test('无分集的导入正文先创建分集，再预览原文分场并完整保留外部源文档', async () => {
  const h = fixture({ noEpisode: true })
  try {
    const source = structuredClone(h.data.documents.draft)
    await h.ui.open({ sourceId: 'draft' })
    assert.deepEqual(h.calls.created, ['created-episode-1'])
    assert.equal(h.dialog.open, true)
    assert.equal(h.input('分场所属集').value, 'created-episode-1')
    assert.equal(h.findButton('AI 规划分场').disabled, true, '外部原文不能误用空白集正文发起规划')
    assert.deepEqual(h.data.documents.draft, source)
    assert.equal(h.calls.commits.length, 0, '建立分集后仍需确认场次')
    await h.click('确认追加分场')
    const action = h.calls.commits[0]
    assert.equal(action.sourceId, 'draft')
    assert.equal(action.sourceContent, source.content)
    assert.equal(action.episodeId, 'created-episode-1')
    assert.equal(action.expectedContent, '')
    assert.deepEqual(action.expectedSceneIds, [])
    assert.deepEqual(h.data.documents.draft, source)
    assert.equal(h.data.documents['created-episode-1'].content, '')
    const ids = h.data.structure.episodes['created-episode-1'].sceneIds
    assert.equal(ids.map(id => h.data.documents[id].content).join(''), source.content)
  } finally { h.cleanup() }
})

test('保存的分场候选恢复生成时的场次快照，新增过分场后不能按当前快照重复追加', async () => {
  const h = fixture()
  try {
    const context = h.candidateContext(), text = h.candidate('来自保存待审稿的场次')
    h.data.documents.later = { title: '生成后新增的场次', content: '另一个已保存场次。' }
    h.data.structure.episodes.e1.sceneIds.push('later')
    const before = structuredClone(h.data)
    h.ui.receiveCandidate(text, context, 'saved-scene-plan')
    assert.equal(h.dialog.open, true)
    assert.equal(h.input('第 1 场标题').value, '来自保存待审稿的场次')
    assert.equal(h.input('第 1 场剧本').value, context.baseContent)
    await h.click('确认追加分场')
    const action = h.calls.commits[0]
    assert.equal(action.candidateId, 'saved-scene-plan')
    assert.deepEqual(action.expectedSceneIds, ['existing'], '使用生成时快照，不能偷换为现在的场次列表')
    assert.equal(action.expectedContent, context.baseContent)
    assert.match(h.dialog.textContent, /本集分场已变化/)
    assert.equal(h.dialog.open, true)
    assert.equal(h.input('第 1 场标题').value, '来自保存待审稿的场次')
    assert.deepEqual(h.data, before)
    assert.equal(h.calls.opened.length, 0)
  } finally { h.cleanup() }
})
