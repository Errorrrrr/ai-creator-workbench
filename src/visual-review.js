import { entityStateFingerprint } from './continuity-assets.js'
import { matchShotReferences } from './storyboard-references.js'
import { sceneContinuityContext, sceneContinuityStateDocumentIds } from './scene-continuity.js'

const FIELDS = ['title', 'visual', 'action', 'camera', 'entryState', 'exitState', 'aspectRatio', 'characterNames', 'sceneNames', 'propNames', 'continuityNotes']
const LABELS = { title: '镜头标题', visual: '画面与构图', action: '主要动作', camera: '景别与机位', entryState: '进入状态', exitState: '结束状态', aspectRatio: '画幅', characterNames: '出场人物', sceneNames: '场景', propNames: '关键物品', continuityNotes: '实际连续性提示' }
const ID = /^[A-Za-z0-9_-]{1,200}$/u
const HASH = /^\d{1,10}:[a-f0-9]{1,8}$/u
// serde_json::Value sorts object keys while persisting tasks and restoring
// project packages. Hash semantic JSON, never JavaScript insertion order.
const stableJSON = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const fingerprint = value => {
  const text = typeof value === 'string' ? value : stableJSON(value)
  let hash = 2166136261
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0
  return `${text.length}:${hash.toString(16)}`
}
const hashSnapshot = snapshot => `visual-v1:${fingerprint(snapshot)}`
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const same = (a, b) => stableJSON(a) === stableJSON(b)
const sort = entries => entries.sort((a, b) => stableJSON(a).localeCompare(stableJSON(b), 'en'))
const find = (assets, versionId) => {
  const found = assets.flatMap(asset => (asset.versions || []).filter(version => version.id === versionId).map(version => ({ asset, version })))
  return found.length === 1 ? found[0] : null
}
const image = found => Boolean(found?.asset.kind === 'image' && (!found.version.mimeType || found.version.mimeType.startsWith('image/')))

export function visualBaselineText(continuity) {
  return [continuity?.style?.trim() ? `全项目统一视觉基准：\n${continuity.style.trim()}` : '',
    '视觉连续性要求：沿用同一人物身份、服装与可见损伤，同一场景的空间布局、光照方向及色调，同一关键物品的比例、结构、材质与固定细节。只应用本镜头明确要求的剧情状态变化；切换机位不重新设计这些对象。'].filter(Boolean).join('\n')
}

// A compact description of the visual inputs, never image bytes or credentials.
// Output selections, dialogue, durations and video settings do not describe a still.
export function visualInputSnapshot(shot, assets, documents = {}, continuity, context = {}) {
  const references = sort((shot.references || []).filter(ref => ref.role !== 'extend').map(ref => ({
    versionId: ref.versionId, role: ref.role, scope: ref.scope || '', present: image(find(assets, ref.versionId))
  })))
  // Hash each related definition separately to stay below 64 KiB even with the
  // maximum 500 registered entities and long IDs. The export carries the full
  // readable definitions; this snapshot only tracks whether they changed.
  const entities = sort(matchShotReferences(shot, assets, documents, continuity).filter(match => match.entityId && !['manual', 'excluded'].includes(match.status)).map(match => ({
    identity: fingerprint(match.entityId), definition: fingerprint([match.stateId,
      entityStateFingerprint(match.entity, match.state, continuity?.style || ''), match.versionId || ''])
  })))
  const stateDocuments = sceneContinuityStateDocumentIds({ ...context, documentId: shot.sourceDocumentId, documents })
  const scene = stateDocuments.length && sceneContinuityContext({ ...context, documentId: shot.sourceDocumentId, documents, storyboard: context.storyboard || { continuity }, shot, assets, enforceLimit: false })
  return { version: 1,
    fields: Object.fromEntries(FIELDS.map(field => [field, fingerprint(Array.isArray(shot[field]) ? [...shot[field]].sort() : shot[field] ?? '')])),
    source: { documentId: shot.sourceDocumentId || '', fingerprint: fingerprint(documents[shot.sourceDocumentId]?.content || '') },
    style: fingerprint(continuity?.style || ''), references, entities,
    ...(scene?.stateDocumentIds?.length ? { sceneContinuity: fingerprint(scene.fingerprint) } : {}) }
}

