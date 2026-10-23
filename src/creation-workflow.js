export const GENERATION_CHARACTER_LIMIT = 24000
const CORE_IDS = ['idea', 'brief', 'world', 'characters', 'outline', 'draft']

export function upstreamDocumentIds(documentId, structure = {}) {
  const primary = { brief: ['idea'], world: ['brief'], characters: ['brief', 'world'], outline: ['idea', 'brief', 'world'], draft: ['brief', 'outline'] }
  if (primary[documentId]) return primary[documentId]
  const episodeId = Object.entries(structure.episodes || {}).find(([, episode]) => episode.sceneIds?.includes(documentId))?.[0]
  return episodeId ? [episodeId, 'outline'] : structure.episodes?.[documentId] ? ['outline'] : []
}

export function previousSceneId(documentId, structure = {}) {
  const episodeIds = (structure.acts || []).flatMap(act => act.episodeIds || [])
  const sceneIds = [...new Set(episodeIds.flatMap(id => structure.episodes?.[id]?.sceneIds || []))]
  const index = sceneIds.indexOf(documentId)
  return index > 0 ? sceneIds[index - 1] : null
}

// Prepare both snapshots without changing the editor; commit them only after storage succeeds.
export function prepareVersionRestore(workspace, documentId, entry, createdAt = new Date().toISOString()) {
  const tabName = entry.tabName || 'script'
  if (!workspace.documents[documentId] || !['script', 'outline', 'references'].includes(tabName)) throw new Error('历史快照的目标文档无效')
  const next = structuredClone(workspace)
  const previousText = tabName === 'script' ? next.documents[documentId].content : next.tabContents[documentId]?.[tabName] || ''
  const entries = next.versions[documentId] || []
  const beforeNumber = Math.max(next.versionCounters[documentId] || 0, ...entries.map(item => item.number), 0) + 1
  const restoredNumber = beforeNumber + 1
  next.versions[documentId] = [
    { number: restoredNumber, content: entry.content, source: `从 v${entry.number} 恢复`, tabName, knowledgeChunks: structuredClone(entry.knowledgeChunks || []), createdAt },
    { number: beforeNumber, content: previousText, source: `恢复 v${entry.number} 前快照`, tabName, knowledgeChunks: [], createdAt },
    ...entries
  ].slice(0, 50)
  next.versionCounters[documentId] = restoredNumber
  if (tabName === 'script') next.documents[documentId].content = entry.content
  else next.tabContents[documentId][tabName] = entry.content
  next.currentDocId = documentId
  next.activeTab = tabName
  return { workspace: next, previousText, beforeNumber, restoredNumber, tabName }
}

