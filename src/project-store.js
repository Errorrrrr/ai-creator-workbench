import { deserializeKnowledgeIndex } from './knowledge-index.js'
import { pruneSemanticIndex } from './semantic-search.js'

const invoke = globalThis.window?.__TAURI__?.core?.invoke
export const MAX_LIBRARY_BYTES = 64 * 1024 * 1024
export const MAX_ARCHIVE_BYTES = 448 * 1024 * 1024
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024
const byteSize = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
const own = (value, key) => Object.hasOwn(value, key)
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
let database
let library
let archives = []
let queue = Promise.resolve()

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function safeParse(text) {
  return JSON.parse(text, (key, value) => {
    assert(!['__proto__', 'prototype', 'constructor'].includes(key), '备份包含非法字段')
    return value
  })
}

function validateStringFields(value, fields, message) {
  for (const field of fields) assert(value[field] === undefined || typeof value[field] === 'string', message)
}

function validateChunks(index, sources) {
  if (index == null) return
  assert(object(index) && index.version === 1 && index.dimension === 384 && Array.isArray(index.chunks), '知识索引格式无效')
  const ids = new Set()
  for (const chunk of index.chunks) {
    assert(object(chunk) && validId(chunk.id) && !ids.has(chunk.id) && validId(chunk.sourceId), '知识片段标识无效或重复')
    ids.add(chunk.id)
    assert(sources.has(chunk.sourceId), '知识片段引用了不存在的来源')
    assert(typeof chunk.name === 'string' && typeof chunk.path === 'string' && typeof chunk.content === 'string' && chunk.content.length > 0 && typeof chunk.updatedAt === 'string', '知识片段内容无效')
    assert(Number.isSafeInteger(chunk.start) && chunk.start >= 0 && Number.isSafeInteger(chunk.end) && chunk.end >= chunk.start, '知识片段位置无效')
    if (chunk.vector !== undefined) assert(Array.isArray(chunk.vector) && chunk.vector.length === 384 && chunk.vector.every(Number.isFinite), '知识向量无效')
  }
}

