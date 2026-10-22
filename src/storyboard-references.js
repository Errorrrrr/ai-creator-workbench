import { projectCharacterNames } from './storyboard-characters.js'

export const REFERENCE_ENTITY_FIELDS = { character: 'characterNames', scene: 'sceneNames', prop: 'propNames' }
const normalized = value => String(value || '').normalize('NFC').trim()
export function referenceAssetName(asset) {
  return normalized(asset.name).replace(/\.(?:png|jpe?g|webp|gif)$/i, '')
    .replace(/\s*·\s*(?:正脸与三视图|角色图|场景图|建立镜头|道具图|白底图)$/, '').trim()
}
const eligible = asset => asset.kind === 'image' && Object.hasOwn(REFERENCE_ENTITY_FIELDS, asset.role)
const key = (role, name) => `${role}:${normalized(name)}`
const imageVersion = version => version && (!version.mimeType || version.mimeType.startsWith('image/'))

function timeOf(text) {
  const times = []
  if (/(?:深夜|午夜|夜晚|夜景|黑夜|夜幕|月光|(?:^|[\s·/（(-])夜(?:$|[\s·/）)-]))/.test(text)) times.push('夜')
  if (/(?:黄昏|傍晚|夕阳|落日)/.test(text)) times.push('黄昏')
  if (/(?:黎明|清晨|晨曦|破晓)/.test(text)) times.push('清晨')
  if (/(?:白天|白昼|日景|烈日|正午|阳光|(?:^|[\s·/（(-])日(?:$|[\s·/）)-]))/.test(text)) times.push('日')
  return times.length === 1 ? times[0] : times.length ? '不明确' : ''
}
function sceneLocation(name) {
  return name.replace(/[\s·/（(-]+(?:白天|白昼|日景|深夜|午夜|夜晚|夜景|黄昏|傍晚|黎明|清晨|日|夜)[\s·/）)-]*$/, '').trim()
}
function visibleMention(text, name) {
  if (!name) return false
  for (const clause of text.split(/[。！？!?\n；;]/)) {
    let at = -1
    while ((at = clause.indexOf(name, at + 1)) !== -1) {
      const before = clause.slice(0, at), after = clause.slice(at + name.length)
      if (/^[a-z\d]/i.test(name) && /[a-z\d]$/i.test(before)) continue
      if (/[a-z\d]$/i.test(name) && /^[a-z\d]/i.test(after)) continue
      if (/(?:提到|提起|谈起|谈论|说起|想起|寻找|等待|没有|不见|未见|未出现的|画外的)\s*$/.test(before)) continue
      if (/^(?:[，,\s]*(?:不在|未在|没有出场|未出场|未入镜|不入镜|被提及|[（(]画外[）)]|位于画外|在画外|处于画外|未出现))/.test(after)) continue
      return true
    }
  }
  return false
}
function mentioned(text, names) {
  const matches = [...new Set(names)].filter(name => visibleMention(text, name))
  // Do not identify a shorter entity inside a longer name from the same catalog.
  return matches.filter(name => !matches.some(longer => longer !== name && longer.includes(name) && !visibleMention(text.split(longer).join(''), name)))
}

export function referenceCatalog(assets) {
  return Object.fromEntries(Object.keys(REFERENCE_ENTITY_FIELDS).map(role => [role, [...new Set(assets.filter(asset => eligible(asset) && asset.role === role).map(referenceAssetName))]]))
}