// Freeze a bounded request before any asynchronous consent, credential or network work.
export function prepareGeneration({ project, documentId, tabName, documents, tabContents, structure, prompt, creativeAction = '', followup = null, includeReferenceNotes = true, includeUpstream = true, includeCharacters = true, knowledgeChunks = [], includeCurrent = true, selectedText = '', objectReferences = [], excludedContextKeys = [], characterLimit = GENERATION_CHARACTER_LIMIT }) {
  if (!Number.isSafeInteger(characterLimit) || characterLimit < 16000 || characterLimit > GENERATION_CHARACTER_LIMIT) throw new Error('文字上下文预算无效')
  if (prompt.length > 12000) throw new Error('创作要求超过 12000 字符，请精简后再发送；正文与知识可通过上下文加入。')
  const current = documents[documentId]
  if (!current) throw new Error('当前文档不存在')
  const continuity = creativeAction === 'continuity'
  const continuation = creativeAction === 'continuation'
  const system = '你是中文内容、故事、短剧与漫剧创作助手。保持用户既有设定与语气，只输出可直接审阅的候选内容，不要声称已经修改正文。' + (continuity ? '\n本次检查连续性：只依据实际提供的设定和前文核对，指出缺失或截断资料带来的不确定性；未提供的内容不能视为已核实。' : '') + (followup ? '\n用户已明确选择继续修改：本轮修改要求作用于提供的已选候选或回答，保留其中未要求改变的部分。' : '') + (continuation ? '\n本次为续写：从提供的当前正文结尾接续，不重复已写内容。' : '')
  const head = `项目：${project.name.slice(0, 100)}（${project.type.slice(0, 30)}）\n当前内容：${current.title.slice(0, 200)}\n`
  const tail = `\n创作要求：\n${prompt}`
  let remaining = characterLimit - system.length - head.length - tail.length
  const sections = []
  const summary = []
  const contextWarnings = []
  const sentKnowledgeChunks = []
  const excluded = new Set(excludedContextKeys)
  const add = (label, content, cap, key, fromEnd = false) => {
    if (excluded.has(key)) return ''
    if (!content?.trim()) return ''
    const prefix = `\n【${label}】\n`
    const length = Math.max(0, Math.min(cap, remaining - prefix.length - 16))
    const text = length ? fromEnd ? content.slice(-length) : content.slice(0, length) : ''
    const truncated = text.length < content.length
    summary.push({ key, label, content: text, characters: text.length, originalCharacters: content.length, truncated })
    if (!text) return ''
    const section = `${prefix}${text}${truncated ? '\n[此项上下文已截断]' : ''}`
    sections.push(section)
    remaining -= section.length
    return text
  }
  if (followup) {
    add('继续修改 · 上次要求', followup.prompt, 1000, 'followup:prompt')
    add(followup.purpose === 'discussion' ? '继续讨论 · 已选回答' : '继续修改 · 已选候选', followup.text, 9000, 'followup:text')
  }
  // Keep the user's selection first; continuation must see the latest ending.
  add('编辑器选区', selectedText, 6000, 'selection')
  if (includeCurrent) add(tabName === 'outline' ? '当前大纲' : continuation ? '当前正文结尾（用于续写）' : '当前正文', tabName === 'outline' ? tabContents[documentId]?.outline : current.content, 9000, 'current', continuation)
  if (includeReferenceNotes) add('引用笔记', tabContents[documentId]?.references, 1500, `notes:${documentId}`)
  if (continuity) {
    if (documentId !== 'world' && documents.world?.content.trim()) add('连续性核对 · 世界观', documents.world.content, 2800, 'continuity:world')
    else if (!documents.world?.content.trim()) contextWarnings.push('未提供世界观：本次无法完整核对世界规则。')
    const previousId = previousSceneId(documentId, structure)
    const previous = documents[previousId]
    if (previous?.content.trim()) add(`连续性核对 · 上一场结尾 · ${previous.title}`, previous.content, 3200, `continuity:previous:${previousId}`, true)
    else contextWarnings.push(previousId ? '上一场尚无正文：本次无法核对前后衔接。' : '当前内容没有上一场：仅核对本次已提供的资料。')
  }
  objectReferences.slice(0, 8).forEach(reference => add(`主动引用 · ${reference.label}`, reference.content, 4000, `object:${reference.key}`))
  const ids = [...new Set([...(includeUpstream ? upstreamDocumentIds(documentId, structure) : []), ...(includeCharacters ? ['characters'] : [])])]
  ids.filter(id => id !== documentId && !(continuity && id === 'world')).forEach(id => {
    const doc = documents[id]
    if (doc) add(`上游资料 · ${doc.title}`, doc.content, 2800, `upstream:${id}`)
  })
  knowledgeChunks.slice(0, 6).forEach((chunk, i) => {
    const content = add(`K${i + 1} · ${chunk.name} / ${chunk.path}`, chunk.content, 900, `knowledge:${chunk.id}`)
    if (content) sentKnowledgeChunks.push({ ...chunk, content })
  })
  return {
    messages: [{ role: 'system', content: system }, { role: 'user', content: head + sections.join('') + tail }],
    summary,
    contextWarnings,
    creativeAction: continuity ? 'continuity' : continuation ? 'continuation' : '',
    followup: followup ? structuredClone(followup) : null,
    knowledgeChunks: sentKnowledgeChunks,
    characters: characterLimit - remaining,
    truncated: summary.some(item => item.truncated)
  }
}

