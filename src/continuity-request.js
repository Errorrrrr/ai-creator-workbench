import { entityReferencePrompt, entityStateFingerprint, normalizeContinuity } from './continuity-assets.js'
import { resolveConnectionRoute } from './storyboard.js'
import { mediaAdapterFor } from './media-adapters.js'

const ID = /^[A-Za-z0-9_-]{1,96}$/
const validId = value => typeof value === 'string' && ID.test(value)
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const utf8Length = value => new TextEncoder().encode(value).byteLength

function imageReference(assets, versionId, projectId, kind) {
  const matches = (assets || []).flatMap(asset => (asset.versions || []).filter(version => version.id === versionId).map(version => ({ asset, version })))
  const reference = matches[0]
  if (matches.length !== 1 || reference.asset.projectId !== projectId || reference.asset.kind !== 'image' || reference.asset.role !== kind
    || !IMAGE_MIMES.has(reference.version.mimeType) || !validId(reference.version.fileId)
    || !Number.isSafeInteger(reference.version.bytes) || reference.version.bytes <= 0 || reference.version.bytes > 512 * 1024 * 1024) {
    throw new Error('设定参考图不可用，请重新选择当前项目同类型的 PNG、JPEG 或 WebP 实际图片版本')
  }
  return reference
}

export function prepareEntityRequest(data, assets, entityId, stateId) {
  if (!data?.projectId) throw new Error('请先打开项目')
  if (!validId(data.projectId)) throw new Error('项目标识无效')
  const continuity = normalizeContinuity(data.storyboard?.continuity)
  const entity = continuity.entities.find(item => item.id === entityId)
  const state = entity?.states.find(item => item.id === stateId)
  if (!state) throw new Error('素材状态已不存在，请重新选择')
  const route = resolveConnectionRoute(data, 'image'), connection = route.connection
  if (!connection) throw new Error(route.error)
  const model = connection.kind === 'cli' ? connection.planningModel || '' : connection.model || ''
  if (!validId(connection.id) || typeof model !== 'string' || utf8Length(model) > 160 || /\p{Cc}/u.test(model) || (connection.baseUrl !== undefined && typeof connection.baseUrl !== 'string')) throw new Error('图片执行端标识或模型名称无效')
  if ([entity.name, state.name].some(name => /\p{Cc}/u.test(name))) throw new Error('素材和状态名称不能包含控制字符')
  const basedOn = entity.states.find(item => item.id === state.basedOnStateId)
  if (basedOn && !state.referenceVersionId) {
    if (!basedOn.referenceVersionId) throw new Error('请先生成或选择基础状态的设定图，再生成派生状态以保持外形一致')
    if (basedOn.referenceFingerprint !== entityStateFingerprint(entity, basedOn, continuity.style)) throw new Error('基础状态的设定图已过期，请先重新生成或确认选图后再生成派生状态')
  }
  const referenceVersionId = state.referenceVersionId || basedOn?.referenceVersionId || ''
  const reference = referenceVersionId ? imageReference(assets, referenceVersionId, data.projectId, entity.kind) : null
  const adapter = mediaAdapterFor(connection, 'image'), mode = reference ? 'edit' : 'generate'
  if (!adapter) throw new Error('图片执行端协议无效，请重新选择')
  if (adapter.modes && !adapter.modes.includes(mode)) throw new Error('图片执行端不支持此设定图生成模式，请更换执行端')
  if (reference && adapter.referenceRoles && (!adapter.referenceRoles.includes('reference') || adapter.maxReferences < 1)) throw new Error('图片执行端不支持参考图，请更换执行端以保持外形一致')
  const prompt = entityReferencePrompt(entity, state, continuity.style) + (reference ? '\n使用上传的既有设定图保持同一对象的身份、外形与基础结构，只应用上文明确的状态变化。' : '')
  if (utf8Length(prompt) > 100000) throw new Error('设定图提示词超过 100000 字节，请精简固定特征、描述或状态差异后生成')
  return {
    projectId: data.projectId, targetId: `entity-${state.id}`, capability: 'image',
    entity: { entityId, stateId, kind: entity.kind, name: entity.name, stateName: state.name, definitionFingerprint: entityStateFingerprint(entity, state, continuity.style) },
    prompt,
    references: reference ? [{ versionId: referenceVersionId, role: 'reference' }] : [],
    connection: { id: connection.id, kind: connection.kind === 'cli' ? 'cli' : 'api', driverId: connection.driverId || null, baseUrl: connection.baseUrl || '', model, adapter: adapter.id },
    parameters: { mode, aspectRatio: '16:9', duration: 5, size: '1536x1024', quality: 'high' },
    allowUserProfile: connection.kind === 'cli'
  }
}
