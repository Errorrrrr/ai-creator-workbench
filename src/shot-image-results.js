function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN
  return /^\d+$/.test(value) ? Number(value) : Date.parse(value)
}

function compare(a, b) {
  return timestamp(a.createdAt) - timestamp(b.createdAt) || a.jobId.localeCompare(b.jobId)
}

function latestImageJobs(jobs, projectId) {
  const latest = new Map()
  if (!projectId) return latest
  for (const job of jobs) {
    if (job.projectId !== projectId || job.capability !== 'image' || job.restored || job.request?.character || !job.id || !Number.isFinite(timestamp(job.createdAt))) continue
    const candidate = { jobId: job.id, createdAt: job.createdAt }
    const previous = latest.get(job.targetId)
    if (!previous || compare(candidate, { jobId: previous.id, createdAt: previous.createdAt }) > 0) latest.set(job.targetId, job)
  }
  return latest
}

// A manual choice acknowledges even a running task, so its later completion
// cannot undo that choice. A subsequently requested generation can still win.
export function imageResultCheckpoint(shotId, jobs, projectId) {
  const job = latestImageJobs(jobs, projectId).get(shotId)
  return job ? { jobId: job.id, createdAt: job.createdAt } : null
}

export function planShotImageResults(storyboard, assets, jobs, projectId) {
  const latest = latestImageJobs(jobs, projectId), linked = []
  let changed = 0
  const shots = storyboard.shots.map(shot => {
    const job = latest.get(shot.id)
    if (!job || job.status !== 'completed') return shot
    const checkpoint = { jobId: job.id, createdAt: job.createdAt }
    if (shot.imageResultCheckpoint && compare(checkpoint, shot.imageResultCheckpoint) <= 0) return shot
    const asset = assets.find(asset => asset.id === job.assetId && asset.projectId === projectId && asset.kind === 'image')
    const versions = (asset?.versions || []).filter(version => version.id && version.mimeType?.startsWith('image/') && version.metadata?.provenance?.jobId === job.id)
    if (!versions.length) return shot
    const current = assets.filter(asset => asset.projectId === projectId && asset.kind === 'image').flatMap(asset => asset.versions || []).find(version => version.id === shot.selectedImageVersionId)
    const currentJobId = current?.metadata?.provenance?.jobId
    // Preserve a deliberate imported/other-shot choice during migration, and
    // preserve a choice among this task's multiple outputs.
    const sameTarget = jobs.some(item => item.id === currentJobId && item.targetId === shot.id && item.projectId === projectId && item.capability === 'image' && !item.request?.character)
    const keepCurrent = currentJobId === job.id || (!shot.imageResultCheckpoint && current && !sameTarget)
    const ordered = [...versions].sort((a, b) => {
      const artifact = version => String(version.metadata?.provenance?.artifact ?? '\uffff')
      return artifact(a).localeCompare(artifact(b), 'en', { numeric: true }) || (timestamp(a.createdAt) || 0) - (timestamp(b.createdAt) || 0) || a.id.localeCompare(b.id)
    })
    const selectedImageVersionId = keepCurrent ? shot.selectedImageVersionId : ordered[0].id
    if (selectedImageVersionId !== shot.selectedImageVersionId) linked.push({ shotId: shot.id, jobId: job.id, versionId: selectedImageVersionId })
    changed += 1
    return { ...shot, selectedImageVersionId, imageResultCheckpoint: checkpoint }
  })
  return { storyboard: changed ? { ...storyboard, revision: storyboard.revision + 1, shots } : storyboard, changed, linked }
}
