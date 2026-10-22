import test from 'node:test'
import assert from 'node:assert/strict'
import { createShot, validateStoryboard, storyboardPrompt, parseStoryboardCandidate } from '../src/storyboard.js'
import { bindShotReferences, matchShotReferences, referenceBindingWarnings, manualReferencePatch, planReferenceBackfill } from '../src/storyboard-references.js'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'

const asset = (role, name, id) => ({ id: `a-${id}`, role, name, kind: 'image', selectedVersionId: id, versions: [{ id, mimeType: 'image/png' }] })
const assets = [asset('character', '陆骁 · 正脸与三视图', 'lu'), asset('character', '苏遥', 'su'), asset('scene', '木筏 · 日', 'day'), asset('scene', '木筏 · 夜', 'night'), asset('prop', '匕首 · 白底图', 'knife')]
const documents = { scene: { title: 'SC001 木筏 · 日', content: '苏遥出场。' } }
const oldShot = () => createShot({ visual: '陆骁站在木筏上，握紧匕首。', dialogue: '苏遥在哪里？' }, { documentId: 'scene' })

test('旧镜头从画面和分场时段识别三类素材，不把对白或整场剧本中的人物关联进来', () => {
  assert.deepEqual(bindShotReferences(oldShot(), assets, documents).references.map(r => r.versionId), ['lu', 'day', 'knife'])
  for (const visual of ['提起苏遥。', '苏遥（画外）呼喊。', '苏遥未入镜。', '苏遥被提及。']) {
    assert.equal(matchShotReferences(createShot({ visual }), assets).some(m => m.name === '苏遥'), false)
  }
})

test('补图后自动关联且反复刷新幂等，固定旧版本和手动首帧保持不变', () => {
  const shot = oldShot()
  shot.references = [{ versionId: 'old-lu', role: 'start' }, { versionId: 'manual', role: 'reference' }]
  const ready = structuredClone(assets); ready[0].versions.push({ id: 'old-lu', mimeType: 'image/png' })
  const waiting = ready.map(a => ({ ...a, selectedVersionId: '' }))
  const board = { revision: 4, shots: [shot] }
  assert.equal(planReferenceBackfill(board, waiting, documents).changed, 0)
  const plan = planReferenceBackfill(board, ready, documents)
  assert.equal(plan.added, 2)
  assert.deepEqual(plan.storyboard.shots[0].references.map(r => r.versionId), ['old-lu', 'manual', 'day', 'knife'])
  assert.equal(plan.storyboard.revision, 5)
  assert.equal(board.revision, 4)
  assert.equal(planReferenceBackfill(plan.storyboard, ready, documents).changed, 0)
})

test('手动移除持久排除后补版本，手动重新选用或恢复排除后可重新关联', () => {
  let shot = oldShot(); shot.references = bindShotReferences(shot, assets, documents).references
  Object.assign(shot, manualReferencePatch(shot, shot.references.filter(r => r.versionId !== 'knife'), assets))
  shot = JSON.parse(JSON.stringify(shot))
  const updated = [...assets.slice(0, 4), asset('prop', '匕首 · 白底图', 'knife-new')]
  assert.equal(bindShotReferences(shot, updated, documents).added, 0)
  assert.equal(matchShotReferences(shot, updated, documents).find(m => m.role === 'prop').status, 'excluded')
  assert.deepEqual(manualReferencePatch(shot, [...shot.references, { versionId: 'knife-new', role: 'reference' }], updated).referenceExclusions, [])
  shot.referenceExclusions = []
  assert.equal(bindShotReferences(shot, updated, documents).added, 1)
})

