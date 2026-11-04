import test from 'node:test'
import assert from 'node:assert/strict'
import { createShot, contentFingerprint, mediaPrompt, storyboardPrompt, parseStoryboardCandidate, shotProductionInputs, shotInputFingerprint, shotInputFieldFingerprints, videoReviewState, jobResult } from '../src/storyboard.js'
import { createEntity, entityStateFingerprint } from '../src/continuity-assets.js'
import { emptySceneContinuity, sceneContinuityContext } from '../src/scene-continuity.js'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'
import { planReferenceBackfill } from '../src/storyboard-references.js'
import { planVideoReturn } from '../src/video-return.js'
import { visualInputSnapshot, visualInputFingerprint, makeVisualReview, imageVisualReviewState, validateVisualRecord } from '../src/visual-review.js'

function fixture() {
  const bag = createEntity({ id: 'bag', kind: 'prop', name: '背包', traits: '灰色帆布，只有两个黄铜扣', sourceDocumentIds: ['s1', 's2'], states: [
    { id: 'stern', name: '放在船尾', description: '背包在船尾木箱上' },
    { id: 'back', name: '背在身上', description: '人物将背包背在身后', basedOnStateId: 'stern' }
  ] })
  const boat = createEntity({ id: 'boat', kind: 'scene', name: '船舱', traits: '北墙只有一扇圆窗，木箱固定在船尾', sourceDocumentIds: ['s2'] })
  const documents = {
    s1: { title: '第一场', content: '她把背包放在船尾木箱上。' },
    s2: { title: '第二场', content: '她回到船舱，取回背包，背在身上。' },
    s3: { title: '第三场', content: '未来秘密：藏宝洞出现三头龙。' }
  }
  documents.s1.sceneContinuity = { ...emptySceneContinuity(), exitState: '背包留在船尾木箱上', exitBindings: [{ entityId: 'bag', stateId: 'stern' }], sourceFingerprint: contentFingerprint(documents.s1.content) }
  documents.s2.sceneContinuity = { ...emptySceneContinuity(), transition: 'continuous', entryState: '背包位于船尾木箱', changes: '取包并背上', exitState: '背包位于人物背上', entryBindings: [{ entityId: 'bag', stateId: 'stern' }], exitBindings: [{ entityId: 'bag', stateId: 'back' }], sourceFingerprint: contentFingerprint(documents.s2.content) }
  const shot = createShot({ title: '取回背包', visual: '船舱中，她从船尾木箱上拿起背包', action: '拿起背包', camera: '中景固定', propNames: ['背包'], sceneNames: ['船舱'], characterNames: [] }, { documentId: 's2', fingerprint: contentFingerprint(documents.s2.content) })
  shot.selectedImageVersionId = 'selected'
  const storyboard = { revision: 1, shots: [shot], continuity: { version: 1, style: '写实电影', entities: [bag, boat] } }
  for (const entity of [bag, boat]) {
    const state = entity.states.find(item => item.id === entity.defaultStateId)
    state.referenceVersionId = `${entity.id}-image`
    state.referenceFingerprint = entityStateFingerprint(entity, state, storyboard.continuity.style)
    shot.references.push({ versionId: state.referenceVersionId, role: 'reference', scope: 'continuity', origin: 'auto', entityId: entity.id, stateId: state.id })
  }
  const structure = { acts: [{ episodeIds: ['ep1'] }], episodes: { ep1: { sceneIds: ['s1', 's2', 's3'] } } }
  const assets = [{ id: 'image', projectId: 'p', role: 'shot', kind: 'image', name: '本镜分镜图', versions: [{ id: 'selected', mimeType: 'image/png' }, { id: 'previous', mimeType: 'image/png' }] },
    ...[bag, boat].map(entity => ({ id: `${entity.id}-asset`, projectId: 'p', role: entity.kind, kind: 'image', name: entity.name, selectedVersionId: `${entity.id}-image`, versions: [{ id: `${entity.id}-image`, mimeType: 'image/png' }] }))]
  const data = { projectId: 'p', project: { name: '海上', type: '短剧' }, storyboard, documents, structure }
  return { data, assets, shot, bag, documents, structure, storyboard }
}
const file = (bundle, path) => bundle.texts.find(item => item.path === path)?.content
const manifest = bundle => JSON.parse(file(bundle, 'manifest.json'))

