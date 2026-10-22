// Navigation is derived from document IDs; changing titles never changes ownership.
export const OTHER_EPISODE = '__other_documents__'
export const UNASSIGNED_SOURCE = '__unassigned_shots__'

export function storyboardGroups({ structure = {}, documents = {} }) {
  const episodes = structure.episodes || {}, used = new Set()
  const ids = [...new Set([...(structure.acts || []).flatMap(act => act.episodeIds || []), ...Object.keys(episodes)])]
  const groups = ids.map(id => {
    const sceneIds = (episodes[id]?.sceneIds || []).filter(scene => documents[scene])
    const sourceIds = [...sceneIds, ...(documents[id] ? [id] : [])]
    sourceIds.forEach(source => used.add(source))
    return { id, title: documents[id]?.title || episodes[id]?.title || id, sceneIds, sourceIds }
  })
  const other = Object.keys(documents).filter(id => !used.has(id))
  groups.push({ id: OTHER_EPISODE, title: '其他内容与未归属', sceneIds: other, sourceIds: other })
  return groups
}

export function scopeForDocument(data, documentId) {
  const group = storyboardGroups(data).find(group => group.sourceIds.includes(documentId))
  return group ? { episodeId: group.id, sourceId: documentId === group.id ? '' : documentId } : null
}

export function scopedShots(data, episodeId, sourceId) {
  const group = storyboardGroups(data).find(group => group.id === episodeId)
  if (!group) return []
  const shots = data.storyboard.shots
  const unassigned = shot => !data.documents[shot.sourceDocumentId]
  if (sourceId === UNASSIGNED_SOURCE) return episodeId === OTHER_EPISODE ? shots.filter(unassigned) : []
  if (sourceId) return group.sourceIds.includes(sourceId) ? shots.filter(shot => shot.sourceDocumentId === sourceId) : []
  const ordered = group.sourceIds.flatMap(id => shots.filter(shot => shot.sourceDocumentId === id))
  return episodeId === OTHER_EPISODE ? [...ordered, ...shots.filter(unassigned)] : ordered
}

// Reordering within one source never moves or swaps another scene's shots.
export function moveSourceShot(shots, movingId, targetId) {
  const moving = shots.find(shot => shot.id === movingId), target = shots.find(shot => shot.id === targetId)
  if (!moving || !target || moving.sourceDocumentId !== target.sourceDocumentId) throw new Error('只能在同一分场内排序')
  const positions = shots.flatMap((shot, index) => shot.sourceDocumentId === moving.sourceDocumentId ? [index] : [])
  const group = positions.map(index => shots[index])
  const from = group.findIndex(shot => shot.id === movingId), to = group.findIndex(shot => shot.id === targetId)
  group.splice(to, 0, group.splice(from, 1)[0])
  positions.forEach((position, index) => { shots[position] = group[index] })
}

export function replaceSourceShots(shots, sourceId, replacements) {
  const first = shots.findIndex(shot => shot.sourceDocumentId === sourceId)
  const remaining = shots.filter(shot => shot.sourceDocumentId !== sourceId)
  remaining.splice(first < 0 ? remaining.length : first, 0, ...replacements)
  shots.splice(0, shots.length, ...remaining)
}
