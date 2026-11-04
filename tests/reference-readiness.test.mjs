import test from 'node:test'
import assert from 'node:assert/strict'
import { createEntity, createEntityState, entityStateFingerprint } from '../src/continuity-assets.js'
import { createShot, contentFingerprint, shotInputFingerprint } from '../src/storyboard.js'
import { shotReadiness } from '../src/shot-workflow.js'
import { productionRows, productionRowMatches } from '../src/production-overview.js'
import { makeVisualReview } from '../src/visual-review.js'

const fields = { character: 'characterNames', scene: 'sceneNames', prop: 'propNames' }
const names = { character: '陆骁', scene: '无尽汪洋', prop: '木筏' }
const docs = { ep1: { title: '第一集', content: '分集大纲' }, s1: { title: '第一场', content: '第一场剧本' }, s2: { title: '第二场', content: '第二场剧本' } }

function fixture(kind = 'prop', { imported = false } = {}) {
  const entity = createEntity({
    id: `${kind}-entity`, kind, name: names[kind], traits: '固定外形', sourceDocumentIds: ['s1', 's2'],
    states: [createEntityState({ id: `${kind}-state`, name: '初始状态', referenceVersionId: `${kind}-reference` })]
  })
  const state = entity.states[0]
  state.referenceFingerprint = entityStateFingerprint(entity, state)
  const version = { id: state.referenceVersionId, mimeType: 'image/png' }
  if (!imported) version.metadata = { provenance: { entity: { entityId: entity.id, stateId: state.id, kind, definitionFingerprint: state.referenceFingerprint } } }
  const reference = { id: `${kind}-asset`, projectId: 'p', name: imported ? '导入图片.png' : `${entity.name} · 初始状态 · 设定图`, role: kind, kind: 'image', selectedVersionId: version.id, versions: [version] }
  const shot = createShot({ title: `${entity.name}入镜`, visual: `${entity.name}的近景`, characterNames: [], sceneNames: [], propNames: [], [fields[kind]]: [entity.name] }, { documentId: 's1', fingerprint: contentFingerprint(docs.s1.content) })
  shot.references = [{ versionId: version.id, role: 'reference', scope: 'continuity', origin: 'auto', entityId: entity.id, stateId: state.id }]
  shot.selectedImageVersionId = 'selected-image'
  const image = { id: 'shot-image', projectId: 'p', name: '选用分镜图', role: 'shot', kind: 'image', versions: [{ id: 'selected-image', mimeType: 'image/png' }] }
  const continuity = { version: 1, style: '', entities: [entity] }
  return { entity, state, reference, shot, assets: [reference, image], continuity }
}

const readiness = ({ shot, assets, continuity }, jobs = []) => shotReadiness(shot, assets, jobs, docs, continuity)
const approveVisual = f => { f.shot.visualReview = makeVisualReview(f.shot, f.assets, docs, f.continuity, { decision: 'approved' }) }
const dataFor = (continuity, shots) => ({
  projectId: 'p', documents: docs,
  structure: { acts: [{ episodeIds: ['ep1'] }], episodes: { ep1: { sceneIds: ['s1', 's2'] } } },
  storyboard: { revision: 1, shots, continuity }
})

for (const kind of Object.keys(fields)) {
  test(`${names[kind]}实体状态图已关联时，不再误报参考待补齐`, () => {
    const f = fixture(kind)
    assert.deepEqual(readiness(f), { label: '待视觉复核', tone: 'review' }, '参考绑定不等于画面已核对一致')
    approveVisual(f)
    assert.deepEqual(readiness(f), { label: '待生成视频', tone: 'ready' })
    f.shot.selectedImageVersionId = ''
    assert.deepEqual(readiness(f), { label: '待生成分镜图', tone: 'pending' })
    const row = productionRows(dataFor(f.continuity, [f.shot]), f.assets).find(row => row.documentId === 's1')
    assert.deepEqual(row.referenceIds, [])
  })

  test(`${names[kind]}手动导入后选为状态图，无生成来源也可认定已齐`, () => {
    const f = fixture(kind, { imported: true })
    assert.equal(readiness(f).label, '待视觉复核')
    approveVisual(f)
    assert.equal(readiness(f).label, '待生成视频')
    assert.deepEqual(productionRows(dataFor(f.continuity, [f.shot]), f.assets)[0].referenceIds, [])
  })
}

