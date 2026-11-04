import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { emptyContinuity, createEntity, createEntityState, entityStateFingerprint } from '../src/continuity-assets.js'
import { contentFingerprint, createShot } from '../src/storyboard.js'
import { initializeContinuityUI, continuityScopes, continuityImageCheckpoint, continuityReferenceOptions, cloneContinuityState } from '../src/continuity-ui.js'

if (!globalThis.crypto) globalThis.crypto = webcrypto

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ''; this.open = false; this.disabled = false; this._text = ''; this.classList = { toggle() {} } }
  set textContent(value) { this._text = value; this.children = [] }
  get textContent() { return this._text + this.children.map(child => child.textContent || '').join('') }
  append(...children) { this.children.push(...children); for (const child of children) child.parentNode = this }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children) }
  setAttribute(name, value) { this.attrs[name] = value }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler) }
  async emit(name) { for (const handler of this.listeners[name] || []) await handler({ preventDefault() {} }) }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('[data-') ? Object.hasOwn(node.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())) : node.tagName === selector
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  contains(node) { return this === node || this.children.some(child => child.contains(node)) }
  showModal() { this.open = true }
  close() { this.open = false }
  focus() { globalThis.document.activeElement = this }
}

function fixture(options = {}) {
  const previous = { document: globalThis.document, window: globalThis.window }
  const body = new Node('body'); globalThis.document = { body, createElement: tag => new Node(tag), activeElement: null }; globalThis.window = { confirm: () => true }
  const prop = createEntity({ kind: 'prop', name: '木筏', traits: '平整木板筏面', sourceDocumentIds: ['s1', 's2'] })
  const data = { projectId: 'p', currentDocId: 's2', documents: { e1: { title: '第一集', content: '' }, s1: { title: '第一场', content: '木筏漂浮。' }, s2: { title: '第二场', content: '木筏破损。' } }, structure: { acts: [{ episodeIds: ['e1'] }], episodes: { e1: { sceneIds: ['s1', 's2'] } } }, storyboard: { revision: 2, shots: [], continuity: { ...emptyContinuity(), entities: [prop] } }, textGenerating: false, mutationBusy: false }
  const calls = { saves: [], generated: [], extracted: [], stopped: 0, notices: [] }, jobs = [], assets = []
  const controls = { failSave: false, saveGate: null }
  const ui = initializeContinuityUI({
    getContext: () => data, getAssets: () => assets, getJobs: () => jobs,
    save: async (next, meta) => { calls.saves.push({ next, meta }); if (controls.saveGate) await controls.saveGate; if (controls.failSave) throw new Error('磁盘不可写'); data.storyboard = { ...data.storyboard, revision: data.storyboard.revision + 1, continuity: next } },
    requestExtraction: async metadata => { calls.extracted.push(metadata); data.textGenerating = true },
    generateReference: async (entityId, stateId) => { calls.generated.push({ entityId, stateId }) },
    stopExtraction: async () => { calls.stopped++; data.textGenerating = false },
    preview: versionId => { const image = new Node('img'); image.dataset.versionId = versionId; return image },
    notify: message => calls.notices.push(message), ...options,
  })
  ui.open()
  const dialog = body.querySelector('dialog')
  const findButton = text => { const result = dialog.querySelectorAll('button').find(node => node.textContent === text); assert.ok(result, `missing button ${text}`); return result }
  const input = label => { const wrapper = dialog.querySelectorAll('label').find(node => node.children[0]?.textContent === label); assert.ok(wrapper, `missing label ${label}`); return wrapper.children[1] }
  const select = label => { const result = dialog.querySelectorAll('select').find(node => node.attrs['aria-label'] === label); assert.ok(result, `missing select ${label}`); return result }
  const edit = async (label, value) => { const node = input(label); node.value = value; await node.emit('input'); return node }
  return { ui, data, prop, calls, jobs, assets, controls, dialog, input, select, edit, click: async label => findButton(label).emit('click'), findButton, cleanup: () => { globalThis.document = previous.document; globalThis.window = previous.window } }
}