test('手选异版的导出视频回填使用完整参考库，未变化时不误报过期', () => {
  const f = fixture()
  f.assets.find(asset => asset.role === 'prop').versions.push({ id: 'bag-picked', mimeType: 'image/png' })
  f.shot.references = f.shot.references.filter(ref => ref.entityId !== 'bag')
  f.shot.references.push({ versionId: 'bag-picked', role: 'reference', scope: 'continuity', origin: 'manual' })
  Object.assign(f.shot, planReferenceBackfill(f.storyboard, f.assets, f.documents, f.data.projectId).storyboard.shots[0])
  const exported = manifest(buildFlowExport(f.data, f.assets))
  const video = { id: 'download', kind: 'video', name: 'shot-001.mp4', versions: [{ id: 'video-v1', name: 'shot-001.mp4', mimeType: 'video/mp4' }] }
  const options = { shots: [f.shot], assets: [video], referenceAssets: [...f.assets, video], manifest: exported, documents: f.documents, structure: f.structure, storyboard: f.storyboard }
  assert.equal(planVideoReturn(options)[0].outdated, false)
  f.documents.s2.sceneContinuity.exitState += '，已扣好肩带'
  const changed = planVideoReturn(options)[0]
  assert.equal(changed.outdated, true)
  assert.ok(changed.warnings.some(value => value.includes('素材与分场状态承接')))
})

test('任务列表按完整分场约束识别已审核视频', () => {
  const f = fixture()
  const video = { id: 'download', kind: 'video', versions: [{ id: 'video-v1', mimeType: 'video/mp4', metadata: { provenance: { jobId: 'job' } } }] }
  const assets = [...f.assets, video]
  f.shot.selectedVideoVersionId = 'video-v1'; f.shot.reviewedVideoVersionId = 'video-v1'
  f.shot.reviewedInputFingerprint = shotInputFingerprint(f.shot, f.documents, { ...f.data, assets })
  const job = { id: 'job', assetId: 'download', targetId: f.shot.id, capability: 'video', status: 'completed' }
  assert.equal(jobResult(job, assets, [f.shot], f.documents, f.data).status, '已收录 · 视频已审核')
  f.documents.s2.sceneContinuity.changes += '，扣好肩带'
  assert.equal(jobResult(job, assets, [f.shot], f.documents, f.data).status, '已收录 · 已选用')
})

test('拆镜提示携带分场边界和变化；模型返回明确冲突时保留候选并阻止采纳', () => {
  const f = fixture(), scene = sceneContinuityContext({ ...f.data, documentId: 's2' })
  const prompt = storyboardPrompt('', [], { sceneContinuity: scene.text })
  for (const value of ['取包并背上', '两个黄铜扣', '北墙只有一扇圆窗', '不把每个镜头重置', 'conflicts']) assert.ok(prompt.includes(value), value)
  assert.doesNotMatch(prompt, /三头龙/)
  assert.throws(() => parseStoryboardCandidate(JSON.stringify({ shots: [], conflicts: ['入口是空船，但本场动作要求拾起原有背包'] })), /分镜连续性冲突.*入口是空船.*候选已保留/)
  assert.throws(() => parseStoryboardCandidate(JSON.stringify({ shots: [{ visual: '可见画面' }], conflicts: [7] })), /连续性冲突说明无效/)
  assert.equal(parseStoryboardCandidate(JSON.stringify({ shots: [{ visual: '可见画面' }], conflicts: [] })).length, 1)
})

test('媒体提示词带入相关素材和前场实际状态，不泄露未来场也不改动图片输入', () => {
  const f = fixture(), before = structuredClone(f)
  const prompt = mediaPrompt(f.shot, f.data.project, ['输入 1：本镜分镜图'], f.data)
  for (const value of ['背包位于船尾木箱', '背包位于人物背上', '取包并背上', '放在船尾', '两个黄铜扣', '不擅自选择一套设定', '不要求每个镜头重复整场动作']) assert.ok(prompt.includes(value), value)
  assert.doesNotMatch(prompt, /三头龙|藏宝洞/)
  assert.equal((prompt.match(/素材与分场连续性约束：/g) || []).length, 1)
  assert.deepEqual(f, before)
  assert.ok(mediaPrompt(f.shot, f.data.project).includes('拿起背包'), '旧三参数调用保留')
  assert.doesNotThrow(() => mediaPrompt({ ...f.shot, sourceDocumentId: 'missing' }, f.data.project, [], f.data))
})

