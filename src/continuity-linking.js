import { entityStateFingerprint, resolveEntityState } from './continuity-assets.js'

const fields = { character: 'characterNames', scene: 'sceneNames', prop: 'propNames' }
const labels = { character: '人物', scene: '场景', prop: '关键物品' }
const normalized = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
export const continuityIdentityName = value => normalized(value).replace(/\s*\([^)]*\)\s*$/u, '').trim()
const provenanceEntity = version => version.metadata?.provenance?.entity
const imageVersion = version => version && (!version.mimeType || version.mimeType.startsWith('image/'))
const legacyAssetName = asset => String(asset.name || '').replace(/\.(?:png|jpe?g|webp|gif)$/iu, '').replace(/\s*·\s*(?:正脸与三视图|角色图|场景图|建立镜头|道具图|白底图)$/, '').trim()

function legacyCharacterMatches(asset, entity) {
  if (asset.kind !== 'image' || asset.role !== 'character' || entity.kind !== 'character') return false
  const versions = asset.versions || []
  // Entity provenance already identifies a specific state. Never reinterpret it
  // as a legacy portrait, including when a different entity has the same name.
  if (versions.some(version => provenanceEntity(version))) return false
  const identities = new Set([entity.name, ...entity.aliases].map(continuityIdentityName).filter(Boolean))
  const provenanceNames = versions.map(version => version.metadata?.provenance?.character?.name).filter(name => typeof name === 'string' && name.trim())
  if (provenanceNames.some(name => !identities.has(continuityIdentityName(name)))) return false
  return [legacyAssetName(asset), ...provenanceNames].some(name => identities.has(continuityIdentityName(name)))
}

// This plan pins a concrete legacy version, so later asset selections do not
// silently change an established state. Callers persist it with the storyboard.
export function planLegacyContinuityReferences(continuity, assets, projectId) {
  const linked = [], issues = []
  if (!continuity?.entities?.length) return { continuity, changed: 0, linked, issues }
  const available = projectId === undefined ? assets : assets.filter(asset => asset.projectId === projectId)
  const versionCounts = new Map()
  for (const asset of available) for (const version of asset.versions || []) versionCounts.set(version.id, (versionCounts.get(version.id) || 0) + 1)
  const entities = continuity.entities.map(entity => {
    if (entity.kind !== 'character') return entity
    const state = entity.states.find(item => item.id === entity.defaultStateId)
    if (!state || state.basedOnStateId || state.referenceVersionId || state.referenceFingerprint || state.imageResultCheckpoint || state.legacyReferenceOptOut) return entity
    const candidates = available.filter(asset => legacyCharacterMatches(asset, entity))
    if (!candidates.length) return entity
    const issue = (reason, message) => {
      issues.push({ entityId: entity.id, stateId: state.id, name: entity.name, reason, message: `${entity.name} · ${state.name}：${message}` })
      return entity
    }
    if (candidates.length > 1) return issue('ambiguous-assets', '找到多份旧角色素材，请手动选择要沿用的图片版本。')
    const asset = candidates[0], versions = asset.versions || []
    let version
    if (asset.selectedVersionId) {
      const selected = versions.filter(item => item.id === asset.selectedVersionId)
      if (selected.length !== 1) return issue('missing-selection', '旧角色素材选用的图片版本已不存在，请重新选择。')
      version = selected[0]
    } else if (versions.length === 1) version = versions[0]
    else return issue('ambiguous-versions', versions.length ? '旧角色素材有多个图片版本且尚未选用，请手动选择。' : '旧角色素材还没有可用的图片版本。')
    // Stored media always has a MIME type. Unlike an existing manual reference,
    // an automatic adoption must positively identify an image.
    if (typeof version?.mimeType !== 'string' || !version.mimeType.startsWith('image/') || !/^[A-Za-z0-9_-]{1,96}$/u.test(version.id || '')) return issue('invalid-version', '旧角色素材选用的版本不是可用图片，请重新选择。')
    if (versionCounts.get(version.id) !== 1) return issue('ambiguous-version-id', '图片版本标识重复，无法确定对应文件，请先整理素材。')
    linked.push({ entityId: entity.id, stateId: state.id, assetId: asset.id, versionId: version.id })
    return { ...entity, states: entity.states.map(item => item.id === state.id ? { ...item, referenceVersionId: version.id, referenceFingerprint: entityStateFingerprint(entity, state, continuity.style) } : item) }
  })
  return { continuity: linked.length ? { ...continuity, entities } : continuity, changed: linked.length, linked, issues }
}

function visibleNames(text, names) {
  const catalog = [...new Set(names.map(continuityIdentityName).filter(Boolean))], found = new Set()
  for (const raw of text.split(/[。！？!?\n；;]/u)) {
    const clause = normalized(raw), spans = []
    for (const name of catalog) {
      let at = -1
      while ((at = clause.indexOf(name, at + 1)) !== -1) {
        const before = clause.slice(0, at), after = clause.slice(at + name.length)
        if (/^[a-z\d_]/iu.test(name) && /[a-z\d_]$/iu.test(before)) continue
        if (/[a-z\d_]$/iu.test(name) && /^[a-z\d_]/iu.test(after)) continue
        if (/(?:提到|提起|谈起|谈论|说起|想起|寻找|等待|没有|没有发现|不见|未见|未出现的|画外的)\s*$/u.test(before)) continue
        if (/^[，,\s]*(?:不在|未在|没有出场|没有入镜|未出场|未入镜|不入镜|被提及|\(画外\)|位于画外|在画外|处于画外|未出现)/u.test(after)) continue
        spans.push({ name, start: at, end: at + name.length })
      }
    }
    // Resolve individual occurrences: a later standalone short name still counts.
    for (const span of spans) if (!spans.some(other => other.name.length > span.name.length && other.start <= span.start && other.end >= span.end)) found.add(span.name)
  }
  return found
}

