import { mediaAdapterFor } from './media-adapters.js'

// Project data only. Files and generation jobs belong to the desktop media store.
export const SHOT_LIMIT = 120
export const REFERENCE_ROLES = ['reference', 'start', 'end', 'extend']
export const ASSET_ROLES = { character: '角色', scene: '场景', prop: '道具', style: '风格', shot: '镜头', other: '其他' }
export const JOB_STATUSES = { queued: '排队', submitting: '提交中', running: '生成中', downloading: '下载中', completed: '已收录', failed: '失败', cancelled: '已取消等待', submission_unknown: '提交结果待确认' }
const TEXT_FIELDS = ['title', 'visual', 'dialogue', 'action', 'camera', 'entryState', 'exitState']
const id = () => crypto.randomUUID()
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const validCharacters = value => Array.isArray(value) && value.length <= 16 && value.every(name => typeof name === 'string' && name.trim() && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name))

export function contentFingerprint(content = '') {
  let hash = 2166136261
  for (const character of String(content)) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0
  return `${String(content).length}:${hash.toString(16)}`
}

export function storyboardSourceFingerprint(storyboard, documentId) {
  return contentFingerprint(JSON.stringify(storyboard.shots.filter(shot => shot.sourceDocumentId === documentId)))
}

// Capture creative inputs, not output selection, review flags or UI metadata.
export function shotProductionInputs(shot, documents = {}) {
  const fields = [...TEXT_FIELDS, 'duration', 'transition', 'characterNames', 'sceneNames', 'propNames', 'selectedImageVersionId', 'aspectRatio', 'imageSize', 'imageQuality', 'videoMode', 'videoDuration']
  return { ...Object.fromEntries(fields.map(field => [field, shot[field] ?? null])),
    references: shot.references.map(({ versionId, role, scope }) => ({ versionId, role, scope: scope || '' })),
    sourceDocumentId: shot.sourceDocumentId,
    sourceFingerprint: shot.sourceDocumentId ? contentFingerprint(documents[shot.sourceDocumentId]?.content ?? '') : '' }
}

export function shotInputFingerprint(shot, documents = {}) {
  return `v1:${contentFingerprint(JSON.stringify(shotProductionInputs(shot, documents)))}`
}

export function shotInputFieldFingerprints(shot, documents = {}) {
  return Object.fromEntries(Object.entries(shotProductionInputs(shot, documents)).map(([key, value]) => [key, contentFingerprint(JSON.stringify(value))]))
}

export function videoReviewState(shot, documents = {}) {
  const recorded = Boolean(shot.selectedVideoVersionId && shot.reviewedVideoVersionId === shot.selectedVideoVersionId)
  const legacy = recorded && !shot.reviewedInputFingerprint
  const reviewed = recorded && shot.reviewedInputFingerprint === shotInputFingerprint(shot, documents)
  return { reviewed, outdated: recorded && !reviewed, legacy }
}

export function snapshotStoryboardSource(storyboard, sourceDocumentId, label = '重做前的分镜') {
  const shots = storyboard.shots.filter(shot => shot.sourceDocumentId === sourceDocumentId)
  if (!shots.length) return null
  const version = { id: id(), createdAt: new Date().toISOString(), sourceDocumentId, label, shots: structuredClone(shots) }
  storyboard.sourceVersions = [version, ...(storyboard.sourceVersions || [])].slice(0, 10)
  return version
}

export function emptyStoryboard() { return { revision: 0, shots: [] } }

export function normalizeWorkflow(value = {}) {
  return {
    preset: ['text', 'script', 'storyboard'].includes(value?.preset) ? value.preset : 'script',
    ...Object.fromEntries(['text', 'storyboard', 'image', 'video'].map(step => [`${step}ConnectionId`, typeof value?.[`${step}ConnectionId`] === 'string' ? value[`${step}ConnectionId`] : '']))
  }
}

