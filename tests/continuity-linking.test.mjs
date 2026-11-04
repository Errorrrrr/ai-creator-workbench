import test from 'node:test'
import assert from 'node:assert/strict'
import { createEntity, createEntityState, entityStateFingerprint, parseEntityExtraction, planEntityImageResults } from '../src/continuity-assets.js'
import { matchContinuityEntities, continuityReadiness, continuityNotes } from '../src/continuity-linking.js'
import { bindShotReferences, matchShotReferences, manualReferencePatch, planReferenceBackfill } from '../src/storyboard-references.js'
import { prepareEntityRequest } from '../src/continuity-request.js'
import { useMediaAdapterCatalog } from '../src/media-adapters.js'

const make = (id = 'raft', kind = 'prop', name = '木筏', patch = {}) => {
  const item = createEntity({ id, kind, name, aliases: [], traits: '保留原有结构', sourceDocumentIds: ['scene-1', 'scene-2'], states: [createEntityState({ id: `${id}-initial`, name: '初始', referenceVersionId: `${id}-image` })], ...patch })
  for (const state of item.states) if (state.referenceVersionId) state.referenceFingerprint = entityStateFingerprint(item, state)
  return item
}
const board = (...entities) => ({ version: 1, style: '', entities })
const imageAsset = (entity, state = entity.states[0], patch = {}) => ({ id: `${entity.id}-asset`, projectId: 'project-1', name: `${entity.name} · ${state.name}`, role: entity.kind, kind: 'image', selectedVersionId: state.referenceVersionId, versions: [{ id: state.referenceVersionId, mimeType: 'image/png', metadata: { provenance: { entity: { entityId: entity.id, stateId: state.id, kind: entity.kind, name: entity.name, stateName: state.name, definitionFingerprint: state.referenceFingerprint } } } }], ...patch })
const shot = (patch = {}) => ({ sourceDocumentId: 'scene-1', visual: '木筏随波前进', references: [], ...patch })
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }

test('人物使用实际画面识别，最长名称和英文边界不会误绑较短角色', () => {
  const people = [make('lin', 'character', '林舟'), make('father', 'character', '林舟父亲'), make('ann', 'character', 'Ann'), make('anna', 'character', 'Anna')]
  const registry = board(...people), assets = people.map(person => imageAsset(person))
  const matches = visual => matchContinuityEntities(shot({ visual }), assets, {}, registry).map(match => match.name)
  assert.deepEqual(matches('林舟父亲坐在屋里。Anna走来。'), ['林舟父亲', 'Anna'])
  assert.deepEqual(matches('林舟父亲坐在屋里，林舟在门外。ANN走来。'), ['林舟', '林舟父亲', 'Ann'])
  assert.deepEqual(matches('Joann拿着Annette的手袋。'), [])
  assert.deepEqual(matches('Ａｎｎ出镜。'), ['Ann'])
})

test('否定、画外和提及不绑定，后面的真实出镜仍可识别；不扫描对白与整个分场', () => {
  const item = make('lin', 'character', '林舟'), registry = board(item), assets = [imageAsset(item)]
  for (const visual of ['谈论林舟。', '等待林舟。', '不见林舟。', '林舟未在画面中。', '林舟（画外）呼喊。', '没有发现林舟。', '林舟处于画外。']) assert.deepEqual(matchContinuityEntities(shot({ visual }), assets, {}, registry), [], visual)
  assert.equal(matchContinuityEntities(shot({ visual: '提到林舟，随后林舟走进画面。' }), assets, {}, registry).length, 1)
  assert.deepEqual(matchContinuityEntities(shot({ visual: '空荡的房间', dialogue: '林舟在哪里？' }), assets, { 'scene-1': { title: '林舟归来', content: '林舟走进房间' } }, registry), [])
})

test('名称和别名可显式指定，旧镜头空物品列表仍可识别实际木筏', () => {
  const item = make('raft', 'prop', '木筏', { aliases: ['浮筏'] }), assets = [imageAsset(item)], registry = board(item)
  assert.equal(matchContinuityEntities(shot({ visual: '空景', propNames: ['浮筏（道具）'] }), assets, {}, registry)[0].inferred, false)
  assert.equal(bindShotReferences(shot({ propNames: [] }), assets, {}, registry).references[0].versionId, 'raft-image')
})

