import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'
import { createShot } from '../src/storyboard.js'
import { planReferenceBackfill } from '../src/storyboard-references.js'

const asset = { name: '角色甲', role: 'character', selectedVersionId: 'new', versions: [{ id: 'fixed', mimeType: 'image/png' }, { id: 'new', mimeType: 'image/jpeg' }, { id: 'video', mimeType: 'video/mp4' }] }
function context(shots) { return { project: { name: '测试项目', type: '短剧' }, storyboard: { revision: 3, shots }, documents: {}, connections: [{ apiKey: 'DO-NOT-EXPORT' }] } }
test('exports pinned versions, deduplicates shared roles and preserves shot order and content', () => {
  const first = createShot({ title: '../第一镜', visual: '雨中的街道', action: '向左走', dialogue: '你好', camera: '缓慢推近' })
  first.selectedImageVersionId = 'fixed'
  first.references = [{ role: 'reference', versionId: 'fixed' }, { role: 'start', versionId: 'fixed' }]
  const data = context([first, createShot({ title: '第二镜' })]), original = structuredClone(data)
  const bundle = buildFlowExport(data, [asset])
  assert.deepEqual(bundle.images, [{ path: 'shot-001/ref-01.png', versionId: 'fixed' }])
  const manifest = JSON.parse(bundle.texts.find(file => file.path === 'manifest.json').content)
  assert.deepEqual(manifest.shots.map(shot => shot.title), ['../第一镜', '第二镜'])
  assert.deepEqual(manifest.shots[0].references[0].roles, ['reference', 'start', 'selected'])
  const prompt = bundle.texts.find(file => file.path === 'shot-001/prompt.txt').content
  for (const text of ['雨中的街道', '向左走', '你好', '缓慢推近']) assert.ok(prompt.includes(text))
  assert.ok(!JSON.stringify(bundle).includes('DO-NOT-EXPORT'))
  assert.deepEqual(data, original)
})
test('reports absent images, stale sources and skipped videos without inventing files', () => {
  const shot = createShot({ title: '镜头' }, { documentId: 'gone', fingerprint: 'old' })
  shot.references = [{ role: 'extend', versionId: 'video' }]
  shot.videoMode = 'extend'
  const bundle = buildFlowExport(context([shot]), [asset])
  assert.equal(bundle.images.length, 0)
  const guide = bundle.texts.find(file => file.path === 'shot-001/说明.md').content
  for (const text of ['没有参考图片', '剧本来源已更新', '不是图片', '视频续接']) assert.ok(guide.includes(text))
})
test('missing bound versions and empty storyboards fail explicitly', () => {
  assert.throws(() => buildFlowExport(context([]), []), /尚无分镜/)
  const shot = createShot(); shot.selectedImageVersionId = 'missing'
  assert.throws(() => buildFlowExport(context([shot]), [asset]), /版本不存在/)
})
test('explicit start frame wins over selected image, end frame and ingredient roles stay distinct', () => {
  const shot = createShot(); shot.selectedImageVersionId = 'fixed'
  shot.references = [{ role: 'start', versionId: 'new' }, { role: 'end', versionId: 'fixed' }]
  const bundle = buildFlowExport(context([shot]), [asset])
  const guide = bundle.texts.find(file => file.path === 'shot-001/说明.md').content
  assert.match(guide, /首帧建议：ref-01.jpg/)
  assert.match(guide, /尾帧建议：ref-02.png/)
  shot.videoMode = 'reference-to-video'
  assert.match(buildFlowExport(context([shot]), [asset]).texts[1].content, /建议入口：Ingredients/)
})

test('UI exports a snapshot without any video connection and refuses a project switch during media loading', async () => {
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('  async function exportFlow() {'), source.indexOf('  async function exportPackage() {'))
  for (const target of ['flow', 'muse']) for (const switched of [false, true]) {
    const state = { ...context([createShot({ visual: '当前未保存的修改' }), createShot({ visual: '另一场不应导出' })]), projectId: 'project-1', connections: [] }
    const calls = [], notices = []
    const env = { planReferenceBackfill, visibleShots: data => data.storyboard.shots.slice(0, 1), structuredClone, buildFlowExport, buildMuseExport, context: () => state, desktop() {}, requireProject() {}, notify: message => notices.push(message), run: async action => { try { await action() } catch (error) { notices.push(error.message) } }, invoke: async (command, payload) => {
      calls.push({ command, payload })
      if (command === 'media_list') { if (switched) state.projectId = 'project-2'; return { assets: [] } }
      return '已导出'
    } }
    vm.createContext(env); vm.runInContext(`${handler}\nthis.submit = ${target === 'flow' ? 'exportFlow' : 'exportMuse'}`, env)
    await env.submit()
    assert.deepEqual(calls.map(call => call.command), switched ? ['media_list'] : ['media_list', `media_export_${target}`])
    if (switched) assert.match(notices[0], /项目已切换/)
    else { assert.match(calls[1].payload.bundle.texts[0].content, /当前未保存的修改/); assert.equal(calls[1].payload.projectId, 'project-1'); assert.ok(!JSON.stringify(calls[1].payload.bundle).includes('另一场不应导出')) }
  }
})
