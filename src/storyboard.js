import { mediaAdapterFor } from './media-adapters.js'

// Project data only. Files and generation jobs belong to the desktop media store.
export const SHOT_LIMIT = 120
export const REFERENCE_ROLES = ['reference', 'start', 'end', 'extend']
export const ASSET_ROLES = { character: '角色', scene: '场景', prop: '道具', style: '风格', shot: '镜头', other: '其他' }
export const JOB_STATUSES = { queued: '排队', submitting: '提交中', running: '生成中', downloading: '下载中', completed: '已收录 · 待审核', failed: '失败', cancelled: '已取消等待', submission_unknown: '提交结果待确认' }
const TEXT_FIELDS = ['title', 'visual', 'dialogue', 'action', 'camera', 'entryState', 'exitState']
const id = () => crypto.randomUUID()
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))

export function contentFingerprint(content = '') {
  let hash = 2166136261
  for (const character of String(content)) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0
  return `${String(content).length}:${hash.toString(16)}`
}

export function emptyStoryboard() { return { revision: 0, shots: [] } }

export function normalizeWorkflow(value = {}) {
  return {
    preset: ['text', 'script', 'storyboard'].includes(value?.preset) ? value.preset : 'script',
    ...Object.fromEntries(['text', 'storyboard', 'image', 'video'].map(step => [`${step}ConnectionId`, typeof value?.[`${step}ConnectionId`] === 'string' ? value[`${step}ConnectionId`] : '']))
  }
}

export function createShot(value = {}, source = {}) {
  return {
    id: id(), ...Object.fromEntries(TEXT_FIELDS.map(field => [field, String(value[field] || '').slice(0, field === 'title' ? 200 : 12000)])),
    title: String(value.title || '未命名镜头').slice(0, 200),
    duration: Number.isFinite(Number(value.duration)) ? Math.max(1, Math.min(60, Number(value.duration))) : 5,
    transition: value.transition === 'continuous' ? 'continuous' : 'cut',
    sourceDocumentId: source.documentId || '', sourceFingerprint: source.fingerprint || '',
    references: [], selectedImageVersionId: '', selectedVideoVersionId: '', reviewedVideoVersionId: '',
    aspectRatio: '16:9', imageSize: 'auto', imageQuality: 'auto', videoMode: 'image-to-video'
  }
}

export function validateStoryboard(value) {
  if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.shots) || value.shots.length > SHOT_LIMIT) throw new Error('分镜结构或修订号无效')
  const ids = new Set()
  for (const shot of value.shots) {
    if (!object(shot) || typeof shot.id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(shot.id) || ids.has(shot.id)) throw new Error('镜头标识无效或重复')
    ids.add(shot.id)
    for (const field of TEXT_FIELDS) if (typeof shot[field] !== 'string' || shot[field].length > (field === 'title' ? 200 : 12000)) throw new Error(`镜头 ${field} 字段无效`)
    if (!Number.isFinite(shot.duration) || shot.duration < 1 || shot.duration > 60 || !['cut', 'continuous'].includes(shot.transition)) throw new Error('镜头时长或衔接方式无效')
    for (const [key, values] of Object.entries({ aspectRatio: ['16:9', '9:16', '1:1'], imageSize: ['auto', '1024x1024', '1536x1024', '1024x1536'], imageQuality: ['auto', 'low', 'medium', 'high'], videoMode: ['image-to-video', 'reference-to-video', 'first-last', 'extend'] })) if (shot[key] !== undefined && !values.includes(shot[key])) throw new Error('镜头生成参数无效')
    for (const field of ['sourceDocumentId', 'sourceFingerprint', 'selectedImageVersionId', 'selectedVideoVersionId']) if (typeof shot[field] !== 'string' || shot[field].length > 200) throw new Error('镜头引用无效')
    if (shot.reviewedVideoVersionId !== undefined && (typeof shot.reviewedVideoVersionId !== 'string' || shot.reviewedVideoVersionId.length > 200)) throw new Error('镜头审核版本无效')
    if (!Array.isArray(shot.references) || shot.references.length > 16 || shot.references.some(ref => !object(ref) || typeof ref.versionId !== 'string' || !ref.versionId || ref.versionId.length > 96 || !REFERENCE_ROLES.includes(ref.role))) throw new Error('镜头参考素材无效')
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
    for (const field of TEXT_FIELDS) if (shot[field] !== undefined && (typeof shot[field] !== 'string' || shot[field].length > (field === 'title' ? 200 : 12000))) throw new Error(`第 ${index + 1} 个镜头字段 ${field} 无效`)
    if (shot.duration !== undefined && (!Number.isFinite(shot.duration) || shot.duration < 1 || shot.duration > 60)) throw new Error(`第 ${index + 1} 个镜头时长无效`)
    return createShot(shot, source)
  })
}

export function storyboardPrompt(requirement = '') {
  return `请将当前正文拆成可制作的有序分镜。${requirement}\n只返回 JSON 对象，不加解释或 Markdown：{"shots":[{"title":"镜头标题","visual":"画面与构图","dialogue":"对白","action":"单一主要动作","camera":"景别与运镜","duration":5,"entryState":"角色位置、服装、视线、道具的进入状态","exitState":"结束状态","transition":"cut"}]}。transition 只能为 cut 或 continuous；duration 为 1–60 秒。不要编造图片地址、资产 ID 或声称已生成素材。不要修改用户剧本。`
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

export function shotIsStale(shot, documents) {
  const document = documents[shot.sourceDocumentId]
  return Boolean(shot.sourceDocumentId && (!document || contentFingerprint(document.content) !== shot.sourceFingerprint))
}

export function mediaPrompt(shot, project, referenceLabels = []) {
  return [`项目：${project.name}（${project.type}）`, `镜头：${shot.title}`, `画面：${shot.visual}`, `动作：${shot.action}`, `对白：${shot.dialogue}`, `运镜：${shot.camera}`, `进入状态：${shot.entryState}`, `结束状态：${shot.exitState}`, `衔接：${shot.transition === 'continuous' ? '延续动作，保持运动方向与道具状态' : '切换机位，保持人物身份与场景关系'}`, ...referenceLabels].filter(Boolean).join('\n')
}
