import test from 'node:test'
import assert from 'node:assert/strict'
import { createShot } from '../src/storyboard.js'
import { createEntity, entityStateFingerprint } from '../src/continuity-assets.js'
import { makeVisualReview, visualInputFingerprint, imageVisualReviewState } from '../src/visual-review.js'
import { createVisualReviewUI, visualReviewNeighbours } from '../src/visual-review-ui.js'

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ''; this.open = false; this.disabled = false; this._text = ''; this.scrollTop = 0 }
  set textContent(value) { this._text = value; this.children = [] }
  get textContent() { return this._text + this.children.map(child => child.textContent || '').join('') }
  append(...children) { this.children.push(...children); for (const child of children) child.parentNode = this }
  prepend(...children) { this.children.unshift(...children); for (const child of children) child.parentNode = this }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children) }
  setAttribute(name, value) { this.attrs[name] = value }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler) }
  async emit(name) { for (const handler of this.listeners[name] || []) await handler({ preventDefault() {} }) }
  querySelectorAll(selector) {
    const match = node => {
      const attr = selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/)
      if (attr) { const key = attr[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); return Object.hasOwn(node.dataset, key) && (attr[2] === undefined || node.dataset[key] === attr[2]) }
      return node.tagName === selector
    }
    return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  contains(node) { return this === node || this.children.some(child => child.contains(node)) }
  showModal() { this.open = true }
  close() { this.open = false }
}

function fixture() {
  const original = globalThis.document, body = new Node('body')
  globalThis.document = { body, createElement: tag => new Node(tag), activeElement: null }
  const prop = createEntity({ id: 'raft', kind: 'prop', name: '木筏', traits: '三块木板，两个蓝色浮桶', sourceDocumentIds: ['s1', 's2'], states: [{ id: 'raft-base', name: '基础状态', referenceVersionId: 'raft-image' }] })
  prop.states[0].referenceFingerprint = entityStateFingerprint(prop, prop.states[0], '写实电影，低饱和')
  const data = { projectId: 'p', documents: { ep1: { title: '第一集', content: '' }, ep2: { title: '第二集', content: '' }, s1: { title: '第一场', content: '海面木筏' }, s2: { title: '第二场', content: '海面继续' }, s3: { title: '下一集第一场', content: '白天' } }, structure: { acts: [{ episodeIds: ['ep1', 'ep2'] }], episodes: { ep1: { sceneIds: ['s1', 's2'] }, ep2: { sceneIds: ['s3'] } } }, storyboard: { revision: 0, shots: [], continuity: { version: 1, style: '写实电影，低饱和', entities: [prop] } } }
  const shots = ['s1', 's2', 's3'].map((source, i) => ({ ...createShot({ title: `镜头${i + 1}`, visual: '木筏漂浮', propNames: ['木筏'] }, { documentId: source }), id: `shot-${i + 1}`, selectedImageVersionId: `selected-${i + 1}`, references: [{ versionId: 'raft-image', role: 'reference', scope: 'continuity', origin: 'auto', entityId: 'raft', stateId: 'raft-base' }] }))
  data.storyboard.shots = [shots[2], shots[1], shots[0]]
  const assets = [{ id: 'raft-asset', projectId: 'p', kind: 'image', role: 'prop', name: '木筏设定图', versions: [{ id: 'raft-image', mimeType: 'image/png' }] }, ...shots.map((shot, i) => ({ id: `asset-${i}`, projectId: 'p', kind: 'image', role: 'shot', name: `图${i + 1}`, versions: [{ id: shot.selectedImageVersionId, mimeType: 'image/png' }] }))]
  const calls = { reviews: [], notices: [], selected: [], baseline: 0 }, controls = { fail: false, gate: null, visible: ['shot-1', 'shot-2'] }
  const ui = createVisualReviewUI({
    getContext: () => data, getAssets: () => assets, getShots: () => data.storyboard.shots.filter(shot => controls.visible.includes(shot.id)),
    preview: (version, name) => { const img = new Node('img'); img.dataset.versionId = version.id; img.name = name; return img },
    onReview: async (shotId, decision, expected) => {
      calls.reviews.push({ shotId, decision, expected })
      if (controls.gate) await controls.gate
      if (controls.fail) throw new Error('磁盘不可写')
      const shot = data.storyboard.shots.find(item => item.id === shotId)
      if (data.projectId !== expected.projectId || shot.selectedImageVersionId !== expected.imageVersionId || visualInputFingerprint(shot, assets, data.documents, data.storyboard.continuity) !== expected.fingerprint) throw new Error('图片或参考已变化')
      shot.visualReview = makeVisualReview(shot, assets, data.documents, data.storyboard.continuity, decision)
    },
    onOpenBaseline: () => { calls.baseline++ }, onSelectShot: id => calls.selected.push(id), notify: text => calls.notices.push(text)
  })
  ui.open()
  const dialog = body.querySelector('dialog')
  const card = id => dialog.querySelector(`[data-visual-shot="${id}"]`)
  const find = (text, host = dialog) => { const node = host.querySelectorAll('button').find(item => item.textContent === text); assert.ok(node, `missing ${text}`); return node }
  const click = async (text, host) => { const node = find(text, host); if (!node.disabled) await node.emit('click') }
  const setFilter = async value => { const select = dialog.querySelector('select'); select.value = value; await select.emit('change') }
  return { ui, data, shots, assets, calls, controls, body, dialog, card, find, click, setFilter, cleanup: () => { globalThis.document = original } }
}

