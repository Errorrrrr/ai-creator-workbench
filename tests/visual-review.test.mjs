import test from 'node:test'
import assert from 'node:assert/strict'
import { createShot, validateStoryboard, normalizeStoryboard } from '../src/storyboard.js'
import { validateWorkspace } from '../src/project-store.js'
import { createEntity, entityStateFingerprint } from '../src/continuity-assets.js'
import { visualInputSnapshot, visualInputFingerprint, imageVisualReviewState, makeVisualReview, validateVisualRecord, visualBaselineText } from '../src/visual-review.js'

function fixture() {
  const entity = createEntity({ id: 'raft', kind: 'prop', name: '木筏', traits: '三块平板与两个蓝色油桶', sourceDocumentIds: ['scene1'], states: [{ id: 'raft-initial', name: '初始状态', referenceVersionId: 'raft-image' }] })
  const continuity = { version: 1, style: '写实日光，木筏始终使用平板结构', entities: [entity] }
  entity.states[0].referenceFingerprint = entityStateFingerprint(entity, entity.states[0], continuity.style)
  const shot = createShot({ title: '木筏近景', visual: '木筏漂浮在海面', action: '陆骁扶住木板', camera: '中景固定', characterNames: [], sceneNames: [], propNames: ['木筏'] }, { documentId: 'scene1', fingerprint: 'old' })
  shot.references = [{ versionId: 'raft-image', role: 'reference', scope: 'continuity', origin: 'auto', entityId: 'raft', stateId: 'raft-initial' }]
  shot.selectedImageVersionId = 'selected-image'
  const assets = [{ id: 'raft-asset', projectId: 'p', kind: 'image', role: 'prop', name: '木筏 · 初始状态 · 道具设定图', selectedVersionId: 'raft-image', versions: [{ id: 'raft-image', mimeType: 'image/png', metadata: { provenance: { entity: { entityId: 'raft', stateId: 'raft-initial', kind: 'prop' } } } }] },
    { id: 'shot-asset', projectId: 'p', kind: 'image', role: 'shot', name: '分镜图', versions: [{ id: 'selected-image', mimeType: 'image/png' }, { id: 'other-image', mimeType: 'image/png' }] }]
  const documents = { scene1: { title: '第一场', content: '陆骁在海面木筏上' } }
  return { shot, assets, documents, continuity, entity }
}
const state = f => imageVisualReviewState(f.shot, f.assets, f.documents, f.continuity)
const snapshot = f => visualInputSnapshot(f.shot, f.assets, f.documents, f.continuity)
const approve = f => { f.shot.visualReview = makeVisualReview(f.shot, f.assets, f.documents, f.continuity, { decision: 'approved', notes: '已并排核对木板、油桶、人物和日光' }); return f }
const basis = f => ({ version: 1, fingerprint: visualInputFingerprint(f.shot, f.assets, f.documents, f.continuity), snapshot: snapshot(f) })
// Rust's serde_json::Value uses a sorted map by default; match that serialization.
const rustJSON = value => Array.isArray(value) ? value.map(rustJSON) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, rustJSON(value[key])])) : value

test('没有生成依据的旧图保持待视觉复核，不能把已绑定参考认定为内容一致', () => {
  const f = fixture(), before = structuredClone(f)
  assert.deepEqual(state(f), { status: 'unreviewed', label: '待视觉复核', reviewed: false, issues: [], changedFields: [] })
  assert.deepEqual(f, before)
})

test('生成时的视觉依据来自图片实际来源，生成完成不自动通过视觉核对', () => {
  const f = fixture()
  f.assets[1].versions[0].metadata = { provenance: { visualBasis: basis(f) } }
  assert.equal(state(f).status, 'unreviewed')
  f.continuity.style += '，高对比暖调'
  assert.equal(state(f).status, 'changed')
  assert.ok(state(f).changedFields.includes('统一视觉基准'))
})

test('旧图片记录的真实参考集合与当前不同，可追踪为参考变化；相同则只待复核', () => {
  const f = fixture()
  f.assets[1].versions[0].metadata = { provenance: { references: [] } }
  assert.equal(state(f).status, 'changed')
  assert.deepEqual(state(f).changedFields, ['固定参考图片'])
  f.assets[1].versions[0].metadata.provenance.references = [{ versionId: 'raft-image', role: 'reference' }]
  assert.equal(state(f).status, 'unreviewed')
})

