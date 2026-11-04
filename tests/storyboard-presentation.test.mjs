import test from 'node:test'
import assert from 'node:assert/strict'
import { createShot } from '../src/storyboard.js'
import { createEntity, entityStateFingerprint } from '../src/continuity-assets.js'
import { makeVisualReview } from '../src/visual-review.js'
import { shotImageReadiness, storyboardNextAction } from '../src/shot-workflow.js'

function fixture(count = 2) {
  const entity = createEntity({ id: 'raft', kind: 'prop', name: '木筏', traits: '平板与蓝色浮桶', sourceDocumentIds: ['scene'], states: [{ id: 'raft-base', name: '基础状态', referenceVersionId: 'ref-v1' }] })
  const continuity = { version: 1, style: '写实电影，日光', entities: [entity] }
  entity.states[0].referenceFingerprint = entityStateFingerprint(entity, entity.states[0], continuity.style)
  const documents = { scene: { title: '海上木筏', content: '木筏平稳漂浮在海面。' } }
  const shots = Array.from({ length: count }, (_, index) => {
    const shot = createShot({ title: `镜头 ${index + 1}`, visual: '木筏漂浮在海面', characterNames: [], sceneNames: [], propNames: ['木筏'] }, { documentId: 'scene' })
    shot.id = `shot-${index + 1}`
    shot.selectedImageVersionId = `image-${index + 1}`
    shot.references = [{ versionId: 'ref-v1', role: 'reference', scope: 'continuity', origin: 'auto', entityId: entity.id, stateId: entity.states[0].id }]
    return shot
  })
  const assets = [{ id: 'reference', name: '木筏', role: 'prop', kind: 'image', selectedVersionId: 'ref-v1', versions: [{ id: 'ref-v1', mimeType: 'image/png' }, { id: 'ref-v2', mimeType: 'image/png' }] },
    { id: 'pictures', name: '分镜图', role: 'shot', kind: 'image', versions: shots.map((_, index) => ({ id: `image-${index + 1}`, mimeType: 'image/png' })) }]
  const context = { projectId: 'project', documents, storyboard: { revision: 1, shots, continuity } }
  return { shots, assets, documents, continuity, context, jobs: [], sceneSelected: true }
}

function approve(f, shot = f.shots[0], decision = 'approved') {
  shot.visualReview = makeVisualReview(shot, f.assets, f.documents, f.continuity, { decision }, f.context)
}
const readiness = (f, shot = f.shots[0]) => shotImageReadiness(shot, f.assets, f.jobs, f.documents, f.continuity, f.context)

test('分镜图全部人工确认后直接导出素材包，不要求本地视频或视频审核', () => {
  const f = fixture()
  for (const shot of f.shots) approve(f, shot)
  assert.ok(f.shots.every(shot => !shot.selectedVideoVersionId && !shot.reviewedVideoVersionId))
  assert.ok(f.assets.every(asset => asset.kind === 'image'))
  for (const shot of f.shots) assert.deepEqual(readiness(f, shot), { label: '画面已确认', tone: 'complete' })
  assert.deepEqual(storyboardNextAction(f), { kind: 'export', label: '导出素材包' })
})

test('已选图但未复核仍进入检查，明确拒绝的图片提示修改且不能导出', () => {
  const f = fixture()
  approve(f, f.shots[1])
  assert.deepEqual(readiness(f), { label: '待检查画面', tone: 'review' })
  assert.deepEqual(storyboardNextAction(f), { kind: 'review', label: '检查画面 · 1', shotId: 'shot-1' })
  approve(f, f.shots[0], 'rejected')
  assert.deepEqual(readiness(f), { label: '需要修改', tone: 'warning' })
  assert.equal(storyboardNextAction(f).kind, 'review')
})

test('参考版本、设定、来源或选图变化均使旧确认失效，保留原图片和复核记录', () => {
  for (const mutate of [
    f => { f.shots[0].references[0].versionId = 'ref-v2'; f.continuity.entities[0].states[0].referenceVersionId = 'ref-v2' },
    f => { f.continuity.entities[0].traits += '，增加钢索' },
    f => { f.documents.scene.content += '天空改为阴天。' },
    f => { f.shots[0].selectedImageVersionId = 'image-2' }
  ]) {
    const f = fixture()
    f.shots.forEach(shot => approve(f, shot))
    const record = structuredClone(f.shots[0].visualReview)
    mutate(f)
    assert.equal(readiness(f).label, '需要重新检查')
    assert.notEqual(readiness(f).tone, 'complete')
    assert.equal(storyboardNextAction(f).kind, 'review')
    assert.equal(storyboardNextAction(f).shotId, 'shot-1')
    assert.deepEqual(f.shots[0].visualReview, record)
    assert.equal(f.assets[1].versions[0].id, 'image-1')
  }
})

