import test from 'node:test'
import assert from 'node:assert/strict'
import { createShot, shotInputFingerprint, videoReviewState, snapshotStoryboardSource, validateStoryboard } from '../src/storyboard.js'
import { shotReadiness } from '../src/shot-workflow.js'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'
import { planVideoReturn } from '../src/video-return.js'

const docs = { scene: { title: '第一场', content: '来源剧本' } }
const reviewedShot = () => {
  const shot = createShot({ visual: '角色在白天走入房间', dialogue: '你好', duration: 8 }, { documentId: 'scene' })
  shot.references = [{ versionId: 'ref-v1', role: 'reference', scope: 'continuity', origin: 'auto' }]
  shot.selectedVideoVersionId = 'video-v1'; shot.reviewedVideoVersionId = 'video-v1'
  shot.reviewedInputFingerprint = shotInputFingerprint(shot, docs)
  return shot
}
const media = [{ id: 'video', name: 'video', kind: 'video', versions: [{ id: 'video-v1', mimeType: 'video/mp4' }] }, { id: 'ref', name: '角色', kind: 'image', role: 'character', selectedVersionId: 'ref-v1', versions: [{ id: 'ref-v1', mimeType: 'image/png' }] }]

test('审核绑定制作输入，修改画面对白参考设置或来源后待复核而保留视频', () => {
  const mutations = [shot => { shot.visual += '夜色' }, shot => { shot.dialogue = '再见' }, shot => { shot.references[0].versionId = 'ref-v2' }, shot => { shot.selectedImageVersionId = 'new-image' }, shot => { shot.videoDuration = 4 }, shot => { shot.aspectRatio = '9:16' }]
  for (const mutate of mutations) {
    const shot = reviewedShot(); assert.equal(videoReviewState(shot, docs).reviewed, true)
    mutate(shot)
    assert.equal(videoReviewState(shot, docs).outdated, true)
    assert.equal(shotReadiness(shot, media, [], docs).label, '内容已变，待复核')
    assert.equal(shot.selectedVideoVersionId, 'video-v1'); assert.equal(shot.reviewedVideoVersionId, 'video-v1')
  }
  assert.equal(videoReviewState(reviewedShot(), { scene: { content: '来源改写' } }).outdated, true)
  const legacy = reviewedShot(); delete legacy.reviewedInputFingerprint
  assert.equal(shotReadiness(legacy, media, [], docs).label, '旧审核待复核')
})

test('更改引用来源标识和审核字段不改变制作指纹', () => {
  const shot = reviewedShot(), fingerprint = shotInputFingerprint(shot, docs)
  shot.references[0].origin = 'manual'; shot.reviewedVideoVersionId = ''; shot.selectedVideoVersionId = 'other-output'
  assert.equal(shotInputFingerprint(shot, docs), fingerprint)
})

test('Flow与Muse导出快照能识别镜头字段和来源改动，旧清单明确不可校验', () => {
  for (const build of [buildFlowExport, buildMuseExport]) {
    const shot = reviewedShot(), data = { projectId: 'p1', project: { name: '测试' }, storyboard: { revision: 1, shots: [shot] }, documents: docs }
    const manifest = JSON.parse(build(data, media).texts.find(item => item.path === 'manifest.json').content)
    const videos = [{ ...media[0], name: `video-${shot.id}.mp4` }]
    const unchanged = planVideoReturn({ shots: [shot], assets: videos, manifest, documents: docs })[0]
    assert.equal(unchanged.outdated, false); assert.equal(unchanged.verifiable, true)
    shot.dialogue = '修改对白'; shot.videoDuration = 4
    const changed = planVideoReturn({ shots: [shot], assets: videos, manifest, documents: docs })[0]
    assert.equal(changed.outdated, true); assert.match(changed.warnings.join(' '), /对白.*生成时长/)
    delete manifest.shots[0].inputFingerprint
    const legacy = planVideoReturn({ shots: [shot], assets: videos, manifest, documents: docs })[0]
    assert.equal(legacy.verifiable, false); assert.match(legacy.warnings.join(' '), /无法校验/)
  }
})

test('分场历史完整保留引用且与当前镜头隔离，限制10份并校验来源', () => {
  const shot = reviewedShot(), storyboard = { revision: 1, shots: [shot] }
  const version = snapshotStoryboardSource(storyboard, 'scene')
  shot.visual = '修改后'; shot.references[0].versionId = 'new'
  assert.equal(version.shots[0].visual, '角色在白天走入房间'); assert.equal(version.shots[0].references[0].versionId, 'ref-v1')
  for (let i = 0; i < 11; i++) snapshotStoryboardSource(storyboard, 'scene')
  assert.equal(storyboard.sourceVersions.length, 10); validateStoryboard(storyboard)
  storyboard.sourceVersions[0].sourceDocumentId = 'other'
  assert.throws(() => validateStoryboard(storyboard), /来源不一致/)
})
