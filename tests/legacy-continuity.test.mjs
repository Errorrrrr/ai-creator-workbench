import test from 'node:test'
import assert from 'node:assert/strict'
import { createEntity, createEntityState, entityStateFingerprint, normalizeContinuity, mergeEntityExtraction, planEntityImageResults } from '../src/continuity-assets.js'
import { planLegacyContinuityReferences, matchContinuityEntities } from '../src/continuity-linking.js'
import { planReferenceBackfill } from '../src/storyboard-references.js'
import { projectBackup, parseBackup } from '../src/project-store.js'

const character = (patch = {}) => createEntity({ id: 'lu', kind: 'character', name: '陆骁', aliases: ['小陆'], sourceDocumentIds: ['scene-1', 'scene-2'], states: [{ id: 'initial', name: '初始状态' }], ...patch })
const registry = (...entities) => ({ version: 1, style: '水彩动画', entities })
const asset = (patch = {}) => ({ id: 'old-asset', projectId: 'project-1', kind: 'image', role: 'character', name: '陆骁 · 正脸与三视图', selectedVersionId: 'old-image', versions: [{ id: 'old-image', mimeType: 'image/png' }], ...patch })
const shot = (patch = {}) => ({ id: 'shot-1', sourceDocumentId: 'scene-1', visual: '陆骁走进屋里', references: [], ...patch })
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const plan = (continuity, assets) => planLegacyContinuityReferences(continuity, assets, 'project-1')

test('旧角色图固定明确选用版本，原输入不可变，再次刷新幂等', () => {
  const input = freeze(registry(character())), images = freeze([asset({ versions: [{ id: 'older-image', mimeType: 'image/jpeg' }, { id: 'old-image', mimeType: 'image/png' }] })])
  const result = plan(input, images), item = result.continuity.entities[0], state = item.states[0]
  assert.equal(result.changed, 1)
  assert.deepEqual(result.linked, [{ entityId: 'lu', stateId: 'initial', assetId: 'old-asset', versionId: 'old-image' }])
  assert.equal(input.entities[0].states[0].referenceVersionId, '')
  assert.equal(state.referenceFingerprint, entityStateFingerprint(item, state, input.style))
  assert.deepEqual(result.issues, [])
  const again = plan(result.continuity, [asset({ selectedVersionId: 'other-image', versions: [{ id: 'other-image' }] })])
  assert.equal(again.changed, 0); assert.equal(again.continuity, result.continuity)
  assert.equal(again.continuity.entities[0].states[0].referenceVersionId, 'old-image')
})

test('同类型精确名称、括号规范名称和别名可沿用旧角色图，不做模糊子串匹配', () => {
  for (const name of ['陆骁.png', '陆骁（男主） · 正脸与三视图', '小陆 · 角色图.webp']) assert.equal(plan(registry(character()), [asset({ name })]).changed, 1, name)
  for (const name of ['陆骁父亲 · 正脸与三视图', '陆骁 · 受伤', '小陆的朋友']) assert.equal(plan(registry(character()), [asset({ name })]).changed, 0, name)
  assert.equal(plan(registry(character({ name: 'Ａｎｎ', aliases: [] })), [asset({ name: 'ann · 正脸与三视图' })]).changed, 1)
  for (const role of ['scene', 'prop', 'storyboard']) assert.equal(plan(registry(character()), [asset({ role })]).changed, 0)
})

test('改名的旧素材可通过角色来源名称关联，冲突角色来源不会以素材名冒认', () => {
  const version = { id: 'old-image', mimeType: 'image/png', metadata: { provenance: { character: { name: '小陆' } } } }
  assert.equal(plan(registry(character()), [asset({ name: '我选好的造型', versions: [version] })]).changed, 1)
  const conflicting = { ...version, metadata: { provenance: { character: { name: '林舟' } } } }
  assert.equal(plan(registry(character()), [asset({ versions: [conflicting] })]).changed, 0)
  assert.equal(plan(registry(character()), [asset({ versions: [version, { ...conflicting, id: 'other-image' }] })]).changed, 0)
})

test('仅有一版的旧图无需素材选中标记，多版未选和同名多素材给出可见歧义', () => {
  assert.equal(plan(registry(character()), [asset({ selectedVersionId: '' })]).changed, 1)
  const severalVersions = plan(registry(character()), [asset({ selectedVersionId: '', versions: [{ id: 'first' }, { id: 'second' }] })])
  assert.equal(severalVersions.changed, 0); assert.equal(severalVersions.issues[0].reason, 'ambiguous-versions')
  assert.match(severalVersions.issues[0].message, /陆骁.*多个图片版本/)
  const severalAssets = plan(registry(character()), [asset(), asset({ id: 'duplicate', name: '小陆.png' })])
  assert.equal(severalAssets.changed, 0); assert.equal(severalAssets.issues[0].reason, 'ambiguous-assets')
  assert.equal(severalAssets.continuity.entities[0].states[0].referenceVersionId, '')
})