test('导入图片的残缺历史元数据不使界面崩溃，也不伪造参考已变的结论', () => {
  const f = fixture()
  for (const provenance of [{ references: [null] }, { references: [{ role: 'reference' }] }, { visualBasis: { version: 1 } }, { visualBasis: { version: 1, snapshot: [] } }]) {
    f.assets[1].versions[0].metadata = { provenance }
    assert.equal(state(f).status, 'unreviewed')
  }
})

test('人工复核保留当前图、固定参考与定义，保存恢复后仍可验证通过', () => {
  const f = approve(fixture())
  assert.equal(state(f).reviewed, true)
  assert.equal(state(f).status, 'approved')
  assert.equal(f.shot.visualReview.imageVersionId, f.shot.selectedImageVersionId)
  const stored = JSON.parse(JSON.stringify({ revision: 1, shots: [f.shot], continuity: f.continuity }))
  assert.deepEqual(normalizeStoryboard(stored), stored)
  assert.equal(imageVisualReviewState(stored.shots[0], f.assets, f.documents, stored.continuity).reviewed, true)
})

test('图片生成依据经Rust键序重排保存后仍能读取，并检测后续视觉定义变更', () => {
  const f = fixture(), original = basis(f)
  const stored = rustJSON(original)
  assert.notDeepEqual(Object.keys(original.snapshot), Object.keys(stored.snapshot), '模拟真实跨语言键序重排')
  assert.deepEqual(validateVisualRecord(stored, { generation: true }), stored)
  f.assets[1].versions[0].metadata = { provenance: { visualBasis: stored, references: [{ versionId: 'raft-image', role: 'reference' }] } }
  assert.equal(state(f).status, 'unreviewed')
  assert.deepEqual(state(f).changedFields, [])
  f.entity.traits += '，底部结构变更'
  assert.equal(state(f).status, 'changed', '不能因为键序不同而静默丢弃真实生成依据')
  assert.ok(state(f).changedFields.includes('人物、场景与关键物品设定'))
})

test('含人工复核的项目包经Rust序列化恢复后通过工作区验证，ID重映射后明确待复核', () => {
  const f = approve(fixture())
  const restored = rustJSON(JSON.parse(JSON.stringify({ project: { name: '视觉核对项目' }, documents: f.documents, storyboard: { revision: 1, shots: [f.shot], continuity: f.continuity } })))
  assert.doesNotThrow(() => validateWorkspace(restored))
  const restoredShot = restored.storyboard.shots[0]
  assert.equal(imageVisualReviewState(restoredShot, f.assets, restored.documents, restored.storyboard.continuity).status, 'approved')
  // Full media-package restoration changes local IDs while preserving bytes.
  // That must invalidate the old approval without corrupting its historical note.
  restoredShot.selectedImageVersionId = 'restored-image'
  f.assets[1].versions.push({ id: 'restored-image', mimeType: 'image/png' })
  assert.doesNotThrow(() => validateWorkspace(restored))
  const review = imageVisualReviewState(restoredShot, f.assets, restored.documents, restored.storyboard.continuity)
  assert.equal(review.status, 'changed')
  assert.ok(review.changedFields.includes('选用分镜图'))
  assert.equal(restoredShot.visualReview.notes, f.shot.visualReview.notes)
})

for (const [field, change, label] of [
  ['visual', f => { f.shot.visual += '，突然出现船舷' }, '画面与构图'],
  ['entryState', f => { f.shot.entryState = '站在筏尾' }, '进入状态'],
  ['camera', f => { f.shot.camera = '低机位侧拍' }, '景别与机位'],
  ['style', f => { f.continuity.style = '水彩表现' }, '统一视觉基准'],
  ['definition', f => { f.entity.traits += '，四角增加钢索' }, '人物、场景与关键物品设定'],
  ['source', f => { f.documents.scene1.content += '，正午改为黄昏' }, '来源剧本'],
  ['selection', f => { f.shot.selectedImageVersionId = 'other-image' }, '选用分镜图']
]) test(`复核后 ${field} 变更，明确失效为待复核`, () => {
  const f = approve(fixture())
  change(f)
  assert.equal(state(f).status, 'changed')
  assert.equal(state(f).reviewed, false)
  assert.ok(state(f).changedFields.includes(label))
})

test('同名参考图换固定版本后也须复核，不能只按素材名称判断', () => {
  const f = approve(fixture())
  f.assets[0].versions.push({ id: 'raft-image-new', mimeType: 'image/png' })
  f.entity.states[0].referenceVersionId = 'raft-image-new'
  f.shot.references[0].versionId = 'raft-image-new'
  assert.equal(state(f).status, 'changed')
  assert.ok(state(f).changedFields.includes('固定参考图片'))
})