function scheduleWorkbenchPoll(ui) {
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const start = source.indexOf('  const poll = window.setInterval(')
  const end = source.indexOf('  function contextObjects()', start)
  assert.ok(start >= 0 && end > start)
  let mediaRefreshes = 0
  const env = { continuityUI: ui, loading: false, operationBusy: false, jobs: [], terminal: () => true, refresh: () => { mediaRefreshes++ }, window: { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, addEventListener() {} } }
  vm.runInNewContext(source.slice(start, end), env)
  return { mediaRefreshes: () => mediaRefreshes }
}

test('提取范围按剧本结构排序，默认当前分集，忽略项目笔记与无关文档', () => {
  const result = continuityScopes({ currentDocId: 's10', documents: { e2: { title: '第二集' }, e1: { title: '第一集' }, s10: { title: '十' }, s2: { title: '二' }, characters: { title: '人物' } }, structure: { acts: [{ episodeIds: ['e2', 'e1'] }], episodes: { e2: { sceneIds: ['s2', 's10', 'missing'] }, e1: { sceneIds: [] } } } })
  assert.equal(result.currentEpisodeId, 'e2')
  assert.deepEqual(result.episodes.map(item => item.id), ['e2', 'e1'])
  assert.deepEqual(result.episodes[0].sourceDocumentIds, ['s2', 's10'])
  assert.deepEqual(result.episodes[1].sourceDocumentIds, ['e1'])
})

test('复制状态保留外形说明和基础状态链，不复用旧参考图与分场', () => {
  const original = createEntityState({ name: '初始', description: '蓝色衣服', sourceDocumentIds: ['s1'], referenceVersionId: 'old-image', referenceFingerprint: 'hash', imageResultCheckpoint: { jobId: 'j1', createdAt: '1000' } })
  const next = cloneContinuityState(original)
  assert.notEqual(next.id, original.id); assert.equal(next.basedOnStateId, original.id); assert.equal(next.description, '蓝色衣服')
  assert.equal(next.referenceVersionId, ''); assert.equal(next.referenceFingerprint, ''); assert.equal(next.imageResultCheckpoint, undefined); assert.deepEqual(next.sourceDocumentIds, [])
})

test('手选版本只显示本项目同类型图片，任务水位包含运行中任务并稳定排序', () => {
  const job = (id, createdAt, extra = {}) => ({ id, createdAt, projectId: 'p', capability: 'image', request: { entity: { entityId: 'e', stateId: 's' } }, ...extra })
  const jobs = [job('j1', '1000'), job('j2', '2000', { status: 'running' }), job('j3', '2000'), job('other', '9999', { projectId: 'foreign' }), job('restored', '9999', { restored: true }), job('invalid', 'bad')]
  assert.deepEqual(continuityImageCheckpoint(jobs, 'p', 'e', 's'), { jobId: 'j3', createdAt: '2000' })
  const asset = (projectId, role, mimeType, id) => ({ projectId, role, kind: 'image', versions: [{ id, mimeType }] })
  assert.deepEqual(continuityReferenceOptions([asset('p', 'prop', 'image/png', 'yes'), asset('q', 'prop', 'image/png', 'other'), asset('p', 'character', 'image/png', 'person'), asset('p', 'prop', 'video/mp4', 'video')], 'p', 'prop').map(item => item.version.id), ['yes'])
})

test('定时刷新保留正在编辑的草稿，保存失败不清草稿，重试成功落盘', async () => {
  const f = fixture()
  try {
    const node = await f.edit('固定外形特征', '平板筏面，禁止圆木')
    f.ui.refresh(); assert.equal(f.input('固定外形特征'), node); assert.equal(node.value, '平板筏面，禁止圆木'); assert.equal(f.ui.hasDrafts(), true)
    f.controls.failSave = true; assert.equal(await f.ui.saveDraft(), false); assert.equal(f.ui.hasDrafts(), true); assert.match(f.dialog.textContent, /磁盘不可写/)
    f.controls.failSave = false; assert.equal(await f.ui.saveDraft(), true); assert.equal(f.ui.hasDrafts(), false); assert.equal(f.data.storyboard.continuity.entities[0].traits, '平板筏面，禁止圆木')
    assert.deepEqual(f.calls.saves[0].meta, { projectId: 'p', revision: 2 })
  } finally { f.cleanup() }
})

