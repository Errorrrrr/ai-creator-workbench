import test from 'node:test'
import assert from 'node:assert/strict'
import { initializeSceneContinuityUI, buildSceneVideoPrompt } from '../src/scene-continuity-ui.js'
import { emptySceneContinuity, sceneContentFingerprint } from '../src/scene-continuity.js'

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.value = ''; this._text = ''; this.open = false; this.disabled = false; this.classList = { toggle() {} } }
  set textContent(value) { this._text = value; this.children = [] }
  get textContent() { return this._text + this.children.map(child => child.textContent || '').join('') }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this._text = ''; this.children = children }
  setAttribute(name, value) { this.attrs[name] = value }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener) }
  async emit(name) { for (const listener of this.listeners[name] || []) await listener({ preventDefault() {} }) }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]) }
  focus() {}
  showModal() { this.open = true }
  close() { this.open = false }
}

function fixture() {
  const previous = { document: globalThis.document, window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') }
  const body = new Node('body'), clipboard = []
  globalThis.document = { body, createElement: tag => new Node(tag) }
  const controls = { confirm: true, fail: false, gate: null }
  globalThis.window = { confirm: () => controls.confirm }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { clipboard.push(text) } } } })
  const prop = { id: 'raft', kind: 'prop', name: '木筏', aliases: [], description: '救生木筏', traits: '平整木板筏面，两个油桶固定在底部', sourceDocumentIds: ['s1', 's2'], defaultStateId: 'whole', states: [
    { id: 'whole', name: '完整', description: '木板完整', sourceDocumentIds: ['s1'], basedOnStateId: '', referenceVersionId: '', referenceFingerprint: '' },
    { id: 'broken', name: '破损', description: '右侧木板破损', sourceDocumentIds: ['s2'], basedOnStateId: 'whole', referenceVersionId: '', referenceFingerprint: '' },
  ] }
  const data = {
    projectId: 'project', documentId: 's2',
    documents: { e1: { title: '第一集', content: '' }, s1: { title: '上一场', content: '人物停在木筏尾部。', sceneContinuity: { ...emptySceneContinuity(), exitState: '木筏完整，背包在尾部。', exitBindings: [{ entityId: 'raft', stateId: 'whole' }] } }, s2: { title: '当前场', content: '人物走向木筏头部。' } },
    structure: { acts: [{ episodeIds: ['e1'] }], episodes: { e1: { sceneIds: ['s1', 's2'] } } },
    storyboard: { revision: 1, shots: [], continuity: { version: 1, style: '写实电影', entities: [prop] } },
  }
  const calls = { saves: [], notices: [], clipboard }
  const ui = initializeSceneContinuityUI({ getContext: () => data, notify: text => calls.notices.push(text), save: async (id, value, metadata) => {
    calls.saves.push({ id, value: structuredClone(value), metadata })
    if (controls.gate) await controls.gate
    if (controls.fail) throw new Error('磁盘不可写')
    data.documents[id].sceneContinuity = structuredClone(value)
  } })
  ui.open()
  const dialog = body.all('dialog')[0]
  const input = label => dialog.all('textarea').find(node => node.attrs['aria-label'] === label)
  const select = label => dialog.all('select').find(node => node.attrs['aria-label'] === label)
  const findButton = label => dialog.all('button').find(node => node.textContent === label)
  const edit = async (label, value) => { const node = input(label); assert.ok(node, label); node.value = value; await node.emit('input') }
  const click = label => { const node = findButton(label); assert.ok(node, label); return node.emit('click') }
  const cleanup = () => {
    globalThis.document = previous.document; globalThis.window = previous.window
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator)
    else delete globalThis.navigator
  }
  return { data, controls, calls, ui, dialog, input, select, findButton, edit, click, cleanup }
}

test('保存分场状态绑定当前项目和正文指纹，不覆盖正文或其他分场', async () => {
  const h = fixture()
  try {
    const before = structuredClone(h.data.documents)
    await h.edit('进入状态', '沿用上一场背包位置。')
    await h.edit('本场变化', '人物从尾部走向头部。')
    await h.edit('结束状态', '人物停在头部。')
    await h.click('保存分场状态')
    assert.equal(h.calls.saves.length, 1)
    const { id, value, metadata } = h.calls.saves[0]
    assert.equal(id, 's2'); assert.equal(value.entryState, '沿用上一场背包位置。')
    assert.deepEqual(metadata, { projectId: 'project', contentFingerprint: sceneContentFingerprint(before.s2.content) })
    assert.equal(value.sourceFingerprint, metadata.contentFingerprint)
    assert.equal(h.data.documents.s2.content, before.s2.content)
    assert.deepEqual(h.data.documents.s1, before.s1)
    assert.equal(h.ui.hasPendingWork(), false)
    assert.match(h.dialog.textContent, /分场状态已保存/)
  } finally { h.cleanup() }
})