export function matchShotReferences(shot, assets, documents = {}) {
  const catalog = referenceCatalog(assets)
  catalog.character = [...new Set([...catalog.character, ...projectCharacterNames(documents, assets)])]
  const text = [shot.title, shot.visual, shot.action, shot.camera, shot.entryState, shot.exitState].filter(Boolean).join('\n')
  // Dialogue may name someone who is absent. Never scan dialogue or the entire scene script.
  const sourceTitle = documents[shot.sourceDocumentId]?.title || ''
  const sceneTime = timeOf(text) || (/闪回|梦境|回忆画面/.test(text) ? '' : timeOf(sourceTitle))
  const targets = []
  for (const [role, field] of Object.entries(REFERENCE_ENTITY_FIELDS)) {
    let names = shot[field]
    if (!names) {
      if (role === 'scene') {
        const locations = catalog.scene.map(sceneLocation)
        const inShot = mentioned(text, locations)
        const locationsInView = inShot.length ? inShot : /闪回|梦境|回忆画面/.test(text) ? [] : mentioned(sourceTitle, locations)
        names = locationsInView
      } else names = mentioned(text, catalog[role])
    }
    for (const name of [...new Set(names.map(normalized).filter(Boolean))]) {
      let matches = assets.filter(asset => eligible(asset) && asset.role === role && referenceAssetName(asset) === name)
      let uncertainTime = false
      let compatibleAssets = matches
      if (role === 'scene') {
        const requestedTime = timeOf(name) || sceneTime
        matches = assets.filter(asset => eligible(asset) && asset.role === role && sceneLocation(referenceAssetName(asset)) === sceneLocation(name))
        const compatible = matches.filter(asset => !timeOf(referenceAssetName(asset)) || (requestedTime && timeOf(referenceAssetName(asset)) === requestedTime))
        compatibleAssets = compatible
        uncertainTime = matches.length > 0 && !compatible.length
        matches = compatible.length ? compatible : matches
      }
      const targetKey = key(role, name)
      const pinned = compatibleAssets.filter(asset => asset.versions?.some(version => shot.references.some(ref => ref.versionId === version.id)))
      const suppressed = (shot.referenceExclusions || []).includes(targetKey) || matches.some(asset => (shot.referenceExclusions || []).includes(key(role, referenceAssetName(asset))))
      const asset = matches.length === 1 ? matches[0] : null
      const version = asset?.versions?.find(item => item.id === asset.selectedVersionId && imageVersion(item))
      const status = pinned.length ? 'bound' : suppressed ? 'excluded' : uncertainTime || matches.length > 1 ? 'ambiguous' : version ? 'ready' : 'missing'
      targets.push({ role, name, key: targetKey, assetIds: compatibleAssets.map(asset => asset.id), inferred: shot[field] === undefined, status, ...(version ? { versionId: version.id } : {}) })
    }
  }
  return targets
}

export function bindShotReferences(shot, assets, documents = {}) {
  const needed = new Set(matchShotReferences(shot, assets, documents).flatMap(match => match.assetIds))
  // Only references created by this reconciler may be removed automatically.
  // Legacy references and unavailable files keep their fixed versions for review.
  const references = structuredClone(shot.references.filter(ref => {
    if (ref.origin !== 'auto' || ref.role !== 'reference' || ref.scope === 'video') return true
    const asset = assets.find(asset => asset.versions?.some(version => version.id === ref.versionId))
    return !asset || needed.has(asset.id)
  }))
  const removed = shot.references.length - references.length
  const matches = matchShotReferences({ ...shot, references }, assets, documents)
  let added = 0
  for (const match of matches) {
    if (match.status !== 'ready' || references.some(ref => ref.versionId === match.versionId)) continue
    if (references.length >= 16) { match.status = 'limit'; continue }
    references.push({ versionId: match.versionId, role: 'reference', scope: 'continuity', origin: 'auto' }); added++
  }
  return { references, matches, added, removed }
}

export function referenceBindingWarnings(shot, assets, documents = {}) {
  const needed = new Set(matchShotReferences(shot, assets, documents).flatMap(match => match.assetIds))
  const legacy = [], unmatched = []
  for (const ref of shot.references) {
    const asset = assets.find(asset => eligible(asset) && asset.versions?.some(version => version.id === ref.versionId))
    if (!asset || ref.role !== 'reference' || ref.scope === 'video' || ref.origin === 'auto') continue
    if (!ref.origin) legacy.push(ref)
    if (!needed.has(asset.id)) unmatched.push({ ref, name: asset.name })
  }
  return { legacy, unmatched }
}

// Manual removal is a durable opt-out for that entity, including future versions.
// Names survive portable-project remapping, unlike local asset/version IDs.
export function manualReferencePatch(shot, references, assets) {
  const exclusions = new Set(shot.referenceExclusions || [])
  for (const asset of assets.filter(eligible)) {
    const contains = refs => refs.some(ref => asset.versions?.some(version => version.id === ref.versionId))
    const entityKey = key(asset.role, referenceAssetName(asset))
    if (contains(shot.references) && !contains(references)) exclusions.add(entityKey)
    if (contains(references)) {
      exclusions.delete(entityKey)
      if (asset.role === 'scene') exclusions.delete(key('scene', sceneLocation(referenceAssetName(asset))))
    }
  }
  const marked = references.map(ref => {
    const previous = shot.references.find(item => item.versionId === ref.versionId && item.role === ref.role)
    return previous && previous.scope === ref.scope && previous.origin === ref.origin ? { ...ref } : { ...ref, origin: 'manual' }
  })
  return { references: marked, referenceExclusions: [...exclusions].slice(-128) }
}

export function planReferenceBackfill(storyboard, assets, documents = {}) {
  let added = 0, removed = 0, changed = 0
  const shots = storyboard.shots.map(shot => {
    const result = bindShotReferences(shot, assets, documents)
    if (!result.added && !result.removed) return shot
    added += result.added; removed += result.removed; changed++
    return { ...shot, references: result.references }
  })
  return { storyboard: { ...storyboard, shots, revision: storyboard.revision + (changed ? 1 : 0) }, added, removed, changed }
}