export function createShot(value = {}, source = {}) {
  for (const field of ['characterNames', 'sceneNames', 'propNames']) if (value[field] !== undefined && !validCharacters(value[field])) throw new Error('镜头角色、场景或道具列表无效')
  return {
    id: id(), ...Object.fromEntries(TEXT_FIELDS.map(field => [field, String(value[field] || '').slice(0, field === 'title' ? 200 : 12000)])),
    title: String(value.title || '未命名镜头').slice(0, 200),
    duration: Number.isFinite(Number(value.duration)) ? Math.max(1, Math.min(60, Number(value.duration))) : 5,
    transition: value.transition === 'continuous' ? 'continuous' : 'cut',
    sourceDocumentId: source.documentId || '', sourceFingerprint: source.fingerprint || '',
    ...Object.fromEntries(['characterNames', 'sceneNames', 'propNames'].filter(field => value[field] !== undefined).map(field => [field, [...new Set(value[field].map(name => name.trim()))]])),
    references: [], selectedImageVersionId: '', selectedVideoVersionId: '', reviewedVideoVersionId: '',
    aspectRatio: '16:9', imageSize: 'auto', imageQuality: 'auto', videoMode: 'image-to-video'
  }
}

export function validateStoryboard(value) {
  if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.shots) || value.shots.length > SHOT_LIMIT) throw new Error('分镜结构或修订号无效')
  const ids = new Set()
  if (value.sourceVersions !== undefined) {
    if (!Array.isArray(value.sourceVersions) || value.sourceVersions.length > 10) throw new Error('分镜历史版本无效')
    const versionIds = new Set()
    for (const version of value.sourceVersions) {
      if (!object(version) || typeof version.id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(version.id) || versionIds.has(version.id) || typeof version.createdAt !== 'string' || !Number.isFinite(Date.parse(version.createdAt)) || typeof version.sourceDocumentId !== 'string' || version.sourceDocumentId.length > 200 || typeof version.label !== 'string' || version.label.length > 200) throw new Error('分镜历史记录无效')
      versionIds.add(version.id)
      validateStoryboard({ revision: 0, shots: version.shots })
      if (version.shots.some(shot => shot.sourceDocumentId !== version.sourceDocumentId)) throw new Error('分镜历史来源不一致')
    }
  }
  for (const shot of value.shots) {
    if (!object(shot) || typeof shot.id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(shot.id) || ids.has(shot.id)) throw new Error('镜头标识无效或重复')
    ids.add(shot.id)
    for (const field of ['characterNames', 'sceneNames', 'propNames']) if (shot[field] !== undefined && !validCharacters(shot[field])) throw new Error('镜头角色、场景或道具列表无效')
    if (shot.referenceExclusions !== undefined && (!Array.isArray(shot.referenceExclusions) || shot.referenceExclusions.length > 128 || shot.referenceExclusions.some(value => typeof value !== 'string' || value.length > 300 || !/^(character|scene|prop):[^\u0000-\u001f\u007f]+$/.test(value)))) throw new Error('镜头手动排除参考无效')
    for (const field of TEXT_FIELDS) if (typeof shot[field] !== 'string' || shot[field].length > (field === 'title' ? 200 : 12000)) throw new Error(`镜头 ${field} 字段无效`)
    if (!Number.isFinite(shot.duration) || shot.duration < 1 || shot.duration > 60 || !['cut', 'continuous'].includes(shot.transition)) throw new Error('镜头时长或衔接方式无效')
    if (shot.videoDuration !== undefined && (!Number.isFinite(shot.videoDuration) || shot.videoDuration < 1 || shot.videoDuration > 60)) throw new Error('视频生成时长无效')
    for (const [key, values] of Object.entries({ aspectRatio: ['16:9', '9:16', '1:1'], imageSize: ['auto', '1024x1024', '1536x1024', '1024x1536'], imageQuality: ['auto', 'low', 'medium', 'high'], videoMode: ['image-to-video', 'reference-to-video', 'first-last', 'extend'] })) if (shot[key] !== undefined && !values.includes(shot[key])) throw new Error('镜头生成参数无效')
    for (const field of ['sourceDocumentId', 'sourceFingerprint', 'selectedImageVersionId', 'selectedVideoVersionId']) if (typeof shot[field] !== 'string' || shot[field].length > 200) throw new Error('镜头引用无效')
    if (shot.reviewedVideoVersionId !== undefined && (typeof shot.reviewedVideoVersionId !== 'string' || shot.reviewedVideoVersionId.length > 200)) throw new Error('镜头审核版本无效')
    if (shot.reviewedInputFingerprint !== undefined && (typeof shot.reviewedInputFingerprint !== 'string' || shot.reviewedInputFingerprint.length > 200)) throw new Error('镜头审核输入指纹无效')
    if (!Array.isArray(shot.references) || shot.references.length > 16 || shot.references.some(ref => !object(ref) || typeof ref.versionId !== 'string' || !ref.versionId || ref.versionId.length > 96 || !REFERENCE_ROLES.includes(ref.role))) throw new Error('镜头参考素材无效')
    if (shot.references.some(ref => ref.scope !== undefined && !['continuity', 'video'].includes(ref.scope))) throw new Error('镜头参考适用范围无效')
    if (shot.references.some(ref => ref.origin !== undefined && !['auto', 'manual'].includes(ref.origin))) throw new Error('镜头参考来源无效')
  }
  return value
}