test('仅台词、剧情时长、视频参数、审核和图片输出排序不令静态画面复核失效', () => {
  const f = approve(fixture()), before = snapshot(f)
  Object.assign(f.shot, { dialogue: '补一句对白', duration: 8, transition: 'continuous', videoDuration: 8, videoMode: 'reference-to-video', imageQuality: 'high', selectedVideoVersionId: 'video', reviewedVideoVersionId: 'video', reviewedInputFingerprint: 'any' })
  f.assets.reverse()
  assert.deepEqual(snapshot(f), before)
  assert.equal(state(f).status, 'approved')
})

test('参考输入和实体列表的无意义顺序变化不失效，也不修改调用方数据', () => {
  const f = fixture()
  f.assets[0].versions.push({ id: 'extra-image', mimeType: 'image/png' })
  f.shot.references.push({ versionId: 'extra-image', role: 'start', scope: 'video', origin: 'manual' })
  approve(f)
  f.shot.references.reverse(); f.continuity.entities.reverse()
  const before = structuredClone(f)
  assert.equal(state(f).status, 'approved')
  assert.deepEqual(f, before)
})

test('无关对象更新不影响本镜头，但同对象适用状态的改变会影响', () => {
  const f = approve(fixture())
  f.continuity.entities.push(createEntity({ kind: 'prop', name: '远处工具箱' }))
  assert.equal(state(f).status, 'approved')
  f.entity.states.push({ ...f.entity.states[0], id: 'raft-damaged', name: '破损', sourceDocumentIds: ['scene1'], basedOnStateId: 'raft-initial', description: '前缘破损' })
  assert.equal(state(f).status, 'changed')
})

test('选用图或固定参考失效、设定图过期时，不能人工误标通过', () => {
  for (const mode of ['selected', 'reference', 'stale', 'unbound', 'source']) {
    const f = fixture()
    if (mode === 'selected') f.shot.selectedImageVersionId = 'missing-image'
    if (mode === 'reference') f.assets.shift()
    if (mode === 'stale') f.entity.traits += '，改为圆木'
    if (mode === 'unbound') f.shot.references = []
    if (mode === 'source') delete f.documents.scene1
    assert.throws(() => approve(f), /先选用|先处理参考问题/u, mode)
    assert.ok(state(f).issues.length > 0, mode)
  }
})

test('手动保留旧状态版本和明确排除不自动换图，复核遵从明确选择', () => {
  const f = fixture()
  f.assets[0].versions.push({ id: 'manual-old', mimeType: 'image/png' })
  f.shot.references = [{ versionId: 'manual-old', role: 'reference', origin: 'manual' }]
  approve(f)
  assert.equal(state(f).status, 'approved')
  assert.equal(f.shot.references[0].versionId, 'manual-old')
  const excluded = fixture()
  excluded.shot.references = []; excluded.shot.referenceExclusions = ['prop:@raft']
  approve(excluded)
  assert.equal(state(excluded).status, 'approved')
  assert.deepEqual(excluded.shot.references, [])
})

test('已排除且未作为实际输入的对象更新定义或参考，不误报本镜图已变', () => {
  const f = fixture()
  f.shot.references = []; f.shot.referenceExclusions = ['prop:@raft']
  approve(f)
  const before = snapshot(f)
  f.entity.traits += '，增加横梁'
  f.entity.states[0].description = '现在期待破损状态'
  f.entity.states[0].referenceVersionId = 'new-excluded-image'
  assert.deepEqual(snapshot(f), before)
  assert.equal(state(f).status, 'approved')
})

test('手选旧状态仅跟踪实际选用图，不跟随未采用的当前状态定义；实际提示改变仍待复核', () => {
  const f = fixture()
  f.assets[0].versions.push({ id: 'manual-old', mimeType: 'image/png' })
  f.shot.references = [{ versionId: 'manual-old', role: 'reference', origin: 'manual' }]
  // The real prompt builder's continuityNotes/stateLines omit manual matches.
  f.shot.continuityNotes = '镜头继续使用手选图片，保持原有木板结构'
  approve(f)
  const before = snapshot(f)
  f.entity.traits += '，设定改为圆木'
  f.entity.states[0].referenceVersionId = 'new-unadopted-image'
  assert.deepEqual(snapshot(f), before)
  assert.equal(state(f).status, 'approved')
  f.shot.continuityNotes = '本次实际发送的补充要求已改成钢制平台'
  assert.equal(state(f).status, 'changed')
  assert.ok(state(f).changedFields.includes('实际连续性提示'))
})