test('状态图未生成、固定版本消失或尚未绑定时，继续提示真正的缺项', () => {
  for (const mode of ['no-image', 'lost-state-version', 'unbound']) {
    const f = fixture()
    f.shot.references = []
    if (mode === 'no-image') { f.state.referenceVersionId = ''; f.state.referenceFingerprint = ''; f.assets = f.assets.filter(asset => asset !== f.reference) }
    if (mode === 'lost-state-version') f.assets = f.assets.filter(asset => asset !== f.reference)
    assert.deepEqual(readiness(f), { label: '参考待补齐', tone: 'warning' }, mode)
    const row = productionRows(dataFor(f.continuity, [f.shot]), f.assets)[0]
    assert.deepEqual(row.referenceIds, [f.shot.id], mode)
  }
})

test('设定修改令自动状态图过期时，不能只凭图片存在就报已齐', () => {
  const f = fixture()
  f.entity.traits = '固定外形增加横梁'
  assert.equal(readiness(f).label, '参考待补齐')
  assert.deepEqual(productionRows(dataFor(f.continuity, [f.shot]), f.assets)[0].referenceIds, [f.shot.id])
})

test('手动保留旧状态参考是明确选择，不作为缺参考计入制作待办', () => {
  const f = fixture()
  const old = { id: 'old-state-image', mimeType: 'image/png', metadata: { provenance: { entity: { entityId: f.entity.id, stateId: 'old-state', kind: 'prop' } } } }
  f.reference.versions.push(old)
  f.shot.references = [{ versionId: old.id, role: 'reference', origin: 'manual' }]
  assert.equal(readiness(f).label, '待视觉复核')
  approveVisual(f)
  const before = structuredClone(f)
  assert.equal(readiness(f).label, '待生成视频')
  assert.deepEqual(productionRows(dataFor(f.continuity, [f.shot]), f.assets)[0].referenceIds, [])
  assert.deepEqual(f, before, '状态检查不能覆盖手动引用或修改设定')
})

test('明确排除的素材不算缺项，但仍检查镜头中的其他失效固定引用', () => {
  const f = fixture()
  f.shot.references = []
  f.shot.referenceExclusions = [`prop:@${f.entity.id}`]
  assert.equal(readiness(f).label, '待视觉复核')
  approveVisual(f)
  assert.equal(readiness(f).label, '待生成视频')
  assert.deepEqual(productionRows(dataFor(f.continuity, [f.shot]), f.assets)[0].referenceIds, [])
  f.shot.references.push({ versionId: 'removed-manual-image', role: 'reference', origin: 'manual' })
  assert.equal(readiness(f).label, '参考待补齐')
  assert.deepEqual(productionRows(dataFor(f.continuity, [f.shot]), f.assets)[0].referenceIds, [f.shot.id])
})

test('镜头已有16张其他参考也不能掩盖尚未关联的当前状态图', () => {
  const f = fixture()
  f.shot.references = Array.from({ length: 16 }, (_, index) => ({ versionId: `manual-${index}`, role: 'reference', origin: 'manual' }))
  f.assets.push({ id: 'other-references', name: '其他输入', kind: 'image', role: 'shot', versions: f.shot.references.map(ref => ({ id: ref.versionId, mimeType: 'image/png' })) })
  assert.equal(readiness(f).label, '参考待补齐')
  assert.deepEqual(productionRows(dataFor(f.continuity, [f.shot]), f.assets)[0].referenceIds, [f.shot.id])
})

test('未迁移项目的旧式同名参考仍支持已绑定、待绑定和歧义判断', () => {
  const f = fixture()
  const oldAsset = { ...f.reference, name: '木筏', versions: [{ id: f.state.referenceVersionId, mimeType: 'image/png' }] }
  const assets = [oldAsset, f.assets[1]]
  assert.equal(shotReadiness(f.shot, assets, [], docs).label, '待视觉复核')
  f.shot.visualReview = makeVisualReview(f.shot, assets, docs, undefined, { decision: 'approved' })
  assert.equal(shotReadiness(f.shot, assets, [], docs).label, '待生成视频')
  f.shot.references = []
  assert.equal(shotReadiness(f.shot, assets, [], docs).label, '参考待补齐')
  assets.push({ ...oldAsset, id: 'other-raft', selectedVersionId: 'other-raft-image', versions: [{ id: 'other-raft-image', mimeType: 'image/png' }] })
  assert.equal(shotReadiness(f.shot, assets, [], docs).label, '参考待补齐')
})

