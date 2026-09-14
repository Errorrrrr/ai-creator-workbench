const invoke = window.__TAURI__?.core?.invoke
const MAX_BACKUP_BYTES = 64 * 1024 * 1024
let database
let library
let queue = Promise.resolve()

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-creator-workbench-projects', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('library')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readBrowser() {
  return new Promise((resolve, reject) => {
    const request = database.transaction('library').objectStore('library').get('current')
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

function writeBrowser(next, revision) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('library', 'readwrite')
    const store = transaction.objectStore('library')
    const request = store.get('current')
    let conflict = false
    request.onsuccess = () => {
      if ((request.result?.revision || 0) !== revision) {
        conflict = true
        transaction.abort()
        return
      }
      if (request.result) store.put(request.result, 'previous')
      store.put(next, 'current')
    }
    transaction.oncomplete = resolve
    transaction.onabort = () => reject(new Error(conflict ? '另一窗口已更新项目，请备份当前内容后刷新' : '保存失败，请检查可用存储空间'))
    transaction.onerror = () => reject(transaction.error)
  })
}

function commit(change) {
  const operation = queue.then(async () => {
    const next = structuredClone(library)
    const result = change(next)
    next.revision = library.revision + 1
    if (invoke) await invoke('library_write', { payload: JSON.stringify(next), expectedRevision: library.revision })
    else await writeBrowser(next, library.revision)
    library = next
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
  library = typeof stored === 'string' ? JSON.parse(stored) : stored
  if (library && (library.version !== 1 || !Array.isArray(library.projects) || !Number.isInteger(library.revision))) {
    throw new Error('项目库格式无法识别；原数据未被修改')
  }
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

export function listInspirations() {
  return structuredClone(library.inspirations || []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function saveInspiration(item) {
  const title = item.title.trim()
  const content = item.content.trim()
  if (!title || title.length > 100 || !content || content.length > 100000) return Promise.reject(new Error('请填写标题（最多 100 字）和正文（最多 10 万字）'))
  return commit(next => {
    next.inspirations ||= []
    const id = item.id || crypto.randomUUID()
    const index = next.inspirations.findIndex(value => value.id === id)
    if (item.id && index < 0) throw new Error('灵感不存在，请重新打开灵感库')
    const saved = { id, title, content, updatedAt: new Date().toISOString() }
    if (index < 0) next.inspirations.push(saved)
    else next.inspirations[index] = saved
    return saved
  })
}

export function saveProject(id, workspace, index) {
  const snapshot = structuredClone({ workspace, index })
  return commit(next => {
    next.settings = { connections: snapshot.workspace.connections, theme: snapshot.workspace.theme }
    if (!id) return
    const project = next.projects.find(item => item.id === id)
    if (!project) throw new Error('项目不存在，保存已中止')
    Object.assign(project, snapshot, { updatedAt: new Date().toISOString() })
  })
}

export function createProject(workspace, index) {
  const snapshot = structuredClone({ workspace, index })
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

export function projectBackup(workspace, index) {
  const copy = structuredClone(workspace)
  delete copy.connections
  return JSON.stringify({ format: 'ai-creator-workbench-project', version: 1, exportedAt: new Date().toISOString(), workspace: copy, index }, null, 2)
}

export function parseBackup(text) {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error('备份超过 64 MiB')
  const data = JSON.parse(text, (key, value) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('备份包含非法字段')
    return value
  })
  if (data?.format !== 'ai-creator-workbench-project' || data.version !== 1) throw new Error('请选择本应用导出的项目备份（版本 1）')
  const workspace = data.workspace
  if (!workspace?.project?.name || typeof workspace.project.name !== 'string' || workspace.project.name.length > 100) throw new Error('项目名称无效')
  if (!workspace.documents || Array.isArray(workspace.documents) || typeof workspace.documents !== 'object') throw new Error('文档格式无效')
  for (const [id, doc] of Object.entries(workspace.documents)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !doc || typeof doc.content !== 'string') throw new Error('文档内容无效')
    for (const field of ['title', 'sceneTitle', 'intent', 'breadcrumb', 'badge', 'kicker', 'mode']) {
      if (doc[field] !== undefined && typeof doc[field] !== 'string') throw new Error('文档属性格式无效')
    }
    for (const field of ['meta', 'labels']) {
      if (doc[field] !== undefined && (!Array.isArray(doc[field]) || doc[field].some(value => typeof value !== 'string'))) throw new Error('文档标签格式无效')
    }
  }
  if (workspace.tabContents !== undefined && (!workspace.tabContents || typeof workspace.tabContents !== 'object' || Array.isArray(workspace.tabContents))) throw new Error('文档视图格式无效')
  for (const tabs of Object.values(workspace.tabContents || {})) {
    if (!tabs || typeof tabs !== 'object' || Array.isArray(tabs) || Object.values(tabs).some(value => typeof value !== 'string')) throw new Error('文档视图内容无效')
  }
  if (workspace.structure?.acts && (!Array.isArray(workspace.structure.acts) || workspace.structure.acts.some(act => !act || typeof act !== 'object'))) throw new Error('项目结构无效')
  if (workspace.knowledge?.sources && (!Array.isArray(workspace.knowledge.sources) || workspace.knowledge.sources.some(source => !source || typeof source.id !== 'string' || typeof source.name !== 'string'))) throw new Error('知识来源格式无效')
  if (workspace.knowledge?.selectedChunkIds && (!Array.isArray(workspace.knowledge.selectedChunkIds) || workspace.knowledge.selectedChunkIds.some(id => typeof id !== 'string'))) throw new Error('知识引用格式无效')
  // 向量可重建；跨设备恢复时不信任备份中嵌入的模型配置和向量。
  if (workspace.knowledge) delete workspace.knowledge.semantic
  delete workspace.connections
  return { workspace, index: data.index || null }
}

export async function downloadDocument(name, content) {
  if (invoke) return invoke('export_document', { name, content })
  const url = URL.createObjectURL(new Blob([content], { type: name.endsWith('.json') ? 'application/json' : 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
  return '浏览器下载目录'
}