test('并排展示选用分镜图、实际设定参考和跨分场邻镜，不跨分集拼接', () => {
  const f = fixture()
  try {
    const neighbours = visualReviewNeighbours(f.data)
    assert.equal(neighbours.get('shot-1').next.id, 'shot-2')
    assert.equal(neighbours.get('shot-2').previous.id, 'shot-1')
    assert.equal(neighbours.get('shot-2').next, null)
    assert.equal(neighbours.get('shot-3').previous, null)
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-1', 'shot-2'])
    assert.match(f.dialog.textContent, /人工核对.*不会自动认定画面内容一致/)
    assert.match(f.dialog.textContent, /写实电影，低饱和/)
    assert.match(f.card('shot-1').textContent, /木筏设定图.*设定参考/)
    assert.match(f.card('shot-1').textContent, /下一镜 · 镜头2/)
    assert.ok(f.card('shot-1').querySelectorAll('img').some(node => node.dataset.versionId === 'selected-1'))
    assert.ok(f.card('shot-1').querySelectorAll('img').some(node => node.dataset.versionId === 'raft-image'))
  } finally { f.cleanup() }
})

test('人工通过仅对捕获的图片及视觉输入生效，筛选和状态实时更新', async () => {
  const f = fixture()
  try {
    const note = f.card('shot-1').querySelector('textarea'); note.value = '蓝桶和三块木板均一致'; await note.emit('input')
    await f.click('核对一致', f.card('shot-1'))
    assert.equal(f.calls.reviews.length, 1)
    assert.deepEqual(f.calls.reviews[0].expected, { projectId: 'p', imageVersionId: 'selected-1', fingerprint: visualInputFingerprint(f.shots[0], f.assets, f.data.documents, f.data.storyboard.continuity) })
    assert.equal(imageVisualReviewState(f.shots[0], f.assets, f.data.documents, f.data.storyboard.continuity).reviewed, true)
    assert.equal(f.card('shot-1'), null)
    await f.setFilter('approved'); assert.ok(f.card('shot-1')); assert.equal(f.card('shot-2'), null)
    f.data.storyboard.continuity.style = '改为水彩画'; f.ui.refresh(); assert.equal(f.card('shot-1'), null)
    await f.setFilter('pending'); assert.ok(f.card('shot-1')); assert.match(f.card('shot-1').textContent, /待复核|变更|变化/)
  } finally { f.cleanup() }
})

test('失败保留备注与图片，重试后标记不一致且不冒充通过', async () => {
  const f = fixture()
  try {
    const note = f.card('shot-1').querySelector('textarea'); note.value = '筏面变成圆木'; await note.emit('input')
    f.controls.fail = true; await f.click('标记不一致', f.card('shot-1'))
    assert.match(f.dialog.textContent, /核对未保存.*磁盘不可写/)
    assert.equal(f.card('shot-1').querySelector('textarea').value, '筏面变成圆木')
    assert.equal(f.shots[0].visualReview, undefined)
    f.controls.fail = false; await f.click('标记不一致', f.card('shot-1'))
    await f.setFilter('rejected'); assert.ok(f.card('shot-1')); assert.equal(f.shots[0].visualReview.decision, 'rejected')
    assert.equal(f.shots[0].visualReview.notes, '筏面变成圆木'); assert.equal(f.shots[0].selectedImageVersionId, 'selected-1')
  } finally { f.cleanup() }
})