export function orderedDocuments(workspace) {
  const result = []
  const visited = new Set()
  const add = id => {
    if (!visited.has(id) && workspace.documents[id]) {
      visited.add(id)
      result.push([id, workspace.documents[id]])
    }
  }
  CORE_IDS.forEach(add)
  for (const act of workspace.structure?.acts || []) {
    for (const episodeId of act.episodeIds || []) {
      add(episodeId)
      for (const sceneId of workspace.structure.episodes?.[episodeId]?.sceneIds || []) add(sceneId)
    }
  }
  // Preserve any recoverable orphan documents rather than silently omitting them.
  Object.keys(workspace.documents).forEach(add)
  return result
}

export function projectMarkdown(workspace, { includeOutline = true, includeReferences = false } = {}) {
  return [`# ${workspace.project.name}`, ...orderedDocuments(workspace).map(([id, doc]) => {
    const outline = includeOutline ? workspace.tabContents[id]?.outline : ''
    const references = includeReferences ? workspace.tabContents[id]?.references : ''
    return `## ${doc.title}\n\n${doc.content}${outline?.trim() ? `\n\n### 大纲\n\n${outline}` : ''}${references?.trim() ? `\n\n### 参考笔记\n\n${references}` : ''}`
  })].join('\n\n')
}

export function planKnowledgeFiles(files) {
  let totalBytes = 0
  const accepted = []
  const skipped = []
  for (const file of files) {
    const path = file.webkitRelativePath || file.name
    let reason = ''
    if (!/\.(md|markdown|txt)$/i.test(file.name)) reason = '格式不支持'
    else if (file.size > 1024 * 1024) reason = '超过单文件 1 MiB'
    else if (accepted.length >= 80) reason = '超过 80 个文件'
    else if (totalBytes + file.size > 4 * 1024 * 1024) reason = '超过本次 4 MiB'
    if (reason) skipped.push({ path, reason })
    else { accepted.push(file); totalBytes += file.size }
  }
  return { accepted, skipped, totalBytes, selectedCount: files.length }
}

export function sceneNavigation(documentId, structure = {}) {
  const scenes = (structure.acts || []).flatMap(act => (act.episodeIds || []).flatMap(id => structure.episodes?.[id]?.sceneIds || []))
  const index = scenes.indexOf(documentId)
  return { previous: index > 0 ? scenes[index - 1] : null, next: index >= 0 ? scenes[index + 1] || null : null }
}

function structurePosition(workspace, documentId) {
  for (const act of workspace.structure.acts) {
    const episodeIndex = act.episodeIds.indexOf(documentId)
    if (episodeIndex >= 0) return { kind: 'episode', list: act.episodeIds, index: episodeIndex, actId: act.id, episodeId: documentId }
    for (const episodeId of act.episodeIds) {
      const list = workspace.structure.episodes[episodeId]?.sceneIds || []
      const index = list.indexOf(documentId)
      if (index >= 0) return { kind: 'scene', list, index, actId: act.id, episodeId }
    }
  }
  return null
}

export function refreshStructure(workspace) {
  let episodeNumber = 0
  for (const act of workspace.structure.acts) for (const episodeId of act.episodeIds) {
    episodeNumber += 1
    const episode = workspace.documents[episodeId]
    if (!episode) continue
    episode.breadcrumb = `第 ${episodeNumber} 集`
    const scenes = workspace.structure.episodes[episodeId]?.sceneIds || []
    episode.meta ||= []
    episode.meta[0] = `${scenes.length} 场`
    scenes.forEach((sceneId, index) => {
      const scene = workspace.documents[sceneId]
      if (!scene) return
      scene.breadcrumb = `第 ${episodeNumber} 集 · 场 ${index + 1}`
      scene.kicker = (scene.kicker || '').replace(/^\d+-\d+/, `${episodeNumber}-${index + 1}`)
    })
  }
}