test('保存失败保留状态草稿，重试可恢复且不会误报已保存', async () => {
  const h = fixture()
  try {
    h.controls.fail = true
    await h.edit('结束状态', '背包仍在尾部。')
    await h.click('保存分场状态')
    assert.equal(h.data.documents.s2.sceneContinuity, undefined)
    assert.equal(h.ui.hasPendingWork(), true)
    assert.equal(h.input('结束状态').value, '背包仍在尾部。')
    assert.match(h.dialog.textContent, /保存失败：磁盘不可写/)
    h.controls.fail = false; await h.click('保存分场状态')
    assert.equal(h.data.documents.s2.sceneContinuity.exitState, '背包仍在尾部。')
  } finally { h.cleanup() }
})

test('保存期间重复点击只写一次，项目或正文切换后不能误存旧草稿', async () => {
  const h = fixture()
  try {
    await h.edit('进入状态', '人物位于尾部。')
    h.data.projectId = 'another'; h.ui.refresh()
    assert.equal(h.findButton('保存分场状态').disabled, true)
    await h.click('保存分场状态'); assert.equal(h.calls.saves.length, 0)
    assert.equal(h.ui.hasPendingWork(), true)
    h.data.projectId = 'project'; h.data.documents.s2.content = '修改过的新正文。'
    await h.click('保存分场状态'); assert.equal(h.calls.saves.length, 0)
    assert.match(h.dialog.textContent, /正文已变化/)
    h.data.documents.s2.content = '人物走向木筏头部。'
    let release; h.controls.gate = new Promise(resolve => { release = resolve })
    const pending = h.click('保存分场状态'); await Promise.resolve()
    await h.click('保存分场状态'); assert.equal(h.calls.saves.length, 1)
    release(); await pending
    assert.equal(h.ui.hasPendingWork(), false)
  } finally { h.cleanup() }
})

test('取消放弃会保留编辑；不能由关闭、切换分场或刷新静默丢失草稿', async () => {
  const h = fixture()
  try {
    await h.edit('本场变化', '人物拿起绳子。'); h.controls.confirm = false
    await h.click('关闭'); assert.equal(h.dialog.open, true); assert.equal(h.ui.hasPendingWork(), true)
    h.data.documentId = 's1'
    assert.equal(h.ui.open('s1'), false)
    h.ui.refresh(); assert.equal(h.input('本场变化').value, '人物拿起绳子。')
    assert.equal(h.findButton('保存分场状态').disabled, true)
    h.controls.confirm = true; await h.click('放弃修改')
    assert.equal(h.dialog.open, false); assert.equal(h.ui.hasPendingWork(), false)
    assert.equal(h.data.documents.s2.sceneContinuity, undefined)
  } finally { h.cleanup() }
})

test('正文更新后的已保存状态显示待核对，并允许核对后保存来源指纹', async () => {
  const h = fixture()
  try {
    h.data.documents.s2.sceneContinuity = { ...emptySceneContinuity(), sourceFingerprint: sceneContentFingerprint('旧正文'), entryState: '人物位于尾部。' }
    h.ui.open('s2')
    assert.match(h.dialog.textContent, /正文已更新/)
    assert.equal(h.findButton('保存分场状态').disabled, false)
    await h.click('保存分场状态')
    assert.equal(h.data.documents.s2.sceneContinuity.sourceFingerprint, sceneContentFingerprint(h.data.documents.s2.content))
  } finally { h.cleanup() }
})

test('尚无正文依据的状态可直接核对保存，初次打开不会虚报已保存', async () => {
  const h = fixture()
  try {
    assert.match(h.dialog.textContent, /尚未保存分场状态/)
    h.data.documents.s2.sceneContinuity = { ...emptySceneContinuity(), entryState: '人物位于尾部。' }
    h.ui.open('s2')
    assert.match(h.dialog.textContent, /状态尚无正文依据/)
    assert.equal(h.findButton('保存分场状态').disabled, false)
    await h.click('保存分场状态')
    assert.equal(h.data.documents.s2.sceneContinuity.sourceFingerprint, sceneContentFingerprint(h.data.documents.s2.content))
    assert.equal(h.data.documents.s2.sceneContinuity.entryState, '人物位于尾部。')
  } finally { h.cleanup() }
})

