import { normalizeContinuity } from './continuity-assets.js'
import { planReferenceBackfill } from './storyboard-references.js'
import { storyboardSceneEntries } from './storyboard-scope.js'
import { imageVisualReviewState, visualInputSnapshot, visualInputChanges } from './visual-review.js'

export function getContinuityReviewBatch(data) {
  const batch = data.storyboard?.continuityReviewBatch
  if (!batch) return null
  const shots = storyboardSceneEntries(data).flatMap(entry => entry.shots).filter(shot => shot.continuityReview?.batchId === batch.id)
  if (!shots.length) return null
  return { projectId: data.projectId, id: batch.id, shotIds: shots.map(shot => shot.id),
    previouslyApprovedShotIds: shots.filter(shot => shot.continuityReview.previouslyApproved).map(shot => shot.id) }
}

// Preview the same reference reconciliation that saving the definitions applies.
// Returning the planned storyboard also lets callers persist the inspected inputs.
export function planContinuityImpact(data, nextContinuity, assets = []) {
  const current = data.storyboard || { revision: 0, shots: [] }
  const available = data.projectId === undefined ? assets : assets.filter(asset => asset.projectId === data.projectId)
  const documents = data.documents || {}, revision = current.revision || 0
  const storyboard = planReferenceBackfill({ ...current, continuity: normalizeContinuity(nextContinuity) }, available, documents, data.projectId).storyboard
  storyboard.revision = revision + 1
  const nextData = { ...data, storyboard }
  const nextShots = new Map(storyboard.shots.map(shot => [shot.id, shot]))
  const groups = storyboardSceneEntries(data).map(entry => {
    const shots = entry.shots.flatMap((shot, index) => {
      const nextShot = nextShots.get(shot.id)
      const previous = visualInputSnapshot(shot, available, documents, current.continuity, data)
      const next = visualInputSnapshot(nextShot, available, documents, storyboard.continuity, nextData)
      const changedFields = visualInputChanges(previous, next)
      if (!changedFields.length) return []
      const review = imageVisualReviewState(shot, available, documents, current.continuity, data)
      return [{ id: shot.id, title: shot.title, sourceDocumentId: shot.sourceDocumentId, number: index + 1,
        changedFields, previouslyApproved: review.reviewed, previousReviewStatus: review.status, hasImage: review.status !== 'missing' }]
    })
    return { sourceId: entry.sourceId, episodeId: entry.episodeId, episodeTitle: entry.episodeTitle,
      sourceTitle: entry.title, pendingAssignment: entry.pendingAssignment, shots }
  }).filter(group => group.shots.length)
  const shots = groups.flatMap(group => group.shots)
  if (shots.length) {
    const batchId = `continuity-review-${storyboard.revision}`, affected = new Map(shots.map(shot => [shot.id, shot]))
    storyboard.continuityReviewBatch = { version: 1, id: batchId }
    storyboard.shots = storyboard.shots.map(shot => {
      const { continuityReview, ...next } = shot
      const impact = affected.get(shot.id)
      return impact ? { ...next, continuityReview: { batchId, previouslyApproved: impact.previouslyApproved } } : next
    })
  }
  return { projectId: data.projectId, revision, storyboard, groups, shots, shotIds: shots.map(shot => shot.id),
    previouslyApprovedCount: shots.filter(shot => shot.previouslyApproved).length }
}