// Mutate only a detached snapshot. The caller publishes this after storage succeeds.
export function prepareStructureChange(workspace, action) {
  const next = structuredClone(workspace)
  const position = structurePosition(next, action.documentId)
  let result = action.documentId
  if (action.type === 'create') {
    const { documentId, kind, document, parentId, actId, tabContents } = action
    if (!['episode', 'scene'].includes(kind) || next.documents[documentId]) throw new Error('新内容类型或标识无效')
    if (kind === 'episode') {
      if (!next.structure.acts.length) next.structure.acts.push({ id: 'act-1', title: '第一幕', collapsed: false, episodeIds: [] })
      const act = next.structure.acts.find(item => item.id === actId) || next.structure.acts[0]
      act.episodeIds.push(documentId)
      next.structure.episodes[documentId] = { sceneIds: [] }
    } else {
      if (!next.structure.episodes[parentId]) throw new Error('所属分集已不存在')
      next.structure.episodes[parentId].sceneIds.push(documentId)
    }
    next.documents[documentId] = structuredClone(document)
    next.tabContents[documentId] = structuredClone(tabContents)
    next.versions[documentId] = []; next.versionCounters[documentId] = 0
    if (action.select !== false) { next.currentDocId = documentId; next.activeTab = 'script' }
  } else if (action.type === 'restore') {
    const removed = action.removed
    if (Object.keys(removed.documents).some(id => next.documents[id])) throw new Error('已有同标识内容，无法自动恢复')
    const list = removed.kind === 'episode' ? next.structure.acts.find(item => item.id === removed.actId)?.episodeIds : next.structure.episodes[removed.episodeId]?.sceneIds
    if (!list) throw new Error('原分幕或分集已不存在，无法自动恢复')
    for (const key of ['documents', 'tabContents', 'versions', 'versionCounters']) Object.assign(next[key], structuredClone(removed[key]))
    if (removed.kind === 'episode') next.structure.episodes[action.documentId] = structuredClone(removed.episodeStructure)
    list.splice(Math.min(removed.index, list.length), 0, action.documentId)
    next.currentDocId = action.documentId; next.activeTab = 'script'
  } else if (action.type === 'metadata') {
    if (!next.documents[action.documentId]) throw new Error('文档已不存在')
    Object.assign(next.documents[action.documentId], action.patch)
  } else {
    if (!position) throw new Error('当前内容无法执行此操作')
    if (action.type === 'move') {
      const target = position.index + action.direction
      if (target < 0 || target >= position.list.length) throw new Error(action.direction < 0 ? '已经是第一项' : '已经是最后一项')
      position.list.splice(position.index, 1); position.list.splice(target, 0, action.documentId)
    } else if (action.type === 'duplicate') {
      if (next.documents[action.newId]) throw new Error('副本标识已存在')
      const original = next.documents[action.documentId]
      next.documents[action.newId] = { ...structuredClone(original), title: `${original.title} · 副本`, sceneTitle: `${original.title} · 副本`, badge: '待完善' }
      next.tabContents[action.newId] = structuredClone(next.tabContents[action.documentId])
      next.versions[action.newId] = []; next.versionCounters[action.newId] = 0
      if (position.kind === 'episode') next.structure.episodes[action.newId] = { sceneIds: [] }
      position.list.splice(position.index + 1, 0, action.newId)
      next.currentDocId = action.newId; next.activeTab = 'script'; result = action.newId
    } else if (action.type === 'delete') {
      const ids = position.kind === 'episode' ? [action.documentId, ...next.structure.episodes[action.documentId].sceneIds] : [action.documentId]
      result = { kind: position.kind, actId: position.actId, episodeId: position.episodeId, index: position.index, episodeStructure: structuredClone(next.structure.episodes[action.documentId] || null) }
      for (const key of ['documents', 'tabContents', 'versions', 'versionCounters']) {
        result[key] = Object.fromEntries(ids.map(id => [id, structuredClone(next[key][id] ?? (key === 'versionCounters' ? 0 : key === 'versions' ? [] : {}))]))
        ids.forEach(id => delete next[key][id])
      }
      position.list.splice(position.index, 1)
      if (position.kind === 'episode') delete next.structure.episodes[action.documentId]
      next.currentDocId = position.kind === 'scene' ? position.episodeId : 'outline'; next.activeTab = 'script'
    } else throw new Error('不支持的结构操作')
  }
  refreshStructure(next)
  return { workspace: next, result }
}