test('版本或项目变化阻止草稿写入，外层草稿保护可查看和放弃', async () => {
  const f = fixture()
  try {
    await f.edit('名称', '平板木筏'); f.data.storyboard.revision++
    f.ui.refresh(); assert.equal(await f.ui.saveDraft(), false); assert.equal(f.calls.saves.length, 0)
    assert.equal(f.ui.pendingDraft().projectId, 'p'); assert.equal(f.ui.pendingDraft('other'), null)
    f.data.projectId = 'q'; f.ui.refresh(); assert.equal(await f.ui.saveDraft(), false); assert.equal(f.ui.hasDrafts(), true)
    assert.equal(f.ui.discardDraft('other'), false); assert.equal(f.ui.discardDraft('p'), true); assert.equal(f.ui.hasDrafts(), false)
  } finally { f.cleanup() }
})

test('输入超长或无效名称不能保存，生成前失败会停止提交图片任务', async () => {
  const f = fixture()
  try {
    await f.edit('名称', ''); await f.click('生成此状态设定图')
    assert.equal(f.calls.generated.length, 0); assert.equal(f.calls.saves.length, 0); assert.equal(f.ui.hasDrafts(), true)
    await f.edit('名称', '木筏'); await f.edit('固定外形特征', '木'.repeat(12001)); assert.equal(await f.ui.saveDraft(), false)
    assert.equal(f.calls.saves.length, 0)
  } finally { f.cleanup() }
})

test('图片生成先原子保存；保存期间重复点击和关闭不能丢失草稿', async () => {
  const f = fixture()
  try {
    let release; f.controls.saveGate = new Promise(resolve => { release = resolve })
    await f.edit('固定外形特征', '平板木筏')
    const first = f.click('生成此状态设定图')
    await f.click('生成此状态设定图'); await f.click('关闭')
    assert.equal(f.ui.hasPendingWork(), true); assert.equal(f.dialog.open, true); assert.equal(f.calls.generated.length, 0)
    release(); await first
    assert.equal(f.calls.saves.length, 1); assert.equal(f.calls.generated.length, 1); assert.equal(f.ui.hasPendingWork(), false)
  } finally { f.cleanup() }
})

test('手选参考图固定定义与运行任务水位，任务刷新不覆盖编辑字段', async () => {
  const f = fixture()
  try {
    const state = f.prop.states[0]
    f.assets.push({ projectId: 'p', kind: 'image', role: 'prop', name: '木筏', versions: [{ id: 'image-1', mimeType: 'image/png', createdAt: '1000' }] })
    f.jobs.push({ id: 'job-1', projectId: 'p', capability: 'image', status: 'running', createdAt: '2000', request: { entity: { entityId: f.prop.id, stateId: state.id } } })
    f.ui.refresh(); f.select('状态参考图片版本').value = 'image-1'; await f.click('选用此图'); await f.ui.saveDraft()
    const saved = f.data.storyboard.continuity.entities[0], version = saved.states[0]
    assert.equal(version.referenceVersionId, 'image-1'); assert.equal(version.referenceFingerprint, entityStateFingerprint(saved, version, '')); assert.deepEqual(version.imageResultCheckpoint, { jobId: 'job-1', createdAt: '2000' })
    const field = await f.edit('状态差异', '绳索略松'); f.jobs[0].status = 'failed'; f.jobs[0].error = '连接中断'; f.ui.refresh()
    assert.equal(f.input('状态差异'), field); assert.match(f.dialog.textContent, /连接中断/); assert.equal(f.findButton('生成此状态设定图').disabled, false)
  } finally { f.cleanup() }
})