test('场景可以按唯一分场设定回填，多个场景或闪回时不猜背景，不扫描其他场全文', () => {
  const dock = make('dock', 'scene', '码头'), cabin = make('cabin', 'scene', '船舱'), assets = [imageAsset(dock), imageAsset(cabin)]
  assert.equal(matchContinuityEntities(shot({ visual: '近景，杯子倾倒' }), assets, {}, board(dock))[0].name, '码头')
  assert.deepEqual(matchContinuityEntities(shot({ visual: '近景，杯子倾倒' }), assets, {}, board(dock, cabin)), [])
  assert.deepEqual(matchContinuityEntities(shot({ visual: '闪回：杯子倾倒' }), assets, {}, board(dock)), [])
  assert.deepEqual(matchContinuityEntities(shot({ visual: '未见码头，画面只有黑暗' }), assets, {}, board(dock)), [])
  assert.deepEqual(matchContinuityEntities(shot({ visual: '船舱里，杯子倾倒' }), assets, {}, board(dock, cabin)).map(match => match.name), ['船舱'])
})

test('metadata.provenance识别各状态所属实体，切场仅绑定当前状态固定版本', () => {
  const item = make(); item.states.push(createEntityState({ id: 'broken', name: '破损', description: '前缘缺口', sourceDocumentIds: ['scene-2'], basedOnStateId: item.defaultStateId, referenceVersionId: 'broken-image' }))
  item.states[1].referenceFingerprint = entityStateFingerprint(item, item.states[1])
  const assets = [imageAsset(item, item.states[0]), imageAsset(item, item.states[1], { id: 'broken-asset' })], registry = board(item)
  const current = shot(); current.references = bindShotReferences(current, assets, {}, registry).references
  assert.deepEqual(current.references.map(ref => ref.versionId), ['raft-image'])
  const changed = bindShotReferences({ ...current, sourceDocumentId: 'scene-2' }, assets, {}, registry)
  assert.equal(changed.removed, 1); assert.equal(changed.added, 1)
  assert.deepEqual(changed.references.map(ref => [ref.versionId, ref.entityId, ref.stateId]), [['broken-image', 'raft', 'broken']])
  assert.equal(matchShotReferences(shot({ visual: '木筏 · 初始' }), assets, {}, registry).length, 1)
})

test('旧自动引用不携带实体ID时也迁移到新状态，同一资产多个版本不会混用', () => {
  const item = make(), assets = [imageAsset(item)]
  assets[0].versions.push({ id: 'older-image', mimeType: 'image/png' })
  const current = shot({ references: [{ versionId: 'older-image', role: 'reference', scope: 'continuity', origin: 'auto' }] })
  const result = bindShotReferences(current, assets, {}, board(item))
  assert.equal(result.removed, 1); assert.equal(result.added, 1)
  assert.deepEqual(result.references.map(ref => ref.versionId), ['raft-image'])
  assert.equal(result.references[0].stateId, 'raft-initial')
  const again = bindShotReferences({ ...current, references: result.references }, assets, {}, board(item))
  assert.equal(again.added + again.removed, 0)
})

test('旧自动同名图片会被替换，手工及来源不明的同名旧图保留且不叠加新图', () => {
  const item = make('raft', 'prop', '木筏', { aliases: ['浮筏'] }), registry = board(item)
  for (const name of ['木筏 · 白底图', '浮筏.png']) {
    const old = { id: 'old-asset', name, role: 'prop', kind: 'image', selectedVersionId: 'old-image', versions: [{ id: 'old-image', mimeType: 'image/png' }] }
    const assets = [imageAsset(item), old]
    for (const origin of ['manual', undefined]) {
      const current = shot({ references: [{ versionId: 'old-image', role: 'reference', ...(origin ? { origin } : {}) }] })
      const result = bindShotReferences(current, assets, {}, registry)
      assert.equal(result.matches[0].status, 'manual'); assert.equal(result.added + result.removed, 0)
      assert.deepEqual(result.references, current.references)
      assert.equal(continuityNotes(result.matches), '')
    }
    const result = bindShotReferences(shot({ references: [{ versionId: 'old-image', role: 'reference', origin: 'auto' }] }), assets, {}, registry)
    assert.deepEqual(result.references.map(ref => ref.versionId), ['raft-image'])
  }
})