test('场景时段冲突、时段不明和重名不猜测；显式空数组覆盖旧镜头自动识别', () => {
  assert.equal(matchShotReferences(createShot({ visual: '木筏漂浮' }), assets).find(m => m.role === 'scene').status, 'ambiguous')
  assert.equal(matchShotReferences(createShot({ visual: '木筏漂浮，夜幕降临' }), [assets[2]]).find(m => m.role === 'scene').status, 'ambiguous')
  assert.equal(matchShotReferences(oldShot(), [...assets, asset('character', '陆骁', 'duplicate')], documents)[0].status, 'ambiguous')
  assert.deepEqual(bindShotReferences({ ...oldShot(), characterNames: [], sceneNames: [], propNames: [] }, assets, documents).references, [])
  const shot = oldShot(); shot.references = Array.from({ length: 16 }, (_, i) => ({ versionId: `manual-${i}`, role: 'reference' }))
  assert.ok(bindShotReferences(shot, assets, documents).matches.every(m => m.status === 'limit'))
})

test('新拆镜三类名称保存并导出 Flow 和 Muse 对应图片，非法字段拒绝', () => {
  const shot = parseStoryboardCandidate(JSON.stringify({ shots: [{ visual: '持刀', characterNames: ['陆骁'], sceneNames: ['木筏 · 夜'], propNames: ['匕首'] }] }))[0]
  shot.references = bindShotReferences(shot, assets).references
  const storyboard = { revision: 1, shots: [shot] }
  assert.deepEqual(validateStoryboard(JSON.parse(JSON.stringify(storyboard))), storyboard)
  for (const build of [buildFlowExport, buildMuseExport]) assert.deepEqual(build({ project: { name: '测试' }, storyboard }, assets).images.map(i => i.versionId), ['lu', 'night', 'knife'])
  for (const field of ['sceneNames', 'propNames']) assert.throws(() => createShot({ [field]: '错误类型' }))
  assert.match(storyboardPrompt('', [], { scene: ['木筏'], prop: ['匕首'] }), /sceneNames/)
  assert.match(storyboardPrompt('', [], { scene: ['木筏'], prop: ['匕首'] }), /匕首/)
})

test('自动补齐入口在刷新后保存，拆镜中暂缓，失败不改原镜头', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('  async function synchronizeReferences()'), source.indexOf('  function reserveStoryboardTask('))
  for (const mode of ['ready', 'task', 'generating', 'transition', 'foreign', 'failure']) {
    const data = { projectId: 'p', documents, storyboard: { revision: 2, shots: [oldShot()] }, textGenerating: mode === 'generating', mutationBusy: mode === 'transition' }
    const calls = [], notices = [], scheduled = []
    const env = { context: () => data, referenceSyncBusy: false, loading: false, error: '', operationBusy: false, storyboardTasks: { active: () => mode === 'task' }, invoke: true, projectId: mode === 'foreign' ? 'another' : 'p', assets, planReferenceBackfill, scheduleReferenceSync: () => scheduled.push(true), commit: async (patch, options) => { calls.push(options); if (mode === 'failure') throw new Error('磁盘不可写'); data.storyboard = patch.storyboard }, renderShots() {}, refreshReferenceDetails() {}, notify: message => notices.push(message) }
    vm.createContext(env); vm.runInContext(`${handler}\nthis.sync = synchronizeReferences`, env)
    await env.sync()
    assert.equal(calls.length, ['ready', 'failure'].includes(mode) ? 1 : 0)
    assert.equal(scheduled.length, mode === 'transition' ? 1 : 0)
    assert.equal(data.storyboard.shots[0].references.length, mode === 'ready' ? 3 : 0)
    assert.equal(env.referenceSyncBusy, false)
    if (mode === 'ready') { assert.equal(calls[0].atomic, true); assert.equal(calls[0].revision, 2); await env.sync(); assert.equal(calls.length, 1) }
    if (mode === 'failure') assert.match(notices[0], /未保存.*磁盘不可写/)
  }
})