export function visualInputFingerprint(shot, assets, documents = {}, continuity, context = {}) {
  return hashSnapshot(visualInputSnapshot(shot, assets, documents, continuity, context))
}

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const keys = (value, allowed, message) => assert(object(value) && Object.keys(value).every(key => allowed.includes(key)), message)
const validHash = value => typeof value === 'string' && HASH.test(value)
const validId = (value, empty = false) => typeof value === 'string' && (empty && value === '' || ID.test(value))

function validateSnapshot(snapshot) {
  const error = '分镜图视觉输入快照无效'
  keys(snapshot, ['version', 'fields', 'source', 'style', 'references', 'entities', 'sceneContinuity'], error)
  assert(snapshot.version === 1 && new TextEncoder().encode(JSON.stringify(snapshot)).length <= 65536, error)
  keys(snapshot.fields, FIELDS, error)
  assert(FIELDS.every(field => validHash(snapshot.fields[field])), error)
  keys(snapshot.source, ['documentId', 'fingerprint'], error)
  assert(validId(snapshot.source.documentId, true) && validHash(snapshot.source.fingerprint) && validHash(snapshot.style), error)
  assert(snapshot.sceneContinuity === undefined || validHash(snapshot.sceneContinuity), error)
  assert(Array.isArray(snapshot.references) && snapshot.references.length <= 16, error)
  for (const ref of snapshot.references) {
    keys(ref, ['versionId', 'role', 'scope', 'present'], error)
    assert(validId(ref.versionId) && ['reference', 'start', 'end'].includes(ref.role) && ['', 'continuity', 'video'].includes(ref.scope) && typeof ref.present === 'boolean', error)
  }
  assert(Array.isArray(snapshot.entities) && snapshot.entities.length <= 500, error)
  for (const entity of snapshot.entities) {
    keys(entity, ['identity', 'definition'], error)
    assert(validHash(entity.identity) && validHash(entity.definition), error)
  }
  return snapshot
}

export function validateVisualRecord(record, { review = false, generation = false } = {}) {
  const common = ['version', 'imageVersionId', 'fingerprint', 'snapshot']
  keys(record, review ? [...common, 'decision', 'reviewedAt', 'notes'] : generation ? ['version', 'fingerprint', 'snapshot'] : common, '分镜图视觉复核记录无效')
  assert(record.version === 1 && (generation || validId(record.imageVersionId)), '分镜图视觉复核版本无效')
  validateSnapshot(record.snapshot)
  assert(record.fingerprint === hashSnapshot(record.snapshot), '分镜图视觉输入指纹与快照不符')
  if (review) {
    assert(['approved', 'rejected'].includes(record.decision) && typeof record.reviewedAt === 'string' && record.reviewedAt.length <= 100 && Number.isFinite(Date.parse(record.reviewedAt)), '分镜图视觉复核结果或时间无效')
    assert(typeof record.notes === 'string' && record.notes.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(record.notes), '分镜图视觉复核备注无效')
  }
  return record
}

function referenceIssues(shot, assets, documents, continuity, context = {}) {
  const issues = []
  if (shot.sourceDocumentId && !documents[shot.sourceDocumentId]) issues.push('来源剧本已不存在，请先核对镜头归属')
  for (const ref of (shot.references || []).filter(ref => ref.role !== 'extend')) if (!image(find(assets, ref.versionId))) issues.push(`固定参考版本不可用：${ref.versionId}`)
  const statuses = { missing: '缺少参考图', stale: '设定已修改，参考图待确认', ready: '参考图尚未关联', ambiguous: '参考图存在歧义', limit: '参考图数量达到上限' }
  for (const match of matchShotReferences(shot, assets, documents, continuity)) if (!['bound', 'manual', 'excluded'].includes(match.status)) issues.push(`${match.name}${match.stateName ? ` · ${match.stateName}` : ''}：${statuses[match.status] || '参考待核对'}`)
  if (sceneContinuityStateDocumentIds({ ...context, documentId: shot.sourceDocumentId, documents }).length) {
    const scene = sceneContinuityContext({ ...context, documentId: shot.sourceDocumentId, documents, storyboard: context.storyboard || { continuity }, shot, assets, enforceLimit: false })
    issues.push(...scene.conflicts.map(message => `分场连续性冲突：${message}`))
  }
  return [...new Set(issues)]
}