test('Flow和Muse导出都保留分场约束，实际首帧仍是本镜选图', () => {
  const f = fixture(), before = structuredClone(f)
  for (const build of [buildFlowExport, buildMuseExport]) {
    const bundle = build(f.data, f.assets), output = manifest(bundle).shots[0]
    for (const value of ['两个黄铜扣', '取包并背上', '背包留在船尾木箱上']) assert.ok(file(bundle, 'shot-001/prompt.txt').includes(value), value)
    assert.match(file(bundle, 'shot-001/说明.md'), /素材与分场状态承接/)
    assert.doesNotMatch(file(bundle, 'shot-001/prompt.txt'), /三头龙/)
    assert.equal(bundle.images.length, 3)
    assert.ok(bundle.images.some(image => image.versionId === 'selected'))
    assert.ok(bundle.images.every(image => image.versionId !== 'previous'))
    assert.ok(output.inputSnapshot.sceneConstraints)
    const synchronized = planReferenceBackfill(f.storyboard, f.assets, f.documents, f.data.projectId).storyboard
    assert.equal(output.inputFingerprint, shotInputFingerprint(synchronized.shots[0], f.documents, { ...f.data, storyboard: synchronized, assets: f.assets }))
  }
  assert.deepEqual(f, before)
})

test('连续入口与前场出口明确不同时，导出提示冲突且不能沿用旧图片审核宣称可生成', () => {
  const f = fixture()
  f.shot.visualReview = makeVisualReview(f.shot, f.assets, f.documents, f.storyboard.continuity, { decision: 'approved' }, f.data)
  f.documents.s2.sceneContinuity.entryBindings[0].stateId = 'back'
  for (const build of [buildFlowExport, buildMuseExport]) {
    const bundle = build(f.data, f.assets), output = manifest(bundle).shots[0]
    assert.ok(output.warnings.some(value => value.includes('连续动作衔接冲突')))
    assert.match(file(bundle, 'shot-001/prompt.txt'), /连续动作衔接冲突/)
    assert.match(file(bundle, 'shot-001/说明.md'), /分场连续性冲突/)
    if (output.inputPlan) assert.equal(output.inputPlan.ready, false)
    assert.equal(output.visualReview.reviewed, false)
  }
  assert.throws(() => makeVisualReview(f.shot, f.assets, f.documents, f.storyboard.continuity, { decision: 'approved' }, f.data), /先处理参考问题.*分场连续性冲突/)
})

test('本场边界、前场结束和相关素材变化使视觉及视频审核失效，未来场变化不影响', () => {
  for (const mutate of [
    f => { f.documents.s2.sceneContinuity.exitState += '，衣服湿透' },
    f => { f.documents.s1.sceneContinuity.exitState += '，木箱盖打开' },
    f => { f.bag.traits += '，背带有红色补丁' }
  ]) {
    const f = fixture()
    f.shot.visualReview = makeVisualReview(f.shot, f.assets, f.documents, f.storyboard.continuity, { decision: 'approved' }, f.data)
    assert.doesNotThrow(() => validateVisualRecord(f.shot.visualReview, { review: true }))
    f.shot.selectedVideoVersionId = 'video'; f.shot.reviewedVideoVersionId = 'video'; f.shot.reviewedInputFingerprint = shotInputFingerprint(f.shot, f.documents, f.data)
    mutate(f)
    const review = imageVisualReviewState(f.shot, f.assets, f.documents, f.storyboard.continuity, f.data)
    assert.equal(review.reviewed, false)
    assert.ok(review.changedFields.includes('素材与分场状态承接'))
    assert.equal(videoReviewState(f.shot, f.documents, f.data).reviewed, false)
  }
  const f = fixture(), before = visualInputFingerprint(f.shot, f.assets, f.documents, f.storyboard.continuity, f.data), video = shotInputFingerprint(f.shot, f.documents, f.data)
  f.documents.s3.sceneContinuity = { ...emptySceneContinuity(), entryState: '未来场内容发生变化' }
  f.documents.s3.content = '未来正文也变化'
  assert.equal(visualInputFingerprint(f.shot, f.assets, f.documents, f.storyboard.continuity, f.data), before)
  assert.equal(shotInputFingerprint(f.shot, f.documents, f.data), video)
})