/** Validate stored and imported workspaces using the same schema; never silently drop writing. */
export function validateWorkspace(workspace, index = null) {
  assert(object(workspace), '项目格式无效')
  assert(workspace.schemaVersion === undefined || [1, 2].includes(workspace.schemaVersion), '项目使用了不支持的数据版本')
  assert(object(workspace.project) && typeof workspace.project.name === 'string' && workspace.project.name.trim().length > 0 && workspace.project.name.length <= 100, '项目名称无效')
  validateStringFields(workspace.project, ['type', 'stage', 'template'], '项目属性无效')
  assert(object(workspace.documents), '文档格式无效')
  for (const [id, doc] of Object.entries(workspace.documents)) {
    assert(/^[a-zA-Z0-9_-]+$/.test(id) && object(doc) && typeof doc.content === 'string', '文档内容无效')
    validateStringFields(doc, ['title', 'sceneTitle', 'intent', 'breadcrumb', 'badge', 'kicker', 'mode'], '文档属性格式无效')
    for (const field of ['meta', 'labels']) assert(doc[field] === undefined || (Array.isArray(doc[field]) && doc[field].every(item => typeof item === 'string')), '文档标签格式无效')
  }
  assert(workspace.currentDocId == null || own(workspace.documents, workspace.currentDocId), '当前文档引用无效')
  assert(workspace.activeTab === undefined || ['script', 'outline', 'references', 'history'].includes(workspace.activeTab), '当前文档视图无效')
  for (const field of ['tabContents', 'versions', 'versionCounters']) {
    assert(workspace[field] === undefined || object(workspace[field]), `${field} 格式无效`)
    for (const id of Object.keys(workspace[field] || {})) assert(own(workspace.documents, id), `${field} 引用了不存在的文档`)
  }
  for (const tabs of Object.values(workspace.tabContents || {})) {
    assert(object(tabs) && Object.keys(tabs).every(key => ['script', 'outline', 'references', 'history'].includes(key)) && Object.values(tabs).every(item => typeof item === 'string'), '文档视图内容无效')
  }
  for (const [id, entries] of Object.entries(workspace.versions || {})) {
    assert(Array.isArray(entries), '历史版本格式无效')
    const numbers = new Set()
    for (const entry of entries) {
      assert(object(entry) && Number.isSafeInteger(entry.number) && entry.number > 0 && !numbers.has(entry.number), '历史版本编号无效或重复')
      numbers.add(entry.number)
      assert(typeof entry.content === 'string' && typeof entry.source === 'string' && typeof entry.createdAt === 'string', '历史版本内容无效')
      assert(entry.tabName === undefined || ['script', 'outline', 'references'].includes(entry.tabName), '历史版本视图无效')
      assert(entry.knowledgeChunks === undefined || (Array.isArray(entry.knowledgeChunks) && entry.knowledgeChunks.every(chunk => object(chunk) && ['id', 'name', 'path', 'content'].every(key => typeof chunk[key] === 'string'))), '历史引用快照无效')
    }
    const counter = workspace.versionCounters?.[id]
    assert(counter !== undefined || entries.length === 0, '历史版本缺少版本计数')
    assert(entries.every(entry => entry.number <= counter), '版本计数小于已有历史版本')
  }
  for (const counter of Object.values(workspace.versionCounters || {})) assert(Number.isSafeInteger(counter) && counter >= 0 && counter < Number.MAX_SAFE_INTEGER, '版本计数须为非负安全整数')
  if (workspace.structure !== undefined) {
    const structure = workspace.structure
    assert(object(structure) && Array.isArray(structure.acts) && object(structure.episodes), '项目结构无效')
    const acts = new Set(), episodes = new Set(), scenes = new Set()
    for (const act of structure.acts) {
      assert(object(act) && validId(act.id) && !acts.has(act.id) && typeof act.title === 'string' && Array.isArray(act.episodeIds), '幕结构无效或重复')
      acts.add(act.id)
      for (const id of act.episodeIds) {
        assert(typeof id === 'string' && own(workspace.documents, id) && own(structure.episodes, id) && !episodes.has(id), '分集引用无效或重复')
        episodes.add(id)
        assert(object(structure.episodes[id]) && Array.isArray(structure.episodes[id].sceneIds), '分场结构无效')
        for (const sceneId of structure.episodes[id].sceneIds) {
          assert(typeof sceneId === 'string' && own(workspace.documents, sceneId) && !scenes.has(sceneId), '分场引用无效或重复')
          scenes.add(sceneId)
        }
      }
    }
    assert(Object.keys(structure.episodes).every(id => episodes.has(id)), '项目中存在未归属幕的分集')
    assert([...episodes].every(id => !scenes.has(id)), '文档不能同时作为分集和分场')
  }
  const sources = new Set()
  if (workspace.knowledge !== undefined) {
    const knowledge = workspace.knowledge
    assert(object(knowledge) && (knowledge.sources === undefined || Array.isArray(knowledge.sources)), '知识来源格式无效')
    for (const source of knowledge.sources || []) {
      assert(object(source) && validId(source.id) && !sources.has(source.id) && typeof source.name === 'string', '知识来源格式无效或重复')
      sources.add(source.id)
      validateStringFields(source, ['kind', 'detail', 'status', 'updatedAt'], '知识来源属性无效')
      for (const key of ['fileCount', 'chunkCount']) assert(source[key] === undefined || (Number.isSafeInteger(source[key]) && source[key] >= 0), '知识来源数量无效')
    }
    const chunkIds = new Set(index?.chunks?.map(chunk => chunk.id) || [])
    assert(knowledge.selectedChunkIds === undefined || (Array.isArray(knowledge.selectedChunkIds) && knowledge.selectedChunkIds.every(id => typeof id === 'string' && chunkIds.has(id))), '知识引用指向不存在的片段')
  }
  validateChunks(index, sources)
  return workspace
}

function validateInspirations(items = []) {
  assert(Array.isArray(items), '灵感库格式无效')
  const ids = new Set()
  for (const item of items) {
    assert(object(item) && validId(item.id) && !ids.has(item.id), '灵感标识无效或重复')
    ids.add(item.id)
    assert(typeof item.title === 'string' && item.title.trim() && item.title.length <= 100 && typeof item.content === 'string' && item.content.trim() && item.content.length <= 100000, '灵感内容无效')
    assert(validDate(item.updatedAt) && (item.archivedAt === undefined || validDate(item.archivedAt)), '灵感时间无效')
  }
}

function validateRecords(projects, archived = false) {
  assert(Array.isArray(projects), '项目列表格式无效')
  const ids = new Set()
  for (const project of projects) {
    assert(object(project) && validId(project.id) && !ids.has(project.id) && validDate(project.updatedAt), '项目记录无效或重复')
    ids.add(project.id)
    if (archived) assert(validDate(project.archivedAt), '归档时间无效')
    validateWorkspace(project.workspace, project.index)
  }
}

