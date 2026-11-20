import { findMediaVersion, videoReviewState } from './storyboard.js'
import { matchShotReferences } from './storyboard-references.js'
import { imageVisualReviewState } from './visual-review.js'

export function shotStagePanel(stage) {
  return stage === 'images' || stage === 'videos' ? 'generation' : stage === 'export' ? 'versions' : 'content'
}

export function shotReferencesNeedAttention(shot, assets, documents = {}, continuity) {
  if (shot.references.some(ref => !findMediaVersion(assets, ref.versionId))) return true
  // An intentional manual version or exclusion is not a missing reference.
  return matchShotReferences(shot, assets, documents, continuity).some(match => !['bound', 'excluded', 'manual'].includes(match.status))
}

export function shotReadiness(shot, assets, jobs = [], documents = {}, continuity, context = {}) {
  const active = jobs.find(job => job.targetId === shot.id && !['completed', 'failed', 'cancelled', 'submission_unknown'].includes(job.status))
  if (active) return { label: active.capability === 'video' ? '视频生成中' : '图片生成中', tone: 'running' }
  if (jobs.some(job => job.targetId === shot.id && job.status === 'submission_unknown')) return { label: '任务待核对', tone: 'warning' }
  const selectedVideo = findMediaVersion(assets, shot.selectedVideoVersionId)
  if (selectedVideo?.asset.kind === 'video') {
    const review = videoReviewState(shot, documents, { ...context, assets, storyboard: { ...context.storyboard, continuity: continuity ?? context.storyboard?.continuity } })
    return review.reviewed ? { label: '已完成', tone: 'complete' }
      : { label: review.legacy ? '旧审核待复核' : review.outdated ? '内容已变，待复核' : '视频待审核', tone: 'review' }
  }
  if (shotReferencesNeedAttention(shot, assets, documents, continuity)) return { label: '参考待补齐', tone: 'warning' }
  if (findMediaVersion(assets, shot.selectedImageVersionId)?.asset.kind === 'image') {
    const visual = imageVisualReviewState(shot, assets, documents, continuity, context)
    return visual.reviewed ? { label: '待生成视频', tone: 'ready' } : { label: visual.label, tone: 'review' }
  }
  return { label: '待生成分镜图', tone: 'pending' }
}

// The image workspace can hand off to Flow/Muse without producing a local video.
// Its next action is a navigation/preview suggestion, never a generation request.
export function shotImageReadiness(shot, assets, jobs = [], documents = {}, continuity, context = {}) {
  const active = jobs.find(job => job.targetId === shot.id && !['completed', 'failed', 'cancelled', 'submission_unknown'].includes(job.status))
  if (active) return { label: active.capability === 'video' ? '视频生成中' : '图片生成中', tone: 'running' }
  if (jobs.some(job => job.targetId === shot.id && job.status === 'submission_unknown')) return { label: '任务待核对', tone: 'warning' }
  const state = imageVisualReviewState(shot, assets, documents, continuity, context)
  if (state.reviewed) return { label: '画面已确认', tone: 'complete' }
  if (state.status === 'missing') return { label: '待准备图片', tone: 'pending' }
  return { label: state.status === 'rejected' ? '需要修改' : state.status === 'changed' ? '需要重新检查' : '待检查画面', tone: state.issues.length || state.status === 'rejected' ? 'warning' : 'review' }
}

export function storyboardNextAction({ shots = [], assets = [], jobs = [], documents = {}, continuity, context = {}, sceneSelected = false }) {
  if (!shots.length) return sceneSelected ? { kind: 'storyboard', label: '拆分本场镜头' } : { kind: 'scenes', label: '整理分场' }
  const ids = new Set(shots.map(shot => shot.id))
  if (jobs.some(job => ids.has(job.targetId) && !['completed', 'failed', 'cancelled'].includes(job.status))) return { kind: 'jobs', label: '查看生成任务' }
  const missing = shots.filter(shot => findMediaVersion(assets, shot.selectedImageVersionId)?.asset.kind !== 'image')
  if (missing.length) return { kind: 'images', label: `准备缺少的图片 · ${missing.length}`, shotIds: missing.slice(0, 20).map(shot => shot.id) }
  const pending = shots.filter(shot => !imageVisualReviewState(shot, assets, documents, continuity, context).reviewed)
  if (pending.length) return { kind: 'review', label: `检查画面 · ${pending.length}`, shotId: pending[0].id }
  return { kind: 'export', label: '导出素材包' }
}
