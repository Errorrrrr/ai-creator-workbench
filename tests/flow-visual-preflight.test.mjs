import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createShot, contentFingerprint } from '../src/storyboard.js'
import { imageVisualReviewState, makeVisualReview } from '../src/visual-review.js'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'
import { planReferenceBackfill } from '../src/storyboard-references.js'
import { singleSceneExport, storyboardExportScope } from '../src/storyboard-scope.js'

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('  function checkFlowVisualExport('), source.indexOf('  async function exportContinuity('))

class Element {
  constructor(tag, className = '', text = '') { this.tagName = tag; this.className = className; this.textContent = text; this.children = []; this.listeners = new Map(); this.attributes = {}; this.open = false }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  setAttribute(name, value) { this.attributes[name] = value }
  addEventListener(name, callback) { const list = this.listeners.get(name) || []; list.push(callback); this.listeners.set(name, list) }
  dispatch(name, event = {}) { for (const callback of this.listeners.get(name) || []) callback(event) }
  showModal() { this.open = true }
  close() { if (!this.open) return; this.open = false; this.dispatch('close') }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null }
}
const descendants = node => [node, ...node.children.flatMap(descendants)]
function harness({ approved = false } = {}) {
  const documents = { s1: { title: '第一场', content: '海面上的人物近景' } }
  const shot = createShot({ title: '人物近景', visual: '人物在海面漂浮的木筏上', characterNames: [], sceneNames: [], propNames: [] }, { documentId: 's1', fingerprint: contentFingerprint(documents.s1.content) })
  shot.selectedImageVersionId = 'still'
  const assets = [{ id: 'image', projectId: 'p1', role: 'shot', kind: 'image', name: '选用分镜图', selectedVersionId: 'still', versions: [{ id: 'still', mimeType: 'image/png' }, { id: 'other-frame', mimeType: 'image/png' }] }]
  const continuity = { version: 1, style: '统一写实，固定人物服装与木筏结构', entities: [] }
  if (approved) shot.visualReview = makeVisualReview(shot, assets, documents, continuity, { decision: 'approved', notes: '已逐项核对' })
  const state = { projectId: 'p1', project: { name: '海上', type: '短剧' }, documents, structure: { acts: [{ episodeIds: ['ep1'] }], episodes: { ep1: { sceneIds: ['s1'] } } }, storyboard: { revision: 2, shots: [shot], continuity } }
  const body = new Element('body'), calls = [], opened = [], notices = []
  const env = { structuredClone, JSON, Promise, Map, Set, imageVisualReviewState, buildFlowExport, buildMuseExport, planReferenceBackfill, singleSceneExport, storyboardExportScope,
    document: { body }, el: (...args) => new Element(...args), button: (label, action, className = '') => { const node = new Element('button', className, label); node.addEventListener('click', action); return node },
    context: () => state, selectedEpisodeId: 'ep1', selectedSourceId: 's1', visibleShots: data => data.storyboard.shots, requireProject() {}, desktop() {}, run: action => action(), notify: value => notices.push(value),
    visualReviewUI: { open: options => opened.push(options) }, invoke: async (command, payload) => { calls.push({ command, payload }); return command === 'media_list' ? { assets } : '/导出/Flow素材包' }
  }
  vm.createContext(env); vm.runInContext(code, env)
  const dialog = () => body.children.find(node => node.tagName === 'dialog')
  const choose = label => { const node = descendants(dialog()).find(item => item.tagName === 'button' && item.textContent === label); assert.ok(node, `按钮不存在：${label}`); node.dispatch('click') }
  const untilDialog = async () => { for (let index = 0; index < 10 && !dialog(); index++) await Promise.resolve(); assert.ok(dialog(), '应展示导出前检查对话框') }
  return { env, state, shot, assets, continuity, documents, body, calls, opened, notices, dialog, choose, untilDialog }
}

test('Flow全部已复核时无多余确认，直接使用当前状态导出', async () => {
  const h = harness({ approved: true })
  assert.equal(await h.env.checkFlowVisualExport(h.state, h.assets), 'export')
  assert.equal(h.body.children.length, 0)
  assert.equal(await h.env.exportVideoBundle(buildFlowExport, 'media_export_flow'), '/导出/Flow素材包')
  assert.deepEqual(h.calls.map(call => call.command), ['media_list', 'media_export_flow'])
})

