import { refreshStructure } from './creation-workflow.js'

export const MAX_EPISODE_SCENES = 100
export const MAX_SCENE_TITLE = 200
export const MAX_SCENE_CONTENT = 2 * 1024 * 1024
const own = (value, key) => Boolean(value && Object.hasOwn(value, key))
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
function assert(condition, message) { if (!condition) throw new Error(message) }

/** A scene is a script document in an episode, never a reusable scene asset. */
export function episodeForDocument(data, documentId) {
  if (!own(data?.documents, documentId)) return null
  const episodes = data.structure?.episodes || {}
  if (own(episodes, documentId) && Array.isArray(episodes[documentId]?.sceneIds)) return documentId
  const parents = Object.entries(episodes).filter(([id, episode]) => own(data.documents, id) && episode?.sceneIds?.includes(documentId))
  return parents.length === 1 ? parents[0][0] : null
}

export function isSceneDocument(data, documentId) {
  const episodeId = episodeForDocument(data, documentId)
  return Boolean(episodeId && episodeId !== documentId)
}

function sceneHeading(line) {
  // Only explicit screenplay headings count. Ordinary Markdown sections,
  // mentioned locations and dialogue containing “第一场” are not boundaries.
  let title = line.trim().replace(/^#{1,6}[ \t]+/u, '').replace(/[ \t]+#+[ \t]*$/u, '')
  if (/^\*\*.*\*\*$/u.test(title)) title = title.slice(2, -2).trim()
  const number = '[0-9０-９一二三四五六七八九十百零〇两]+'
  const numbered = new RegExp(`^(?:第[ \\t]*${number}[ \\t]*场|(?:分场|场景|场)[ \\t]*${number})(?=$|[ \\t：:、.．·—–\\-（(])`, 'u')
  if (numbered.test(title) || /^(?:分场|场景)[ \t]*[：:][ \t]*\S/u.test(title)
    || /^scene[ \t]+\d+(?=$|[ \t：:、.\-])/iu.test(title)
    || /^s\d{1,3}(?=$|[ \t|｜：:、.\-])/iu.test(title)
    || /^\d{1,3}[-－]\d{1,3}(?=$|[ \t：:、])/u.test(title)) return title
  return null
}

/** Split without rewriting any character, newline, heading or opening notes. */
export function splitEpisodeScript(content) {
  assert(typeof content === 'string' && content.length <= MAX_SCENE_CONTENT, '本集正文无效或超过 2 MiB 字符，请先精简后再分场')
  if (!content.trim()) return []
  const headings = []
  const lines = /[^\r\n]*(?:\r\n|\r|\n|$)/gu
  for (const match of content.matchAll(lines)) {
    if (!match[0]) continue
    const title = sceneHeading(match[0].replace(/[\r\n]+$/u, ''))
    if (title) headings.push({ title, index: match.index })
  }
  if (!headings.length) return [{ title: '第 1 场 · 待确认', content }]
  assert(headings.length <= MAX_EPISODE_SCENES, '本集超过 100 个明确场次，请分批整理')
  return headings.map((heading, index) => ({
    title: heading.title,
    content: content.slice(index ? heading.index : 0, headings[index + 1]?.index ?? content.length)
  }))
}

/** Prepare a detached append; the caller persists it before publishing UI state. */
export function prepareEpisodeScenes(workspace, { episodeId, scenes, expectedContent, expectedSceneIds, idFactory = () => `scene-${crypto.randomUUID()}` }) {
  assert(episodeForDocument(workspace, episodeId) === episodeId, '所选分集已不存在，请重新打开分场预览')
  const episode = workspace.structure.episodes[episodeId]
  assert(typeof expectedContent === 'string' && workspace.documents[episodeId].content === expectedContent, '本集正文已变化，请重新预览分场；未修改现有内容')
  assert(Array.isArray(scenes) && scenes.length > 0 && scenes.length <= MAX_EPISODE_SCENES, '请提供 1–100 个分场')
  assert(episode.sceneIds.length + scenes.length <= MAX_EPISODE_SCENES, '新增后本集超过 100 个分场，请先整理现有分场')
  assert(Array.isArray(expectedSceneIds) && expectedSceneIds.length === episode.sceneIds.length && expectedSceneIds.every((id, index) => id === episode.sceneIds[index]), '本集分场已变化或缺少快照，请重新预览；未重复添加')
  for (const scene of scenes) {
    assert(object(scene) && typeof scene.title === 'string' && scene.title.trim() && scene.title.length <= MAX_SCENE_TITLE && !/[\u0000-\u001f\u007f]/u.test(scene.title), '分场标题不能为空、含控制字符或超过 200 字符')
    assert(typeof scene.content === 'string' && scene.content.trim() && scene.content.length <= MAX_SCENE_CONTENT, '分场正文不能为空或超过 2 MiB 字符')
    assert(!episode.sceneIds.some(id => workspace.documents[id]?.title === scene.title.trim() && workspace.documents[id]?.content === scene.content), '已有同标题和正文的分场，请检查是否重复提交；未修改原分场')
  }
  assert(typeof idFactory === 'function', '分场编号生成器无效')
  const next = structuredClone(workspace), sceneIds = []
  for (const field of ['tabContents', 'versions', 'versionCounters']) next[field] ||= {}
  const episodeNumber = (next.structure.acts || []).flatMap(act => act.episodeIds || []).indexOf(episodeId) + 1
  for (const scene of scenes) {
    const sceneId = idFactory()
    assert(validId(sceneId) && !own(next.documents, sceneId), '新分场标识无效或已存在，未覆盖已有内容')
    const sceneNumber = next.structure.episodes[episodeId].sceneIds.length + 1
    const title = scene.title.trim()
    next.documents[sceneId] = {
      title, breadcrumb: `第 ${episodeNumber} 集 · 场 ${sceneNumber}`, badge: '草稿',
      kicker: `${episodeNumber}-${sceneNumber} · 场景待定 · 时间待定`, sceneTitle: title,
      intent: '明确地点、出场人物，以及这场戏结束时必须发生的变化。',
      meta: ['场景待定', '时间待定', '人物待定'], mode: '剧本模式',
      labels: ['剧本', '本场大纲', '设定引用', '历史版本'], content: scene.content
    }
    next.tabContents[sceneId] = { outline: '', references: '', history: '' }
    next.versions[sceneId] = []; next.versionCounters[sceneId] = 0
    next.structure.episodes[episodeId].sceneIds.push(sceneId)
    sceneIds.push(sceneId)
  }
  refreshStructure(next)
  // refreshStructure maintains navigation metadata, not script text or states.
  return { workspace: next, sceneIds }
}

/** Rehome explicit selections and pin their existing references for review. */
export function prepareAssignShots(workspace, { shotIds, targetSceneId, expectedSources }) {
  assert(isSceneDocument(workspace, targetSceneId), '目标分场已不存在，请重新选择真实分场')
  assert(Array.isArray(shotIds) && shotIds.length > 0 && shotIds.length <= 120 && shotIds.every(validId) && new Set(shotIds).size === shotIds.length, '请选择 1–120 个不重复的镜头')
  assert(object(expectedSources), '缺少原镜头归属快照，请重新打开归场预览')
  const storyboard = workspace.storyboard
  assert(object(storyboard) && Array.isArray(storyboard.shots) && Number.isSafeInteger(storyboard.revision) && storyboard.revision >= 0 && storyboard.revision < Number.MAX_SAFE_INTEGER, '分镜结构或修订号无效')
  for (const shotId of shotIds) {
    const matches = storyboard.shots.filter(shot => shot.id === shotId)
    assert(matches.length === 1, '所选镜头已不存在或标识重复，请重新选择')
    assert(own(expectedSources, shotId) && typeof expectedSources[shotId] === 'string' && matches[0].sourceDocumentId === expectedSources[shotId], '所选镜头归属已变化，请重新预览；未移动其他镜头')
  }
  const movingIds = new Set(shotIds.filter(id => storyboard.shots.find(shot => shot.id === id).sourceDocumentId !== targetSceneId))
  assert(movingIds.size, '所选镜头已属于目标分场，无需重复归场')
  const next = structuredClone(workspace)
  for (const shot of next.storyboard.shots) if (movingIds.has(shot.id)) {
    shot.sourceDocumentId = targetSceneId
    // A new source may resolve a different asset state. The user's explicit
    // move fixes the references they saw, so background backfill cannot swap
    // their versions before they review the target scene's requirements.
    shot.references = shot.references.map(ref => ref.origin === 'auto' ? { ...ref, origin: 'manual' } : ref)
  }
  next.storyboard.revision += 1
  return {
    workspace: next, shotIds: [...movingIds], warnings: [
      '镜头来源已变化，请按目标分场重新核对剧本、参考图、画面连续性和视频；原来源指纹、媒体选用和复核记录均保留，不视为通过新的复核。',
      '归场时已固定原参考图版本，请之后在参考页核对、调整；旧素材状态范围和分场状态不自动迁移。',
      '旧拆镜候选和分镜历史仍关联原来源，未自动改写；恢复或采纳旧内容前请核对归属。'
    ]
  }
}
