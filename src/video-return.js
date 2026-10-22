// A filename is a suggestion, never permission to replace a selected version.
const formats = new Set(['google-flow-handoff', 'meta-muse-chat-handoff'])

export function parseVideoManifest(text, projectId) {
  if (text.length > 2_000_000) throw new Error('导出清单过大，请选择素材包中的 manifest.json')
  let manifest
  try { manifest = JSON.parse(text) } catch { throw new Error('清单不是有效 JSON，请选择素材包中的 manifest.json') }
  if (!formats.has(manifest?.format) || manifest.version !== 1 || !Array.isArray(manifest.shots) || manifest.shots.length > 500) throw new Error('请选择工作台导出的 Flow／Muse 清单')
  if (manifest.projectId && manifest.projectId !== projectId) throw new Error('这份清单属于其他项目，请切换到原项目后回填')
  const ids = new Set(), numbers = new Set()
  for (const shot of manifest.shots) {
    if (typeof shot?.id !== 'string' || !shot.id || shot.id.length > 128 || !Number.isSafeInteger(shot.number) || shot.number < 1 || ids.has(shot.id) || numbers.has(shot.number)) throw new Error('清单中的镜头编号或标识无效／重复')
    ids.add(shot.id); numbers.add(shot.number)
  }
  return manifest
}

function containsId(name, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(name)
}

export function planVideoReturn({ shots, assets, manifest = null }) {
  const manifestShots = manifest?.shots || []
  return assets.filter(asset => asset.kind === 'video').flatMap(asset => (asset.versions || []).filter(version => version.mimeType?.startsWith('video/')).map(version => {
    const name = version.name || asset.name
    const byId = shots.filter(shot => containsId(name, shot.id))
    const number = /^shot[-_\s]?(\d{1,4})(?=[-_.\s]|$)/i.exec(name)?.[1]
    const exported = number ? manifestShots.find(shot => shot.number === Number(number)) : null
    const targets = new Set(byId.map(shot => shot.id))
    if (exported) targets.add(exported.id)
    let shotId = targets.size === 1 ? [...targets][0] : ''
    let reason = byId.length ? '文件名中的镜头标识' : exported ? '导出清单中的镜头编号' : '未匹配，请手动选择镜头'
    if (targets.size > 1) { shotId = ''; reason = '文件名标识与清单冲突，请手动核对' }
    if (shotId && !shots.some(shot => shot.id === shotId)) { shotId = ''; reason = '原镜头已删除，不自动分配给其他镜头' }
    const shot = shots.find(shot => shot.id === shotId)
    const source = manifestShots.find(item => item.id === shotId)
    const warnings = []
    if (source?.sourceFingerprint && source.sourceFingerprint !== shot?.sourceFingerprint) warnings.push('拆镜来源与导出时不同，请核对内容')
    if (shot?.selectedVideoVersionId && shot.selectedVideoVersionId !== version.id) warnings.push('确认后更换选用版本，原视频仍保留')
    return { assetId: asset.id, versionId: version.id, name, shotId, reason, warnings }
  }))
}

export function applyVideoReturn(storyboard, assignments, assets) {
  if (!assignments.length) throw new Error('请先勾选要关联的视频并选择镜头')
  const next = structuredClone(storyboard), seen = new Set()
  for (const { shotId, versionId } of assignments) {
    const shot = next.shots.find(item => item.id === shotId)
    if (!shot) throw new Error('目标镜头不存在，请重新核对匹配结果')
    if (seen.has(shotId)) throw new Error(`“${shot.title}”选择了多个视频，请只保留一个选用版本`)
    seen.add(shotId)
    const exists = assets.some(asset => asset.kind === 'video' && asset.versions?.some(version => version.id === versionId && version.mimeType?.startsWith('video/')))
    if (!exists) throw new Error('视频版本已不存在，请重新导入或刷新')
    if (shot.selectedVideoVersionId !== versionId) { shot.selectedVideoVersionId = versionId; shot.reviewedVideoVersionId = '' }
  }
  next.revision += 1
  return next
}