test('当前范围活跃任务或结果未知任务优先查看任务，不能重复准备缺图或直接导出', () => {
  for (const status of ['queued', 'submitting', 'running', 'downloading', 'submission_unknown']) {
    for (const capability of ['image', 'video']) {
      const f = fixture()
      f.jobs = [{ id: 'job', targetId: 'shot-1', status, capability }]
      f.shots[1].selectedImageVersionId = ''
      assert.deepEqual(storyboardNextAction(f), { kind: 'jobs', label: '查看生成任务' })
      assert.deepEqual(readiness(f), status === 'submission_unknown' ? { label: '任务待核对', tone: 'warning' }
        : { label: capability === 'video' ? '视频生成中' : '图片生成中', tone: 'running' })
      f.shots[1].selectedImageVersionId = 'image-2'
      f.shots.forEach(shot => approve(f, shot))
      assert.equal(storyboardNextAction(f).kind, 'jobs', '人工确认不能掩盖尚未结束的任务')
    }
  }
})

test('其他范围的任务与当前范围已结束任务不阻塞下一步，未知任务仅影响对应镜头', () => {
  const f = fixture()
  f.shots.forEach(shot => approve(f, shot))
  f.jobs = [
    { targetId: 'outside', status: 'running', capability: 'image' },
    { targetId: 'outside-unknown', status: 'submission_unknown', capability: 'image' },
    ...['completed', 'failed', 'cancelled'].map(status => ({ targetId: 'shot-1', status, capability: 'image' }))
  ]
  assert.equal(storyboardNextAction(f).kind, 'export')
  assert.equal(readiness(f).tone, 'complete')
  f.jobs.push({ targetId: 'shot-2', status: 'submission_unknown', capability: 'image' })
  assert.equal(readiness(f).tone, 'complete')
  assert.equal(readiness(f, f.shots[1]).label, '任务待核对')
  assert.equal(storyboardNextAction(f).kind, 'jobs')
})

test('缺图计划只选真正缺图镜头，保留已有选图，预览一次最多二十镜且总数准确', () => {
  const f = fixture(29), retained = new Set(['shot-1', 'shot-4', 'shot-9'])
  f.assets.push({ id: 'video', kind: 'video', role: 'shot', versions: [{ id: 'video-v1', mimeType: 'video/mp4' }] })
  const missing = f.shots.filter(shot => !retained.has(shot.id))
  missing.forEach((shot, index) => { shot.selectedImageVersionId = index % 3 === 0 ? '' : index % 3 === 1 ? 'unavailable-image' : 'video-v1' })
  const before = structuredClone(f)
  const action = storyboardNextAction(f)
  assert.deepEqual(action, { kind: 'images', label: '准备缺少的图片 · 26', shotIds: missing.slice(0, 20).map(shot => shot.id) })
  assert.equal(action.shotIds.length, 20)
  assert.ok(action.shotIds.every(id => !retained.has(id)))
  assert.deepEqual(f, before, '计划建议不得改变任何已有选用或任务')
})

test('空范围先整理分场，已选具体分场才建议拆分本场镜头', () => {
  assert.deepEqual(storyboardNextAction({}), { kind: 'scenes', label: '整理分场' })
  assert.deepEqual(storyboardNextAction({ shots: [], sceneSelected: true }), { kind: 'storyboard', label: '拆分本场镜头' })
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) freeze(item)
  return value
}

test('画面状态与下一步建议只读输入，包括复核、缺图、任务和可导出路径', () => {
  for (const setup of [
    () => {},
    f => { f.shots[0].selectedImageVersionId = '' },
    f => { f.jobs.push({ targetId: 'shot-1', status: 'submission_unknown', capability: 'image' }) },
    f => f.shots.forEach(shot => approve(f, shot)),
    f => { f.shots.forEach(shot => approve(f, shot)); f.continuity.style = '水彩' }
  ]) {
    const f = fixture(); setup(f)
    const before = structuredClone(f)
    freeze(f)
    for (const shot of f.shots) assert.doesNotThrow(() => readiness(f, shot))
    assert.doesNotThrow(() => storyboardNextAction(f))
    assert.deepEqual(f, before)
  }
})
