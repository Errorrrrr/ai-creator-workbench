import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createEntity, entityStateFingerprint } from '../src/continuity-assets.js'
import { createShot, normalizeStoryboard, validateStoryboard, storyboardSourceFingerprint, snapshotStoryboardSource } from '../src/storyboard.js'
import { planReferenceBackfill } from '../src/storyboard-references.js'
import { emptySceneContinuity } from '../src/scene-continuity.js'
import { imageVisualReviewState, makeVisualReview } from '../src/visual-review.js'
import { getContinuityReviewBatch, planContinuityImpact } from '../src/continuity-impact.js'

if (!globalThis.crypto) globalThis.crypto = webcrypto

function fixture() {
  const raft = createEntity({ id: 'raft', kind: 'prop', name: '木筏', traits: '三块平板与蓝色油桶', sourceDocumentIds: ['s1', 's2'],
    states: [{ id: 'raft-base', name: '完整', referenceVersionId: 'raft-image' }] })
  const torch = createEntity({ id: 'torch', kind: 'prop', name: '火把', traits: '短柄黑色火把', sourceDocumentIds: ['s3'],
    states: [{ id: 'torch-base', name: '未点燃', referenceVersionId: 'torch-image' }] })
  const continuity = { version: 1, style: '写实电影', entities: [raft, torch] }
  for (const entity of continuity.entities) entity.states[0].referenceFingerprint = entityStateFingerprint(entity, entity.states[0], continuity.style)
  const assets = continuity.entities.map(entity => ({ id: `${entity.id}-asset`, projectId: 'p', kind: 'image', role: entity.kind, name: entity.name,
    selectedVersionId: entity.states[0].referenceVersionId,
    versions: [{ id: entity.states[0].referenceVersionId, mimeType: 'image/png', metadata: { provenance: { entity: { entityId: entity.id, stateId: entity.states[0].id, kind: entity.kind } } } }] }))
  const make = (id, sourceId, name, withImage = true) => {
    const shot = createShot({ title: id, visual: name ? `${name}近景` : '海面空镜', characterNames: [], sceneNames: [], propNames: name ? [name] : [] }, { documentId: sourceId })
    shot.id = id
    if (withImage) {
      shot.selectedImageVersionId = `${id}-image`
      assets.push({ id: `${id}-asset`, projectId: 'p', kind: 'image', role: 'shot', name: id, versions: [{ id: shot.selectedImageVersionId, mimeType: 'image/png' }] })
    }
    return shot
  }
  const shots = [make('torch-shot', 's3', '火把'), make('raft-pending', 's2', '木筏'), make('raft-approved', 's1', '木筏'),
    make('empty-shot', 's1', ''), make('raft-missing', 's2', '木筏', false)]
  const data = { projectId: 'p', documents: { ep1: { title: '第一集', content: '' }, ep2: { title: '第二集', content: '' },
    s1: { title: '第一场', content: '木筏近景与海面空镜。' }, s2: { title: '第二场', content: '木筏继续漂浮。' }, s3: { title: '第三场', content: '火把靠在墙边。' } },
    structure: { acts: [{ episodeIds: ['ep2', 'ep1'] }], episodes: { ep2: { sceneIds: ['s2'] }, ep1: { sceneIds: ['s1', 's3'] } } },
    storyboard: { revision: 7, shots, continuity } }
  data.storyboard = planReferenceBackfill(data.storyboard, assets, data.documents, data.projectId).storyboard
  for (const id of ['raft-approved', 'torch-shot']) {
    const shot = data.storyboard.shots.find(item => item.id === id)
    shot.visualReview = makeVisualReview(shot, assets, data.documents, continuity, { decision: 'approved' }, data)
  }
  return { data, assets, next: structuredClone(continuity) }
}

test('未改变实际视觉输入时没有受影响分场或镜头，预览不修改项目或素材', () => {
  const f = fixture(), before = structuredClone(f)
  const plan = planContinuityImpact(f.data, f.next, f.assets)
  assert.deepEqual(plan.groups, [])
  assert.deepEqual(plan.shotIds, [])
  assert.equal(plan.previouslyApprovedCount, 0)
  assert.equal(plan.projectId, 'p')
  assert.equal(plan.revision, f.data.storyboard.revision)
  assert.equal(plan.storyboard.revision, plan.revision + 1)
  assert.deepEqual(f, before)
})