test('空人物初始状态可继承唯一旧角色图，场景和物品不能仅凭同名自动继承', () => {
  const item = make(); item.states[0].referenceVersionId = ''; item.states[0].referenceFingerprint = ''
  const old = imageAsset(item, item.states[0], { name: '木筏 · 白底图', selectedVersionId: 'old-image', versions: [{ id: 'old-image', mimeType: 'image/png' }] })
  const result = planReferenceBackfill({ revision: 1, shots: [shot()], continuity: board(item) }, [old], {}, 'project-1')
  assert.equal(result.storyboard.shots[0].references.length, 0); assert.equal(result.linked.length, 0)
  const person = make('lu', 'character', '陆骁'); person.states[0].referenceVersionId = ''; person.states[0].referenceFingerprint = ''
  const portrait = { ...old, name: '陆骁 · 正脸与三视图', role: 'character' }
  const inherited = planReferenceBackfill({ revision: 1, shots: [shot({ visual: '陆骁走来' })], continuity: board(person) }, [portrait], {}, 'project-1')
  assert.equal(inherited.storyboard.continuity.entities[0].states[0].referenceVersionId, 'old-image')
  assert.deepEqual(inherited.storyboard.shots[0].references.map(ref => [ref.versionId, ref.entityId, ref.stateId]), [['old-image', 'lu', 'lu-initial']])
})

test('手动视频输入、首尾帧保留用途，图片生成不会永久等待重复绑定同一版本', () => {
  const item = make(), assets = [imageAsset(item)], registry = board(item)
  for (const role of ['reference', 'start', 'end']) {
    const current = shot({ references: [{ versionId: 'raft-image', role, scope: 'video', origin: 'manual' }] })
    const result = bindShotReferences(current, assets, {}, registry)
    assert.equal(result.matches[0].status, 'bound'); assert.equal(result.added + result.removed, 0)
    assert.deepEqual(result.references, current.references)
    assert.deepEqual(continuityReadiness(current, assets, {}, registry), [])
  }
})

test('手动选其他状态的设定图不被本场自动状态覆盖', () => {
  const item = make(), oldVersion = { id: 'older-state-image', mimeType: 'image/png', metadata: { provenance: { entity: { entityId: item.id, stateId: 'old-state', kind: item.kind } } } }
  const assets = [imageAsset(item, item.states[0], { name: '已重命名的素材', versions: [...imageAsset(item).versions, oldVersion] })]
  const current = shot({ references: [{ versionId: oldVersion.id, role: 'reference', origin: 'manual' }] })
  const result = bindShotReferences(current, assets, {}, board(item))
  assert.equal(result.matches[0].status, 'manual'); assert.deepEqual(result.references, current.references)
})

test('移除实体参考持久排除，后续换图、重命名均不重新加入，重新手选可解除', () => {
  const item = make(), registry = board(item), assets = [imageAsset(item)]
  let current = shot(); current.references = bindShotReferences(current, assets, {}, registry).references
  Object.assign(current, manualReferencePatch(current, [], assets))
  assert.ok(current.referenceExclusions.includes('prop:@raft'))
  item.name = '平板木筏'; item.states[0].referenceVersionId = 'new-image'; item.states[0].referenceFingerprint = entityStateFingerprint(item, item.states[0])
  const updated = [imageAsset(item)]
  assert.equal(bindShotReferences({ ...current, visual: '平板木筏漂流' }, updated, {}, registry).added, 0)
  assert.equal(matchContinuityEntities({ ...current, visual: '平板木筏漂流' }, updated, {}, registry)[0].status, 'excluded')
  const chosen = manualReferencePatch(current, [{ versionId: 'new-image', role: 'reference' }], updated)
  assert.ok(!chosen.referenceExclusions.includes('prop:@raft'))
})

test('移除手选生成版本或素材暂时丢失时仍通过实体ID持久排除', () => {
  const item = make('lin', 'character', '林舟'), registry = board(item), assets = [imageAsset(item)]
  const manual = shot({ visual: '林舟走来', references: [{ versionId: 'lin-image', role: 'reference', origin: 'manual' }] })
  const removed = manualReferencePatch(manual, [], assets)
  assert.ok(removed.referenceExclusions.includes('character:@lin'))
  assert.equal(bindShotReferences({ ...manual, ...removed }, assets, {}, registry).added, 0)
  const auto = shot({ visual: '林舟走来' }); auto.references = bindShotReferences(auto, assets, {}, registry).references
  const missing = manualReferencePatch(auto, [], [])
  assert.ok(missing.referenceExclusions.includes('character:@lin'))
  assert.equal(bindShotReferences({ ...auto, ...missing }, assets, {}, registry).added, 0)
})

test('图片缺失与设定修改不会沿用旧自动状态，手动参考原样保留', () => {
  const item = make(), assets = [imageAsset(item)], registry = board(item), current = shot()
  current.references = bindShotReferences(current, assets, {}, registry).references
  item.traits = '增加一根固定横梁'
  const stale = bindShotReferences(current, assets, {}, registry)
  assert.equal(stale.removed, 1); assert.equal(stale.added, 0); assert.equal(stale.matches[0].status, 'stale')
  assert.match(continuityReadiness(current, assets, {}, registry)[0], /设定已修改/)
  const missing = bindShotReferences(current, [], {}, registry)
  assert.equal(missing.removed, 1); assert.equal(missing.matches[0].status, 'missing')
  current.references[0].origin = 'manual'
  assert.deepEqual(bindShotReferences(current, assets, {}, registry).references, current.references)
})