test('没有选用图的镜头仍展示设定参考，不能核对通过或标记图片不一致', async () => {
  const f = fixture()
  try {
    f.shots[0].selectedImageVersionId = ''; f.ui.refresh()
    assert.equal(f.find('核对一致', f.card('shot-1')).disabled, true)
    assert.equal(f.find('标记不一致', f.card('shot-1')).disabled, true)
    assert.match(f.card('shot-1').textContent, /尚无可用图片/)
    await f.click('核对一致', f.card('shot-1')); assert.equal(f.calls.reviews.length, 0)
  } finally { f.cleanup() }
})

test('图片或参考在用户核对期间变化时阻止过期按钮提交，备注继续保留', async () => {
  const f = fixture()
  try {
    const oldCard = f.card('shot-1'), note = oldCard.querySelector('textarea'); note.value = '发现光线差异'; await note.emit('input')
    f.shots[0].visual = '改变机位'
    await f.click('核对一致', oldCard)
    assert.equal(f.calls.reviews.length, 0); assert.match(f.dialog.textContent, /本次未写入核对结果/)
    assert.equal(f.card('shot-1').querySelector('textarea').value, '发现光线差异')
    f.ui.refresh(); assert.equal(f.card('shot-1').querySelector('textarea').value, '发现光线差异')
  } finally { f.cleanup() }
})

test('轮询不打断备注输入，外部变更后保留输入并在失焦时更新图片', async () => {
  const f = fixture()
  try {
    const note = f.card('shot-1').querySelector('textarea'); note.value = '人物背心'; await note.emit('input')
    globalThis.document.activeElement = note; f.ui.refresh()
    assert.equal(f.card('shot-1').querySelector('textarea'), note)
    f.shots[0].visual = '新的机位'; f.ui.refresh()
    assert.equal(f.card('shot-1').querySelector('textarea'), note)
    assert.match(f.dialog.textContent, /正在输入的核对备注已保留/)
    globalThis.document.activeElement = null; await note.emit('blur')
    assert.equal(f.card('shot-1').querySelector('textarea').value, '人物背心')
  } finally { f.cleanup() }
})

test('保存中禁止重复核对，项目切换后关闭面板并忽略迟到保存回执', async () => {
  const f = fixture(); let release
  try {
    f.controls.gate = new Promise(resolve => { release = resolve })
    const oldCard = f.card('shot-1'), pending = f.click('核对一致', oldCard)
    await f.click('核对一致', oldCard); assert.equal(f.calls.reviews.length, 1)
    f.data.projectId = 'other'; f.ui.refresh(); assert.equal(f.dialog.open, false)
    release(); await pending
    assert.equal(f.shots[0].visualReview, undefined)
    assert.equal(f.calls.notices.length, 0, '迟到回执不污染新项目提示')
  } finally { release?.(); f.cleanup() }
})

test('导出范围参数独立于工作区选择，单镜定位可显示已通过镜头', async () => {
  const f = fixture()
  try {
    f.controls.visible = ['shot-1']
    f.shots[1].visualReview = makeVisualReview(f.shots[1], f.assets, f.data.documents, f.data.storyboard.continuity, { decision: 'approved', notes: '' })
    f.ui.open({ shotIds: ['shot-2', 'shot-3'], filter: 'all' })
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-2', 'shot-3'])
    f.ui.open({ shotId: 'shot-2' }); assert.ok(f.card('shot-2'))
    await f.click('设置统一视觉基准'); assert.equal(f.calls.baseline, 1); assert.equal(f.dialog.open, false)
  } finally { f.cleanup() }
})

test('图片可在面板内放大且关闭不改变选用版本', async () => {
  const f = fixture()
  try {
    const action = f.card('shot-1').querySelectorAll('button').find(node => node.attrs['aria-label'] === '放大查看：当前选用分镜图')
    await action.emit('click')
    const zoom = f.body.querySelectorAll('dialog')[1]
    assert.equal(zoom.open, true); assert.equal(zoom.querySelector('img').dataset.versionId, 'selected-1')
    await f.click('关闭图片', zoom); assert.equal(zoom.open, false)
    assert.equal(f.shots[0].selectedImageVersionId, 'selected-1')
  } finally { f.cleanup() }
})
