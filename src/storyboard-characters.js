import { biographyCharacters } from './character-images.js'

const normalized = name => String(name || '').trim().normalize('NFC')
const assetName = asset => normalized(asset.name).replace(/\s*·\s*正脸与三视图$/, '')
const characterAssets = assets => assets.filter(asset => asset.role === 'character' && asset.kind === 'image')

export function projectCharacterNames(documents, assets) {
  return [...new Set([...biographyCharacters(documents.characters?.content || '').map(item => normalized(item.name)), ...characterAssets(assets).map(assetName)])].filter(name => name && name.length <= 80)
}

// Match exact names only. Missing and ambiguous identities require an explicit choice.
export function matchShotCharacters(shot, assets) {
  return (shot.characterNames || []).map(name => {
    const matches = characterAssets(assets).filter(asset => assetName(asset) === normalized(name))
    const pinned = matches.filter(asset => (asset.versions || []).some(version => shot.references.some(ref => ref.role === 'reference' && ref.versionId === version.id)))
    if (pinned.length) return { name, status: 'bound' }
    if (matches.length > 1) return { name, status: 'ambiguous' }
    const asset = matches[0], version = asset?.versions?.find(item => item.id === asset.selectedVersionId)
    return version ? { name, status: 'ready', versionId: version.id } : { name, status: 'missing' }
  })
}

export function bindShotCharacters(shot, assets) {
  const references = structuredClone(shot.references), matches = matchShotCharacters(shot, assets)
  for (const match of matches) {
    if (match.status !== 'ready' || references.some(ref => ref.role === 'reference' && ref.versionId === match.versionId)) continue
    if (references.length >= 16) { match.status = 'limit'; continue }
    references.push({ versionId: match.versionId, role: 'reference' })
  }
  return { references, matches }
}