function changedFields(previous, current) {
  if (!previous) return []
  return [
    ...FIELDS.filter(field => previous.fields?.[field] !== current.fields[field]).map(field => LABELS[field]),
    ...(!same(previous.source, current.source) ? ['来源剧本'] : []),
    ...(previous.style !== current.style ? ['统一视觉基准'] : []),
    ...(previous.sceneContinuity !== current.sceneContinuity ? ['素材与分场状态承接'] : []),
    ...(!same(previous.references, current.references) ? ['固定参考图片'] : []),
    ...(!same(previous.entities, current.entities) ? ['人物、场景与关键物品设定'] : [])
  ]
}

// Inspect stored inputs, not pixels. Approval is an explicit human decision.
export function imageVisualReviewState(shot, assets, documents = {}, continuity, context = {}) {
  const selected = find(assets, shot.selectedImageVersionId)
  if (!image(selected)) return { status: 'missing', label: '待生成分镜图', reviewed: false, issues: ['尚未选用可用的分镜图'], changedFields: [] }
  const snapshot = visualInputSnapshot(shot, assets, documents, continuity, context), current = hashSnapshot(snapshot)
  const issues = referenceIssues(shot, assets, documents, continuity, context)
  const review = shot.visualReview
  let generated
  try {
    const stored = selected.version.metadata?.provenance?.visualBasis
    if (stored) generated = validateVisualRecord(stored, { generation: true })
  } catch { /* Imported metadata is not an authenticated generation history. */ }
  const basis = review || generated || shot.imageGenerationBasis
  if (basis) {
    const changes = changedFields(basis.snapshot, snapshot)
    if (basis.imageVersionId && basis.imageVersionId !== shot.selectedImageVersionId) changes.unshift('选用分镜图')
    if (basis.fingerprint !== current || changes.length) return { status: 'changed', label: '分镜图待复核', reviewed: false, issues, changedFields: changes.length ? changes : ['视觉输入'] }
  } else {
    const historical = selected.version.metadata?.provenance?.references
    if (Array.isArray(historical) && historical.every(ref => object(ref) && validId(ref.versionId) && ['reference', 'start', 'end'].includes(ref.role))) {
      const actual = refs => sort(refs.map(({ versionId, role }) => ({ versionId, role })))
      if (!same(actual(historical), actual((shot.references || []).filter(ref => ref.role !== 'extend')))) return { status: 'changed', label: '参考已变，分镜图待复核', reviewed: false, issues, changedFields: ['固定参考图片'] }
    }
  }
  if (issues.length && review?.decision === 'approved') return { status: 'changed', label: '参考待核对，分镜图待复核', reviewed: false, issues, changedFields: ['参考图片有效性'] }
  if (review?.decision === 'approved') return { status: 'approved', label: '视觉复核通过', reviewed: true, issues, changedFields: [] }
  if (review?.decision === 'rejected') return { status: 'rejected', label: '分镜图不一致', reviewed: false, issues, changedFields: [] }
  return { status: 'unreviewed', label: '待视觉复核', reviewed: false, issues, changedFields: [] }
}

export function makeVisualReview(shot, assets, documents = {}, continuity, { decision, notes = '' } = {}, context = {}) {
  assert(['approved', 'rejected'].includes(decision), '请选择视觉复核结果')
  assert(image(find(assets, shot.selectedImageVersionId)), '请先选用可用的分镜图，再进行视觉复核')
  const issues = referenceIssues(shot, assets, documents, continuity, context)
  if (decision === 'approved' && issues.length) throw new Error(`请先处理参考问题：${issues.join('；')}`)
  const snapshot = visualInputSnapshot(shot, assets, documents, continuity, context)
  return validateVisualRecord({ version: 1, imageVersionId: shot.selectedImageVersionId, fingerprint: hashSnapshot(snapshot), snapshot, decision, reviewedAt: new Date().toISOString(), notes }, { review: true })
}
