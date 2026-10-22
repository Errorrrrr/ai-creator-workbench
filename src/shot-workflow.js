import { findMediaVersion } from './storyboard.js'
import { matchShotReferences } from './storyboard-references.js'

export function shotStagePanel(stage) {
  return stage === 'images' || stage === 'videos' ? 'generation' : stage === 'export' ? 'versions' : 'content'
}

export function shotReadiness(shot, assets, jobs = [], documents = {}) {
  const active = jobs.find(job => job.targetId === shot.id && !['completed', 'failed', 'cancelled', 'submission_unknown'].includes(job.status))
  if (active) return { label: active.capability === 'video' ? '视频生成中' : '图片生成中', tone: 'running' }
  if (jobs.some(job => job.targetId === shot.id && job.status === 'submission_unknown')) return { label: '任务待核对', tone: 'warning' }
  const selectedVideo = findMediaVersion(assets, shot.selectedVideoVersionId)
  if (selectedVideo?.asset.kind === 'video') return shot.reviewedVideoVersionId === shot.selectedVideoVersionId
    ? { label: '已完成', tone: 'complete' } : { label: '视频待审核', tone: 'review' }
  if (shot.references.some(ref => !findMediaVersion(assets, ref.versionId)) || matchShotReferences(shot, assets, documents).some(match => !['bound', 'excluded'].includes(match.status))) return { label: '参考待补齐', tone: 'warning' }
  if (findMediaVersion(assets, shot.selectedImageVersionId)?.asset.kind === 'image') return { label: '待生成视频', tone: 'ready' }
  return { label: '待生成分镜图', tone: 'pending' }
}