test('提取只提交选定分场，候选标记时间，保存失败保留且成功后清除', async () => {
  const f = fixture()
  try {
    f.select('提取分场').value = 's2'; await f.select('提取分场').emit('change'); await f.click('AI 提取人物、场景和物品')
    assert.deepEqual(f.calls.extracted[0], { sourceDocumentIds: ['s2'] }); assert.equal(f.ui.hasPendingWork(), true)
    await f.click('停止提取'); assert.equal(f.calls.stopped, 1); assert.equal(f.ui.hasPendingWork(), false)
    const text = JSON.stringify({ entities: [{ kind: 'character', name: '陆骁', description: '短发', sourceDocumentIds: ['s2'], states: [{ name: '初始', sourceDocumentIds: ['s2'] }] }] })
    assert.equal(f.ui.receiveCandidate(text, { projectId: 'p', sourceDocumentIds: ['s2'], createdAt: '1793066400000', sourceFingerprints: { s2: contentFingerprint(f.data.documents.s2.content) } }, 'candidate-1'), true)
    assert.match(f.dialog.textContent, /生成于/); assert.match(f.dialog.textContent, /陆骁/)
    f.controls.failSave = true; await f.click('采纳并保存设定'); assert.match(f.dialog.textContent, /提取候选/); assert.equal(f.data.storyboard.continuity.entities.length, 1)
    f.controls.failSave = false; await f.click('采纳并保存设定'); assert.doesNotMatch(f.dialog.textContent, /提取候选/); assert.equal(f.data.storyboard.continuity.entities.length, 2); assert.equal(f.calls.saves.at(-1).meta.resolvedCandidateId, 'candidate-1')
  } finally { f.cleanup() }
})

test('恢复候选来源修改与跨项目候选不能写入，错误候选继续保留', async () => {
  const f = fixture()
  try {
    const text = JSON.stringify({ entities: [{ kind: 'prop', name: '绳索', sourceDocumentIds: ['s1'], states: [{ name: '初始', sourceDocumentIds: ['s1'] }] }] })
    assert.equal(f.ui.receiveCandidate(text, { projectId: 'other', sourceDocumentIds: ['s1'] }, 'other'), false)
    f.ui.receiveCandidate(text, { projectId: 'p', sourceDocumentIds: ['s1'], sourceFingerprints: { s1: contentFingerprint(f.data.documents.s1.content) } }, 'candidate')
    f.data.documents.s1.content += '新修改'; await f.click('采纳并保存设定'); assert.equal(f.calls.saves.length, 0); assert.match(f.dialog.textContent, /原候选已保留/)
    f.ui.clearCandidate('other'); assert.match(f.dialog.textContent, /提取候选/); f.ui.clearCandidate('candidate'); assert.doesNotMatch(f.dialog.textContent, /提取候选/)
    f.ui.receiveCandidate('不是 JSON', { projectId: 'p', sourceDocumentIds: ['s1'] }, 'bad'); assert.match(f.dialog.textContent, /候选格式暂时无法采纳/)
  } finally { f.cleanup() }
})

test('新增状态不复用旧图，新增同类实体默认名称唯一，关闭遵守未保存确认', async () => {
  const f = fixture()
  try {
    await f.click('新增状态'); await f.click('新增状态'); await f.ui.saveDraft()
    assert.deepEqual(f.data.storyboard.continuity.entities[0].states.map(item => item.name), ['初始状态', '新状态', '新状态 2'])
    await f.click('＋关键物品'); await f.click('＋关键物品'); await f.ui.saveDraft()
    assert.deepEqual(f.data.storyboard.continuity.entities.map(item => item.name), ['木筏', '新关键物品', '新关键物品 2'])
    await f.edit('名称', '另一木筏'); globalThis.window.confirm = () => false; await f.click('关闭'); assert.equal(f.dialog.open, true); assert.equal(f.ui.hasDrafts(), true)
    globalThis.window.confirm = () => true; await f.click('关闭'); assert.equal(f.dialog.open, false); assert.equal(f.ui.hasDrafts(), false)
  } finally { f.cleanup() }
})

