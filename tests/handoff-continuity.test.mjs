import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'
import { createShot, shotInputFingerprint } from '../src/storyboard.js'
import { createEntity, createEntityState, emptyContinuity, entityStateFingerprint } from '../src/continuity-assets.js'
import { planReferenceBackfill } from '../src/storyboard-references.js'

const style = '写实，统一冷色调'
const file = (bundle, path) => bundle.texts.find(entry => entry.path === path)?.content
const manifest = bundle => JSON.parse(file(bundle, 'manifest.json'))
const builders = [['Flow', buildFlowExport], ['Muse', buildMuseExport]]

function entity(kind = 'prop', name = '木筏') {
  const base = createEntityState({ id: `${kind}-initial`, name: '完整', description: '完整无破损', sourceDocumentIds: ['scene-1'], referenceVersionId: `${kind}-base-image` })
  const changed = createEntityState({ id: `${kind}-changed`, name: '受损', description: '右前角有明显缺口', sourceDocumentIds: ['scene-2'], basedOnStateId: base.id, referenceVersionId: `${kind}-changed-image` })
  const result = createEntity({ id: kind, kind, name, traits: `${name}固定特征不能改变`, sourceDocumentIds: ['scene-1', 'scene-2'], states: [base, changed], defaultStateId: base.id })
  for (const state of result.states) state.referenceFingerprint = entityStateFingerprint(result, state, style)
  return result
}

function assetFor(item, state = item.states[0]) {
  return { id: `${state.id}-asset`, projectId: 'project-1', kind: 'image', role: item.kind, name: `${item.name} · ${state.name}`, selectedVersionId: 'unrelated-new-version', versions: [
    { id: state.referenceVersionId, mimeType: 'image/png', metadata: { provenance: { entity: { entityId: item.id, stateId: state.id, kind: item.kind, definitionFingerprint: state.referenceFingerprint } } } },
    { id: `${state.id}-new-version`, mimeType: 'image/jpeg' }
  ] }
}

function sceneShot(source = 'scene-1', names = { propNames: ['木筏'] }) {
  const shot = createShot({ title: '镜头', ...names })
  shot.sourceDocumentId = source
  return shot
}
function context(entities, shots) { return { projectId: 'project-1', project: { name: '连续性', type: '短剧' }, storyboard: { revision: 4, shots, continuity: { ...emptyContinuity(), style, entities } }, documents: {} } }

