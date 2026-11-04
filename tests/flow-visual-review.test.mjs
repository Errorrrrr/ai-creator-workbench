import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'
import { createShot, contentFingerprint } from '../src/storyboard.js'
import { makeVisualReview } from '../src/visual-review.js'

const file = (bundle, path) => bundle.texts.find(entry => entry.path === path)?.content
const manifest = bundle => JSON.parse(file(bundle, 'manifest.json'))
function fixture() {
  const documents = { s1: { title: '第一场', content: '烈日下，陆骁站在木筏上举起飞钩。' } }
  const shot = createShot({ title: '举起飞钩', visual: '陆骁站在平板木筏上', action: '右手举起飞钩', camera: '中景缓推', characterNames: ['陆骁'], sceneNames: [], propNames: ['木筏'] }, { documentId: 's1', fingerprint: contentFingerprint(documents.s1.content) })
  shot.selectedImageVersionId = 'shot-image'
  shot.references = [{ versionId: 'person-image', role: 'reference', scope: 'continuity', origin: 'manual' }, { versionId: 'raft-image', role: 'reference', scope: 'continuity', origin: 'manual' }]
  const assets = [
    { id: 'person', name: '陆骁', role: 'character', kind: 'image', projectId: 'p1', selectedVersionId: 'person-image', versions: [{ id: 'person-image', mimeType: 'image/png' }, { id: 'person-new', mimeType: 'image/png' }] },
    { id: 'raft', name: '木筏', role: 'prop', kind: 'image', projectId: 'p1', selectedVersionId: 'raft-image', versions: [{ id: 'raft-image', mimeType: 'image/png' }] },
    { id: 'shot', name: '分镜图', role: 'shot', kind: 'image', projectId: 'p1', selectedVersionId: 'shot-image', versions: [{ id: 'shot-image', mimeType: 'image/png' }, { id: 'explicit-start', mimeType: 'image/jpeg' }, { id: 'explicit-end', mimeType: 'image/png' }] }
  ]
  const continuity = { version: 1, style: '写实；烈日白昼；同一平板木筏，不添加建筑与圆木', entities: [] }
  const data = { projectId: 'p1', project: { name: '海上', type: '短剧' }, documents, storyboard: { revision: 3, shots: [shot], continuity }, connections: [{ apiKey: 'DO-NOT-EXPORT-KEY' }] }
  return { data, shot, assets, continuity, documents }
}
function review(f, decision = 'approved') {
  f.shot.visualReview = makeVisualReview(f.shot, f.assets, f.documents, f.continuity, { decision, notes: decision === 'approved' ? '已逐项核对服装、木板结构与光线' : '木筏结构与设定不同' })
}

test('Flow保留未复核图片，但明确标为候选首帧且不假称可直接生成', () => {
  const f = fixture(), before = structuredClone(f), bundle = buildFlowExport(f.data, f.assets), output = manifest(bundle).shots[0]
  assert.equal(output.visualReview.status, 'unreviewed')
  assert.equal(output.visualReview.reviewed, false)
  assert.equal(output.inputPlan.ready, false)
  assert.equal(bundle.images.length, 3)
  assert.match(file(bundle, 'shot-001/说明.md'), /候选，需先核对，不建议直接生成/)
  assert.match(file(bundle, 'shot-001/prompt.txt'), /下方文字不能把相互矛盾的图片自动变成一致画面/)
  assert.match(file(bundle, '视觉检查.md'), /人工复核通过 0 镜/)
  assert.match(file(bundle, '视觉检查.md'), /不是模型自动识图结论/)
  assert.equal(output.visualReview.baseline, f.continuity.style)
  assert.deepEqual(f, before)
})

test('已通过复核的Frames只上传首帧，设定图保留在包中供校对', () => {
  const f = fixture(); review(f)
  const bundle = buildFlowExport(f.data, f.assets), output = manifest(bundle).shots[0]
  assert.equal(output.visualReview.status, 'approved')
  assert.equal(output.inputPlan.ready, true)
  assert.deepEqual(output.inputPlan.uploadPaths, ['shot-001/ref-03.png'])
  assert.deepEqual(output.inputPlan.comparisonPaths, ['shot-001/ref-01.png', 'shot-001/ref-02.png'])
  assert.deepEqual(output.inputPlan.startPaths, output.inputPlan.uploadPaths)
  assert.equal(bundle.images.length, 3, '用于校对的设定图仍应携带')
  const guide = file(bundle, 'shot-001/说明.md'), prompt = file(bundle, 'shot-001/prompt.txt')
  assert.match(guide, /Frames 首帧：ref-03.png/)
  assert.match(guide, /不代表该模式能同时采用全部设定图/)
  assert.match(prompt, /全项目统一视觉基准/)
  for (const text of ['脸型', '服装配件', '结构、材质与比例', '光线方向', '右手举起飞钩', '中景缓推', '不重新设计外观']) assert.ok(prompt.includes(text), text)
  assert.match(file(bundle, '视觉检查.md'), /人工复核通过 1 镜/)
  assert.ok(!JSON.stringify(bundle).includes('DO-NOT-EXPORT-KEY'))
})