test('面板关闭后文字任务失败仍释放忙状态，统一风格编辑不被轮询打断', async () => {
  const f = fixture()
  try {
    await f.click('AI 提取人物、场景和物品'); await f.click('关闭'); f.data.textGenerating = false; f.ui.refresh()
    assert.equal(f.ui.hasPendingWork(), false)
    f.ui.open(); const field = await f.edit('全项目视觉基准', '写实电影，低饱和')
    globalThis.document.activeElement = field; f.ui.refresh(); assert.equal(f.input('全项目视觉基准'), field)
    assert.equal(await f.ui.saveDraft(), true); assert.equal(f.data.storyboard.continuity.style, '写实电影，低饱和')
  } finally { f.cleanup() }
})

test('统一视觉基准入口展开并聚焦，保存后保留旧分镜图并明确需要视觉复核', async () => {
  const f = fixture()
  try {
    const shot = createShot({ title: '漂浮' }, { documentId: 's1' }); shot.selectedImageVersionId = 'existing-image'
    f.data.storyboard.shots = [shot]
    f.ui.open({ baseline: true })
    const field = f.input('全项目视觉基准')
    assert.equal(globalThis.document.activeElement, field)
    assert.equal(f.dialog.querySelectorAll('details').find(node => node.className === 'continuity-project-style').open, true)
    assert.match(f.dialog.textContent, /画风、色彩、材质和成片质感/)
    assert.match(f.dialog.textContent, /不把所有分场强制设成同一种光线/)
    await f.edit('全项目视觉基准', '写实电影；保持低饱和与真实旧化材质')
    f.controls.failSave = true; assert.equal(await f.ui.saveDraft(), false)
    assert.equal(f.input('全项目视觉基准').value, '写实电影；保持低饱和与真实旧化材质')
    f.controls.failSave = false; assert.equal(await f.ui.saveDraft(), true)
    assert.equal(f.data.storyboard.continuity.style, '写实电影；保持低饱和与真实旧化材质')
    assert.equal(f.data.storyboard.shots[0].selectedImageVersionId, 'existing-image')
    assert.match(f.dialog.textContent, /已有分镜图不会自动重绘.*需要重新核对视觉一致性/)
  } finally { f.cleanup() }
})

test('提取快速失败保留之前候选，显示真实错误且不被启动成功消息覆盖', async () => {
  let f
  f = fixture({ requestExtraction: async () => { f.ui.receiveCandidate('', { projectId: 'p', sourceDocumentIds: ['s1', 's2'], error: '执行端区域不可用' }, 'failed'); return 'started-id' } })
  try {
    const text = JSON.stringify({ entities: [{ kind: 'prop', name: '绳索', sourceDocumentIds: ['s1'], states: [{ name: '初始', sourceDocumentIds: ['s1'] }] }] })
    f.ui.receiveCandidate(text, { projectId: 'p', sourceDocumentIds: ['s1'] }, 'old-candidate')
    await f.click('AI 提取人物、场景和物品')
    assert.equal(f.ui.hasPendingWork(), false); assert.match(f.dialog.textContent, /执行端区域不可用/); assert.match(f.dialog.textContent, /绳索/); assert.match(f.dialog.textContent, /已有候选保留/)
    assert.doesNotMatch(f.dialog.textContent, /提取任务已启动/); assert.doesNotMatch(f.dialog.textContent, /候选格式暂时无法采纳/)
    await f.click('采纳并保存设定'); assert.equal(f.calls.saves[0].meta.resolvedCandidateId, 'old-candidate')
  } finally { f.cleanup() }
})