for (const [name, build] of builders) {
  test(`${name} 按分场固定人物、场景、物品状态与图片，不混入其他状态或素材新版本`, () => {
    const entities = [entity('character', '苏遥'), entity('scene', '码头'), entity()]
    const data = context(entities, ['scene-1', 'scene-2'].map(source => sceneShot(source, { characterNames: ['苏遥'], sceneNames: ['码头'], propNames: ['木筏'] })))
    data.storyboard.shots[1].references = [{ role: 'reference', scope: 'continuity', origin: 'auto', entityId: 'prop', stateId: 'prop-initial', versionId: 'prop-base-image' }]
    const assets = entities.flatMap(item => item.states.map(state => assetFor(item, state)))
    const before = structuredClone({ data, assets }), bundle = build(data, assets), output = manifest(bundle)
    assert.deepEqual(bundle.images.map(image => image.versionId), ['character-base-image', 'scene-base-image', 'prop-base-image', 'character-changed-image', 'scene-changed-image', 'prop-changed-image'])
    assert.equal(output.version, 1)
    for (const [index, shot] of output.shots.entries()) {
      assert.equal(shot.continuity.entities.length, 3)
      for (const state of shot.continuity.entities) {
        assert.equal(state.status, 'bound')
        assert.equal(state.stateName, index ? '受损' : '完整')
        assert.equal(state.basedOnStateName, index ? '完整' : '')
        assert.equal(state.usedReferences.length, 1)
        assert.equal(state.usedReferences[0].versionId, state.referenceVersionId)
      }
      for (const reference of shot.references) {
        assert.equal(reference.stateName, index ? '受损' : '完整')
        assert.equal(reference.definitionStatus, 'current')
        assert.ok(reference.entityId)
        assert.equal(reference.states.length, 1)
      }
      const synchronized = planReferenceBackfill(data.storyboard, assets, data.documents, data.projectId)
      assert.equal(shot.inputFingerprint, shotInputFingerprint(synchronized.storyboard.shots[index], data.documents))
      assert.equal(shot.inputSnapshotVersion, 1)
      assert.match(file(bundle, `shot-00${index + 1}/prompt.txt`), /固定特征不能改变/)
    }
    assert.match(file(bundle, 'shot-002/说明.md'), /基础状态：完整/)
    assert.match(file(bundle, 'shot-002/prompt.txt'), /不能擅自改变人物身份/)
    assert.deepEqual({ data, assets }, before)
  })

  test(`${name} 保留手选基础状态图，但不冒充本场派生状态图`, () => {
    const item = entity(), shot = sceneShot('scene-2')
    shot.references = [{ role: 'reference', origin: 'manual', versionId: 'prop-base-image' }]
    const assets = item.states.map(state => assetFor(item, state)), data = context([item], [shot]), before = structuredClone(data)
    const bundle = build(data, assets), output = manifest(bundle).shots[0]
    assert.deepEqual(bundle.images.map(image => image.versionId), ['prop-base-image'])
    assert.equal(output.references[0].stateId, 'prop-initial')
    assert.equal(output.continuity.entities[0].stateId, 'prop-changed')
    assert.equal(output.continuity.entities[0].status, 'manual')
    assert.equal(output.continuity.entities[0].usedReferences[0].selection, 'manual')
    assert.ok(!file(bundle, 'shot-001/prompt.txt').includes('右前角有明显缺口'))
    assert.match(file(bundle, 'shot-001/说明.md'), /保留手动选择/)
    assert.match(file(bundle, 'shot-001/说明.md'), /固定版本 prop-base-image；完整/)
    assert.deepEqual(data, before)
  })

  test(`${name} 手动未知版本不会伪称当前状态，也不被素材库当前版本替换`, () => {
    const item = entity(), shot = sceneShot(), asset = assetFor(item)
    shot.references = [{ role: 'reference', origin: 'manual', versionId: 'prop-initial-new-version' }]
    const bundle = build(context([item], [shot]), [asset]), output = manifest(bundle).shots[0]
    assert.equal(bundle.images[0].versionId, 'prop-initial-new-version')
    assert.equal(output.references[0].entityId, 'prop')
    assert.equal(output.references[0].stateId, null)
    assert.equal(output.references[0].stateName, null)
    assert.equal(output.continuity.entities[0].status, 'manual')
    assert.match(file(bundle, 'shot-001/说明.md'), /手选图片，状态未确认/)
    assert.ok(!file(bundle, 'shot-001/prompt.txt').includes('木筏固定特征不能改变'))
  })

  test(`${name} 手动排除设定后不重新添加附件或提示词`, () => {
    const item = entity(), shot = sceneShot()
    shot.references = [{ role: 'reference', origin: 'auto', scope: 'continuity', entityId: item.id, stateId: item.defaultStateId, versionId: item.states[0].referenceVersionId }]
    shot.referenceExclusions = ['prop:@prop']
    const bundle = build(context([item], [shot]), [assetFor(item)])
    assert.deepEqual(bundle.images, [])
    assert.equal(manifest(bundle).shots[0].continuity.entities[0].status, 'excluded')
    assert.ok(!file(bundle, 'shot-001/prompt.txt').includes('木筏固定特征不能改变'))
  })

  test(`${name} 旧角色图按别名关联后直接进入导出，且固定已选版本`, () => {
    const item = entity('character', '苏遥')
    item.aliases = ['小苏']; item.states[0].referenceVersionId = ''; item.states[0].referenceFingerprint = ''
    const legacy = { id: 'legacy', projectId: 'project-1', kind: 'image', role: 'character', name: '小苏 · 正脸与三视图.png', selectedVersionId: 'legacy-selected', versions: [{ id: 'legacy-selected', mimeType: 'image/png' }, { id: 'legacy-other', mimeType: 'image/jpeg' }] }
    const data = context([item], [sceneShot('scene-1', { characterNames: ['苏遥'] })]), before = structuredClone(data)
    const bundle = build(data, [legacy]), output = manifest(bundle).shots[0]
    assert.deepEqual(bundle.images.map(image => image.versionId), ['legacy-selected'])
    assert.equal(output.references[0].entityId, 'character')
    assert.equal(output.references[0].stateId, 'character-initial')
    assert.equal(output.continuity.entities[0].referenceVersionId, 'legacy-selected')
    assert.equal(output.continuity.entities[0].status, 'bound')
    assert.deepEqual(data, before)
  })

  test(`${name} 旧角色图歧义明确报告且不猜测图片`, () => {
    const item = entity('character', '苏遥')
    item.states[0].referenceVersionId = ''; item.states[0].referenceFingerprint = ''
    const assets = ['first', 'second'].map(id => ({ id, projectId: 'project-1', kind: 'image', role: 'character', name: '苏遥 · 正脸与三视图', selectedVersionId: `${id}-image`, versions: [{ id: `${id}-image`, mimeType: 'image/png' }] }))
    const bundle = build(context([item], [sceneShot('scene-1', { characterNames: ['苏遥'] })]), assets)
    assert.deepEqual(bundle.images, [])
    assert.equal(manifest(bundle).shots[0].continuity.entities[0].status, 'ambiguous')
    assert.match(file(bundle, 'shot-001/说明.md'), /歧义/)
  })

  test(`${name} 派生状态缺图不能偷用基础图，自动过期图不能导出`, () => {
    for (const missing of [false, true]) {
      const item = entity(), shot = sceneShot('scene-2'), assets = item.states.map(state => assetFor(item, state))
      const state = item.states[1]
      if (missing) { state.referenceVersionId = ''; state.referenceFingerprint = '' }
      else { state.description = '剧情刚修改为完全破损'; shot.references = [{ role: 'reference', origin: 'auto', scope: 'continuity', entityId: item.id, stateId: state.id, versionId: state.referenceVersionId }] }
      const data = context([item], [shot]), before = structuredClone(data), bundle = build(data, missing ? [assets[0]] : assets)
      assert.deepEqual(bundle.images, [])
      assert.equal(manifest(bundle).shots[0].continuity.entities[0].status, missing ? 'missing' : 'stale')
      assert.match(file(bundle, 'shot-001/说明.md'), missing ? /缺少当前状态图/ : /设定已过期/)
      assert.match(file(bundle, 'shot-001/prompt.txt'), /未用其他状态图片代替/)
      assert.deepEqual(data, before)
    }
  })

  test(`${name} 手选过期图保留且明确标记过期，不伪称已验证当前设定`, () => {
    const item = entity(), assets = [assetFor(item)], shot = sceneShot()
    item.traits = '设定修改为新颜色'
    shot.references = [{ role: 'reference', origin: 'manual', versionId: 'prop-base-image' }]
    const bundle = build(context([item], [shot]), assets), output = manifest(bundle).shots[0]
    assert.equal(bundle.images[0].versionId, 'prop-base-image')
    assert.equal(output.references[0].definitionStatus, 'stale')
    assert.equal(output.continuity.entities[0].status, 'stale')
    assert.match(file(bundle, 'shot-001/说明.md'), /设定已过期/)
  })

  test(`${name} 不导出其他项目的同名素材`, () => {
    const item = entity('character', '苏遥'), foreign = assetFor(item)
    foreign.projectId = 'foreign-project'
    const shot = sceneShot('scene-1', { characterNames: ['苏遥'] }), data = context([item], [shot])
    assert.deepEqual(build(data, [foreign]).images, [])
    shot.references = [{ role: 'reference', origin: 'manual', versionId: 'character-base-image' }]
    assert.throws(() => build(data, [foreign]), /版本不存在/)
  })
}