test('制作进度分别统计分镜图缺图与视觉待复核，人工确认后清除复核待办，参考变化后重新出现', () => {
  const f = fixture()
  const missing = createShot({ title: '第二场空镜', visual: '海面', characterNames: [], sceneNames: [], propNames: [] }, { documentId: 's2', fingerprint: contentFingerprint(docs.s2.content) })
  const data = dataFor(f.continuity, [f.shot, missing])
  let rows = productionRows(data, f.assets)
  assert.deepEqual(rows[0].imageIds, [])
  assert.deepEqual(rows[0].imageReviewIds, [f.shot.id])
  assert.deepEqual(rows[1].imageIds, [missing.id])
  assert.deepEqual(rows[1].imageReviewIds, [], '没有图的镜头归入缺图，不冒充视觉检查结论')
  assert.deepEqual(rows.filter(row => productionRowMatches(row, 'image-review')).map(row => row.documentId), ['s1'])
  approveVisual(f)
  rows = productionRows(data, f.assets)
  assert.deepEqual(rows[0].imageReviewIds, [])
  assert.deepEqual(rows.filter(row => productionRowMatches(row, 'image-review')), [])
  f.entity.traits += '，木板结构已调整'
  rows = productionRows(data, f.assets)
  assert.deepEqual(rows[0].imageReviewIds, [f.shot.id])
  assert.deepEqual(rows[0].referenceIds, [f.shot.id])
  assert.deepEqual(rows.filter(row => productionRowMatches(row, 'image-review')).map(row => row.documentId), ['s1'])
})

test('制作进度按分场精确统计缺参考镜头，修复或切换当前状态后同步筛选', () => {
  const f = fixture()
  const missing = createShot({ title: '第二场木筏', visual: '木筏近景', propNames: ['木筏'], characterNames: [], sceneNames: [] }, { documentId: 's2', fingerprint: contentFingerprint(docs.s2.content) })
  const damaged = createEntityState({ id: 'damaged-state', name: '破损状态', description: '前缘缺口', sourceDocumentIds: ['s2'], basedOnStateId: f.state.id })
  f.entity.states.push(damaged)
  const data = dataFor(f.continuity, [f.shot, missing])
  let rows = productionRows(data, f.assets)
  assert.deepEqual(rows.map(row => row.referenceIds), [[], [missing.id]])
  assert.deepEqual(rows.filter(row => productionRowMatches(row, 'references')).map(row => row.documentId), ['s2'])
  assert.equal(rows[0].images, 1)
  damaged.referenceVersionId = 'damaged-image'
  damaged.referenceFingerprint = entityStateFingerprint(f.entity, damaged)
  f.reference.versions.push({ id: damaged.referenceVersionId, mimeType: 'image/png', metadata: { provenance: { entity: { entityId: f.entity.id, stateId: damaged.id, kind: f.entity.kind } } } })
  missing.references = [{ versionId: damaged.referenceVersionId, role: 'reference', origin: 'auto', entityId: f.entity.id, stateId: damaged.id }]
  rows = productionRows(data, f.assets)
  assert.deepEqual(rows.map(row => row.referenceIds), [[], []])
  assert.deepEqual(rows.filter(row => productionRowMatches(row, 'references')), [])
})

test('参考判断不遮盖生成任务、未知提交或视频审核阶段，制作进度仍保留缺项', () => {
  const f = fixture()
  f.shot.references = []
  assert.equal(readiness(f, [{ targetId: f.shot.id, capability: 'image', status: 'running' }]).label, '图片生成中')
  assert.equal(readiness(f, [{ targetId: f.shot.id, capability: 'video', status: 'running' }]).label, '视频生成中')
  assert.equal(readiness(f, [{ targetId: f.shot.id, capability: 'video', status: 'submission_unknown' }]).label, '任务待核对')
  f.shot.selectedVideoVersionId = 'video-version'
  f.assets.push({ id: 'video-asset', name: '成片', role: 'shot', kind: 'video', versions: [{ id: 'video-version', mimeType: 'video/mp4' }] })
  assert.equal(readiness(f).label, '视频待审核')
  f.shot.reviewedVideoVersionId = 'video-version'
  f.shot.reviewedInputFingerprint = shotInputFingerprint(f.shot, docs)
  assert.equal(readiness(f).label, '已完成')
  let row = productionRows(dataFor(f.continuity, [f.shot]), f.assets)[0]
  assert.equal(row.complete, 1)
  assert.deepEqual(row.referenceIds, [f.shot.id], '成片完成不隐藏仍需处理的参考缺项')
  f.shot.visual += ' 新动作'
  assert.equal(readiness(f).label, '内容已变，待复核')
  row = productionRows(dataFor(f.continuity, [f.shot]), f.assets)[0]
  assert.equal(row.complete, 0)
  assert.deepEqual(row.reviewIds, [f.shot.id])
})