export function normalizeStoryboard(value) {
  if (value === undefined || value === null) return emptyStoryboard()
  validateStoryboard(value)
  return structuredClone(value)
}

export function parseStoryboardCandidate(text, source = {}) {
  if (typeof text !== 'string' || text.length > 250000) throw new Error('分镜候选过大或不是文本')
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value
  try { value = JSON.parse(clean) } catch { throw new Error('AI 未返回有效分镜 JSON；候选仍保留，可修改后重新解析') }
  if (!object(value) || !Array.isArray(value.shots) || !value.shots.length || value.shots.length > SHOT_LIMIT) throw new Error(`分镜候选必须包含 1–${SHOT_LIMIT} 个镜头`)
  return value.shots.map((shot, index) => {
    if (!object(shot) || typeof shot.visual !== 'string' || !shot.visual.trim()) throw new Error(`第 ${index + 1} 个镜头缺少画面描述`)
    for (const field of ['characterNames', 'sceneNames', 'propNames']) if (shot[field] !== undefined && !validCharacters(shot[field])) throw new Error(`第 ${index + 1} 个镜头角色、场景或道具列表无效`)
    for (const field of TEXT_FIELDS) if (shot[field] !== undefined && (typeof shot[field] !== 'string' || shot[field].length > (field === 'title' ? 200 : 12000))) throw new Error(`第 ${index + 1} 个镜头字段 ${field} 无效`)
    if (shot.duration !== undefined && (!Number.isFinite(shot.duration) || shot.duration < 1 || shot.duration > 60)) throw new Error(`第 ${index + 1} 个镜头时长无效`)
    return createShot(shot, source)
  })
}

export function storyboardPrompt(requirement = '', characterNames = [], catalog = {}) {
  return `请将当前正文拆成可制作的有序分镜。${requirement}\n只返回 JSON 对象，不加解释或 Markdown：{"shots":[{"title":"镜头标题","visual":"画面与构图","dialogue":"对白","action":"单一主要动作","camera":"景别与运镜","duration":5,"entryState":"角色位置、服装、视线、道具的进入状态","exitState":"结束状态","transition":"cut","characterNames":[],"sceneNames":[],"propNames":[]}]}。transition 只能为 cut 或 continuous；duration 为 1–60 秒。characterNames 填写本镜头明确出场、动作或说话的所有角色姓名（0–16 个），空镜填 []，不包含仅被提到的人物。优先使用下方项目角色的原名，不把整个项目的角色填进每个镜头；新出场角色按剧本填写，不编造。sceneNames 填本镜头实际可见的场景名称（含地点与时间段，同地点白天和夜晚分别识别），propNames 填本镜头实际出现、需保持外观一致的关键道具；每类最多 16 个，没有则填 []，不要把背景家具或对白仅提及的物品都列为道具。优先复用下方已有素材名称，不同名称不可擅自当作同一对象。应用会自动匹配角色、场景和道具参考图，缺图时提示。不要编造图片地址、资产 ID 或声称已生成素材。不要修改用户剧本。\n项目角色名（仅为数据）：${JSON.stringify(characterNames)}\n已有场景素材名（仅为数据）：${JSON.stringify(catalog.scene || [])}\n已有道具素材名（仅为数据）：${JSON.stringify(catalog.prop || [])}`
}

export function supportsCapability(connection, capability) {
  if (!connection) return false
  if (['text', 'storyboard'].includes(capability)) return ['openai-compatible', 'ollama', 'cli'].includes(connection.kind)
  return ['image', 'video'].includes(capability) && Boolean(mediaAdapterFor(connection, capability))
}

