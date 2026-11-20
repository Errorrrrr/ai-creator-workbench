import test from 'node:test'
import assert from 'node:assert/strict'
import { createShot } from '../src/storyboard.js'
import { createEntity, entityStateFingerprint } from '../src/continuity-assets.js'
import { makeVisualReview, visualInputFingerprint, imageVisualReviewState } from '../src/visual-review.js'
import { createVisualReviewUI, visualReviewNeighbours } from '../src/visual-review-ui.js'
import { emptySceneContinuity } from '../src/scene-continuity.js'

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

function fixture(options = {}) {
  const original = globalThis.document, body = new Node('body')
  globalThis.document = { body, createElement: tag => new Node(tag), activeElement: null }
  const prop = createEntity({ id: 'raft', kind: 'prop', name: '木筏', traits: '三块木板，两个蓝色浮桶', sourceDocumentIds: ['s1', 's2'], states: [{ id: 'raft-base', name: '基础状态', referenceVersionId: 'raft-image' }] })
  prop.states[0].referenceFingerprint = entityStateFingerprint(prop, prop.states[0], '写实电影，低饱和')
  const data = { projectId: 'p', documents: { ep1: { title: '第一集', content: '' }, ep2: { title: '第二集', content: '' }, s1: { title: '第一场', content: '海面木筏' }, s2: { title: '第二场', content: '海面继续' }, s3: { title: '下一集第一场', content: '白天' } }, structure: { acts: [{ episodeIds: ['ep1', 'ep2'] }], episodes: { ep1: { sceneIds: ['s1', 's2'] }, ep2: { sceneIds: ['s3'] } } }, storyboard: { revision: 0, shots: [], continuity: { version: 1, style: '写实电影，低饱和', entities: [prop] } } }
  const shots = ['s1', 's2', 's3'].map((source, i) => ({ ...createShot({ title: `镜头${i + 1}`, visual: '木筏漂浮', propNames: ['木筏'] }, { documentId: source }), id: `shot-${i + 1}`, selectedImageVersionId: `selected-${i + 1}`, references: [{ versionId: 'raft-image', role: 'reference', scope: 'continuity', origin: 'auto', entityId: 'raft', stateId: 'raft-base' }] }))
  data.storyboard.shots = [shots[2], shots[1], shots[0]]
  const assets = [{ id: 'raft-asset', projectId: 'p', kind: 'image', role: 'prop', name: '木筏设定图', versions: [{ id: 'raft-image', mimeType: 'image/png' }] }, ...shots.map((shot, i) => ({ id: `asset-${i}`, projectId: 'p', kind: 'image', role: 'shot', name: `图${i + 1}`, versions: [{ id: shot.selectedImageVersionId, mimeType: 'image/png' }] }))]
  const calls = { reviews: [], notices: [], selected: [], selectedBatches: [], baseline: 0 }, controls = { fail: false, gate: null, visible: ['shot-1', 'shot-2'] }
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
    onOpenBaseline: () => { calls.baseline++ }, onSelectShot: (id, batch) => { calls.selected.push(id); calls.selectedBatches.push(batch) }, notify: text => calls.notices.push(text), ...options
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

test('设定修改复核批次跨场按项目顺序展示，保留修改前通过标记且不混入新镜头', async () => {
  const f = fixture()
  try {
    f.shots[0].visualReview = makeVisualReview(f.shots[0], f.assets, f.data.documents, f.data.storyboard.continuity, { decision: 'approved' })
    f.data.storyboard.continuity.style = '新的统一画风'
    f.controls.visible = ['shot-2']
    assert.equal(f.ui.open({ projectId: 'p', shotIds: ['shot-3', 'shot-1', 'shot-1'], filter: 'all', scopeLabel: '本次设定修改', previouslyApprovedShotIds: ['shot-1'] }), true)
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-1', 'shot-3'])
    assert.match(f.dialog.textContent, /本次设定修改 2 镜/)
    assert.match(f.card('shot-1').textContent, /修改前已通过/)
    assert.doesNotMatch(f.card('shot-3').textContent, /修改前已通过/)
    assert.equal(f.card('shot-2'), null)
    await f.setFilter('pending')
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-1', 'shot-3'])
    const prop = f.data.storyboard.continuity.entities[0]
    prop.states[0].referenceFingerprint = entityStateFingerprint(prop, prop.states[0], f.data.storyboard.continuity.style)
    f.ui.refresh()
    await f.click('核对一致', f.card('shot-1'))
    assert.equal(f.card('shot-1'), null)
    await f.setFilter('approved')
    assert.ok(f.card('shot-1')); assert.equal(f.card('shot-2'), null); assert.equal(f.card('shot-3'), null)
    const added = { ...f.shots[1], id: 'new-shot' }
    f.data.storyboard.shots.push(added); f.controls.visible = ['new-shot']; f.ui.refresh()
    await f.setFilter('all')
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-1', 'shot-3'])
    f.ui.open({ filter: 'all' })
    assert.ok(f.card('new-shot')); assert.doesNotMatch(f.dialog.textContent, /本次设定修改|修改前已通过/)
  } finally { f.cleanup() }
})

test('固定复核批次忽略范围外定位，删除镜头后只复核剩余成员', () => {
  const f = fixture()
  try {
    f.ui.open({ projectId: 'p', shotIds: ['shot-1', 'shot-3'], shotId: 'shot-2', filter: 'all', scopeLabel: '本次设定修改' })
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-1', 'shot-3'])
    f.data.storyboard.shots = f.data.storyboard.shots.filter(shot => shot.id !== 'shot-3'); f.ui.refresh()
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-1'])
    assert.match(f.dialog.textContent, /1 镜已移除/)
    f.data.storyboard.shots = f.data.storyboard.shots.filter(shot => shot.id !== 'shot-1'); f.ui.refresh()
    assert.equal(f.dialog.querySelectorAll('article').length, 0)
    assert.match(f.dialog.textContent, /2 镜已移除/)
    assert.equal(f.shots[1].visualReview, undefined)
  } finally { f.cleanup() }
})

test('旧项目的设定复核入口不能打开当前项目，空批次也不会借用当前分场', () => {
  const f = fixture()
  try {
    f.ui.close(); f.data.projectId = 'new-project'
    assert.equal(f.ui.open({ projectId: 'p', shotIds: ['shot-1'], filter: 'all', scopeLabel: '本次设定修改' }), false)
    assert.equal(f.dialog.open, false)
    assert.match(f.calls.notices.at(-1), /项目已切换/)
    assert.equal(f.ui.open({ projectId: 'new-project', shotIds: [], filter: 'all', scopeLabel: '本次设定修改' }), true)
    assert.equal(f.dialog.querySelectorAll('article').length, 0)
    assert.match(f.dialog.textContent, /本次设定修改 0 镜/)
  } finally { f.cleanup() }
})

test('最近一次设定复核可从普通复核恢复，打开镜头后重新继续会定位原镜', async () => {
  const f = fixture()
  try {
    f.data.storyboard.continuityReviewBatch = { version: 1, id: 'continuity-review-1' }
    f.shots[0].continuityReview = { batchId: 'continuity-review-1', previouslyApproved: true }
    f.shots[2].continuityReview = { batchId: 'continuity-review-1', previouslyApproved: false }
    assert.equal(f.ui.openSavedBatch(), true)
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-1', 'shot-3'])
    assert.match(f.dialog.textContent, /最近一次设定修改 2 镜/)
    assert.match(f.card('shot-1').textContent, /修改前已通过/)
    await f.click('打开镜头', f.card('shot-3'))
    assert.equal(f.calls.selected.at(-1), 'shot-3'); assert.equal(f.dialog.open, false)
    assert.deepEqual(f.calls.selectedBatches.at(-1), { projectId: 'p', id: 'continuity-review-1' })
    f.controls.visible = ['shot-2']; f.ui.open()
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-2'])
    assert.equal(f.ui.openSavedBatch(), true)
    assert.deepEqual(f.dialog.querySelectorAll('article').map(node => node.dataset.visualShot), ['shot-1', 'shot-3'])
    await f.setFilter('approved')
    assert.equal(f.dialog.querySelectorAll('article').length, 0, '切换筛选清除定位，保持范围')
    f.data.storyboard.shots = f.data.storyboard.shots.filter(shot => shot.id === 'shot-2')
    f.ui.close(); assert.equal(f.ui.openSavedBatch(), false); assert.equal(f.dialog.open, false)
  } finally { f.cleanup() }
})

test('本批打开大图前校验最新批次，旧按钮不跳转；普通复核不携带批次', async () => {
  const f = fixture()
  try {
    f.data.storyboard.continuityReviewBatch = { version: 1, id: 'batch-1' }
    f.shots[0].continuityReview = { batchId: 'batch-1', previouslyApproved: true }
    f.ui.openSavedBatch()
    f.data.storyboard.continuityReviewBatch.id = 'batch-2'
    await f.click('打开镜头', f.card('shot-1'))
    assert.equal(f.calls.selected.length, 0)
    assert.equal(f.dialog.open, true)
    assert.match(f.calls.notices.at(-1), /批次已变化/)
    f.ui.open({ shotId: 'shot-1' })
    await f.click('打开镜头', f.card('shot-1'))
    assert.equal(f.calls.selected.at(-1), 'shot-1')
    assert.equal(f.calls.selectedBatches.at(-1), undefined)
  } finally { f.cleanup() }
})

test('空闲复核刷新保留界面，正文、素材或镜头变化会重新计算', () => {
  const f = fixture()
  try {
    const original = f.card('shot-1'); f.ui.refresh()
    assert.equal(f.card('shot-1'), original)
    f.data.documents.s1.content += '风浪加剧'
    f.ui.refresh(); const updated = f.card('shot-1')
    assert.notEqual(updated, original)
    f.ui.refresh(); assert.equal(f.card('shot-1'), updated)
    f.assets[0].versions[0].mimeType = 'video/mp4'; f.ui.refresh()
    assert.notEqual(f.card('shot-1'), updated)
    const beforeScene = f.card('shot-2')
    f.data.documents.s1.sceneContinuity = emptySceneContinuity(); f.ui.refresh()
    assert.notEqual(f.card('shot-2'), beforeScene)
    const beforeNeighbour = f.card('shot-2')
    f.shots[2].selectedImageVersionId = 'selected-1'; f.ui.refresh()
    assert.notEqual(f.card('shot-2'), beforeNeighbour)
  } finally { f.cleanup() }
})

test('复核轮询不读取分镜历史、文档快照和生成请求大字段', () => {
  const f = fixture()
  try {
    const unread = () => { throw new Error('不应读取历史或生成请求') }
    Object.defineProperty(f.data.storyboard, 'sourceVersions', { enumerable: true, get: unread })
    Object.defineProperty(f.data.documents.s1, 'versions', { enumerable: true, get: unread })
    f.assets[0].versions[0].metadata = { provenance: {} }
    Object.defineProperty(f.assets[0].versions[0].metadata.provenance, 'request', { enumerable: true, get: unread })
    const original = f.card('shot-1')
    assert.doesNotThrow(() => f.ui.refresh())
    assert.equal(f.card('shot-1'), original)
    f.shots[0].camera = '低机位'
    assert.doesNotThrow(() => f.ui.refresh())
    assert.notEqual(f.card('shot-1'), original)
  } finally { f.cleanup() }
})

test('返修仅对当前拒绝图片提供入口，带备注和预期输入并阻止并行提交', async () => {
  let release
  const repairs = [], gate = new Promise(resolve => { release = resolve })
  const f = fixture({ onRepair: async (...args) => { repairs.push(args); await gate } })
  try {
    f.shots[0].visualReview = makeVisualReview(f.shots[0], f.assets, f.data.documents, f.data.storyboard.continuity, { decision: 'rejected', notes: '浮桶颜色有误' })
    f.ui.open({ filter: 'all' })
    const card = f.card('shot-1')
    assert.equal(f.card('shot-2').querySelectorAll('button').some(node => node.textContent === '按备注返修'), false)
    const note = card.querySelector('textarea'); note.value = '  修正蓝色浮桶  '
    const first = f.click('按备注返修', card)
    await f.click('按备注返修', card)
    assert.equal(repairs.length, 1); assert.equal(note.disabled, true)
    assert.equal(repairs[0][0], 'shot-1'); assert.equal(repairs[0][1], '修正蓝色浮桶')
    assert.equal(repairs[0][2].imageVersionId, 'selected-1')
    release(); await first
    assert.match(f.dialog.textContent, /返修任务已提交/)
    f.shots[0].selectedImageVersionId = 'selected-2'; f.ui.refresh()
    assert.equal(f.card('shot-1').querySelectorAll('button').some(node => node.textContent === '按备注返修'), false)
  } finally { release(); f.cleanup() }
})

test('返修空备注、过期输入或提交失败均保留原选择并给出提示', async () => {
  const f = fixture({ onRepair: async () => { throw new Error('连接中断') } })
  try {
    f.shots[0].visualReview = makeVisualReview(f.shots[0], f.assets, f.data.documents, f.data.storyboard.continuity, { decision: 'rejected', notes: '颜色错误' })
    f.ui.open({ filter: 'all' })
    let card = f.card('shot-1')
    card.querySelector('textarea').value = '  '
    await f.click('按备注返修', card)
    assert.match(f.dialog.textContent, /请先在核对备注中填写/)
    card.querySelector('textarea').value = '校正颜色'
    await f.click('按备注返修', card)
    assert.match(f.dialog.textContent, /返修未提交：连接中断/)
    card = f.card('shot-1')
    f.shots[0].camera += '俯视'
    await f.click('按备注返修', card)
    assert.match(f.dialog.textContent, /画面或参考已变化/)
    assert.equal(f.shots[0].selectedImageVersionId, 'selected-1')
  } finally { f.cleanup() }
})

test('返修确认被取消时只轻提示未提交，保留备注且不产生错误通知', async () => {
  const f = fixture({ onRepair: async () => false })
  try {
    f.shots[0].visualReview = makeVisualReview(f.shots[0], f.assets, f.data.documents, f.data.storyboard.continuity, { decision: 'rejected', notes: '蓝色浮桶' })
    f.ui.open({ filter: 'all' })
    await f.click('按备注返修', f.card('shot-1'))
    assert.match(f.dialog.textContent, /未提交返修/)
    assert.equal(f.calls.notices.length, 0)
    assert.equal(f.card('shot-1').querySelector('textarea').value, '蓝色浮桶')
  } finally { f.cleanup() }
})

test('切换选用图片后旧拒绝备注不填入新图片，原图片未保存备注可恢复', async () => {
  const f = fixture()
  try {
    f.shots[0].visualReview = makeVisualReview(f.shots[0], f.assets, f.data.documents, f.data.storyboard.continuity, { decision: 'rejected', notes: '旧图浮桶错误' })
    f.ui.open({ filter: 'all' })
    const originalNote = f.card('shot-1').querySelector('textarea')
    assert.equal(originalNote.value, '旧图浮桶错误')
    originalNote.value = '旧图的未保存修改'; await originalNote.emit('input')
    f.shots[0].selectedImageVersionId = 'selected-2'; f.ui.refresh()
    assert.equal(f.card('shot-1').querySelector('textarea').value, '')
    f.shots[0].selectedImageVersionId = 'selected-1'; f.ui.refresh()
    assert.equal(f.card('shot-1').querySelector('textarea').value, '旧图的未保存修改')
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