test('回填是纯计划，只改当前镜头并保持手工排除和已有历史，重复刷新幂等', () => {
  const item = make(), continuity = board(item), assets = [imageAsset(item)], current = { revision: 5, shots: [shot()], continuity, sourceVersions: [{ shots: [shot()] }] }
  freeze(current); freeze(assets)
  const result = planReferenceBackfill(current, assets)
  assert.equal(result.changed, 1); assert.equal(result.storyboard.revision, 6)
  assert.equal(current.shots[0].references.length, 0)
  assert.deepEqual(result.storyboard.sourceVersions, current.sourceVersions)
  assert.equal(planReferenceBackfill(result.storyboard, assets).changed, 0)
})

test('提取两种木筏状态后先生成基础图，派生图强制参考编辑，完成后按分场绑定各自版本', () => {
  useMediaAdapterCatalog({ schemaVersion: 1, adapters: [{ id: 'openai-images', transport: 'api', capability: 'image', driverId: null, modes: ['generate', 'edit'], referenceRoles: ['reference'], maxReferences: 16 }] })
  const documents = { 'scene-1': { content: '四块平板的木筏顺流前进。' }, 'scene-2': { content: '木筏两侧加装平板扩建。' } }
  const entities = parseEntityExtraction(JSON.stringify({ entities: [{ kind: 'prop', name: '木筏', traits: '平板结构，不用圆木', sourceDocumentIds: ['scene-1', 'scene-2'], states: [{ name: '初始', description: '四块平板', sourceDocumentIds: ['scene-1'] }, { name: '扩建', description: '两侧加装平板', sourceDocumentIds: ['scene-2'] }] }] }), { documents, sourceDocumentIds: ['scene-1', 'scene-2'] })
  const [initial, expanded] = entities[0].states
  assert.equal(expanded.basedOnStateId, initial.id)
  const data = { projectId: 'project-1', workflow: {}, storyboard: { continuity: board(...entities) }, connections: [{ id: 'image-api', kind: 'image-api', adapter: 'openai-images', model: 'image-model', baseUrl: 'https://example.com/v1', defaultFor: ['image'] }] }
  assert.throws(() => prepareEntityRequest(data, [], entities[0].id, expanded.id), /先生成或选择基础状态/)
  const initialRequest = prepareEntityRequest(data, [], entities[0].id, initial.id)
  assert.equal(initialRequest.parameters.mode, 'generate')
  const firstJob = { id: 'first-job', projectId: data.projectId, capability: 'image', status: 'completed', createdAt: '1793066400000', assetId: 'base-asset', request: initialRequest }
  const baseAsset = { id: 'base-asset', projectId: data.projectId, kind: 'image', role: 'prop', name: '木筏 · 初始', versions: [{ id: 'base-image', fileId: 'base-file', bytes: 1000, mimeType: 'image/png', metadata: { provenance: { jobId: firstJob.id, entity: initialRequest.entity } } }] }
  data.storyboard.continuity = planEntityImageResults(data.storyboard.continuity, [baseAsset], [firstJob], data.projectId).continuity
  const expandedRequest = prepareEntityRequest(data, [baseAsset], entities[0].id, expanded.id)
  assert.equal(expandedRequest.parameters.mode, 'edit'); assert.deepEqual(expandedRequest.references, [{ versionId: 'base-image', role: 'reference' }])
  const expandedJob = { ...firstJob, id: 'expanded-job', createdAt: '1793066460000', assetId: 'expanded-asset', request: expandedRequest }
  const expandedAsset = { ...baseAsset, id: 'expanded-asset', name: '木筏 · 扩建', versions: [{ ...baseAsset.versions[0], id: 'expanded-image', fileId: 'expanded-file', metadata: { provenance: { jobId: expandedJob.id, entity: expandedRequest.entity } } }] }
  const assets = [baseAsset, expandedAsset]
  data.storyboard.continuity = planEntityImageResults(data.storyboard.continuity, assets, [firstJob, expandedJob], data.projectId).continuity
  for (const [sourceDocumentId, expected] of [['scene-1', 'base-image'], ['scene-2', 'expanded-image']]) assert.deepEqual(bindShotReferences(shot({ sourceDocumentId }), assets, documents, data.storyboard.continuity).references.map(ref => ref.versionId), [expected])
})