test('无分场状态的旧项目不新增审核字段，无归属镜头保持兼容', () => {
  const f = fixture()
  delete f.documents.s1.sceneContinuity; delete f.documents.s2.sceneContinuity
  const old = shotInputFingerprint(f.shot, f.documents)
  assert.equal(shotInputFingerprint(f.shot, f.documents, f.data), old)
  assert.equal(shotProductionInputs(f.shot, f.documents, f.data).sceneConstraints, undefined)
  assert.equal(shotInputFieldFingerprints(f.shot, f.documents, f.data).sceneConstraints, undefined)
  assert.equal(visualInputSnapshot(f.shot, f.assets, f.documents, f.storyboard.continuity, f.data).sceneContinuity, undefined)
  assert.doesNotThrow(() => visualInputSnapshot({ ...f.shot, sourceDocumentId: '' }, f.assets, f.documents, f.storyboard.continuity, f.data))
})

test('手动排除设定不重新注入固定特征，也不抹掉本场已写明的状态文字', () => {
  const f = fixture()
  f.shot.referenceExclusions = ['prop:@bag']
  const prompt = mediaPrompt(f.shot, f.data.project, [], { ...f.data, assets: f.assets })
  assert.doesNotMatch(prompt, /两个黄铜扣/)
  assert.match(prompt, /背包位于船尾木箱/)
  assert.match(prompt, /背包位于人物背上/)
  assert.match(prompt, /已手动排除/)
  f.shot.visualReview = makeVisualReview(f.shot, f.assets, f.documents, f.storyboard.continuity, { decision: 'approved' }, f.data)
  const before = visualInputFingerprint(f.shot, f.assets, f.documents, f.storyboard.continuity, f.data)
  f.bag.traits += '，不应重新注入的红色标识'
  assert.equal(visualInputFingerprint(f.shot, f.assets, f.documents, f.storyboard.continuity, f.data), before)
  assert.equal(imageVisualReviewState(f.shot, f.assets, f.documents, f.storyboard.continuity, f.data).reviewed, true)
  for (const build of [buildFlowExport, buildMuseExport]) {
    const bundle = build(f.data, f.assets)
    assert.doesNotMatch(file(bundle, 'shot-001/prompt.txt'), /两个黄铜扣|不应重新注入的红色标识/)
    assert.match(file(bundle, 'shot-001/prompt.txt'), /背包位于船尾木箱/)
    assert.ok(bundle.images.every(image => image.versionId !== 'bag-image'))
  }
})

test('真实素材库中的手选异版被识别为待核对，导出保留实际版本和用途', () => {
  const f = fixture()
  f.assets.find(asset => asset.role === 'prop').versions.push({ id: 'bag-handpicked', mimeType: 'image/png' })
  f.shot.references = f.shot.references.filter(ref => ref.entityId !== 'bag')
  f.shot.references.push({ versionId: 'bag-handpicked', role: 'reference', scope: 'continuity', origin: 'manual' })
  const context = { ...f.data, assets: f.assets }, before = structuredClone(f)
  assert.match(mediaPrompt(f.shot, f.data.project, [], context), /已手动选用其他参考图.*保留人工选择/)
  for (const build of [buildFlowExport, buildMuseExport]) {
    const bundle = build(f.data, f.assets)
    assert.ok(bundle.images.some(image => image.versionId === 'bag-handpicked'))
    assert.ok(bundle.images.every(image => image.versionId !== 'bag-image'))
    assert.match(file(bundle, 'shot-001/prompt.txt'), /未强加规范设定/)
    assert.doesNotMatch(file(bundle, 'shot-001/prompt.txt'), /两个黄铜扣/)
    assert.match(file(bundle, 'shot-001/说明.md'), /保留人工选择/)
  }
  assert.deepEqual(f, before)
})
