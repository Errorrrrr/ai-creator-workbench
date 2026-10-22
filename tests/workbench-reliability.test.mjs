import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { prepareShotInputs, jobResult, ASSET_ROLES } from '../src/storyboard.js'
import { bindShotReferences } from '../src/storyboard-references.js'
import { shotReadiness } from '../src/shot-workflow.js'

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  assert.ok(match)
  const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
  return body.slice(0, end.index + end[0].length)
}
const image = (id, role = 'shot') => ({ id, name: id, role, kind: 'image', selectedVersionId: `${id}-v1`, versions: [{ id: `${id}-v1`, mimeType: 'image/png', bytes: 1024 }] })
const assets = [image('小舟', 'character'), image('客厅', 'scene'), image('手表', 'prop'), image('shot'), image('tail'), { ...image('clip'), kind: 'video', versions: [{ id: 'clip-v1', mimeType: 'video/mp4' }] }]
const shot = () => ({ id: 's1', visual: '小舟在客厅举起手表', title: '镜头', characterNames: ['小舟'], sceneNames: ['客厅'], propNames: ['手表'], references: [], selectedImageVersionId: 'shot-v1', sourceDocumentId: 'scene1', duration: 5 })

test('自动三类参考保留供分镜图使用，图生视频只传选用首帧且不修改原引用', () => {
  const s = shot(); s.references = bindShotReferences(s, assets).references
  assert.equal(s.references.length, 3)
  const before = structuredClone(s)
  const video = prepareShotInputs(s, assets, 'video')
  assert.deepEqual(video.references, [{ versionId: 'shot-v1', role: 'start' }])
  assert.equal(video.retained.length, 3)
  assert.deepEqual(s, before)
  const picture = prepareShotInputs(s, assets, 'image')
  assert.equal(picture.mode, 'edit')
  assert.deepEqual(picture.references, s.references.map(({ versionId, role }) => ({ versionId, role })))
  assert.ok(s.references.every(ref => ref.origin === 'auto' && ref.scope === 'continuity'))
})

test('参考生视频保留参考，首尾帧/续接保留显式输入，冲突不能被自动参考过滤掩盖', () => {
  const s = shot(); s.references = bindShotReferences(s, assets).references
  s.videoMode = 'reference-to-video'
  assert.equal(prepareShotInputs(s, assets, 'video').references.length, 3)
  s.videoMode = 'first-last'; s.references.push({ role: 'end', versionId: 'tail-v1', scope: 'video' })
  assert.deepEqual(prepareShotInputs(s, assets, 'video').references, [{ role: 'end', versionId: 'tail-v1' }, { role: 'start', versionId: 'shot-v1' }])
  s.videoMode = 'image-to-video'
  assert.throws(() => prepareShotInputs(s, assets, 'video'), /显式视频输入用途冲突/)
  s.references.pop(); s.references[0].scope = 'video'
  assert.throws(() => prepareShotInputs(s, assets, 'video'), /显式视频输入用途冲突/)
  s.references[0].scope = 'continuity'; s.videoMode = 'extend'
  s.references.push({ role: 'extend', versionId: 'clip-v1', scope: 'video' })
  assert.deepEqual(prepareShotInputs(s, assets, 'video').references, [{ role: 'extend', versionId: 'clip-v1' }])
  s.videoMode = 'image-to-video'; s.references.pop(); s.selectedImageVersionId = ''
  assert.throws(() => prepareShotInputs(s, assets, 'video'), /先选用一张分镜图/)
})

test('任务结果按实际 job 版本判断选用和审核，不把同素材的其他版本算作本任务', () => {
  const s = shot(), asset = image('result')
  asset.versions = ['j1', 'j2'].map(id => ({ id: `${id}-v`, metadata: { provenance: { jobId: id } } }))
  const job = { id: 'j1', assetId: asset.id, targetId: s.id, capability: 'video', status: 'completed' }
  s.selectedVideoVersionId = 'j2-v'; s.reviewedVideoVersionId = 'j2-v'
  assert.equal(jobResult(job, [asset], [s]).status, '已收录 · 待选用')
  s.selectedVideoVersionId = 'j1-v'
  assert.equal(jobResult(job, [asset], [s]).status, '已收录 · 已选用')
  s.reviewedVideoVersionId = 'j1-v'
  assert.equal(jobResult(job, [asset], [s]).status, '已收录 · 视频已审核')
  assert.equal(jobResult(job, [], [s]).status, '已收录 · 素材未找到')
  assert.equal(jobResult({ ...job, id: 'unknown' }, [asset], [s]).status, '已收录 · 版本待核对')
  asset.selectedVersionId = 'j1-v'
  assert.equal(jobResult({ ...job, capability: 'image', targetId: 'character:小舟' }, [asset], [s]).status, '已收录 · 已选用')
})