test('显式首尾帧覆盖选用图，但不会借用选用图的人工审核背书', () => {
  const f = fixture()
  f.shot.references.push({ versionId: 'explicit-start', role: 'start', scope: 'video' }, { versionId: 'explicit-end', role: 'end', scope: 'video' })
  review(f)
  const bundle = buildFlowExport(f.data, f.assets), output = manifest(bundle).shots[0]
  assert.equal(output.visualReview.reviewed, true)
  assert.equal(output.inputPlan.ready, false)
  assert.deepEqual(output.inputPlan.startPaths, ['shot-001/ref-03.jpg'])
  assert.deepEqual(output.inputPlan.endPaths, ['shot-001/ref-04.png'])
  assert.ok(output.inputPlan.comparisonPaths.includes('shot-001/ref-05.png'))
  assert.match(file(bundle, 'shot-001/说明.md'), /审核不能认证这些图片/)
  assert.match(file(bundle, 'shot-001/说明.md'), /首帧建议：ref-03.jpg（候选/)
  assert.equal(bundle.images.length, 5)
})

test('Ingredients清单只使用主体参考，首尾帧与已选图分别列为校对用途', () => {
  const f = fixture()
  f.shot.videoMode = 'reference-to-video'
  f.shot.references.push({ versionId: 'explicit-start', role: 'start', scope: 'video' })
  review(f)
  const bundle = buildFlowExport(f.data, f.assets), output = manifest(bundle).shots[0]
  assert.equal(output.inputPlan.mode, 'ingredients')
  assert.deepEqual(output.inputPlan.uploadPaths, ['shot-001/ref-01.png', 'shot-001/ref-02.png'])
  assert.deepEqual(output.inputPlan.startPaths, [])
  assert.deepEqual(output.inputPlan.endPaths, [])
  assert.deepEqual(output.inputPlan.comparisonPaths, ['shot-001/ref-03.jpg', 'shot-001/ref-04.png'])
  assert.match(file(bundle, 'shot-001/说明.md'), /当前 Ingredients 模式不把它们作为首尾帧输入/)
  assert.match(file(bundle, 'shot-001/说明.md'), /Ingredients 上传：ref-01.png、ref-02.png/)
  assert.doesNotMatch(file(bundle, 'shot-001/说明.md'), /Frames 首帧：/)
})

test('基准或参考固定版本变化后，导出即时标记旧审核失效并保留原审核时间', () => {
  for (const change of ['baseline', 'reference']) {
    const f = fixture(); review(f)
    const prior = structuredClone(f.shot.visualReview)
    if (change === 'baseline') f.continuity.style = '改为卡通，但木筏结构仍须一致'
    else f.shot.references[0].versionId = 'person-new'
    const bundle = buildFlowExport(f.data, f.assets), output = manifest(bundle).shots[0]
    assert.equal(output.visualReview.status, 'changed', change)
    assert.equal(output.visualReview.reviewed, false)
    assert.equal(output.inputPlan.ready, false)
    assert.equal(output.visualReview.recordedReview.reviewedAt, prior.reviewedAt)
    assert.ok(output.visualReview.changedFields.includes(change === 'baseline' ? '统一视觉基准' : '固定参考图片'))
    assert.match(file(bundle, '视觉检查.md'), /分镜图待复核/)
    assert.match(file(bundle, 'shot-001/说明.md'), /候选，需先核对/)
  }
})

test('已标记不一致的分镜图保留供修正，报告不能当成已经审核通过', () => {
  const f = fixture(); review(f, 'rejected')
  const bundle = buildFlowExport(f.data, f.assets), output = manifest(bundle).shots[0]
  assert.equal(output.visualReview.status, 'rejected')
  assert.equal(output.inputPlan.ready, false)
  assert.equal(output.visualReview.recordedReview.notes, '木筏结构与设定不同')
  assert.match(file(bundle, '视觉检查.md'), /分镜图不一致/)
  assert.equal(bundle.images.length, 3)
})

test('没有图片和未填写基准的镜头明确缺项，不编造可上传文件', () => {
  const f = fixture()
  f.shot.references = []; f.shot.selectedImageVersionId = ''; f.shot.characterNames = []; f.shot.propNames = []; f.continuity.style = ''
  const bundle = buildFlowExport(f.data, []), output = manifest(bundle).shots[0]
  assert.equal(output.visualReview.status, 'missing')
  assert.equal(output.inputPlan.mode, 'text')
  assert.deepEqual(output.inputPlan.uploadPaths, [])
  assert.equal(bundle.images.length, 0)
  assert.match(file(bundle, '视觉检查.md'), /统一视觉基准：尚未填写/)
  assert.match(file(bundle, 'shot-001/prompt.txt'), /仅文字生成不能确认跨镜头/)
})

test('首尾帧模式缺尾帧与续接缺源视频不会被报告为已准备好', () => {
  const f = fixture(); review(f)
  f.shot.videoMode = 'first-last'
  let bundle = buildFlowExport(f.data, f.assets)
  assert.equal(manifest(bundle).shots[0].inputPlan.ready, false)
  assert.match(file(bundle, 'shot-001/说明.md'), /尚未指定尾帧/)
  f.shot.videoMode = 'extend'
  bundle = buildFlowExport(f.data, f.assets)
  assert.equal(manifest(bundle).shots[0].inputPlan.mode, 'extend')
  assert.deepEqual(manifest(bundle).shots[0].inputPlan.uploadPaths, [])
  assert.match(file(bundle, 'shot-001/prompt.txt'), /不得把当前设定图或文字当作已有视频的实际末帧/)
})

test('Muse保留独立聊天协议和旧文件结构，同时携带真实视觉复核状态', () => {
  const f = fixture(); review(f)
  const bundle = buildMuseExport(f.data, f.assets), output = manifest(bundle).shots[0]
  assert.equal(output.visualReview.status, 'approved')
  assert.equal(bundle.texts.length, 5)
  assert.ok(!file(bundle, '视觉检查.md'))
  assert.match(file(bundle, 'shot-001/prompt.txt'), /Meta Muse Video/)
  assert.ok(!JSON.stringify(bundle).includes('Ingredients'))
})