test('切换角色、场景时段与道具后只移除失效自动项，手动引用及旧引用保留', () => {
  const ready = [...assets, asset('prop', '绳索', 'rope')]
  const shot = createShot({ visual: '陆骁持刀', characterNames: ['陆骁'], sceneNames: ['木筏 · 日'], propNames: ['匕首'] })
  shot.references = bindShotReferences(shot, ready).references
  assert.ok(shot.references.every(ref => ref.origin === 'auto' && ref.scope === 'continuity'))
  shot.references.push({ versionId: 'old-manual', role: 'start', origin: 'manual' }, { versionId: 'legacy', role: 'reference' })
  Object.assign(shot, { characterNames: ['苏遥'], sceneNames: ['木筏 · 夜'], propNames: ['绳索'] })
  const result = bindShotReferences(shot, ready)
  assert.equal(result.removed, 3); assert.equal(result.added, 3)
  assert.deepEqual(result.references.map(ref => ref.versionId), ['old-manual', 'legacy', 'su', 'night', 'rope'])
  const board = { revision: 1, shots: [shot] }, plan = planReferenceBackfill(board, ready)
  assert.equal(plan.removed, 3); assert.equal(plan.changed, 1); assert.equal(plan.storyboard.revision, 2)
  assert.equal(planReferenceBackfill(plan.storyboard, ready).changed, 0)
  assert.deepEqual(shot.references.slice(0, 3).map(ref => ref.versionId), ['lu', 'day', 'knife'])
})

test('自动清理支持仅移除、不添加；场景时段改变但没有新图时不继续使用旧时段图', () => {
  const shot = createShot({ visual: '木筏漂浮', sceneNames: ['木筏 · 日'], characterNames: [], propNames: [] })
  shot.references = bindShotReferences(shot, assets).references
  shot.sceneNames = ['木筏 · 夜']
  const result = bindShotReferences(shot, assets.filter(asset => asset.selectedVersionId !== 'night'))
  assert.equal(result.added, 0); assert.equal(result.removed, 1)
  assert.equal(result.matches[0].status, 'ambiguous'); assert.deepEqual(result.references, [])
  shot.sceneNames = []
  const plan = planReferenceBackfill({ revision: 3, shots: [shot] }, assets)
  assert.equal(plan.changed, 1); assert.equal(plan.removed, 1); assert.equal(plan.storyboard.revision, 4)
})

test('手动接管自动引用与用途修改不被之后同步移除；未改的自动项仍有来源', () => {
  const shot = oldShot(); shot.references = bindShotReferences(shot, assets, documents).references
  const next = shot.references.map(ref => ref.versionId === 'lu' ? { ...ref, origin: 'manual' } : ref.versionId === 'knife' ? { ...ref, scope: 'video' } : ref)
  Object.assign(shot, manualReferencePatch(shot, next, assets))
  assert.deepEqual(shot.references.map(ref => ref.origin), ['manual', 'auto', 'manual'])
  Object.assign(shot, { characterNames: [], sceneNames: [], propNames: [] })
  assert.deepEqual(bindShotReferences(shot, assets, documents).references.map(ref => ref.versionId), ['lu', 'knife'])
  const manual = manualReferencePatch(shot, [...shot.references, { versionId: 'su', role: 'reference' }], assets)
  assert.equal(manual.references.at(-1).origin, 'manual')
})

test('旧引用不猜测来源并提示未匹配项；同一实体的已固定版本不随素材选用版本漂移', () => {
  const shot = createShot({ visual: '苏遥', characterNames: ['苏遥'], sceneNames: [], propNames: [] })
  shot.references = [{ versionId: 'lu', role: 'reference' }, { versionId: 'knife', role: 'reference', origin: 'manual' }]
  const result = bindShotReferences(shot, assets)
  assert.equal(result.removed, 0); assert.equal(result.added, 1)
  const warnings = referenceBindingWarnings(shot, assets)
  assert.equal(warnings.legacy.length, 1)
  assert.deepEqual(warnings.unmatched.map(item => item.ref.versionId), ['lu', 'knife'])
  const original = oldShot(); original.references = bindShotReferences(original, assets, documents).references
  const updated = structuredClone(assets); updated[0].versions.push({ id: 'new-lu', mimeType: 'image/png' }); updated[0].selectedVersionId = 'new-lu'
  assert.deepEqual(bindShotReferences(original, updated, documents).references, original.references)
  validateStoryboard({ revision: 0, shots: [original] })
  const corrupt = structuredClone(original); corrupt.references[0].origin = 'guess'
  assert.throws(() => validateStoryboard({ revision: 0, shots: [corrupt] }), /来源/)
})