function validateLibrary(value, archived = []) {
  assert(object(value) && value.version === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 && value.revision < Number.MAX_SAFE_INTEGER && object(value.settings), '项目库格式无法识别；原数据未被修改')
  validateRecords(value.projects)
  validateRecords(archived, true)
  validateInspirations(value.inspirations)
  assert(value.activeId === null || value.projects.some(project => project.id === value.activeId), '活动项目引用无效')
  assert(!archived.some(project => value.projects.some(active => active.id === project.id)), '活动与归档项目标识重复')
  if (value.legacyTemplateBackups !== undefined) validateRecords(value.legacyTemplateBackups)
  return value
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-creator-workbench-projects', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('library')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readBrowser(key = 'current') {
  return new Promise((resolve, reject) => {
    const request = database.transaction('library').objectStore('library').get(key)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

function writeBrowser(next, revision, nextArchives) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('library', 'readwrite')
    const store = transaction.objectStore('library')
    const current = store.get('current')
    const archived = store.get('archives')
    let conflict = false
    archived.onsuccess = () => {
      if ((current.result?.revision || 0) !== revision) {
        conflict = true
        transaction.abort()
        return
      }
      if (current.result) {
        store.put(current.result, 'previous')
        store.put(archived.result || [], 'previousArchives')
      }
      store.put(next, 'current')
      store.put(nextArchives, 'archives')
    }
    transaction.oncomplete = resolve
    transaction.onabort = () => reject(new Error(conflict ? '另一窗口已更新项目，请备份当前内容后刷新' : '保存失败，请检查可用存储空间'))
    transaction.onerror = () => reject(transaction.error)
  })
}

function serializedLibrary(next, nextArchives) {
  validateLibrary(next, nextArchives)
  // Hash vectors are deterministic caches. Keep text authoritative in storage too,
  // so restoring a backup cannot inflate its persisted size by rebuilding vectors.
  for (const project of [...next.projects, ...nextArchives, ...(next.legacyTemplateBackups || [])]) stripLexicalVectors(project.index)
  const payload = JSON.stringify(next)
  const archivePayload = JSON.stringify(nextArchives)
  const activeBytes = byteSize(payload)
  const archiveBytes = byteSize(archivePayload)
  assert(activeBytes <= MAX_LIBRARY_BYTES, '活动项目库超过 64 MiB，请归档部分项目后重试')
  assert(archiveBytes <= MAX_ARCHIVE_BYTES, '归档库超过 448 MiB，请先导出完整备份')
  assert(activeBytes + archiveBytes + 1024 <= MAX_BACKUP_BYTES, '总容量已达到完整备份预算，请先导出完整备份')
  return { payload, archivePayload }
}

function commit(change) {
  const operation = queue.then(async () => {
    assert(library, '项目库尚未载入，请先导出或恢复内部快照')
    const next = structuredClone(library)
    const nextArchives = structuredClone(archives)
    const result = await change(next, nextArchives)
    if (JSON.stringify(next) === JSON.stringify(library) && JSON.stringify(nextArchives) === JSON.stringify(archives)) return result
    next.revision = library.revision + 1
    const { payload, archivePayload } = serializedLibrary(next, nextArchives)
    if (invoke) await invoke('library_write', { payload, archivePayload, expectedRevision: library.revision })
    else await writeBrowser(next, library.revision, nextArchives)
    library = next
    archives = nextArchives
    return result
  })
  queue = operation.catch(() => {})
  return operation
}