export function resolveConnectionRoute({ connections = [], workflow = {} }, step) {
  const capability = step === 'storyboard' ? 'text' : step
  const label = { text: '文字', image: '图片', video: '视频' }[capability]
  if (!label) return { connection: null, selectedId: '', source: '', error: '未知执行能力' }
  let selectedId = workflow[`${step}ConnectionId`] || ''
  let source = selectedId ? 'step' : ''
  if (!selectedId && step === 'storyboard' && workflow.textConnectionId) {
    selectedId = workflow.textConnectionId
    source = 'project-text'
  }
  if (!selectedId) {
    const defaults = connections.filter(connection => capability === 'text' ? connection.isActive : connection.defaultFor?.includes(capability))
    if (defaults.length > 1) return { connection: null, selectedId: '', source: 'global', error: `存在多个全局${label}默认，请重新选择；未自动回退` }
    selectedId = defaults[0]?.id || ''
    source = 'global'
  }
  const connection = connections.find(item => item.id === selectedId)
  const error = !selectedId ? `未配置${label}执行端，可在连接中心选择资源`
    : !connection ? `原${label}执行端不存在，请重新选择；未自动回退`
      : !supportsCapability(connection, step) ? `${connection.name} 不支持${label}能力，请重新选择；未自动回退` : ''
  return { connection: error ? null : connection, selectedId, source, error }
}

export function findMediaVersion(assets, versionId) {
  for (const asset of assets) {
    const version = asset.versions?.find(item => item.id === versionId)
    if (version) return { asset, version }
  }
  return null
}

export function isContinuityReference(ref, assets) {
  if (ref.role !== 'reference' || ref.scope === 'video') return false
  return ref.scope === 'continuity' || ['character', 'scene', 'prop'].includes(findMediaVersion(assets, ref.versionId)?.asset.role)
}

export function prepareShotInputs(shot, assets, capability) {
  const mode = capability === 'video' ? shot.videoMode || 'image-to-video' : shot.references.length ? 'edit' : 'generate'
  const retained = capability === 'video' && mode !== 'reference-to-video' ? shot.references.filter(ref => isContinuityReference(ref, assets)) : []
  const refs = shot.references.filter(ref => !retained.includes(ref)).map(({ versionId, role }) => ({ versionId, role }))
  const roles = capability === 'image' ? ['reference', 'start', 'end'] : ({ 'image-to-video': ['start'], 'reference-to-video': ['reference'], 'first-last': ['start', 'end'], extend: ['extend'] })[mode]
  if (!roles || refs.some(ref => !roles.includes(ref.role))) throw new Error('所选模式与显式视频输入用途冲突，请调整首尾帧、主体参考或续接输入')
  if (capability === 'video' && ['image-to-video', 'first-last'].includes(mode) && !refs.some(ref => ref.role === 'start')) {
    const image = findMediaVersion(assets, shot.selectedImageVersionId)
    if (!image || !image.version.mimeType?.startsWith('image/')) throw new Error('先选用一张分镜图，再生成视频；或明确指定起始帧')
    refs.push({ versionId: image.version.id, role: 'start' })
  }
  if (refs.some(ref => !findMediaVersion(assets, ref.versionId))) throw new Error('引用的媒体文件不存在，请恢复完整项目包或重新选择')
  return { mode, references: refs, retained }
}

// The plot duration is editorial data. An explicit execution duration changes
// only the provider request, never the scene timing or the original script.
export function videoParameterState(shot, connection) {
  const duration = shot.videoDuration ?? shot.duration, aspectRatio = shot.aspectRatio || '16:9'
  const mode = shot.videoMode || 'image-to-video', veo = mediaAdapterFor(connection, 'video')?.id === 'veo'
  const allowedDurations = veo ? ['reference-to-video', 'extend'].includes(mode) ? [8] : [4, 6, 8] : []
  const issues = []
  if (veo) {
    if (!['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview'].includes(connection.model)) issues.push('当前 Veo 适配器仅支持 Veo 3.1 标准／Fast preview，请在连接中心核对模型')
    if (!['16:9', '9:16'].includes(aspectRatio)) issues.push(`Veo 不支持 ${aspectRatio} 视频，请将生成画幅改为 16:9 或 9:16`)
    if (!allowedDurations.includes(duration)) issues.push(`当前视频生成时长 ${duration} 秒不兼容：${mode === 'reference-to-video' ? '主体参考模式' : mode === 'extend' ? '原生视频续接' : 'Veo'}支持 ${allowedDurations.join('／')} 秒，请在生成设置中明确选择；剧情时长 ${shot.duration} 秒保持不变`)
  }
  return { duration, aspectRatio, allowedDurations, issues }
}