test('失效选择、不合法版本、非图片版本不会回落到其他图片', () => {
  for (const patch of [
    { selectedVersionId: 'gone' },
    { versions: [{ id: 'old-image', mimeType: 'video/mp4' }] },
    { selectedVersionId: '', versions: [{ id: '../unsafe', mimeType: 'image/png' }] },
    { versions: [{ id: 'old-image', mimeType: 'image/png' }, { id: 'old-image', mimeType: 'image/png' }] },
    { versions: [{ id: 'old-image' }] },
    { versions: [{ id: 'old-image', mimeType: 123 }] },
  ]) {
    const result = plan(registry(character()), [asset(patch)])
    assert.equal(result.changed, 0); assert.equal(result.issues.length, 1)
  }
})

test('仅当前项目的旧角色图参与关联和镜头回填', () => {
  const foreign = asset({ id: 'foreign', projectId: 'project-2' })
  assert.equal(plan(registry(character()), [foreign]).changed, 0)
  const local = asset({ selectedVersionId: 'local-image', versions: [{ id: 'local-image', mimeType: 'image/png' }] })
  const result = plan(registry(character()), [foreign, local])
  assert.equal(result.continuity.entities[0].states[0].referenceVersionId, 'local-image')
  const backfilled = planReferenceBackfill({ revision: 1, shots: [shot()], continuity: registry(character()) }, [foreign], {}, 'project-1')
  assert.deepEqual(backfilled.storyboard.shots[0].references, [])
})

test('带实体或状态来源的图片不能通过同名被重新解释成旧基础角色图', () => {
  for (const entity of [{ entityId: 'other', stateId: 'initial', kind: 'character' }, { entityId: 'lu', stateId: 'hurt', kind: 'character' }, { entityId: 'lu', stateId: 'initial', kind: 'character' }]) {
    const existing = asset({ versions: [{ id: 'old-image', mimeType: 'image/png', metadata: { provenance: { entity } } }] })
    assert.equal(plan(registry(character()), [existing]).changed, 0)
  }
})

test('当前项目中其他素材持有同一版本标识时拒绝关联，跨项目同标识不干扰本项目', () => {
  const other = asset({ id: 'other-asset', name: '别的人物' })
  const ambiguous = plan(registry(character()), [asset(), other])
  assert.equal(ambiguous.changed, 0); assert.equal(ambiguous.issues[0].reason, 'ambiguous-version-id')
  assert.equal(plan(registry(character()), [asset(), { ...other, projectId: 'other-project' }]).changed, 1)
})

test('旧基础角色图不填充派生状态，也不填充被改为默认的派生状态', () => {
  const item = character(); item.states.push(createEntityState({ id: 'hurt', name: '受伤', sourceDocumentIds: ['scene-2'], basedOnStateId: 'initial' }))
  const result = plan(registry(item), [asset()])
  assert.equal(result.changed, 1); assert.equal(result.continuity.entities[0].states[1].referenceVersionId, '')
  const matches = matchContinuityEntities(shot({ sourceDocumentId: 'scene-2' }), [asset()], {}, result.continuity)
  assert.equal(matches[0].status, 'missing'); assert.equal(matches[0].stateId, 'hurt')
  assert.equal(plan(registry({ ...item, defaultStateId: 'hurt' }), [asset()]).changed, 0)
})

test('已有图、已确认空选择、明确退出和生成检查点均不覆盖', () => {
  for (const patch of [
    { referenceVersionId: 'manual-image' }, { referenceFingerprint: 'previous-choice' },
    { legacyReferenceOptOut: true }, { imageResultCheckpoint: { jobId: 'completed-job', createdAt: '2026-10-28T10:00:00Z' } },
  ]) {
    const item = character(); Object.assign(item.states[0], patch)
    const input = registry(item), result = plan(input, [asset()])
    assert.equal(result.changed, 0); assert.equal(result.continuity, input)
    assert.deepEqual(result.continuity.entities[0].states[0], item.states[0])
  }
})

test('明确清空标记兼容保存和读取，解除后可以重新自动关联', () => {
  const item = character(); item.states[0].legacyReferenceOptOut = true
  const roundTrip = normalizeContinuity(JSON.parse(JSON.stringify(registry(item))))
  assert.equal(plan(roundTrip, [asset()]).changed, 0)
  roundTrip.entities[0].states[0].legacyReferenceOptOut = false
  assert.equal(plan(roundTrip, [asset()]).changed, 1)
  roundTrip.entities[0].states[0].legacyReferenceOptOut = 'true'
  assert.throws(() => normalizeContinuity(roundTrip), /自动关联设置无效/)
})