test('本地视频提示词携带正文与素材约束，未保存草稿会明确标注且不改项目', async () => {
  const h = fixture()
  try {
    const before = structuredClone(h.data)
    await h.edit('进入状态', '背包仍在尾部。')
    await h.click('复制本场视频提示词')
    assert.equal(h.calls.clipboard.length, 1)
    const text = h.calls.clipboard[0]
    assert.match(text, /人物走向木筏头部/); assert.match(text, /平整木板筏面/); assert.match(text, /背包仍在尾部/)
    assert.match(h.dialog.textContent, /包含当前未保存的状态草稿/)
    assert.deepEqual(h.data, before); assert.equal(h.calls.saves.length, 0)
  } finally { h.cleanup() }
})

test('素材或前场状态变化会失效旧提示词预览，状态下拉同步新目录并保留草稿', async () => {
  const h = fixture()
  try {
    await h.edit('进入状态', '背包仍在尾部。')
    const add = h.dialog.all('button').find(node => node.textContent === '关联素材状态')
    await add.emit('click')
    await h.click('复制本场视频提示词')
    assert.match(h.input('本场视频提示词').value, /平整木板筏面/)
    const entity = h.data.storyboard.continuity.entities[0]
    entity.traits = '平整木板筏面，四个油桶。'
    entity.states.push({ ...entity.states[0], id: 'new-state', name: '新状态' })
    h.ui.refresh()
    assert.equal(h.input('本场视频提示词').value, '')
    assert.match(h.dialog.textContent, /素材或分场状态已变化/)
    assert.equal(h.input('进入状态').value, '背包仍在尾部。')
    assert.ok(h.select('进入素材状态 1').children.some(node => node.value === 'new-state'))
    await h.click('复制本场视频提示词')
    assert.match(h.input('本场视频提示词').value, /四个油桶/)
  } finally { h.cleanup() }
})

test('显式连续动作入口冲突显示原因并阻止复制，不冒充自然语言审查', async () => {
  const h = fixture()
  try {
    h.data.documents.s2.sceneContinuity = { ...emptySceneContinuity(), transition: 'continuous', entryBindings: [{ entityId: 'raft', stateId: 'broken' }] }
    h.ui.open('s2')
    assert.match(h.dialog.textContent, /冲突/)
    await h.click('复制本场视频提示词')
    assert.equal(h.calls.clipboard.length, 0)
    assert.match(h.dialog.textContent, /请先处理分场状态冲突/)
    assert.match(h.dialog.textContent, /不代表已完成自然语言或画面一致性审查/)
  } finally { h.cleanup() }
})

test('保存后继续切换素材状态立即检查冲突并保存最新绑定', async () => {
  const h = fixture()
  try {
    const transition = h.select('与上一场关系'); transition.value = 'continuous'; await transition.emit('change')
    await h.dialog.all('button').find(node => node.textContent === '关联素材状态').emit('click')
    await h.click('保存分场状态')
    assert.equal(h.data.documents.s2.sceneContinuity.entryBindings[0].stateId, 'whole')
    const state = h.select('进入素材状态 1'); state.value = 'broken'; await state.emit('change')
    assert.match(h.dialog.textContent, /连续动作衔接冲突/)
    await h.click('复制本场视频提示词')
    assert.equal(h.calls.clipboard.length, 0)
    await h.click('保存分场状态')
    assert.equal(h.data.documents.s2.sceneContinuity.entryBindings[0].stateId, 'broken')
    assert.equal(h.calls.saves.length, 2)
  } finally { h.cleanup() }
})

test('空白剧本不能复制，纯提示词整理不截断超长正文', () => {
  const h = fixture()
  try {
    h.data.documents.s2.content = ''
    assert.throws(() => buildSceneVideoPrompt({ ...h.data, documentId: 's2' }), /剧本为空/)
    h.data.documents.s2.content = '木筏'.repeat(40000)
    assert.throws(() => buildSceneVideoPrompt({ ...h.data, documentId: 's2' }), /超过|过长|容量/)
  } finally { h.cleanup() }
})