export function validateVideoParameters(shot, assets, connection, input) {
  const state = videoParameterState(shot, connection)
  if (state.issues.length) throw new Error(state.issues.join('；'))
  if (mediaAdapterFor(connection, 'video')?.id !== 'veo') return state
  const count = role => input.references.filter(ref => ref.role === role).length
  const [start, end, reference, extend] = ['start', 'end', 'reference', 'extend'].map(count)
  const valid = ({
    'image-to-video': start === 1 && end + reference + extend === 0,
    'first-last': start === 1 && end === 1 && reference + extend === 0,
    'reference-to-video': reference >= 1 && reference <= 3 && start + end + extend === 0,
    extend: extend === 1 && start + end + reference === 0
  })[input.mode]
  if (!valid) throw new Error(({ 'image-to-video': '图生视频需要且只接受 1 张起始帧', 'first-last': '首尾帧模式需要各 1 张起始帧和结束帧', 'reference-to-video': '主体参考模式需要 1–3 张图片，不混用首尾帧或续接视频', extend: '续接模式需要且只接受 1 个原生 Veo 视频' })[input.mode] || 'Veo 不支持此视频输入模式')
  let bytes = 0
  for (const ref of input.references) {
    const found = findMediaVersion(assets, ref.versionId)
    if (!found) throw new Error('视频输入文件未找到，请重新选择')
    const expectedKind = ref.role === 'extend' ? 'video' : 'image'
    if (expectedKind === 'video' ? !found.version.mimeType?.startsWith('video/') : !['image/png', 'image/jpeg', 'image/webp'].includes(found.version.mimeType)) throw new Error(`${ref.role === 'extend' ? '续接输入必须是视频' : '首尾帧和主体参考必须是 PNG、JPEG 或 WebP 图片'}：${found.asset.name}`)
    if (ref.role === 'extend') {
      const provenance = found.version.metadata?.provenance
      if (!provenance?.model?.startsWith('veo-3.1-') || provenance.connectionId !== connection.id) throw new Error('续接必须使用同一执行端生成的原生 Veo 3.1 视频，导入视频或其他执行端的视频不能续接')
    }
    if (found.version.bytes > 50 * 1024 * 1024) throw new Error(`视频输入单项不能超过 50 MiB：${found.asset.name}`)
    bytes += found.version.bytes || 0
  }
  if (bytes > 100 * 1024 * 1024) throw new Error('视频输入总大小不能超过 100 MiB')
  return state
}

export function jobResult(job, assets, shots, documents = {}) {
  const asset = assets.find(item => item.id === job.assetId)
  const versions = asset?.versions?.filter(version => version.metadata?.provenance?.jobId === job.id) || []
  const shot = shots.find(item => item.id === job.targetId)
  const selectedId = shot ? job.capability === 'video' ? shot.selectedVideoVersionId : shot.selectedImageVersionId : asset?.selectedVersionId
  const selected = versions.some(version => version.id === selectedId)
  const reviewed = job.capability === 'video' && selected && shot && videoReviewState(shot, documents).reviewed
  const status = job.status !== 'completed' ? JOB_STATUSES[job.status] || job.status
    : !asset ? '已收录 · 素材未找到' : !versions.length ? '已收录 · 版本待核对'
      : reviewed ? '已收录 · 视频已审核' : selected ? '已收录 · 已选用' : '已收录 · 待选用'
  return { asset, versions, shot, status }
}

export function shotIsStale(shot, documents) {
  const document = documents[shot.sourceDocumentId]
  return Boolean(shot.sourceDocumentId && (!document || contentFingerprint(document.content) !== shot.sourceFingerprint))
}

export function mediaPrompt(shot, project, referenceLabels = []) {
  return [`项目：${project.name}（${project.type}）`, `镜头：${shot.title}`, shot.characterNames?.length ? `出场角色：${shot.characterNames.join('、')}` : '',
    shot.sceneNames?.length ? `场景参考：${shot.sceneNames.join('、')}` : '',
    shot.propNames?.length ? `道具参考：${shot.propNames.join('、')}` : '', `画面：${shot.visual}`, `动作：${shot.action}`, `对白：${shot.dialogue}`, `运镜：${shot.camera}`, `进入状态：${shot.entryState}`, `结束状态：${shot.exitState}`, `衔接：${shot.transition === 'continuous' ? '延续动作，保持运动方向与道具状态' : '切换机位，保持人物身份与场景关系'}`, ...referenceLabels].filter(Boolean).join('\n')
}