test('正文备份恢复和重复提取都保留用户退出旧图自动关联的选择', () => {
  const item = character(); item.states[0].legacyReferenceOptOut = true
  const workspace = { schemaVersion: 2, project: { name: '旧角色迁移', type: '短剧' }, currentDocId: 'scene-1', activeTab: 'script', documents: { 'scene-1': { title: '第一场', content: '陆骁走来。' }, 'scene-2': { title: '第二场', content: '陆骁离开。' } }, tabContents: {}, storyboard: { revision: 1, shots: [], continuity: registry(item) } }
  const restored = parseBackup(projectBackup(workspace)).workspace.storyboard.continuity
  assert.equal(restored.entities[0].states[0].legacyReferenceOptOut, true)
  assert.equal(plan(restored, [asset()]).changed, 0)
  const merged = mergeEntityExtraction(restored, [character({ description: '补充人物设定' })])
  assert.equal(merged.entities[0].states[0].legacyReferenceOptOut, true)
  assert.equal(plan(merged, [asset()]).changed, 0)
})

test('退出旧图关联后的旧生成结果受检查点保护，新主动生成仍可正常采用', () => {
  const item = character(), state = item.states[0]
  state.legacyReferenceOptOut = true; state.imageResultCheckpoint = { jobId: 'clear-checkpoint', createdAt: '100' }
  const input = registry(item), metadata = { entityId: item.id, stateId: state.id, kind: item.kind, definitionFingerprint: entityStateFingerprint(item, state, input.style) }
  const job = { id: 'image-job', projectId: 'project-1', capability: 'image', status: 'completed', createdAt: '99', assetId: 'generated', request: { entity: metadata } }
  const generated = asset({ id: 'generated', versions: [{ id: 'new-image', mimeType: 'image/png', metadata: { provenance: { jobId: job.id, entity: metadata } } }] })
  assert.equal(planEntityImageResults(input, [generated], [job], 'project-1').changed, 0)
  const updated = planEntityImageResults(input, [generated], [{ ...job, createdAt: '101' }], 'project-1')
  assert.equal(updated.continuity.entities[0].states[0].referenceVersionId, 'new-image')
  assert.equal(updated.continuity.entities[0].states[0].legacyReferenceOptOut, true)
  assert.equal(plan(updated.continuity, [asset()]).changed, 0)
})

test('旧自动镜头引用升级为实体和状态固定引用，不重复挂图，历史镜头不修改', () => {
  const oldRef = { versionId: 'old-image', role: 'reference', scope: 'continuity', origin: 'auto' }
  const current = freeze({ revision: 7, continuity: registry(character()), shots: [shot({ references: [oldRef] })], sourceVersions: [{ shots: [shot({ references: [oldRef] })] }] })
  const result = planReferenceBackfill(current, [asset()], {}, 'project-1')
  assert.equal(result.storyboard.revision, 8); assert.equal(result.added, 1); assert.equal(result.removed, 1)
  assert.deepEqual(result.storyboard.shots[0].references, [{ ...oldRef, entityId: 'lu', stateId: 'initial' }])
  assert.equal(result.storyboard.sourceVersions, current.sourceVersions)
  const again = planReferenceBackfill(result.storyboard, [asset()], {}, 'project-1')
  assert.equal(again.changed, 0); assert.equal(again.storyboard.revision, 8)
})

test('镜头手选版本和显式排除继续生效，自动关联只补实体默认状态', () => {
  const images = [asset({ versions: [{ id: 'old-image', mimeType: 'image/png' }, { id: 'manual-image', mimeType: 'image/png' }] })]
  for (const origin of ['manual', undefined]) {
    const reference = { versionId: 'manual-image', role: 'reference', ...(origin ? { origin } : {}) }
    const result = planReferenceBackfill({ revision: 1, continuity: registry(character()), shots: [shot({ references: [reference] })] }, images, {}, 'project-1')
    assert.equal(result.linked.length, 1); assert.deepEqual(result.storyboard.shots[0].references, [reference])
  }
  for (const exclusion of ['character:@lu', 'character:小陆']) {
    const result = planReferenceBackfill({ revision: 1, continuity: registry(character()), shots: [shot({ referenceExclusions: [exclusion] })] }, images, {}, 'project-1')
    assert.equal(result.linked.length, 1); assert.deepEqual(result.storyboard.shots[0].references, [])
  }
})

test('尚无镜头时也能持久化旧图关联，有图后重规划也能关联，空库维持兼容', () => {
  const current = { revision: 2, continuity: registry(character()), shots: [] }
  const before = planReferenceBackfill(current, [], {}, 'project-1')
  assert.equal(before.changed, 0)
  const after = planReferenceBackfill(before.storyboard, [asset()], {}, 'project-1')
  assert.equal(after.changed, 1); assert.equal(after.storyboard.revision, 3)
  const absent = planReferenceBackfill({ revision: 0, shots: [] }, [asset()], {}, 'project-1')
  assert.equal(absent.changed, 0); assert.equal(Object.hasOwn(absent.storyboard, 'continuity'), false)
})
