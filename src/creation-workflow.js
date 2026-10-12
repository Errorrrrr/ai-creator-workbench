export const GENERATION_CHARACTER_LIMIT = 24000
const CORE_IDS = ['idea', 'brief', 'world', 'characters', 'outline', 'draft']

export function upstreamDocumentIds(documentId, structure = {}) {
  const primary = { brief: ['idea'], world: ['brief'], characters: ['brief', 'world'], outline: ['idea', 'brief', 'world'], draft: ['brief', 'outline'] }
  if (primary[documentId]) return primary[documentId]
  const episodeId = Object.entries(structure.episodes || {}).find(([, episode]) => episode.sceneIds?.includes(documentId))?.[0]
  return episodeId ? [episodeId, 'outline'] : structure.episodes?.[documentId] ? ['outline'] : []
}

// Freeze a bounded request before any asynchronous consent, credential or network work.
export function prepareGeneration({ project, documentId, tabName, documents, tabContents, structure, prompt, includeUpstream = true, includeCharacters = true, knowledgeChunks = [], includeCurrent = true, selectedText = '', objectReferences = [], excludedContextKeys = [], characterLimit = GENERATION_CHARACTER_LIMIT }) {
  if (!Number.isSafeInteger(characterLimit) || characterLimit < 16000 || characterLimit > GENERATION_CHARACTER_LIMIT) throw new Error('文字上下文预算无效')
  if (prompt.length > 12000) throw new Error('创作要求超过 12000 字符，请精简后再发送；正文与知识可通过上下文加入。')
  const current = documents[documentId]
  if (!current) throw new Error('当前文档不存在')
  const system = '你是中文内容、故事、短剧与漫剧创作助手。保持用户既有设定与语气，只输出可直接审阅的候选内容，不要声称已经修改正文。'
  const head = `项目：${project.name.slice(0, 100)}（${project.type.slice(0, 30)}）\n当前内容：${current.title.slice(0, 200)}\n`
  const tail = `\n创作要求：\n${prompt}`
  let remaining = characterLimit - system.length - head.length - tail.length
  const sections = []
  const summary = []
  const sentKnowledgeChunks = []
  const excluded = new Set(excludedContextKeys)
  const add = (label, content, cap, key) => {
    if (excluded.has(key)) return ''
    if (!content?.trim()) return ''
    const prefix = `\n【${label}】\n`
    const length = Math.max(0, Math.min(cap, remaining - prefix.length - 16))
    const text = content.slice(0, length)
    const truncated = text.length < content.length
    summary.push({ key, label, content: text, characters: text.length, originalCharacters: content.length, truncated })
    if (!text) return ''
    const section = `${prefix}${text}${truncated ? '\n[此项上下文已截断]' : ''}`
    sections.push(section)
    remaining -= section.length
    return text
  }
  // The references view is a checking workflow: always include the actual script.
  add('编辑器选区', selectedText, 6000, 'selection')
  if (includeCurrent) add(tabName === 'outline' ? '当前大纲' : '当前正文', tabName === 'outline' ? tabContents[documentId]?.outline : current.content, 9000, 'current')
  if (tabName === 'references') add('引用笔记', tabContents[documentId]?.references, 1500, `notes:${documentId}`)
  objectReferences.slice(0, 8).forEach(reference => add(`主动引用 · ${reference.label}`, reference.content, 4000, `object:${reference.key}`))
  const ids = [...new Set([...(includeUpstream ? upstreamDocumentIds(documentId, structure) : []), ...(includeCharacters ? ['characters'] : [])])]
  ids.filter(id => id !== documentId).forEach(id => {
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

export function projectMarkdown(workspace) {
  return [`# ${workspace.project.name}`, ...orderedDocuments(workspace).map(([id, doc]) => {
    const outline = workspace.tabContents[id]?.outline
    return `## ${doc.title}\n\n${doc.content}${outline?.trim() ? `\n\n### 大纲\n\n${outline}` : ''}`
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