test('对象改动按真实分集分场顺序列出受影响镜头，同时区分已通过、待复核和缺图', () => {
  const f = fixture()
  f.next.entities[0].traits += '，筏头增加横梁'
  const plan = planContinuityImpact(f.data, f.next, f.assets)
  assert.deepEqual(plan.groups.map(group => [group.episodeTitle, group.sourceTitle]), [['第二集', '第二场'], ['第一集', '第一场']])
  assert.deepEqual(plan.shotIds, ['raft-pending', 'raft-missing', 'raft-approved'])
  assert.deepEqual(plan.shots.filter(shot => shot.hasImage).map(shot => shot.id), ['raft-pending', 'raft-approved'])
  assert.equal(plan.previouslyApprovedCount, 1)
  assert.deepEqual(plan.shots.map(shot => [shot.id, shot.number, shot.previouslyApproved, shot.previousReviewStatus, shot.hasImage]), [
    ['raft-pending', 1, false, 'unreviewed', true], ['raft-missing', 2, false, 'missing', false], ['raft-approved', 1, true, 'approved', true]
  ])
  for (const shot of plan.shots) assert.ok(shot.changedFields.includes('人物、场景与关键物品设定'))
  assert.ok(!plan.shotIds.includes('empty-shot'))
  assert.ok(!plan.shotIds.includes('torch-shot'))
})

test('镜号保留原场顺序，筛选掉无关镜头后不重新编号', () => {
  const f = fixture()
  f.data.storyboard.shots.unshift(f.data.storyboard.shots.splice(f.data.storyboard.shots.findIndex(shot => shot.id === 'empty-shot'), 1)[0])
  f.next.entities[0].traits += '，增加横梁'
  assert.equal(planContinuityImpact(f.data, f.next, f.assets).shots.find(shot => shot.id === 'raft-approved').number, 2)
})

test('预览计划与真实保存使用相同的引用补齐、自动旧引用移除和连续性提示', () => {
  const f = fixture()
  const state = f.next.entities[0].states[0]
  f.assets[0].versions.push({ id: 'raft-new', mimeType: 'image/png' })
  state.referenceVersionId = 'raft-new'
  const expected = planReferenceBackfill({ ...f.data.storyboard, continuity: f.next }, f.assets, f.data.documents, f.data.projectId).storyboard
  expected.revision = f.data.storyboard.revision + 1
  const plan = planContinuityImpact(f.data, f.next, f.assets)
  const { continuityReviewBatch, ...content } = plan.storyboard
  content.shots = content.shots.map(({ continuityReview, ...shot }) => shot)
  assert.deepEqual(content, expected)
  const savedShot = plan.storyboard.shots.find(shot => shot.id === 'raft-approved')
  assert.ok(savedShot.references.some(ref => ref.versionId === 'raft-new'))
  assert.ok(!savedShot.references.some(ref => ref.versionId === 'raft-image'))
  assert.ok(plan.shots.find(shot => shot.id === 'raft-approved').changedFields.includes('固定参考图片'))
  assert.equal(imageVisualReviewState(savedShot, f.assets, f.data.documents, plan.storyboard.continuity, { ...f.data, storyboard: plan.storyboard }).reviewed, false)
})

test('统一视觉基准改变包含没有实体引用的空镜，已通过状态以修改前有效结果为准', () => {
  const f = fixture()
  f.next.style = '水彩电影'
  const plan = planContinuityImpact(f.data, f.next, f.assets)
  assert.equal(plan.shots.length, 5)
  assert.equal(plan.previouslyApprovedCount, 2)
  assert.ok(plan.shots.every(shot => shot.changedFields.includes('统一视觉基准')))
  assert.ok(plan.shots.find(shot => shot.id === 'empty-shot').hasImage)
})

test('手动排除对象与手选其他状态图片保留原选择，不因未采用的定义修改误报', () => {
  for (const mode of ['excluded', 'manual']) {
    const f = fixture(), shot = f.data.storyboard.shots.find(shot => shot.id === 'raft-approved')
    if (mode === 'excluded') {
      shot.references = []
      shot.referenceExclusions = ['prop:@raft']
    } else {
      f.assets[0].versions.push({ id: 'raft-manual', mimeType: 'image/png' })
      shot.references = [{ versionId: 'raft-manual', role: 'reference', origin: 'manual' }]
    }
    f.data.storyboard = planReferenceBackfill(f.data.storyboard, f.assets, f.data.documents, f.data.projectId).storyboard
    const beforeShot = f.data.storyboard.shots.find(item => item.id === shot.id)
    beforeShot.visualReview = makeVisualReview(beforeShot, f.assets, f.data.documents, f.data.storyboard.continuity, { decision: 'approved' }, f.data)
    const references = structuredClone(beforeShot.references)
    f.next.entities[0].traits += '，增加横梁'
    const plan = planContinuityImpact(f.data, f.next, f.assets)
    assert.ok(!plan.shotIds.includes(shot.id), mode)
    assert.deepEqual(plan.storyboard.shots.find(item => item.id === shot.id).references, references, mode)
  }
})