function harness() {
  const doc = { activeElement: null, listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn) } }
  class Node {
    constructor(tag = 'div', className = '', text = '') { Object.assign(this, { tag, className, textContent: text, children: [], dataset: {}, listeners: new Map(), attrs: new Map(), open: false, scrollTop: 0, value: '', disabled: false, paused: true }); this.classList = { toggle() {} } }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child) } }
    prepend(...children) { for (const child of children.reverse()) { child.parent = this; this.children.unshift(child) } }
    replaceChildren(...children) { if (this.contains(doc.activeElement)) doc.activeElement = null; this.children.forEach(child => { child.parent = null }); this.children = []; this.append(...children) }
    setAttribute(name, value) { this.attrs.set(name, value) }
    addEventListener(type, callback) { this.listeners.set(type, callback) }
    contains(target) { for (let node = target; node; node = node.parent) if (node === this) return true; return false }
    querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(node => selector === '*' || node.tag === selector || (selector === '[data-shot-focus]' && node.dataset.shotFocus) || (selector === '[data-version-id]' && node.dataset.versionId)) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    focus() { if (!this.disabled) doc.activeElement = this }
    scrollIntoView() { this.scrolled = true }
    close() { this.open = false }
    async click() { this.focus(); return this.listeners.get('click')?.({ target: this }) }
  }
  const el = (...args) => new Node(...args)
  const data = { projectId: 'p1', currentDocId: 'scene1', documents: { scene1: { title: '第一场' } }, storyboard: { shots: [shot(), { ...shot(), id: 's2', title: '镜头2' }] } }
  const env = {
    document: doc, el, Option: class extends Node { constructor(text, value) { super('option', '', text); this.value = value } },
    context: () => data, assets: structuredClone(assets), assetDrafts: new Map(), resultVersionId: '', selectedAssetId: '小舟',
    assetGrid: el('div'), assetDetail: el('section'), assetBody: el('div'), assetNotice: el('p'), roleFilter: el('select'),
    shotList: el('div'), shotBody: el('div'), shotStatus: el('p'), selectedShotId: 's1', selectedSourceId: 'scene1', selectedEpisodeId: 'episode1',
    jobsDialog: el('dialog'), lastContextDocId: null, OTHER_EPISODE: 'other', UNASSIGNED_SOURCE: 'unassigned',
    loading: false, error: '', recoveryIssues: [], ASSET_ROLES, jobs: [], shotReadiness,
    preview: () => el('div'), notify() {}, desktop() {}, run: async callback => callback(), invoke: async () => {},
    renderShotDetail() {}, visibleShots: () => data.storyboard.shots, storyboardGroups: () => [{ id: 'episode1' }],
    shotIsStale: () => false, findMediaVersion: () => null, jobResult, reorder() {}, addShot() {}, renderSources() {}
  }
  vm.createContext(env)
  vm.runInContext(['button', 'field', 'disclosure', 'actionMenu', 'renderAssets', 'renderAssetDetail', 'renderShots', 'openJobResult', 'pendingAssetDraft', 'showAssetDraft'].map(productionFunction).join('\n'), env)
  const descendants = node => node.querySelectorAll('*')
  const input = () => env.assetDetail.querySelector('input')
  const changeName = value => { input().value = value; input().listeners.get('input')() }
  const action = label => descendants(env.assetDetail).find(node => node.tag === 'button' && node.textContent === label)
  env.refresh = async () => { doc.activeElement = null; env.renderAssets() }
  return { env, data, doc, el, descendants, input, changeName, action }
}

test('素材名称与用途草稿跨轮询、切换素材和项目保留；保存失败不清理', async () => {
  const h = harness(), { env } = h
  env.renderAssets(); h.changeName('小舟的新名字')
  let role = env.assetDetail.querySelector('select'); role.value = 'prop'; role.listeners.get('change')()
  h.doc.activeElement = null; env.renderAssets()
  assert.equal(h.input().value, '小舟的新名字')
  assert.equal(env.assetDetail.querySelector('select').value, 'prop')
  env.selectedAssetId = '客厅'; env.renderAssets()
  env.selectedAssetId = '小舟'; h.data.projectId = 'p2'; env.renderAssets()
  assert.equal(h.input().value, '小舟')
  h.data.projectId = 'p1'; env.renderAssets()
  assert.equal(h.input().value, '小舟的新名字')
  env.invoke = async () => { throw new Error('测试保存失败') }
  await assert.rejects(h.action('保存素材信息').click(), /测试保存失败/)
  assert.equal(env.assetDrafts.get('p1:小舟').name, '小舟的新名字')
  env.invoke = async () => {}
  await h.action('保存素材信息').click()
  assert.equal(env.assetDrafts.size, 0)
  assert.equal(h.input().value, '小舟的新名字')
})

