import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVideoManifest, planVideoReturn, applyVideoReturn } from '../src/video-return.js'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'
import { createShot } from '../src/storyboard.js'
import { shotReadiness, shotStagePanel } from '../src/shot-workflow.js'
import { creationSteps } from '../src/workflow-navigation.js'

const shots = ['第一镜', '第二镜'].map(title => createShot({ title, visual: '海面' }))
const asset = (name, id = name) => ({ id, name, kind: 'video', versions: [{ id: `${id}-v`, name, mimeType: 'video/mp4' }] })
const manifest = () => ({ format: 'google-flow-handoff', version: 1, projectId: 'p1', shots: shots.map((shot, index) => ({ ...shot, number: index + 1 })) })

test('回填按导出时清单匹配，当前镜头重新排序不改变对应关系', () => {
  const parsed = parseVideoManifest(JSON.stringify(manifest()), 'p1')
  const rows = planVideoReturn({ shots: [...shots].reverse(), assets: [asset('shot-001.mp4'), asset('shot-002-take2.webm')], manifest: parsed })
  assert.deepEqual(rows.map(row => row.shotId), shots.map(shot => shot.id))
  assert.equal(planVideoReturn({ shots, assets: [asset('shot-001.mp4')] })[0].shotId, '', '没有清单不能按当前排序猜测')
})
test('完整镜头标识独立匹配，冲突与被删镜头需要手工核对', () => {
  assert.equal(planVideoReturn({ shots, assets: [asset(`video-${shots[0].id}.mp4`)] })[0].shotId, shots[0].id)
  assert.equal(planVideoReturn({ shots, assets: [asset(`shot-002-${shots[0].id}.mp4`)], manifest: manifest() })[0].shotId, '')
  assert.equal(planVideoReturn({ shots: [shots[1]], assets: [asset('shot-001.mp4')], manifest: manifest() })[0].shotId, '')
  assert.equal(planVideoReturn({ shots: [{ ...shots[0], id: 's1' }], assets: [asset('s10.mp4')] })[0].shotId, '')
})
test('清单拒绝其他项目、重复映射、任意JSON和超大文件', () => {
  assert.throws(() => parseVideoManifest(JSON.stringify(manifest()), 'p2'), /其他项目/)
  const invalid = manifest(); invalid.shots[1].number = 1
  assert.throws(() => parseVideoManifest(JSON.stringify(invalid), 'p1'), /重复/)
  assert.throws(() => parseVideoManifest('{}', 'p1'), /清单/)
  assert.throws(() => parseVideoManifest('x'.repeat(2_000_001), 'p1'), /过大/)
})
test('关联只更新选中镜头，保留旧视频，重置新版本审核且不修改输入', () => {
  const source = { revision: 4, shots: structuredClone(shots) }
  source.shots[0].selectedVideoVersionId = 'old-v'; source.shots[0].reviewedVideoVersionId = 'old-v'
  const media = [asset('old'), asset('new')], before = structuredClone(source)
  const next = applyVideoReturn(source, [{ shotId: shots[0].id, versionId: 'new-v' }], media)
  assert.equal(next.revision, 5); assert.equal(next.shots[0].selectedVideoVersionId, 'new-v'); assert.equal(next.shots[0].reviewedVideoVersionId, '')
  assert.deepEqual(next.shots[1], source.shots[1]); assert.deepEqual(source, before); assert.equal(media.length, 2)
  const same = applyVideoReturn(source, [{ shotId: shots[0].id, versionId: 'old-v' }], media)
  assert.equal(same.shots[0].reviewedVideoVersionId, 'old-v')
  assert.throws(() => applyVideoReturn(source, [{ shotId: shots[0].id, versionId: 'new-v' }, { shotId: shots[0].id, versionId: 'old-v' }], media), /多个视频/)
  assert.throws(() => applyVideoReturn(source, [{ shotId: 'deleted', versionId: 'new-v' }], media), /不存在/)
  assert.throws(() => applyVideoReturn(source, [{ shotId: shots[0].id, versionId: 'missing' }], media), /不存在/)
})
test('两类导出保留可回填标识与项目绑定，旧清单仍可读取', () => {
  for (const build of [buildFlowExport, buildMuseExport]) {
    const bundle = build({ projectId: 'p1', project: { name: '测试' }, storyboard: { revision: 1, shots }, documents: {} }, [])
    const parsed = parseVideoManifest(bundle.texts.find(file => file.path === 'manifest.json').content, 'p1')
    assert.equal(parsed.projectId, 'p1')
    assert.equal(planVideoReturn({ shots, manifest: parsed, assets: [asset(parsed.shots[0].suggestedVideoFilename)] })[0].shotId, shots[0].id)
    delete parsed.projectId; assert.equal(parseVideoManifest(JSON.stringify(parsed), 'p1').shots.length, 2)
  }
})
test('剧本路径包括参考阶段，制作阶段有明确面板，选用与审核状态不同', () => {
  const ids = creationSteps('script').map(step => step.id)
  assert.ok(ids.indexOf('references') > ids.indexOf('script')); assert.ok(ids.indexOf('references') < ids.indexOf('storyboard'))
  assert.equal(shotStagePanel('images'), 'generation'); assert.equal(shotStagePanel('videos'), 'generation'); assert.equal(shotStagePanel('export'), 'versions')
  const shot = { ...shots[0], references: [], selectedVideoVersionId: 'new-v' }, media = [asset('new')]
  assert.equal(shotReadiness(shot, media).label, '视频待审核')
  shot.reviewedVideoVersionId = 'new-v'; assert.equal(shotReadiness(shot, media).label, '已完成')
  assert.equal(shotReadiness(shot, media, [{ targetId: shot.id, capability: 'video', status: 'running' }]).label, '视频生成中')
})