test('历史通过记录已失效或选用图片丢失时不标成修改前已通过', () => {
  for (const mode of ['changed', 'missing', 'duplicate']) {
    const f = fixture(), shot = f.data.storyboard.shots.find(shot => shot.id === 'raft-approved')
    if (mode === 'changed') shot.camera += '，低机位'
    if (mode === 'missing') f.assets = f.assets.filter(asset => !asset.versions.some(version => version.id === shot.selectedImageVersionId))
    if (mode === 'duplicate') f.assets.push(structuredClone(f.assets.find(asset => asset.versions.some(version => version.id === shot.selectedImageVersionId))))
    f.next.entities[0].traits += '，增加横梁'
    const plan = planContinuityImpact(f.data, f.next, f.assets), affected = plan.shots.find(item => item.id === shot.id)
    assert.equal(affected.previouslyApproved, false, mode)
    assert.equal(plan.previouslyApprovedCount, 0, mode)
    assert.equal(affected.hasImage, mode === 'changed', mode)
  }
})

test('已拒绝与旧图未检查的受影响镜头仍可进入复核，保留原复核记录', () => {
  const f = fixture(), shot = f.data.storyboard.shots.find(shot => shot.id === 'raft-pending')
  shot.visualReview = makeVisualReview(shot, f.assets, f.data.documents, f.data.storyboard.continuity, { decision: 'rejected', notes: '结构不对' }, f.data)
  f.next.entities[0].traits += '，增加横梁'
  const plan = planContinuityImpact(f.data, f.next, f.assets)
  assert.equal(plan.shots.find(item => item.id === shot.id).previousReviewStatus, 'rejected')
  assert.ok(plan.shots.find(item => item.id === shot.id).hasImage)
  assert.deepEqual(plan.storyboard.shots.find(item => item.id === shot.id).visualReview, shot.visualReview)
})

test('只改某分场使用的派生状态，影响限制在采用该状态的分场', () => {
  const f = fixture(), entity = f.next.entities[0]
  entity.states.push({ ...structuredClone(entity.states[0]), id: 'raft-damaged', name: '破损', description: '筏头缺一角', sourceDocumentIds: ['s2'], basedOnStateId: 'raft-base', referenceVersionId: '', referenceFingerprint: '' })
  const plan = planContinuityImpact(f.data, f.next, f.assets)
  assert.deepEqual(plan.groups.map(group => group.sourceId), ['s2'])
  assert.deepEqual(plan.shotIds, ['raft-pending', 'raft-missing'])
})

test('基础状态变化沿真实分场状态承接影响下游镜头', () => {
  const f = fixture()
  f.data.documents.s2.sceneContinuity = { ...emptySceneContinuity(), exitBindings: [{ entityId: 'raft', stateId: 'raft-base' }] }
  const shot = f.data.storyboard.shots.find(item => item.id === 'empty-shot')
  shot.visualReview = makeVisualReview(shot, f.assets, f.data.documents, f.data.storyboard.continuity, { decision: 'approved' }, f.data)
  f.next.entities[0].traits += '，增加横梁'
  const affected = planContinuityImpact(f.data, f.next, f.assets).shots.find(item => item.id === shot.id)
  assert.ok(affected.changedFields.includes('素材与分场状态承接'))
  assert.equal(affected.previouslyApproved, true)
})

test('待归场与来源缺失镜头仍出现在明确的组中', () => {
  const f = fixture()
  f.data.storyboard.shots.find(shot => shot.id === 'empty-shot').sourceDocumentId = 'removed-scene'
  f.next.style = '水彩电影'
  const plan = planContinuityImpact(f.data, f.next, f.assets), group = plan.groups.find(item => item.shots.some(shot => shot.id === 'empty-shot'))
  assert.equal(group.pendingAssignment, true)
  assert.match(group.sourceTitle, /来源缺失/)
  assert.equal(group.shots[0].sourceDocumentId, 'removed-scene')
})

test('预览过滤其他项目的同ID素材，避免误认缺图镜头已经通过', () => {
  const f = fixture(), shot = f.data.storyboard.shots.find(item => item.id === 'raft-approved')
  f.assets.find(asset => asset.versions.some(version => version.id === shot.selectedImageVersionId)).projectId = 'foreign'
  f.next.entities[0].traits += '，增加横梁'
  const plan = planContinuityImpact(f.data, f.next, f.assets), affected = plan.shots.find(item => item.id === shot.id)
  assert.equal(affected.hasImage, false)
  assert.equal(affected.previouslyApproved, false)
})