test('没有历史候选的提取失败说明本次未生成，不声称保留了候选且不自动重试', async () => {
  let f, requests = 0
  f = fixture({ requestExtraction: async () => { requests++; f.ui.receiveCandidate('', { projectId: 'p', sourceDocumentIds: ['s1'], error: 'Antigravity 未返回内容。' }, 'failed'); return 'started-id' } })
  try {
    await f.click('AI 提取人物、场景和物品'); f.ui.refresh()
    assert.equal(requests, 1); assert.equal(f.ui.hasPendingWork(), false)
    assert.match(f.dialog.textContent, /提取失败：Antigravity 未返回内容。本次未生成可用候选，可重新提取。/)
    assert.doesNotMatch(f.dialog.textContent, /已有候选保留|提取任务已启动/)
    assert.equal(f.findButton('AI 提取人物、场景和物品').disabled, false)
  } finally { f.cleanup() }
})

test('提取显示实时耗时和十分钟上限，聚焦范围选择时照常刷新并阻止重复执行', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1793066400000 })
  const f = fixture()
  try {
    await f.click('AI 提取人物、场景和物品')
    assert.match(f.dialog.textContent, /已用时 0 分 00 秒.*最长等待 10 分钟/)
    assert.equal(f.findButton('AI 提取人物、场景和物品').disabled, true)
    await f.click('AI 提取人物、场景和物品'); assert.equal(f.calls.extracted.length, 1)
    const scope = f.select('提取分场'); globalThis.document.activeElement = scope
    t.mock.timers.tick(65000); f.ui.refresh()
    assert.equal(f.select('提取分场'), scope); assert.match(f.dialog.textContent, /已用时 1 分 05 秒/)
    await f.click('停止提取'); assert.equal(f.calls.stopped, 1); assert.equal(f.ui.hasPendingWork(), false)
    assert.doesNotMatch(f.dialog.textContent, /已用时/)
  } finally { f.cleanup() }
})

test('停止后后台请求尚未退出时仍不能提交新的提取', async () => {
  const f = fixture({ stopExtraction: async () => {} })
  try {
    await f.click('AI 提取人物、场景和物品'); await f.click('停止提取')
    assert.equal(f.findButton('AI 提取人物、场景和物品').disabled, true)
    await f.click('AI 提取人物、场景和物品'); assert.equal(f.calls.extracted.length, 1)
    f.data.textGenerating = false; f.ui.refresh()
    assert.equal(f.findButton('AI 提取人物、场景和物品').disabled, false)
  } finally { f.cleanup() }
})

test('工作台真实轮询在没有媒体任务时刷新提取耗时，并在失败或停止后的请求退出后解除按钮锁', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1793066400000 })
  const f = fixture({ stopExtraction: async () => {} })
  try {
    const poll = scheduleWorkbenchPoll(f.ui)
    await f.click('AI 提取人物、场景和物品')
    t.mock.timers.tick(65000)
    assert.match(f.dialog.textContent, /已用时 1 分 05 秒/)
    assert.equal(poll.mediaRefreshes(), 0, '文字任务轮询不会额外读取媒体数据')
    f.ui.receiveCandidate('', { projectId: 'p', sourceDocumentIds: ['s1'], error: '上游连接中断' }, 'failed')
    assert.equal(f.ui.hasPendingWork(), false)
    assert.equal(f.findButton('AI 提取人物、场景和物品').disabled, true, '失败处理期间实际请求仍持有锁')
    f.data.textGenerating = false
    t.mock.timers.tick(5000)
    assert.equal(f.findButton('AI 提取人物、场景和物品').disabled, false)
    assert.match(f.dialog.textContent, /上游连接中断/)
    await f.click('AI 提取人物、场景和物品'); await f.click('停止提取')
    assert.equal(f.findButton('AI 提取人物、场景和物品').disabled, true)
    f.data.textGenerating = false
    t.mock.timers.tick(5000)
    assert.equal(f.findButton('AI 提取人物、场景和物品').disabled, false)
    assert.equal(f.calls.extracted.length, 2, '轮询不会自动重试')
  } finally { f.cleanup() }
})

