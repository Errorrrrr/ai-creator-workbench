import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'
import { createShot } from '../src/storyboard.js'

const assets = [{ name: '苏遥', role: 'character', selectedVersionId: 'new', versions: [
  { id: 'fixed', mimeType: 'image/png' }, { id: 'new', mimeType: 'image/jpeg' }, { id: 'clip', mimeType: 'video/mp4' }
] }]
function data(shots) { return { project: { name: '雨夜', type: '短剧' }, storyboard: { revision: 1, shots }, documents: {}, connections: [{ apiKey: 'NEVER-EXPORT' }] } }
const file = (bundle, path) => bundle.texts.find(entry => entry.path === path)?.content

test('Muse messages request actual video with dialogue, target duration and explicit attachment roles', () => {
  const shot = createShot({ title: '进入街道', visual: '雨中的街道', action: '向左走', camera: '跟拍', dialogue: '苏遥：别走！', duration: 6, entryState: '门外', exitState: '路灯下', transition: 'continuous' })
  shot.aspectRatio = '9:16'; shot.selectedImageVersionId = 'fixed'
  shot.references = [{ versionId: 'new', role: 'start' }, { versionId: 'fixed', role: 'reference' }, { versionId: 'fixed', role: 'end' }]
  const state = data([shot]), before = structuredClone(state)
  const bundle = buildMuseExport(state, assets), prompt = file(bundle, 'shot-001/prompt.txt')
  for (const text of ['Meta Muse Video', '视频片段', '6 秒', '9:16', '苏遥：别走！', '跟拍', '门外', '路灯下', '附件 1（ref-01.jpg）', '附件 2（ref-02.png）', '期望开场画面参考：ref-01.jpg', '期望结束画面参考：ref-02.png', '若不能精确约束首尾帧', '如果无法满足', '仅处理这一镜头']) assert.ok(prompt.includes(text), text)
  assert.equal(bundle.images.length, 2)
  assert.equal(bundle.images[1].versionId, 'fixed')
  const manifest = JSON.parse(file(bundle, 'manifest.json'))
  assert.equal(manifest.format, 'meta-muse-chat-handoff')
  assert.deepEqual(manifest.shots[0].references[1].roles, ['reference', 'end', 'selected'])
  assert.match(file(bundle, 'shot-001/修改消息.txt'), /填写具体时间点/)
  assert.match(file(bundle, '使用说明.md'), /https:\/\/muse.ai\//)
  assert.ok(!JSON.stringify(bundle).includes('NEVER-EXPORT'))
  assert.ok(!JSON.stringify(bundle).includes('Flow'))
  assert.ok(!JSON.stringify(bundle).includes('Ingredients'))
  assert.deepEqual(state, before)
})

test('Muse handles text-only shots without fictional attachments or dialogue', () => {
  const bundle = buildMuseExport(data([createShot({ visual: '海面' })]), [])
  assert.equal(bundle.images.length, 0)
  assert.match(file(bundle, 'shot-001/prompt.txt'), /没有附参考图/)
  assert.match(file(bundle, 'shot-001/prompt.txt'), /不添加人物对白或旁白/)
  assert.ok(!file(bundle, 'shot-001/prompt.txt').includes('附件 1'))
  assert.match(file(bundle, 'shot-001/说明.md'), /没有参考图片/)
})

test('Muse reports stale sources, unresolved versions and unsupported video handoff', () => {
  assert.throws(() => buildMuseExport(data([]), assets), /尚无分镜/)
  const shot = createShot({}, { documentId: 'removed', fingerprint: 'old' })
  shot.references = [{ role: 'extend', versionId: 'clip' }]; shot.videoMode = 'extend'
  const bundle = buildMuseExport(data([shot]), assets)
  assert.match(file(bundle, 'shot-001/说明.md'), /剧本来源已更新/)
  assert.match(file(bundle, 'shot-001/prompt.txt'), /本包未附源视频/)
  assert.equal(bundle.images.length, 0)
  shot.selectedImageVersionId = 'missing'
  assert.throws(() => buildMuseExport(data([shot]), assets), /版本不存在/)
})

test('120-shot Muse export stays within backend limits; Flow stays a separate handoff', () => {
  const shots = Array.from({ length: 120 }, (_, index) => createShot({ title: `镜头 ${index + 1}` }))
  const bundle = buildMuseExport(data(shots), [])
  assert.equal(bundle.texts.length, 362)
  assert.equal(new Set(bundle.texts.map(entry => entry.path)).size, 362)
  assert.ok(file(bundle, 'shot-120/修改消息.txt'))
  const flow = buildFlowExport(data([shots[0]]), [])
  assert.equal(flow.texts.length, 4)
  assert.equal(JSON.parse(file(flow, 'manifest.json')).format, 'google-flow-handoff')
  assert.ok(!JSON.stringify(flow).includes('Muse'))
})