test('无关设定保存时补齐已有滞留引用，也如实列为本次保存造成的输入变化', () => {
  const f = fixture(), shot = f.data.storyboard.shots.find(item => item.id === 'raft-approved')
  shot.references = []
  f.next.entities[1].traits += '，手柄带绳结'
  const plan = planContinuityImpact(f.data, f.next, f.assets), affected = plan.shots.find(item => item.id === shot.id)
  assert.ok(affected.changedFields.includes('固定参考图片'))
  assert.equal(affected.previouslyApproved, false)
  assert.ok(plan.storyboard.shots.find(item => item.id === shot.id).references.some(ref => ref.versionId === 'raft-image'))
  assert.ok(plan.shotIds.includes('torch-shot'))
})

test('影响批次与设定同份计划保存，序列化后按当前项目恢复并保持场序', () => {
  const f = fixture(), before = structuredClone(f.data)
  f.next.entities[0].traits += '，增加横梁'
  const plan = planContinuityImpact(f.data, f.next, f.assets)
  const data = { ...f.data, storyboard: normalizeStoryboard(JSON.parse(JSON.stringify(plan.storyboard))) }
  const batch = getContinuityReviewBatch(data)
  assert.deepEqual(batch, { projectId: 'p', id: `continuity-review-${plan.storyboard.revision}`,
    shotIds: ['raft-pending', 'raft-missing', 'raft-approved'], previouslyApprovedShotIds: ['raft-approved'] })
  assert.deepEqual(getContinuityReviewBatch({ ...data, projectId: 'restored-project' }), { ...batch, projectId: 'restored-project' })
  assert.deepEqual(f.data, before, '计划建立不修改原项目，保存失败也不会提前产生批次')
  assert.deepEqual(planContinuityImpact(f.data, f.next, f.assets).storyboard, plan.storyboard, '重复预览产生确定性计划')
})

test('无影响保存保留最近一次批次，新影响只保留新批次，删除镜头后自然退出', () => {
  const f = fixture()
  f.next.entities[0].traits += '，增加横梁'
  f.data.storyboard = planContinuityImpact(f.data, f.next, f.assets).storyboard
  const firstBatch = getContinuityReviewBatch(f.data)
  const unchanged = planContinuityImpact(f.data, f.data.storyboard.continuity, f.assets)
  assert.equal(unchanged.shots.length, 0)
  assert.deepEqual(getContinuityReviewBatch({ ...f.data, storyboard: unchanged.storyboard }), firstBatch)
  f.next = structuredClone(f.data.storyboard.continuity); f.next.entities[1].traits += '，柄上缠绳'
  f.data.storyboard = planContinuityImpact(f.data, f.next, f.assets).storyboard
  assert.deepEqual(getContinuityReviewBatch(f.data).shotIds, ['torch-shot'])
  assert.notEqual(getContinuityReviewBatch(f.data).id, firstBatch.id)
  assert.ok(f.data.storyboard.shots.filter(shot => shot.id !== 'torch-shot').every(shot => !shot.continuityReview))
  f.data.storyboard.shots = f.data.storyboard.shots.filter(shot => shot.id !== 'torch-shot')
  assert.equal(getContinuityReviewBatch(f.data), null)
  assert.doesNotThrow(() => validateStoryboard(f.data.storyboard))
})

test('复核元数据不使拆镜候选失效，新建和历史快照均不复制旧批次成员资格', () => {
  const f = fixture(), before = storyboardSourceFingerprint(f.data.storyboard, 's1')
  f.next.entities[0].traits += '，增加横梁'
  const plan = planContinuityImpact(f.data, f.next, f.assets), shot = plan.storyboard.shots.find(item => item.id === 'raft-approved')
  const metadataOnly = structuredClone(f.data.storyboard)
  metadataOnly.shots.find(item => item.id === shot.id).continuityReview = shot.continuityReview
  assert.equal(storyboardSourceFingerprint(metadataOnly, 's1'), before)
  const version = snapshotStoryboardSource(plan.storyboard, 's1')
  assert.ok(version.shots.every(item => !item.continuityReview))
  assert.equal(createShot(shot).continuityReview, undefined)
})

test('批次和镜头标记校验兼容旧项目，拒绝未知版本和非法字段', () => {
  const f = fixture(), old = normalizeStoryboard(f.data.storyboard)
  assert.equal(getContinuityReviewBatch({ ...f.data, storyboard: old }), null)
  for (const batch of [null, { version: 2, id: 'batch' }, { version: 1, id: '' }, { version: 1, id: 'batch', projectId: 'other' }]) {
    assert.throws(() => validateStoryboard({ ...old, continuityReviewBatch: batch }), /设定复核批次无效/)
  }
  for (const marker of [null, { batchId: '', previouslyApproved: true }, { batchId: 'batch', previouslyApproved: 'true' }, { batchId: 'batch', previouslyApproved: true, shotId: 'other' }]) {
    const data = structuredClone(old); data.shots[0].continuityReview = marker
    assert.throws(() => validateStoryboard(data), /镜头设定复核标记无效/)
  }
})