test('手选的正是当前状态图时实际提示仍采用该定义，定义变化继续提示复核', () => {
  const f = fixture()
  f.shot.references[0].origin = 'manual'
  approve(f)
  f.entity.traits += '，当前状态增加斜撑'
  assert.equal(state(f).status, 'changed')
  assert.ok(state(f).changedFields.includes('人物、场景与关键物品设定'))
})

test('不一致复核记录单独保存；修改输入后不能沿用旧拒绝结果冒充新检查', () => {
  const f = fixture()
  f.shot.visualReview = makeVisualReview(f.shot, f.assets, f.documents, f.continuity, { decision: 'rejected', notes: '背景出现船舷，木筏结构不对' })
  assert.equal(state(f).status, 'rejected')
  f.shot.visual += '，移除船舷'
  assert.equal(state(f).status, 'changed')
})

test('已有人工记录优先于图片生成依据，不能被来源记录重置为通过', () => {
  const f = fixture()
  f.assets[1].versions[0].metadata = { provenance: { visualBasis: basis(f) } }
  f.shot.visualReview = makeVisualReview(f.shot, f.assets, f.documents, f.continuity, { decision: 'rejected' })
  assert.equal(state(f).status, 'rejected')
  f.shot.imageGenerationBasis = { ...basis(f), imageVersionId: 'selected-image' }
  assert.equal(state(f).status, 'rejected')
})

test('所有图片版本标识必须唯一且确实为图像，不能靠同名或视频通过', () => {
  const f = fixture()
  f.assets[1].versions[0].mimeType = 'video/mp4'
  assert.equal(state(f).status, 'missing')
  f.assets[1].versions[0].mimeType = 'image/png'
  f.assets.push({ ...f.assets[1], id: 'duplicate-asset' })
  assert.equal(state(f).status, 'missing')
})

test('视觉复核验证拒绝伪造指纹、非法字段、缺字段、过长备注和损坏快照', () => {
  const f = approve(fixture())
  const check = mutate => {
    const shot = structuredClone(f.shot); mutate(shot.visualReview)
    assert.throws(() => validateStoryboard({ revision: 1, shots: [shot] }), /视觉/u)
  }
  check(record => { record.fingerprint = 'fake' })
  check(record => { record.snapshot.fields.visual = {} })
  check(record => { delete record.snapshot.source })
  check(record => { record.snapshot.extra = 'unsupported' })
  check(record => { record.notes = 'x'.repeat(2001) })
  check(record => { record.reviewedAt = 'not-a-date' })
  check(record => { record.decision = 'auto-passed' })
  check(record => { record.imageVersionId = '../another-file' })
  check(record => { record.snapshot.references[0].present = 'yes' })
})

test('视觉快照只包含hash与固定版本，无正文、人物描述、密钥或文件内容', () => {
  const f = fixture()
  f.shot.visual = '木筏漂在海面，长篇画面描述'
  const serialized = JSON.stringify(snapshot(f))
  assert.ok(!serialized.includes(f.shot.visual))
  assert.ok(!serialized.includes(f.documents.scene1.content))
  assert.ok(!serialized.includes(f.entity.traits))
  assert.ok(serialized.includes('raft-image'))
  assert.ok(new TextEncoder().encode(serialized).length < 65536)
})

test('最多500个长标识实体仍保持快照小于64KiB并能验证', () => {
  const f = fixture()
  f.continuity.entities = Array.from({ length: 500 }, (_, index) => createEntity({ id: `entity-${String(index).padStart(4, '0')}-${'x'.repeat(70)}`, kind: 'prop', name: `物品${index}号`, states: [{ id: `state-${String(index).padStart(4, '0')}-${'x'.repeat(65)}`, name: '初始', referenceVersionId: 'r'.repeat(96) }] }))
  f.shot.visual = f.continuity.entities.map(entity => entity.name).join('、')
  f.shot.propNames = undefined; f.shot.references = []
  const current = basis(f)
  assert.equal(current.snapshot.entities.length, 500)
  assert.ok(new TextEncoder().encode(JSON.stringify(current.snapshot)).length < 65536)
  assert.deepEqual(validateVisualRecord(current, { generation: true }), current)
})

test('统一视觉基准提示词保留用户规则，并约束换机位时不重做外观', () => {
  const f = fixture()
  const text = visualBaselineText(f.continuity)
  assert.ok(text.includes(f.continuity.style))
  assert.match(text, /切换机位不重新设计/u)
  assert.ok(!visualBaselineText(undefined).includes('undefined'))
})