test('旧提取启动请求延迟失败不会清除同项目随后启动的新任务', async () => {
  let f, rejectFirst, requests = 0
  const first = new Promise((_, reject) => { rejectFirst = reject })
  f = fixture({ requestExtraction: async () => { requests++; if (requests === 1) return first; f.data.textGenerating = true; return 'new-id' } })
  try {
    const pending = f.click('AI 提取人物、场景和物品')
    await f.click('停止提取'); await f.click('AI 提取人物、场景和物品')
    rejectFirst(new Error('旧任务启动失败')); await pending
    assert.equal(requests, 2); assert.equal(f.ui.hasPendingWork(), true)
    assert.doesNotMatch(f.dialog.textContent, /旧任务启动失败/)
    assert.equal(f.findButton('AI 提取人物、场景和物品').disabled, true)
  } finally { f.cleanup() }
})

test('切换默认态后已勾选的冲突分场仍可取消，避免陷入无法保存的状态', async () => {
  const f = fixture()
  try {
    const original = f.data.storyboard.continuity.entities[0]; original.states[0].sourceDocumentIds = ['s1', 's2']
    const damaged = createEntityState({ name: '破损', sourceDocumentIds: ['s2'] }), repaired = createEntityState({ name: '修复' })
    original.states.push(damaged, repaired); f.ui.refresh()
    f.select('状态版本').value = repaired.id; await f.select('状态版本').emit('change')
    const defaultLabel = f.dialog.querySelectorAll('label').find(node => node.textContent.includes('作为默认状态'))
    defaultLabel.children[0].checked = true; await defaultLabel.children[0].emit('change')
    f.select('状态版本').value = original.states[0].id; await f.select('状态版本').emit('change')
    const conflictLabel = f.dialog.querySelectorAll('label').find(node => node.textContent.includes('第二场（已用：破损）'))
    assert.equal(conflictLabel.children[0].checked, true); assert.equal(conflictLabel.children[0].disabled, false)
    conflictLabel.children[0].checked = false; await conflictLabel.children[0].emit('change')
    assert.equal(await f.ui.saveDraft(), true)
    assert.deepEqual(f.data.storyboard.continuity.entities[0].states[0].sourceDocumentIds, ['s1'])
  } finally { f.cleanup() }
})

test('素材包导出按当前分类、锁定重复操作，未保存草稿不导出', async () => {
  const exported = []; let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ exportBundle: async request => { exported.push(request); await gate; return '/tmp/木筏设定素材包' } })
  try {
    f.select('设定分类').value = 'prop'; await f.select('设定分类').emit('change')
    const pending = f.click('导出关键物品素材包')
    assert.equal(f.findButton('导出关键物品素材包').disabled, true)
    await f.click('导出关键物品素材包'); assert.equal(exported.length, 1)
    release(); await pending
    assert.deepEqual(exported[0], { projectId: 'p', kind: 'prop' }); assert.match(f.dialog.textContent, /已导出：\/tmp\/木筏设定素材包/)
    await f.edit('固定外形特征', '新设定'); assert.equal(f.findButton('导出关键物品素材包').disabled, true)
    await f.click('导出关键物品素材包'); assert.equal(exported.length, 1)
  } finally { release(); f.cleanup() }
})

test('清除选图阻止旧图自动补回，重新选用恢复明确选择', async () => {
  const f = fixture()
  try {
    f.assets.push({ projectId: 'p', kind: 'image', role: 'prop', name: '木筏', versions: [{ id: 'image-1', mimeType: 'image/png' }] })
    f.ui.refresh(); f.select('状态参考图片版本').value = 'image-1'; await f.click('选用此图'); await f.ui.saveDraft()
    await f.click('清除选图'); await f.ui.saveDraft()
    assert.equal(f.data.storyboard.continuity.entities[0].states[0].legacyReferenceOptOut, true)
    f.select('状态参考图片版本').value = 'image-1'; await f.click('选用此图'); await f.ui.saveDraft()
    assert.equal(f.data.storyboard.continuity.entities[0].states[0].legacyReferenceOptOut, undefined)
  } finally { f.cleanup() }
})