test('素材保存期间继续输入，包括改回旧名称，不被成功回执清理', async () => {
  for (const next of ['继续输入', '小舟']) {
    const h = harness(); h.env.renderAssets(); h.changeName('已提交名称')
    let resolve
    h.env.invoke = () => new Promise(done => { resolve = done })
    const saving = h.action('保存素材信息').click()
    h.changeName(next); resolve(); await saving
    assert.equal(h.env.assetDrafts.get('p1:小舟').name, next)
    assert.equal(h.input().value, next)
  }
})

test('镜头列表点击、轮询和排序后恢复同一操作焦点及滚动位置，详情输入不被抢焦点', async () => {
  const h = harness(), { env } = h
  env.renderShots(); env.shotList.scrollTop = 95
  const control = key => env.shotList.querySelectorAll('[data-shot-focus]').find(node => node.dataset.shotFocus === key)
  // macOS WebKit does not focus buttons on mouse click by default.
  await control('s2:select').listeners.get('click')({ target: control('s2:select') })
  assert.equal(h.doc.activeElement, control('s2:select'))
  env.renderShots({ detail: false })
  assert.equal(h.doc.activeElement, control('s2:select'))
  assert.equal(env.shotList.scrollTop, 95)
  control('s2:up').focus(); h.data.storyboard.shots.reverse(); env.renderShots()
  assert.equal(h.doc.activeElement, control('s2:select'), 'disabled ordering action falls back to selected shot')
  const field = h.el('input'); field.focus(); env.renderShots({ detail: false })
  assert.equal(h.doc.activeElement, field)
})

test('菜单 Escape 在本地消费并恢复菜单焦点，不向全局停止生成冒泡', () => {
  const h = harness(), menu = h.env.actionMenu('更多操作', [])
  menu.open = true; let prevented = false, stopped = false
  menu.listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
  assert.equal(menu.open, false)
  assert.equal(prevented, true); assert.equal(stopped, true)
  assert.equal(h.doc.activeElement, menu.querySelector('summary'))
})

test('任务定位镜头切到对应分场，查看结果切换用途过滤，不改变选用或参考版本', () => {
  const h = harness(), { env } = h
  const result = image('result', 'character'); result.versions[0].metadata = { provenance: { jobId: 'j1' } }
  env.assets.push(result)
  const job = { id: 'j1', targetId: 's2', assetId: result.id, capability: 'image', status: 'completed' }
  let destination
  env.navigate = view => { destination = view }
  env.showSource = id => { env.selectedSourceId = id; env.selectedEpisodeId = 'correct-episode' }
  const before = structuredClone(h.data.storyboard)
  env.openJobResult(job, 'shot')
  assert.equal(destination, 'storyboard')
  assert.equal(env.selectedSourceId, 'scene1')
  assert.equal(env.selectedEpisodeId, 'correct-episode')
  assert.equal(env.lastContextDocId, 'scene1')
  assert.equal(env.selectedShotId, 's2')
  env.openJobResult(job, 'asset')
  assert.equal(destination, 'assets')
  assert.equal(env.roleFilter.value, 'character')
  assert.equal(env.selectedAssetId, result.id)
  assert.equal(h.doc.activeElement.dataset.versionId, result.versions[0].id)
  assert.equal(h.doc.activeElement.scrolled, true)
  assert.deepEqual(h.data.storyboard, before)
})


test('未保存素材可定位与放弃，关闭/升级检测读取同一草稿状态', async () => {
  const h = harness(); h.env.renderAssets(); h.changeName('新名称')
  assert.deepEqual({ ...h.env.pendingAssetDraft() }, { projectId: 'p1', assetId: '小舟' })
  h.env.navigate = () => {}
  h.env.selectedAssetId = '客厅'; h.env.renderAssets()
  h.env.showAssetDraft('小舟')
  assert.equal(h.input().value, '新名称')
  await h.action('放弃未保存修改').click()
  assert.equal(h.env.pendingAssetDraft(), null)
  assert.equal(h.input().value, '小舟')
})


test('任务时间支持桌面存储的毫秒字符串和导入的 ISO 时间，缺失或非法值才标未记录', () => {
  const env = {}; vm.createContext(env); vm.runInContext(productionFunction('mediaTimeLabel'), env)
  const time = Date.parse('2026-10-23T08:45:12Z')
  const expected = new Date(time).toLocaleString('zh-CN', { hour12: false })
  for (const value of [time, String(time), '2026-10-23T08:45:12Z']) assert.equal(env.mediaTimeLabel(value), expected)
  for (const value of [null, undefined, '', 'invalid']) assert.equal(env.mediaTimeLabel(value), '未记录')
})