async function fingerprint(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function isUntouchedLegacyTemplate(project) {
  const w = project.workspace
  if (w.project?.name !== '未命名短剧' || w.project?.type !== '短剧' || w.project?.template !== 'blank') return false
  if (Object.values(w.versions || {}).some(items => !Array.isArray(items) || items.length)
    || Object.values(w.versionCounters || {}).some(value => value !== 0)
    || w.knowledge?.sources?.length || w.knowledge?.selectedChunkIds?.length || project.index?.chunks?.length) return false
  if (!w.documents || !w.structure || Object.keys(w.tabContents || {}).length !== 7) return false
  if (await fingerprint(w.documents) !== 'f08093653a4196ea085e6dfabd9c7d7fcd8be0adb5537c7c6d1333101edfc4db') return false
  if (await fingerprint(w.structure) !== 'beb4a5d2cacc6b61fef1f28d5172d97915f409bb4e555f50a2d1c1d8a17a8134') return false
  const tabs = await Promise.all(Object.values(w.tabContents).map(fingerprint))
  return tabs.every(hash => hash === '5d088acd4facccfec4d9d720bc31a09ce178d7ad54594c861765ffc44ef67775')
}

export async function initializeProjects() {
  if (!invoke) database = await openDatabase()
  const stored = invoke ? await invoke('library_read') : await readBrowser()
  const archiveData = invoke ? await invoke('library_read_archives') : await readBrowser('archives')
  library = typeof stored === 'string' ? safeParse(stored) : stored
  archives = (typeof archiveData === 'string' ? safeParse(archiveData) : archiveData) || []
  if (library) validateLibrary(library, archives)
  if (!library) {
    library = { version: 1, revision: 0, activeId: null, projects: [], settings: {} }
    const raw = localStorage.getItem('ai-creator-workbench')
    if (raw) {
      const workspace = JSON.parse(raw)
      if (workspace.project?.name || Object.keys(workspace.documents || {}).length) {
        const index = JSON.parse(localStorage.getItem('ai-creator-workbench:knowledge-index') || 'null')
        const id = crypto.randomUUID()
        await commit(next => {
          next.projects.push({ id, workspace, index, updatedAt: new Date().toISOString() })
          next.activeId = id
          next.settings = { connections: workspace.connections || [], theme: workspace.theme }
        })
      }
    }
  }
  const legacyIds = new Set()
  for (const project of library.projects) {
    if (await isUntouchedLegacyTemplate(project)) legacyIds.add(project.id)
  }
  if (legacyIds.size) await commit(next => {
    // Retain the exact original payload for recovery, without exposing a seeded project.
    next.legacyTemplateBackups = [...(next.legacyTemplateBackups || []), ...next.projects.filter(project => legacyIds.has(project.id))]
    next.projects = next.projects.filter(project => !legacyIds.has(project.id))
    if (legacyIds.has(next.activeId)) next.activeId = next.projects[0]?.id || null
  })
  return getActiveProject()
}

export function getActiveProject() {
  const project = library.projects.find(item => item.id === library.activeId)
  return structuredClone({ id: project?.id || null, workspace: { ...project?.workspace, ...library.settings }, index: project?.index || null })
}

export function listProjects() {
  return library.projects.map(item => ({ id: item.id, name: item.workspace.project.name, type: item.workspace.project.type, updatedAt: item.updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function listInspirations({ archived = false } = {}) {
  return structuredClone((library.inspirations || []).filter(item => archived === null || Boolean(item.archivedAt) === archived)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function saveInspiration(item) {
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  const content = typeof item.content === 'string' ? item.content.trim() : ''
  if (!title || title.length > 100 || !content || content.length > 100000) return Promise.reject(new Error('请填写标题（最多 100 字）和正文（最多 10 万字）'))
  return commit(next => {
    next.inspirations ||= []
    const id = item.id || crypto.randomUUID()
    const index = next.inspirations.findIndex(value => value.id === id)
    if (item.id && index < 0) throw new Error('灵感不存在，请重新打开灵感库')
    const saved = { id, title, content, updatedAt: new Date().toISOString() }
    if (index < 0) next.inspirations.push(saved)
    else next.inspirations[index] = { ...next.inspirations[index], ...saved }
    return saved
  })
}

export function saveProject(id, workspace, index) {
  const snapshot = projectSnapshot(workspace, index)
  return commit(next => {
    next.settings = { connections: snapshot.workspace.connections, theme: snapshot.workspace.theme }
    if (!id) return
    const project = next.projects.find(item => item.id === id)
    if (!project) throw new Error('项目不存在，保存已中止')
    if (JSON.stringify(snapshot) === JSON.stringify({ workspace: project.workspace, index: project.index })) return
    Object.assign(project, snapshot, { updatedAt: new Date().toISOString() })
  })
}

export function createProject(workspace, index) {
  const snapshot = projectSnapshot(workspace, index)
  return commit(next => {
    const id = crypto.randomUUID()
    next.projects.push({ id, ...snapshot, updatedAt: new Date().toISOString() })
    next.activeId = id
    return id
  })
}

export function activateProject(id) {
  return commit(next => {
    if (!next.projects.some(project => project.id === id)) throw new Error('未找到项目')
    next.activeId = id
  })
}

export function renameProject(id, name) {
  if (!name.trim() || name.length > 100) return Promise.reject(new Error('项目名称须为 1–100 个字符'))
  return commit(next => {
    const project = next.projects.find(item => item.id === id)
    if (!project) throw new Error('未找到项目')
    project.workspace.project.name = name.trim()
    project.updatedAt = new Date().toISOString()
  })
}

export async function downloadDocument(name, content) {
  assert(byteSize(content) <= MAX_BACKUP_BYTES, '导出文件超过 512 MiB')
  if (invoke) return invoke('export_document', { name, content })
  const url = URL.createObjectURL(new Blob([content], { type: name.endsWith('.json') ? 'application/json' : 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
  return '浏览器下载目录'
}

export function listArchivedProjects() {
  return archives.map(item => ({ id: item.id, name: item.workspace.project.name, type: item.workspace.project.type, updatedAt: item.updatedAt, archivedAt: item.archivedAt }))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
}

export function archiveProject(id, workspace = null, index = null) {
  const snapshot = workspace ? projectSnapshot(workspace, index) : null
  return commit((next, nextArchives) => {
    const project = next.projects.find(item => item.id === id)
    assert(project, '未找到项目')
    if (snapshot) {
      Object.assign(project, snapshot, { updatedAt: new Date().toISOString() })
      next.settings = { connections: snapshot.workspace.connections, theme: snapshot.workspace.theme }
    }
    nextArchives.push({ ...project, archivedAt: new Date().toISOString() })
    next.projects = next.projects.filter(item => item.id !== id)
    if (next.activeId === id) next.activeId = next.projects[0]?.id || null
    return next.activeId
  })
}

export function restoreProject(id) {
  return commit((next, nextArchives) => {
    const position = nextArchives.findIndex(item => item.id === id)
    assert(position >= 0, '未找到归档项目')
    const [project] = nextArchives.splice(position, 1)
    delete project.archivedAt
    next.projects.push(project)
    next.activeId = id
    return id
  })
}

export function archiveInspiration(id) {
  return commit(next => {
    const item = next.inspirations?.find(value => value.id === id)
    assert(item, '未找到灵感')
    item.archivedAt = new Date().toISOString()
  })
}

export function restoreInspiration(id) {
  return commit(next => {
    const item = next.inspirations?.find(value => value.id === id)
    assert(item, '未找到归档灵感')
    delete item.archivedAt
  })
}

function stripLexicalVectors(index) {
  if (index?.chunks) for (const chunk of index.chunks) delete chunk.vector
}

function projectSnapshot(workspace, index) {
  const snapshot = structuredClone({ workspace, index })
  if (snapshot.workspace.knowledge) snapshot.workspace.knowledge.semantic = pruneSemanticIndex(index, snapshot.workspace.knowledge.semantic)
  stripLexicalVectors(snapshot.index)
  return snapshot
}

function portableProject(project) {
  const copy = structuredClone(project)
  delete copy.workspace.connections
  if (copy.workspace.knowledge) delete copy.workspace.knowledge.semantic
  stripLexicalVectors(copy.index)
  return copy
}

function checkedBackup(value) {
  const text = JSON.stringify(value)
  assert(byteSize(text) <= MAX_BACKUP_BYTES, '备份超过 512 MiB')
  return text
}

export function projectBackup(workspace, index) {
  validateWorkspace(workspace, index)
  const copy = portableProject({ workspace, index })
  return checkedBackup({ format: 'ai-creator-workbench-project', version: 1, exportedAt: new Date().toISOString(), ...copy })
}

function parseBackupEnvelope(text, format) {
  assert(typeof text === 'string' && byteSize(text) <= MAX_BACKUP_BYTES, '备份超过 512 MiB 或不是文本')
  const data = safeParse(text)
  assert(object(data) && data.format === format && data.version === 1, '请选择本应用导出的对应备份（版本 1）')
  assert(validDate(data.exportedAt), '备份导出时间无效')
  return data
}

function restorePortableProject(project) {
  const copy = portableProject(project)
  // Deterministic lexical vectors are rebuilt locally; imported semantic settings are discarded.
  copy.index = deserializeKnowledgeIndex(copy.index)
  return copy
}

export function parseBackup(text) {
  const data = parseBackupEnvelope(text, 'ai-creator-workbench-project')
  validateWorkspace(data.workspace, data.index)
  return restorePortableProject({ workspace: data.workspace, index: data.index || null })
}

export function libraryBackup() {
  assert(library, '项目库尚未载入')
  const projects = [...library.projects, ...(library.legacyTemplateBackups || [])].map(portableProject)
  return checkedBackup({
    format: 'ai-creator-workbench-library', version: 1, exportedAt: new Date().toISOString(),
    projects, archives: archives.map(portableProject), inspirations: structuredClone(library.inspirations || []),
    activeId: library.activeId
  })
}

export function parseLibraryBackup(text) {
  const data = parseBackupEnvelope(text, 'ai-creator-workbench-library')
  validateRecords(data.projects)
  validateRecords(data.archives, true)
  validateInspirations(data.inspirations)
  const ids = new Set(data.projects.map(project => project.id))
  assert(!data.archives.some(project => ids.has(project.id)), '备份中活动与归档项目标识重复')
  assert(data.activeId === null || ids.has(data.activeId), '备份中活动项目引用无效')
  return { projects: data.projects.map(restorePortableProject), archives: data.archives.map(restorePortableProject), inspirations: structuredClone(data.inspirations || []), activeId: data.activeId }
}

export function importLibraryBackup(input) {
  const data = typeof input === 'string' ? parseLibraryBackup(input) : structuredClone(input)
  validateRecords(data.projects)
  validateRecords(data.archives, true)
  validateInspirations(data.inspirations)
  return commit((next, nextArchives) => {
    const idMap = new Map()
    for (const project of [...data.projects, ...data.archives]) idMap.set(project.id, crypto.randomUUID())
    next.projects.push(...data.projects.map(project => ({ ...restorePortableProject(project), id: idMap.get(project.id) })))
    nextArchives.push(...data.archives.map(project => ({ ...restorePortableProject(project), id: idMap.get(project.id) })))
    next.inspirations ||= []
    next.inspirations.push(...(data.inspirations || []).map(item => ({ ...item, id: crypto.randomUUID() })))
    next.activeId ||= idMap.get(data.activeId) || next.projects[0]?.id || null
    return { projects: data.projects.length, archives: data.archives.length, inspirations: data.inspirations?.length || 0, activeId: next.activeId }
  })
}

export async function readPreviousLibrary() {
  await queue
  if (!invoke && !database) database = await openDatabase()
  const stored = invoke ? await invoke('library_read_previous') : await readBrowser('previous')
  if (!stored) return { available: false }
  const archived = invoke ? await invoke('library_read_previous_archives') : await readBrowser('previousArchives')
  const previous = typeof stored === 'string' ? safeParse(stored) : stored
  const previousArchives = (typeof archived === 'string' ? safeParse(archived) : archived) || []
  validateLibrary(previous, previousArchives)
  return {
    available: true, activeProjects: previous.projects.length, archivedProjects: previousArchives.length,
    inspirations: previous.inspirations?.length || 0, revision: previous.revision, library: previous, archives: previousArchives
  }
}

export async function restorePreviousLibrary() {
  const snapshot = await readPreviousLibrary()
  assert(snapshot.available, '没有可恢复的上一份内部快照')
  const operation = queue.then(async () => {
    const revision = invoke ? await invoke('library_current_revision') : (await readBrowser())?.revision || 0
    assert(Number.isSafeInteger(revision) && revision >= 0, '当前保存版本已损坏，请先导出原始数据')
    const next = structuredClone(snapshot.library)
    next.revision = revision + 1
    const { payload, archivePayload } = serializedLibrary(next, snapshot.archives)
    if (invoke) await invoke('library_write', { payload, archivePayload, expectedRevision: revision })
    else await writeBrowser(next, revision, snapshot.archives)
    library = next
    archives = snapshot.archives
    return getActiveProject()
  })
  queue = operation.catch(() => {})
  return operation
}

export function getStorageMetrics() {
  const semanticBytes = [...library.projects, ...archives].reduce((sum, project) => sum + (project.workspace.knowledge?.semantic ? byteSize(project.workspace.knowledge.semantic) : 0), 0)
  return {
    activeBytes: byteSize(library), archiveBytes: byteSize(archives), semanticBytes,
    projectCount: library.projects.length, archivedCount: archives.length, inspirationCount: library.inspirations?.length || 0,
    limitBytes: MAX_LIBRARY_BYTES, archiveLimitBytes: MAX_ARCHIVE_BYTES, backupLimitBytes: MAX_BACKUP_BYTES
  }
}

/** Emergency export keeps original bytes even when the active schema cannot be loaded. */
export async function rawLibrarySnapshot() {
  if (!invoke && !database) database = await openDatabase()
  const current = invoke ? await invoke('library_read') : await readBrowser()
  const archived = invoke ? await invoke('library_read_archives') : await readBrowser('archives')
  return JSON.stringify({ format: 'ai-creator-workbench-recovery', current, archives: archived })
}