export function continuityAssetMatches(asset, entity) {
  if (asset.kind !== 'image' || asset.role !== entity.kind) return false
  const versions = asset.versions || []
  if (versions.some(version => imageVersion(version) && (entity.states.some(state => state.referenceVersionId === version.id) || provenanceEntity(version)?.entityId === entity.id && provenanceEntity(version)?.kind === entity.kind))) return true
  // State adoption is planned separately; this match also recognizes manual
  // choices so the shot reconciler never replaces them.
  if (versions.some(version => provenanceEntity(version))) return false
  if (entity.kind === 'character') return legacyCharacterMatches(asset, entity)
  const name = legacyAssetName(asset)
  const location = entity.kind === 'scene' ? name.replace(/[\s·/（(-]+(?:白天|白昼|日景|深夜|午夜|夜晚|夜景|黄昏|傍晚|黎明|清晨|日|夜)[\s·/）)-]*$/, '').trim() : name
  return [entity.name, ...entity.aliases].some(alias => [name, location].some(candidate => continuityIdentityName(candidate) === continuityIdentityName(alias)))
}

export function matchContinuityEntities(shot, assets, documents = {}, continuity) {
  if (!continuity?.entities?.length) return []
  const text = [shot.title, shot.visual, shot.action, shot.camera, shot.entryState, shot.exitState].filter(Boolean).join('\n')
  const visibleByKind = Object.fromEntries(Object.keys(fields).map(kind => [kind, visibleNames(text, continuity.entities.filter(entity => entity.kind === kind).flatMap(entity => [entity.name, ...entity.aliases]))]))
  const sourceScenes = continuity.entities.filter(entity => entity.kind === 'scene' && entity.sourceDocumentIds.includes(shot.sourceDocumentId))
  const matches = []
  for (const entity of continuity.entities) {
    const names = [entity.name, ...entity.aliases]
    const explicit = (shot[fields[entity.kind]] || []).some(name => names.some(alias => continuityIdentityName(alias) === continuityIdentityName(name)))
    const mentioned = names.some(name => visibleByKind[entity.kind].has(continuityIdentityName(name)))
    const sceneContext = entity.kind === 'scene' && sourceScenes.length === 1 && sourceScenes[0].id === entity.id && !/闪回|梦境|回忆画面/.test(text) && !(shot.sceneNames?.length) && visibleByKind.scene.size === 0 && !names.some(name => normalized(text).includes(continuityIdentityName(name)))
    if (!explicit && !mentioned && !sceneContext) continue
    const state = resolveEntityState(entity, shot.sourceDocumentId)
    if (!state) continue
    const assetIds = assets.filter(asset => continuityAssetMatches(asset, entity)).map(asset => asset.id)
    const asset = assets.find(asset => asset.kind === 'image' && asset.role === entity.kind && asset.versions?.some(version => version.id === state.referenceVersionId && imageVersion(version)))
    // All these roles are uploaded for image generation. scope:'video' changes
    // video routing only, so it must not cause a permanent "waiting to bind".
    const refs = (shot.references || []).filter(ref => ['reference', 'start', 'end'].includes(ref.role))
    const manual = refs.find(ref => ref.origin !== 'auto' && assets.some(asset => assetIds.includes(asset.id) && asset.versions.some(version => version.id === ref.versionId)))
    const excluded = (shot.referenceExclusions || []).some(value => value === `${entity.kind}:@${entity.id}` || value.startsWith(`${entity.kind}:`) && names.some(name => continuityIdentityName(value.slice(entity.kind.length + 1)) === continuityIdentityName(name)))
    const stale = Boolean(asset && state.referenceFingerprint !== entityStateFingerprint(entity, state, continuity.style))
    const bound = refs.some(ref => ref.versionId === state.referenceVersionId)
    const status = manual ? (manual.versionId === state.referenceVersionId ? 'bound' : 'manual') : excluded ? 'excluded' : !asset ? 'missing' : stale ? 'stale' : bound ? 'bound' : 'ready'
    matches.push({ entityId: entity.id, stateId: state.id, role: entity.kind, name: entity.name, aliases: names, stateName: state.name, key: `${entity.kind}:@${entity.id}`, assetIds, inferred: !explicit, status, versionId: state.referenceVersionId, entity, state })
  }
  return matches
}

export function continuityNotes(matches, style = '') {
  const active = matches.filter(match => !['excluded', 'manual'].includes(match.status))
  if (!active.length) return ''
  return [style ? `统一视觉风格：${style}` : '', '连续性设定：以下对象必须保持身份、结构、材质与布局一致；只改变镜头构图和指定的剧情状态。', ...active.map(({ entity, state }) => `${labels[entity.kind]}「${entity.name}」· ${state.name}\n固定特征：${entity.traits || entity.description || '以设定参考图为准'}${entity.traits && entity.description ? `\n整体描述：${entity.description}` : ''}\n当前状态：${state.description || '保持默认设定'}`)].filter(Boolean).join('\n')
}

export function continuityReadiness(shot, assets, documents, continuity) {
  return matchContinuityEntities(shot, assets, documents, continuity).filter(match => ['missing', 'stale', 'ready'].includes(match.status)).map(match => `${match.name} · ${match.stateName}：${match.status === 'missing' ? '尚未选用设定图' : match.status === 'stale' ? '设定已修改，请重新生成或确认选用参考图' : '参考正在关联，请稍后再试'}`)
}