test('Flow检查真实展示待办，取消及Escape都不导出、不改变审核状态', async () => {
  for (const action of ['button', 'escape']) {
    const h = harness(), before = structuredClone(h.state)
    const result = h.env.exportVideoBundle(buildFlowExport, 'media_export_flow')
    await h.untilDialog()
    assert.equal(h.dialog().attributes['aria-label'], 'Flow 导出前视觉检查')
    assert.ok(descendants(h.dialog()).some(node => node.textContent.includes('人物近景')))
    if (action === 'button') h.choose('取消')
    else { let prevented = false; h.dialog().dispatch('cancel', { preventDefault() { prevented = true } }); assert.equal(prevented, true) }
    assert.equal(await result, undefined)
    assert.deepEqual(h.calls.map(call => call.command), ['media_list'])
    assert.equal(h.body.children.length, 0)
    assert.deepEqual(h.state, before)
  }
})

test('返回视觉复核会打开当前范围的检查面板，释放操作后不调用导出', async () => {
  const h = harness(), result = h.env.exportVideoBundle(buildFlowExport, 'media_export_flow')
  await h.untilDialog(); h.choose('返回视觉复核'); await result
  assert.deepEqual(h.calls.map(call => call.command), ['media_list'])
  assert.deepEqual(JSON.parse(JSON.stringify(h.opened)), [{ shotIds: [h.shot.id] }])
  assert.equal(h.shot.visualReview, undefined)
})

test('用户选择仍导出当前范围，包内保留已通过和待复核镜头', async () => {
  const h = harness()
  const approved = createShot({ title: '已通过镜头', visual: '相邻的海面空镜', characterNames: [], sceneNames: [], propNames: [] }, { documentId: 's1' })
  approved.selectedImageVersionId = 'still'
  approved.visualReview = makeVisualReview(approved, h.assets, h.documents, h.continuity, { decision: 'approved' }, h.state)
  h.state.storyboard.shots.push(approved)
  const result = h.env.exportVideoBundle(buildFlowExport, 'media_export_flow')
  await h.untilDialog(); h.choose('仍导出当前范围')
  assert.equal(await result, '/导出/Flow素材包')
  assert.equal(h.calls[1].command, 'media_export_flow')
  const bundle = h.calls[1].payload.bundle, manifest = JSON.parse(bundle.texts.find(file => file.path === 'manifest.json').content)
  assert.equal(manifest.shots[0].visualReview.reviewed, false)
  assert.equal(manifest.shots[0].inputPlan.ready, false)
  assert.deepEqual(manifest.shots.map(shot => shot.id), [h.shot.id, approved.id])
  assert.equal(manifest.shots[1].visualReview.reviewed, true)
  assert.ok(bundle.texts.find(file => file.path === '视觉检查.md'))
  assert.equal(h.shot.visualReview, undefined)
})

test('检查期间项目、分镜或来源剧本变化后，拒绝继续导出旧快照', async () => {
  for (const change of ['project', 'storyboard', 'source']) {
    const h = harness(), result = h.env.exportVideoBundle(buildFlowExport, 'media_export_flow')
    await h.untilDialog()
    if (change === 'project') h.state.projectId = 'p2'
    else if (change === 'storyboard') h.state.storyboard.revision++
    else h.state.documents.s1.content += ' 修改了人物外观与地点'
    h.choose('仍导出当前范围')
    await assert.rejects(result, /已变化|变更|重新检查|重新导出/, change)
    assert.deepEqual(h.calls.map(call => call.command), ['media_list'])
  }
})

test('已复核选用图不掩盖不同显式首帧的核对待办', async () => {
  const h = harness()
  h.shot.references = [{ versionId: 'other-frame', role: 'start', scope: 'video', origin: 'manual' }]
  h.shot.visualReview = makeVisualReview(h.shot, h.assets, h.documents, h.continuity, { decision: 'approved' })
  const result = h.env.checkFlowVisualExport(h.state, h.assets)
  await h.untilDialog()
  assert.ok(descendants(h.dialog()).some(node => /首尾帧|首帧/.test(node.textContent)))
  h.choose('取消')
  assert.equal(await result, 'cancel')
})
