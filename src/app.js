import {
  createKnowledgeIndex,
  deserializeKnowledgeIndex,
  searchKnowledgeIndex,
  serializeKnowledgeIndex
} from './knowledge-index.js'
import { initializeProjects, getActiveProject, listProjects, saveProject, createProject, activateProject, renameProject, projectBackup, parseBackup, downloadDocument, archiveProject, restoreProject, listArchivedProjects, libraryBackup, parseLibraryBackup, importLibraryBackup, readPreviousLibrary, restorePreviousLibrary, getStorageMetrics, rawLibrarySnapshot, MAX_BACKUP_BYTES } from './project-store.js'
import { buildSemanticIndex, semanticSearch, pruneSemanticIndex, semanticIndexCoverage } from './semantic-search.js'
import { initializeInspirations } from './inspirations.js'
import { initializeUpdates } from './update-ui.js'
import { consumeProviderStream, fetchProviderResponse, providerEndpointUrl, validateProviderBaseUrl } from './provider-stream.js'
import { prepareGeneration, projectMarkdown, planKnowledgeFiles } from './creation-workflow.js'

async function recoverStartup(error) {
  const shell = document.querySelector('#appShell')
  shell.hidden = true
  const panel = document.createElement('section')
  panel.className = 'startup-recovery'
  const heading = document.createElement('h1')
  heading.textContent = '暂时无法打开项目库'
  const detail = document.createElement('p')
  detail.textContent = `${error.message || error}。原数据已保留，可先导出原始数据，或恢复上一份内部快照。`
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const exportButton = document.createElement('button')
  exportButton.className = 'secondary-button'
  exportButton.textContent = '导出原始数据'
  exportButton.addEventListener('click', async () => {
    try { status.textContent = `已导出到：${await downloadDocument('项目库原始恢复数据.json', await rawLibrarySnapshot())}` }
    catch (failure) { status.textContent = failure.message || String(failure) }
  })
  const restoreButton = document.createElement('button')
  restoreButton.className = 'primary-button'
  restoreButton.textContent = '恢复上一份内部快照'
  const retry = document.createElement('button')
  retry.className = 'text-button'
  retry.textContent = '重新打开'
  retry.addEventListener('click', () => window.location.reload())
  panel.append(heading, detail, exportButton, restoreButton, retry, status)
  document.body.append(panel)
  return new Promise(resolve => {
    restoreButton.addEventListener('click', async () => {
      restoreButton.disabled = true
      try {
        const previous = await readPreviousLibrary()
        if (!previous.available) throw new Error('没有可恢复的内部快照，请先导出原始数据。')
        if (!window.confirm(`恢复 ${previous.activeProjects} 个活动项目、${previous.archivedProjects} 个归档项目和 ${previous.inspirations} 条灵感？当前存储会保留为恢复前快照。`)) return
        const snapshot = await restorePreviousLibrary()
        panel.remove()
        shell.hidden = false
        resolve(snapshot)
      } catch (failure) { status.textContent = failure.message || String(failure) }
      finally { restoreButton.disabled = false }
    })
  })
}

let projectBoot
try {
  projectBoot = await initializeProjects()
} catch (error) {
  projectBoot = await recoverStartup(error)
}
let activeProjectId = projectBoot.id
let projectTransition = false
const projectTransitionNodes = new Map()

function setProjectTransition(value) {
  projectTransition = value
  if (value) {
    for (const node of document.querySelectorAll('#appShell, dialog')) {
      projectTransitionNodes.set(node, { inert: node.inert, busy: node.getAttribute('aria-busy') })
      node.inert = true
      node.setAttribute('aria-busy', 'true')
    }
  } else {
    for (const [node, previous] of projectTransitionNodes) {
      node.inert = previous.inert
      if (previous.busy === null) node.removeAttribute('aria-busy')
      else node.setAttribute('aria-busy', previous.busy)
    }
    projectTransitionNodes.clear()
    // Cancelling recovery must not cancel the draft's pending auto-save forever.
    if (unsavedEdits && !state.storageFailed && activeProjectId) {
      window.clearTimeout(state.saveTimer)
      state.saveTimer = window.setTimeout(() => { persistWorkspace() }, 300)
    }
    const target = document.querySelector('dialog[open] button:not([disabled]), dialog[open] input:not([disabled])')
      || (state.currentView === 'workspace' ? elements.scriptEditor : null)
    target?.focus({ preventScroll: true })
  }
}

function blockProjectTransitionInput(event) {
  if (!projectTransition) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

const desktopInvoke = window.__TAURI__?.core?.invoke
const isDesktopRuntime = typeof desktopInvoke === 'function'

if (isDesktopRuntime) document.documentElement.dataset.desktopShell = 'tauri'

function invokeDesktop(command, args = {}) {
  if (!isDesktopRuntime) return Promise.reject(new Error('桌面运行时不可用'))
  return desktopInvoke(command, args)
}

function readableError(error, fallback = '操作失败') {
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return fallback
}

const WORKSPACE_SCHEMA_VERSION = 2
const WORKSPACE_STORAGE_KEY = 'ai-creator-workbench'
const CORE_DOCUMENT_IDS = ['idea', 'brief', 'world', 'characters', 'outline']
const KNOWLEDGE_INDEX_STORAGE_KEY = 'ai-creator-workbench:knowledge-index'
const MAX_KNOWLEDGE_CHUNKS = 2000
const MAX_SELECTED_KNOWLEDGE_CHUNKS = 6

const tabFallbacks = {
  outline: '',
  references: `已引用设定

暂无引用。连接知识库后，可将人物、世界观与历史素材作为只读上下文加入生成任务。

引用原则
取消勾选后，新的生成任务将不再使用该资料；已生成的版本会保留当时的引用快照。`,
  history: `暂无历史版本

点击“保存快照”保留手写内容；采纳 AI 候选也会自动建立快照。

历史版本不可直接覆盖。恢复旧内容时会创建一个新的版本。`
}

const defaultProject = {
  name: '',
  type: '短剧',
  stage: '短剧 · 新项目',
  template: 'blank'
}

const defaultConnections = [
  {
    id: 'ollama-local',
    kind: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: '',
    status: 'unknown',
    capabilities: ['完全本地'],
    isActive: true,
    error: null
  }
]

const sessionSecrets = new Map()

async function connectionSecret(connection) {
  if (sessionSecrets.has(connection.id)) return sessionSecrets.get(connection.id)
  if (isDesktopRuntime && connection.rememberSecret) {
    const secret = await invokeDesktop('credential_load', { id: connection.id, endpoint: connection.baseUrl })
    if (secret) sessionSecrets.set(connection.id, secret)
    return secret || ''
  }
  return ''
}
const connectionTestTasks = new Map()
let connectionTestSequence = 0
let connectionBatchTesting = false
let connectionDraftTestSequence = 0
let connectionDraftTestController = null

function createBlankStructure() {
  return {
    acts: [],
    episodes: {}
  }
}

function createGenericDocument(documentId, title = '未命名内容') {
  const isScene = documentId.startsWith('scene-')
  const isEpisode = documentId.startsWith('episode-')
  return {
    title,
    breadcrumb: isScene ? '分场' : isEpisode ? '分集' : '前期创作',
    badge: '待创作',
    kicker: isScene ? '场景待定 · 时间待定' : isEpisode ? 'Episode · draft' : 'Draft',
    sceneTitle: title,
    intent: isScene ? '明确这场戏结束时必须发生的变化。' : '明确本阶段的创作目标与交付内容。',
    meta: ['待完善'],
    mode: isScene ? '剧本模式' : isEpisode ? '分集模式' : '创作模式',
    labels: isScene ? ['剧本', '本场大纲', '设定引用', '历史版本'] : ['正文', '大纲', '设定引用', '历史版本'],
    content: ''
  }
}

function normalizeStructure(value, documents) {
  const fallback = createBlankStructure()
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.acts)) return fallback

  const episodes = {}
  const usedEpisodeIds = new Set()
  const acts = value.acts.map((act, actIndex) => {
    const rawEpisodeIds = Array.isArray(act?.episodeIds) ? act.episodeIds : []
    const episodeIds = rawEpisodeIds.filter((episodeId) => {
      if (typeof episodeId !== 'string' || usedEpisodeIds.has(episodeId) || !documents[episodeId]) return false
      usedEpisodeIds.add(episodeId)
      const rawScenes = value.episodes?.[episodeId]?.sceneIds
      const sceneIds = Array.isArray(rawScenes)
        ? rawScenes.filter((sceneId, index, all) => typeof sceneId === 'string' && documents[sceneId] && all.indexOf(sceneId) === index)
        : []
      episodes[episodeId] = { sceneIds }
      return true
    })
    return {
      id: typeof act?.id === 'string' ? act.id : `act-${actIndex + 1}`,
      title: typeof act?.title === 'string' && act.title.trim() ? act.title.trim() : `第 ${actIndex + 1} 幕`,
      collapsed: Boolean(act?.collapsed),
      episodeIds
    }
  }).filter((act) => act.episodeIds.length || value.acts.length === 1)

  return acts.length ? { acts, episodes } : fallback
}

function normalizeConnections(value) {
  const connections = (Array.isArray(value) ? value : []).map((connection) => {
    if (!connection || typeof connection !== 'object' || typeof connection.id !== 'string') return null
    if (!['openai-compatible', 'ollama', 'cli'].includes(connection.kind)) return null
    return {
      id: connection.id,
      kind: connection.kind,
      name: typeof connection.name === 'string' && connection.name.trim() ? connection.name.trim() : '未命名连接',
      baseUrl: typeof connection.baseUrl === 'string' ? connection.baseUrl : '',
      model: typeof connection.model === 'string' ? connection.model : '',
      driverId: connection.kind === 'cli' && typeof connection.driverId === 'string' ? connection.driverId : null,
      status: 'unknown',
      capabilities: Array.isArray(connection.capabilities) ? connection.capabilities.filter((item) => typeof item === 'string').slice(0, 6) : [],
      isActive: Boolean(connection.isActive),
      rememberSecret: Boolean(connection.rememberSecret),
      error: null
    }
  }).filter(Boolean)
  if (!connections.some((connection) => ['openai-compatible', 'ollama'].includes(connection.kind))) {
    connections.unshift(structuredClone(defaultConnections[0]))
  }
  if (!connections.some((connection) => connection.isActive)) connections[0].isActive = true
  let foundActive = false
  connections.forEach((connection) => {
    if (connection.isActive && !foundActive) foundActive = true
    else connection.isActive = false
  })
  return connections
}

function normalizeStoredProject(project) {
  if (!project || typeof project !== 'object' || typeof project.name !== 'string') return { ...defaultProject }
  return {
    name: project.name.trim() || defaultProject.name,
    type: typeof project.type === 'string' ? project.type : defaultProject.type,
    stage: typeof project.stage === 'string' ? project.stage : defaultProject.stage,
    template: 'blank'
  }
}

function mergeStoredDocument(baseDocument, storedDocument) {
  if (typeof storedDocument === 'string') return { ...baseDocument, content: storedDocument }
  if (!storedDocument || typeof storedDocument !== 'object' || Array.isArray(storedDocument)) return baseDocument
  const nextDocument = { ...baseDocument }
  const textFields = ['title', 'breadcrumb', 'badge', 'kicker', 'sceneTitle', 'intent', 'mode', 'content']
  textFields.forEach((field) => {
    if (typeof storedDocument[field] === 'string') nextDocument[field] = storedDocument[field]
  })
  if (Array.isArray(storedDocument.meta) && storedDocument.meta.every((item) => typeof item === 'string')) {
    nextDocument.meta = storedDocument.meta.slice(0, 8)
  }
  if (Array.isArray(storedDocument.labels) && storedDocument.labels.length >= 4 && storedDocument.labels.every((item) => typeof item === 'string')) {
    nextDocument.labels = storedDocument.labels.slice(0, 4)
  }
  return nextDocument
}

function normalizeStoredVersions(versions) {
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return {}
  const normalized = {}
  for (const [documentId, entries] of Object.entries(versions)) {
    if (typeof documentId !== 'string' || !documentId || !Array.isArray(entries)) continue
    normalized[documentId] = entries.filter((entry) => (
      entry && typeof entry === 'object' &&
      Number.isInteger(entry.number) && entry.number > 0 &&
      typeof entry.content === 'string' &&
      typeof entry.source === 'string' &&
      typeof entry.createdAt === 'string'
    )).map((entry) => ({
      number: entry.number,
      content: entry.content,
      source: entry.source,
      createdAt: entry.createdAt,
      tabName: ['script', 'outline', 'references'].includes(entry.tabName) ? entry.tabName : 'script',
      knowledgeChunks: Array.isArray(entry.knowledgeChunks)
        ? entry.knowledgeChunks.filter((chunk) => (
          chunk && typeof chunk === 'object' && typeof chunk.id === 'string' &&
          typeof chunk.name === 'string' && typeof chunk.path === 'string' && typeof chunk.content === 'string'
        )).slice(0, 6).map((chunk) => ({
          id: chunk.id,
          sourceId: typeof chunk.sourceId === 'string' ? chunk.sourceId : '',
          name: chunk.name,
          path: chunk.path,
          content: chunk.content
        }))
        : []
    }))
  }
  return normalized
}

const storedWorkspace = projectBoot.workspace
const initialProject = normalizeStoredProject(storedWorkspace.project)
const storedDocumentMap = storedWorkspace.documents && typeof storedWorkspace.documents === 'object' && !Array.isArray(storedWorkspace.documents)
  ? storedWorkspace.documents
  : {}
const starterDocuments = createStarterDocuments(initialProject.name, initialProject.type)
const initialDocuments = {}

for (const [documentId, storedDocument] of Object.entries(storedDocumentMap)) {
  const baseDocument = starterDocuments[documentId] || createGenericDocument(documentId)
  initialDocuments[documentId] = mergeStoredDocument(baseDocument, storedDocument)
}

const initialTabContents = Object.fromEntries(
  Object.keys(initialDocuments).map((documentId) => [
    documentId,
    structuredClone(tabFallbacks)
  ])
)

for (const [documentId, tabs] of Object.entries(storedWorkspace.tabContents || {})) {
  if (!initialTabContents[documentId] || !tabs || typeof tabs !== 'object') continue
  for (const tabName of ['outline', 'references']) {
    if (typeof tabs[tabName] === 'string') initialTabContents[documentId][tabName] = tabs[tabName]
  }
}

const initialVersionCounters = Object.fromEntries(
  Object.keys(initialDocuments).map((documentId) => [documentId, 0])
)

const initialVersions = normalizeStoredVersions(storedWorkspace.versions)
for (const documentId of Object.keys(initialVersions)) {
  if (!initialDocuments[documentId]) delete initialVersions[documentId]
}
let initialKnowledgeIndex
try {
  initialKnowledgeIndex = deserializeKnowledgeIndex(JSON.stringify(projectBoot.index))
} catch {
  initialKnowledgeIndex = deserializeKnowledgeIndex(null)
}

const storedSources = Array.isArray(storedWorkspace.knowledge?.sources)
  ? storedWorkspace.knowledge.sources.filter((source) => source && typeof source.id === 'string' && typeof source.name === 'string')
  : null

const state = {
  activeTab: ['script', 'outline', 'references', 'history'].includes(storedWorkspace.activeTab) ? storedWorkspace.activeTab : 'script',
  currentDocId: (() => {
    const requestedId = storedWorkspace.currentDocId
    if (requestedId && initialDocuments[requestedId]) return requestedId
    return Object.keys(initialDocuments)[0] || null
  })(),
  currentView: 'workspace',
  project: initialProject,
  documents: initialDocuments,
  structure: normalizeStructure(storedWorkspace.structure, initialDocuments),
  connections: normalizeConnections(storedWorkspace.connections),
  runtime: { platform: null, architecture: null, drivers: [], checkedAt: null, status: 'idle' },
  knowledge: {
    sources: storedSources || [],
    index: initialKnowledgeIndex,
    semantic: storedWorkspace.knowledge?.semantic || null,
    results: [],
    selectedChunkIds: Array.isArray(storedWorkspace.knowledge?.selectedChunkIds)
      ? storedWorkspace.knowledge.selectedChunkIds.filter((id) => typeof id === 'string').slice(0, MAX_SELECTED_KNOWLEDGE_CHUNKS)
      : [],
    pendingFiles: [],
    query: ''
  },
  generationTimer: null,
  generationAbortController: null,
  generationSequence: 0,
  activeGenerationId: null,
  generationText: '',
  generationContext: null,
  isGenerating: false,
  candidateApplying: false,
  knowledgeBusy: false,
  lastPrompt: '',
  lastAcceptedText: '',
  saveTimer: null,
  storageFailed: false,
  tabContents: initialTabContents,
  versions: initialVersions,
  versionCounters: { ...initialVersionCounters },
  selectedVersionByDocument: {},
  editHistories: new Map()
}

const availableKnowledgeChunkIds = new Set(state.knowledge.index.chunks.map((chunk) => chunk.id))
state.knowledge.selectedChunkIds = state.knowledge.selectedChunkIds.filter((id) => availableKnowledgeChunkIds.has(id))

for (const [documentId, version] of Object.entries(storedWorkspace.versionCounters || {})) {
  if (state.documents[documentId] && Number.isInteger(version) && version >= 0) {
    state.versionCounters[documentId] = version
  }
}

for (const documentId of Object.keys(state.documents)) {
  if (Array.isArray(state.versions[documentId]) && state.versions[documentId].length) {
    state.tabContents[documentId].history = formatVersionHistory(documentId)
  }
}

const elements = {
  appShell: document.querySelector('#appShell'),
  assistantPanel: document.querySelector('#assistantPanel'),
  assistantConversation: document.querySelector('#assistantConversation'),
  a11yAnnouncements: document.querySelector('#a11yAnnouncements'),
  candidateActions: document.querySelector('#candidateActions'),
  candidateCard: document.querySelector('#candidateCard'),
  candidateCitations: document.querySelector('#candidateCitations'),
  candidateContent: document.querySelector('#candidateContent'),
  generationError: document.querySelector('#generationError'),
  historyToolbar: document.querySelector('#historyToolbar'),
  historyVersionSelect: document.querySelector('#historyVersionSelect'),
  historyVersionMeta: document.querySelector('#historyVersionMeta'),
  characterCount: document.querySelector('#characterCount'),
  commandDialog: document.querySelector('#commandDialog'),
  commandInput: document.querySelector('#commandInput'),
  connectionDialog: document.querySelector('#connectionDialog'),
  connectionTestStatus: document.querySelector('#connectionTestStatus'),
  conversationThread: document.querySelector('#conversationThread'),
  documentDialog: document.querySelector('#documentDialog'),
  documentBadge: document.querySelector('#documentBadge'),
  documentBreadcrumb: document.querySelector('#documentBreadcrumb'),
  documentTitle: document.querySelector('#documentTitle'),
  editorSaveState: document.querySelector('#editorSaveState'),
  generationState: document.querySelector('#generationState'),
  globalSaveIndicator: document.querySelector('#globalSaveIndicator'),
  knowledgeDialog: document.querySelector('#knowledgeDialog'),
  knowledgeFilePicker: document.querySelector('#knowledgeFilePicker'),
  knowledgeQuery: document.querySelector('#knowledgeQuery'),
  knowledgeResults: document.querySelector('#knowledgeResults'),
  newContentDialog: document.querySelector('#newContentDialog'),
  newProjectDialog: document.querySelector('#newProjectDialog'),
  projectTree: document.querySelector('#projectTree'),
  promptInput: document.querySelector('#promptInput'),
  resourceExplorer: document.querySelector('#resourceExplorer'),
  sceneIntent: document.querySelector('#sceneIntent'),
  sceneKicker: document.querySelector('#sceneKicker'),
  sceneTitle: document.querySelector('#sceneTitle'),
  scriptEditor: document.querySelector('#scriptEditor'),
  sendButton: document.querySelector('#sendButton'),
  stageAdvanceButton: document.querySelector('#stageAdvanceButton'),
  toastStack: document.querySelector('#toastStack'),
  treeSearch: document.querySelector('#treeSearch'),
  userMessage: document.querySelector('#userMessage'),
  welcome: document.querySelector('#assistantWelcome')
}

let drawerReturnFocus = null

function rememberDrawerOpener() {
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
    drawerReturnFocus = document.activeElement
  }
}

function restoreDrawerFocus() {
  const returnTarget = drawerReturnFocus
  drawerReturnFocus = null
  if (returnTarget?.isConnected) window.setTimeout(() => returnTarget.focus(), 0)
}

function readStoredWorkspace() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function getCurrentDocument() {
  return state.documents[state.currentDocId]
}

function getContentAt(documentId, tabName) {
  if (tabName === 'script') return state.documents[documentId]?.content || ''
  return state.tabContents[documentId]?.[tabName] || ''
}

function setContentAt(documentId, tabName, content) {
  if (tabName === 'history') return
  if (tabName === 'script' && state.documents[documentId]) {
    state.documents[documentId].content = content
    return
  }
  if (state.tabContents[documentId] && typeof state.tabContents[documentId][tabName] === 'string') {
    state.tabContents[documentId][tabName] = content
  }
}

function getCurrentContent() {
  return getContentAt(state.currentDocId, state.activeTab)
}

function setCurrentContent(content) {
  setContentAt(state.currentDocId, state.activeTab, content)
}

function getEditHistory(documentId = state.currentDocId, tabName = state.activeTab) {
  const key = `${documentId}:${tabName}`
  if (!state.editHistories.has(key)) {
    state.editHistories.set(key, { undo: [], redo: [] })
  }
  return state.editHistories.get(key)
}

function workspaceSnapshot() {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    currentDocId: state.currentDocId,
    activeTab: state.activeTab,
    project: state.project,
    documents: state.documents,
    structure: state.structure,
    tabContents: state.tabContents,
    versions: state.versions,
    versionCounters: state.versionCounters,
    connections: state.connections.map(connection => ({ ...connection, status: 'unknown', error: null })),
    knowledge: { sources: state.knowledge.sources, selectedChunkIds: state.knowledge.selectedChunkIds, semantic: state.knowledge.semantic },
    theme: document.documentElement.dataset.theme
  }
}

let saveSequence = 0
let pendingSaves = 0
let unsavedEdits = false
let editRevision = 0
async function persistWorkspace() {
  const sequence = ++saveSequence
  const revision = editRevision
  pendingSaves += 1
  setSaveStatus('saving')
  try {
    await saveProject(activeProjectId, workspaceSnapshot(), state.knowledge.index)
    if (sequence === saveSequence && revision === editRevision) {
      state.storageFailed = false
      unsavedEdits = false
      setSaveStatus('saved')
    }
    return true
  } catch (error) {
    state.storageFailed = true
    setSaveStatus('error')
    showToast(readableError(error, '保存失败，请先导出备份'))
    return false
  } finally { pendingSaves -= 1 }
}

function getEpisodeIds() {
  return state.structure.acts.flatMap((act) => act.episodeIds)
}

function getParentEpisodeId(documentId) {
  if (state.structure.episodes[documentId]) return documentId
  return getEpisodeIds().find((episodeId) => state.structure.episodes[episodeId]?.sceneIds.includes(documentId)) || null
}

function getDocumentKind(documentId) {
  if (CORE_DOCUMENT_IDS.includes(documentId)) return 'core'
  if (state.structure.episodes[documentId]) return 'episode'
  return getParentEpisodeId(documentId) ? 'scene' : 'document'
}

function getDocumentPosition(documentId) {
  for (const [actIndex, act] of state.structure.acts.entries()) {
    const episodeIndex = act.episodeIds.indexOf(documentId)
    if (episodeIndex >= 0) return { kind: 'episode', actIndex, episodeIndex, list: act.episodeIds }
    for (const episodeId of act.episodeIds) {
      const scenes = state.structure.episodes[episodeId]?.sceneIds || []
      const sceneIndex = scenes.indexOf(documentId)
      if (sceneIndex >= 0) return { kind: 'scene', actIndex, episodeId, sceneIndex, list: scenes }
    }
  }
  return null
}

function makeUniqueId(prefix) {
  let counter = 0
  let id = `${prefix}-${Date.now().toString(36)}`
  while (state.documents[id]) {
    counter += 1
    id = `${prefix}-${Date.now().toString(36)}-${counter}`
  }
  return id
}

function renderTreeDocumentButton(documentId, kind, position) {
  const documentData = state.documents[documentId]
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.docId = documentId
  button.dataset.action = 'select-doc'
  button.setAttribute('role', 'treeitem')
  button.setAttribute('aria-selected', String(documentId === state.currentDocId))

  if (kind === 'episode') {
    button.className = `tree-item tree-item-episode${documentId === state.currentDocId ? ' is-selected' : ''}`
    const number = document.createElement('span')
    number.className = 'episode-number'
    number.textContent = String(position + 1).padStart(2, '0')
    const copy = document.createElement('span')
    copy.className = 'episode-copy'
    const title = document.createElement('strong')
    title.textContent = documentData.title
    const status = document.createElement('small')
    const sceneCount = state.structure.episodes[documentId]?.sceneIds.length || 0
    status.textContent = `${sceneCount} 场 · ${documentData.badge}`
    copy.append(title, status)
    button.append(number, copy)
    return button
  }

  button.className = `tree-item${documentId === state.currentDocId ? ' is-selected' : ''}`
  const iconByDocument = {
    idea: 'icon-lightbulb', brief: 'icon-file', world: 'icon-book', characters: 'icon-users', outline: 'icon-layers'
  }
  button.append(createIcon(iconByDocument[documentId] || 'icon-file'))
  const label = document.createElement('span')
  label.textContent = documentData.title
  button.append(label)
  if (state.versionCounters[documentId]) {
    const badge = document.createElement('span')
    badge.className = 'tree-badge tree-badge-muted'
    badge.textContent = String(state.versionCounters[documentId])
    button.append(badge)
  }
  return button
}

function renderProjectTree() {
  if (!elements.projectTree) return
  const fragment = document.createDocumentFragment()
  const coreSection = document.createElement('div')
  coreSection.className = 'tree-section'
  const coreHeading = document.createElement('div')
  coreHeading.className = 'tree-section-heading'
  const coreLabel = document.createElement('span')
  coreLabel.textContent = '前期创作'
  coreHeading.append(coreLabel)
  const coreList = document.createElement('div')
  coreList.className = 'tree-list'
  coreList.setAttribute('role', 'tree')
  coreList.setAttribute('aria-label', '前期创作内容')
  CORE_DOCUMENT_IDS.forEach((documentId) => {
    if (state.documents[documentId]) coreList.append(renderTreeDocumentButton(documentId, 'core', 0))
  })
  coreSection.append(coreHeading, coreList)
  fragment.append(coreSection)

  state.structure.acts.forEach((act, actIndex) => {
    const section = document.createElement('div')
    section.className = 'tree-section'
    const heading = document.createElement('div')
    heading.className = 'tree-act-heading'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'tree-section-toggle'
    toggle.dataset.action = 'toggle-tree-group'
    toggle.dataset.actId = act.id
    toggle.setAttribute('aria-expanded', String(!act.collapsed))
    const chevron = createIcon(act.collapsed ? 'icon-chevron-right' : 'icon-chevron-down')
    chevron.classList.add('icon-small', 'tree-chevron')
    const title = document.createElement('span')
    title.textContent = act.title
    const count = document.createElement('span')
    count.className = 'tree-count'
    count.textContent = `${act.episodeIds.length} 集`
    toggle.append(chevron, title, count)
    const addEpisode = document.createElement('button')
    addEpisode.type = 'button'
    addEpisode.className = 'mini-button tree-add-button'
    addEpisode.dataset.action = 'new-content'
    addEpisode.dataset.contentType = 'episode'
    addEpisode.dataset.actId = act.id
    addEpisode.setAttribute('aria-label', `在${act.title}中新增分集`)
    addEpisode.append(createIcon('icon-plus'))
    heading.append(toggle, addEpisode)

    const group = document.createElement('div')
    group.className = 'tree-group-content'
    group.hidden = act.collapsed
    act.episodeIds.forEach((episodeId, episodeIndex) => {
      group.append(renderTreeDocumentButton(episodeId, 'episode', episodeIndex))
      const scenes = state.structure.episodes[episodeId]?.sceneIds || []
      if (scenes.length) {
        const sceneList = document.createElement('div')
        sceneList.className = 'scene-list'
        sceneList.setAttribute('role', 'group')
        sceneList.setAttribute('aria-label', `${state.documents[episodeId].title}分场`)
        scenes.forEach((sceneId, sceneIndex) => {
          const scene = state.documents[sceneId]
          if (!scene) return
          const sceneButton = document.createElement('button')
          sceneButton.type = 'button'
          sceneButton.className = `scene-item${sceneId === state.currentDocId ? ' is-current' : ''}`
          sceneButton.dataset.docId = sceneId
          sceneButton.dataset.action = 'select-doc'
          const sceneNumber = document.createElement('span')
          sceneNumber.textContent = `${episodeIndex + 1}-${sceneIndex + 1}`
          sceneButton.append(sceneNumber, scene.sceneTitle || scene.title)
          sceneList.append(sceneButton)
        })
        group.append(sceneList)
      }
      const addScene = document.createElement('button')
      addScene.type = 'button'
      addScene.className = 'scene-add-button'
      addScene.dataset.action = 'new-content'
      addScene.dataset.contentType = 'scene'
      addScene.dataset.parentId = episodeId
      addScene.append(createIcon('icon-plus'), document.createTextNode('添加分场'))
      group.append(addScene)
    })
    section.append(heading, group)
    fragment.append(section)
  })

  elements.projectTree.replaceChildren(fragment)
}

function updateStageAdvanceButton() {
  if (!elements.stageAdvanceButton) return
  const kind = getDocumentKind(state.currentDocId)
  const labelByDocument = {
    idea: '进入创作简报', brief: '完善世界观', world: '塑造人物', characters: '形成全剧大纲', outline: '拆分为分集'
  }
  const label = labelByDocument[state.currentDocId]
    || (kind === 'episode' ? '拆分为分场' : kind === 'scene' ? '新增下一场' : '下一步')
  elements.stageAdvanceButton.querySelector('span').textContent = label
  elements.stageAdvanceButton.setAttribute('aria-label', label)
  elements.stageAdvanceButton.title = label
}

function renderProjectIdentity() {
  const hasProject = Boolean(state.project.name || Object.keys(state.documents).length)
  elements.appShell.classList.toggle('no-project', !hasProject)
  document.querySelector('#emptyWorkspace').hidden = hasProject
  document.querySelector('.project-switcher-copy strong').textContent = state.project.name || '新建项目'
  const sceneCount = Object.values(state.structure.episodes).reduce((sum, episode) => sum + episode.sceneIds.length, 0)
  const stage = sceneCount ? '分场创作' : getEpisodeIds().length ? '分集规划' : state.documents.outline?.content.trim() ? '大纲构建' : Object.values(state.documents).some(doc => doc.content.trim()) ? '前期创作' : '新项目'
  state.project.stage = `${state.project.type} · ${stage}`
  document.querySelector('.project-switcher-copy span').textContent = hasProject ? state.project.stage : '开始你的创作'
  document.querySelector('.explorer-project-title').textContent = state.project.name || '暂无项目'
  document.querySelector('.project-mark').textContent = state.project.name.slice(0, 1)
  document.querySelector('#projectBreadcrumb').textContent = state.project.name
  renderProjectTree()
  updateStageAdvanceButton()

  const episodeCommand = document.querySelector('#command-episode')
  const commandEpisodeId = getEpisodeIds().at(-1)
  if (episodeCommand) episodeCommand.hidden = !commandEpisodeId
  if (episodeCommand && commandEpisodeId && state.documents[commandEpisodeId]) {
    episodeCommand.dataset.commandDoc = commandEpisodeId
    episodeCommand.querySelector('strong').textContent = state.documents[commandEpisodeId].title
    episodeCommand.querySelector('small').textContent = state.structure.acts.find((act) => act.episodeIds.includes(commandEpisodeId))?.title || '分集'
  }

  const sceneIds = getEpisodeIds().flatMap((episodeId) => state.structure.episodes[episodeId]?.sceneIds || [])
  const completedScenes = sceneIds.filter((sceneId) => state.documents[sceneId]?.content.trim() && !state.documents[sceneId].content.startsWith('【待创作】')).length
  const target = sceneIds.length
  const progress = target ? Math.round((completedScenes / target) * 100) : 0
  document.querySelector('.progress-copy strong').textContent = `${completedScenes} / ${target} 场`
  document.querySelector('.progress-track span').style.width = `${Math.min(100, progress)}%`
  document.querySelector('.progress-track').setAttribute('aria-label', `已写分场进度 ${Math.min(100, progress)}%`)
}

function syncThemeControl() {
  const themeButton = document.querySelector('[data-action="toggle-theme"]')
  const nextLabel = document.documentElement.dataset.theme === 'dark' ? '切换浅色模式' : '切换深色模式'
  themeButton.setAttribute('aria-label', nextLabel)
  themeButton.setAttribute('title', nextLabel)
}

function formatVersionHistory(documentId) {
  const entries = Array.isArray(state.versions[documentId]) ? state.versions[documentId] : []
  if (!entries.length) {
    return tabFallbacks.history
  }
  const lines = entries.flatMap((entry, index) => [
    `版本 v${entry.number}${index === 0 ? ' · 最新快照' : ' · 内容快照'}`,
    `${entry.createdAt} · ${entry.source} · ${entry.tabName === 'outline' ? '大纲' : entry.tabName === 'references' ? '引用' : '正文'}${entry.knowledgeChunks?.length ? ` · ${entry.knowledgeChunks.length} 条知识引用` : ''}`,
    ''
  ])
  lines.push('从上方选择快照可查看完整内容；恢复时会另建新版本，不覆盖历史。')
  return lines.join('\n').trim()
}

function addVersion(documentId, content, source, { tabName = state.activeTab, knowledgeChunks = [] } = {}) {
  const nextVersion = Math.max(Number(state.versionCounters[documentId]) || 0, ...((state.versions[documentId] || []).map(entry => entry.number)), 0) + 1
  state.versionCounters[documentId] = nextVersion
  if (!Array.isArray(state.versions[documentId])) state.versions[documentId] = []
  state.versions[documentId].unshift({
    number: nextVersion,
    content,
    source,
    tabName: ['script', 'outline', 'references'].includes(tabName) ? tabName : 'script',
    knowledgeChunks: knowledgeChunks.slice(0, 6).map((chunk) => ({
      id: chunk.id,
      sourceId: chunk.sourceId,
      name: chunk.name,
      path: chunk.path,
      content: chunk.content
    })),
    createdAt: new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date())
  })
  state.versions[documentId] = state.versions[documentId].slice(0, 50)
  state.selectedVersionByDocument[documentId] = nextVersion
  state.tabContents[documentId].history = formatVersionHistory(documentId)
  return nextVersion
}

function getSelectedHistoryVersion(documentId = state.currentDocId) {
  const entries = state.versions[documentId] || []
  const selectedNumber = state.selectedVersionByDocument[documentId]
  return entries.find((entry) => entry.number === selectedNumber) || entries[0] || null
}

function renderHistoryControls() {
  const isHistory = state.activeTab === 'history'
  elements.historyToolbar.hidden = !isHistory
  if (!isHistory) return null
  const entries = state.versions[state.currentDocId] || []
  const selected = getSelectedHistoryVersion()
  elements.historyVersionSelect.replaceChildren()
  if (!entries.length) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = '尚无历史快照'
    elements.historyVersionSelect.append(option)
  } else {
    entries.forEach((entry) => {
      const option = document.createElement('option')
      option.value = String(entry.number)
      option.selected = entry.number === selected?.number
      const tabLabel = entry.tabName === 'outline' ? '大纲' : entry.tabName === 'references' ? '引用' : '正文'
      option.textContent = `v${entry.number} · ${entry.source} · ${tabLabel}`
      elements.historyVersionSelect.append(option)
    })
  }
  elements.historyVersionSelect.disabled = !entries.length
  elements.historyVersionMeta.textContent = selected
    ? `${selected.createdAt}${selected.knowledgeChunks?.length ? ` · ${selected.knowledgeChunks.length} 条知识引用快照` : ' · 未使用外部知识'}`
    : '点击“保存快照”可保留当前手写内容'
  document.querySelector('[data-action="restore-version"]').disabled = !selected
  return selected
}

async function restoreSelectedVersion() {
  const entry = getSelectedHistoryVersion()
  if (!entry) {
    showToast('当前文档还没有可恢复的快照')
    return
  }
  const documentId = state.currentDocId
  const targetTab = entry.tabName
  const previousText = getContentAt(documentId, targetTab)
  if (previousText === entry.content) {
    showToast(`v${entry.number} 与当前内容相同，无需恢复`)
    return
  }
  const history = getEditHistory(documentId, targetTab)
  const transaction = { before: previousText, after: entry.content }
  history.undo.push(transaction)
  history.redo.length = 0
  setContentAt(documentId, targetTab, entry.content)
  state.activeTab = targetTab
  const versionNumber = addVersion(documentId, entry.content, `从 v${entry.number} 恢复`, {
    tabName: targetTab,
    knowledgeChunks: entry.knowledgeChunks || []
  })
  const saved = await persistWorkspace()
  updateDocumentView({ keepFocus: true })
  showToast(saved ? `已将 v${entry.number} 恢复为新版本 v${versionNumber}` : '内容已恢复，但本地保存失败')
}

function createStarterDocuments(projectName, contentType) {
  const titles = {
    idea: '核心灵感', brief: '创作简报', world: '世界观设定',
    characters: '人物小传', outline: '全剧大纲'
  }
  return Object.fromEntries(CORE_DOCUMENT_IDS.map((documentId) => [
    documentId,
    { ...createGenericDocument(documentId, titles[documentId]), meta: [contentType], content: '' }
  ]))
}

function updateDocumentView({ keepFocus = false } = {}) {
  const documentData = getCurrentDocument()
  if (!documentData) return
  elements.documentTitle.textContent = documentData.title
  elements.documentBreadcrumb.textContent = documentData.breadcrumb
  elements.documentBadge.textContent = documentData.badge
  elements.sceneKicker.textContent = documentData.kicker
  elements.sceneTitle.textContent = documentData.sceneTitle
  elements.sceneIntent.querySelector('p').textContent = documentData.intent
  elements.sceneIntent.querySelector('.scene-meta').replaceChildren(
    ...documentData.meta.map((value) => {
      const item = document.createElement('span')
      item.textContent = value
      return item
    })
  )
  const isReadOnly = state.activeTab === 'history'
  const historyEntry = renderHistoryControls()
  elements.scriptEditor.value = isReadOnly && historyEntry ? historyEntry.content : getCurrentContent()
  elements.scriptEditor.readOnly = isReadOnly
  elements.scriptEditor.setAttribute('aria-readonly', String(isReadOnly))
  elements.scriptEditor.closest('.editor-paper').classList.toggle('is-readonly', isReadOnly)
  document.querySelector('.editor-label').textContent = isReadOnly && historyEntry ? `版本 v${historyEntry.number} 快照（只读）` : isReadOnly ? '历史版本（只读）' : '正文'
  document.querySelectorAll('[data-action="undo"], [data-action="redo"], [data-action="save-snapshot"]').forEach((button) => {
    button.disabled = isReadOnly
  })
  document.querySelector('#currentMode').textContent = documentData.mode

  document.querySelectorAll('.document-tab').forEach((tab, index) => {
    tab.textContent = documentData.labels[index]
    tab.classList.toggle('is-active', tab.dataset.tab === state.activeTab)
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.activeTab))
    tab.tabIndex = tab.dataset.tab === state.activeTab ? 0 : -1
  })
  const versionNumber = state.versionCounters[state.currentDocId] || 0
  document.querySelector('[data-action="show-history"] span').textContent = versionNumber ? `v${versionNumber}` : 'v—'

  document.querySelectorAll('[data-doc-id]').forEach((item) => {
    const isSelected = item.dataset.docId === state.currentDocId
    item.classList.toggle('is-selected', isSelected && item.classList.contains('tree-item'))
    item.classList.toggle('is-current', isSelected && item.classList.contains('scene-item'))
    if (item.getAttribute('role') === 'treeitem') item.setAttribute('aria-selected', String(isSelected))
  })

  updateEditorMetrics()
  updateAssistantProfile()
  updateStageAdvanceButton()
  setSaveStatus(state.storageFailed ? 'error' : pendingSaves ? 'saving' : unsavedEdits ? 'dirty' : 'saved')
  if (keepFocus) {
    if (isReadOnly) {
      window.requestAnimationFrame(() => {
        const editorScroll = document.querySelector('.editor-scroll')
        if (editorScroll) editorScroll.scrollTop = 0
        if (!elements.historyVersionSelect.disabled) elements.historyVersionSelect.focus()
        else document.querySelector('[data-tab="history"]')?.focus()
      })
    } else {
      elements.scriptEditor.focus()
    }
  }
}

function updateEditorMetrics() {
  const count = elements.scriptEditor.value.replace(/\s/g, '').length
  elements.characterCount.textContent = `${count.toLocaleString('zh-CN')} 字`
  elements.scriptEditor.style.height = 'auto'
  elements.scriptEditor.style.height = `${Math.max(438, elements.scriptEditor.scrollHeight)}px`
  renderContextPreview()
}

function setSaveStatus(status) {
  const copy = {
    dirty: ['编辑中', '编辑中'],
    saving: ['正在保存…', '保存中…'],
    saved: ['已保存', '已保存到本地'],
    error: ['保存失败', '本地保存失败']
  }[status]
  if (!copy) return
  elements.globalSaveIndicator.lastElementChild.textContent = copy[0]
  elements.editorSaveState.textContent = copy[1]
  const dots = [elements.globalSaveIndicator.querySelector('.status-dot'), elements.editorSaveState.previousElementSibling]
  dots.forEach((dot) => {
    dot.classList.toggle('status-dot-success', status === 'saved')
    dot.classList.toggle('status-dot-warning', status !== 'saved')
  })
}

function scheduleSave() {
  editRevision += 1
  unsavedEdits = true
  window.clearTimeout(state.saveTimer)
  setSaveStatus('dirty')
  state.saveTimer = window.setTimeout(() => { persistWorkspace() }, 300)
}

async function saveImmediately({ announce = true } = {}) {
  window.clearTimeout(state.saveTimer)
  if (state.activeTab !== 'history') setCurrentContent(elements.scriptEditor.value)
  const saved = await persistWorkspace()
  if (announce) showToast(saved ? '当前内容已保存到本地' : '本地保存失败，请复制内容后重试')
  return saved
}

async function selectDocument(documentId) {
  if (projectTransition) return
  if (state.candidateApplying) return showToast('正在保存候选，请稍候再切换内容')
  if (!state.documents[documentId]) return
  const projectId = activeProjectId
  if (!await saveImmediately({ announce: false })) return
  if (projectTransition || projectId !== activeProjectId) return
  abandonCandidateOnContextChange(documentId, 'script')
  state.currentDocId = documentId
  state.activeTab = 'script'
  switchView('workspace')
  updateDocumentView({ keepFocus: true })
  await persistWorkspace()
  closeDrawers()
}

async function switchTab(tabName, { focusEditor = true } = {}) {
  if (projectTransition) return
  if (state.candidateApplying) return showToast('正在保存候选，请稍候再切换视图')
  if (!Object.hasOwn(tabFallbacks, tabName) && tabName !== 'script') return
  const projectId = activeProjectId
  if (!await saveImmediately({ announce: false })) return
  if (projectTransition || projectId !== activeProjectId) return
  abandonCandidateOnContextChange(state.currentDocId, tabName)
  state.activeTab = tabName
  updateDocumentView({ keepFocus: focusEditor })
  if (!focusEditor) document.querySelector(`[data-tab="${tabName}"]`)?.focus()
}

function switchView(viewName) {
  const view = document.querySelector(`[data-view="${viewName}"]`)
  if (!view) return
  if (viewName === 'knowledge') renderKnowledge()
  if (viewName === 'connections') renderConnections()
  if (viewName === 'inspirations') inspirationUI.render()
  state.currentView = viewName
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.hidden = panel !== view
  })
  document.querySelectorAll('.rail-button[data-view-target]').forEach((button) => {
    const isActive = button.dataset.viewTarget === viewName
    button.classList.toggle('is-active', isActive)
    if (isActive) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
  elements.appShell.classList.toggle('secondary-view', viewName !== 'workspace')
  if (viewName !== 'workspace') closeDrawers()
  else syncAssistantAccessibility()
  document.querySelector('#workspaceMain').focus({ preventScroll: true })
  window.requestAnimationFrame(() => { view.scrollTop = 0 })
}

function toggleAssistant(forceOpen) {
  const usesDrawer = window.matchMedia('(max-width: 1099px)').matches
  if (usesDrawer) {
    const wasOpen = elements.appShell.classList.contains('assistant-open')
    const shouldOpen = typeof forceOpen === 'boolean'
      ? forceOpen
      : !wasOpen
    if (shouldOpen && !wasOpen) rememberDrawerOpener()
    elements.appShell.classList.toggle('assistant-open', shouldOpen)
    elements.appShell.classList.remove('assistant-collapsed')
    syncAssistantAccessibility()
    if (shouldOpen) window.setTimeout(() => elements.promptInput.focus(), 0)
    else if (wasOpen) restoreDrawerFocus()
  } else {
    const shouldCollapse = typeof forceOpen === 'boolean'
      ? !forceOpen
      : !elements.appShell.classList.contains('assistant-collapsed')
    elements.appShell.classList.toggle('assistant-collapsed', shouldCollapse)
  }
  syncAssistantAccessibility()
}

function syncAssistantAccessibility() {
  const usesDrawer = window.matchMedia('(max-width: 1099px)').matches
  const isOpen = !elements.appShell.classList.contains('no-project') && state.currentView === 'workspace' && (usesDrawer
    ? elements.appShell.classList.contains('assistant-open')
    : !elements.appShell.classList.contains('assistant-collapsed'))
  const topbarToggle = document.querySelector('.titlebar [data-action="toggle-assistant"]')
  topbarToggle.setAttribute('aria-expanded', String(isOpen))
  topbarToggle.setAttribute('aria-label', isOpen ? '收起 AI 助手' : '打开 AI 助手')
  topbarToggle.setAttribute('title', isOpen ? '收起 AI 助手' : '打开 AI 助手')
  elements.assistantPanel.inert = !isOpen
  elements.assistantPanel.setAttribute('aria-hidden', String(!isOpen))
  const explorerUsesDrawer = window.matchMedia('(max-width: 899px)').matches
  const explorerOpen = state.currentView === 'workspace' && explorerUsesDrawer && elements.appShell.classList.contains('explorer-open')
  const explorerToggle = document.querySelector('[data-action="toggle-explorer"]')
  explorerToggle?.setAttribute('aria-expanded', String(explorerOpen))
  explorerToggle?.setAttribute('aria-label', explorerOpen ? '关闭内容导航' : '打开内容导航')
  explorerToggle?.setAttribute('title', explorerOpen ? '关闭内容导航' : '打开内容导航')
  elements.resourceExplorer.inert = explorerUsesDrawer ? !explorerOpen : false
  elements.resourceExplorer.setAttribute('aria-hidden', String(explorerUsesDrawer && !explorerOpen))

  const modalDrawerOpen = (usesDrawer && isOpen) || explorerOpen
  const backgroundTargets = ['.titlebar', '.activity-rail', '.main-surface', '.statusbar']
  backgroundTargets.forEach((selector) => {
    const target = document.querySelector(selector)
    if (target) target.inert = modalDrawerOpen
  })
  if (usesDrawer && isOpen) elements.resourceExplorer.inert = true
  if (explorerOpen) elements.assistantPanel.inert = true
}

function closeDrawers() {
  const hadOpenDrawer = elements.appShell.classList.contains('assistant-open') || elements.appShell.classList.contains('explorer-open')
  elements.appShell.classList.remove('assistant-open', 'explorer-open')
  syncAssistantAccessibility()
  if (hadOpenDrawer) restoreDrawerFocus()
}

function toggleExplorer(forceOpen) {
  const usesDrawer = window.matchMedia('(max-width: 899px)').matches
  const wasOpen = elements.appShell.classList.contains('explorer-open')
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !wasOpen
  if (usesDrawer && shouldOpen && !wasOpen) rememberDrawerOpener()
  elements.appShell.classList.toggle('explorer-open', shouldOpen)
  syncAssistantAccessibility()
  if (usesDrawer && shouldOpen) window.setTimeout(() => elements.treeSearch.focus(), 0)
  if (usesDrawer && wasOpen && !shouldOpen) restoreDrawerFocus()
}

function focusAssistant() {
  if (state.currentView !== 'workspace') switchView('workspace')
  toggleAssistant(true)
  window.setTimeout(() => elements.promptInput.focus(), 180)
}

const assistantProfiles = {
  idea: {
    eyebrow: '针对核心灵感',
    title: '先找到值得写的故事',
    description: 'AI 会从冲突、人物和可持续性三个角度扩展灵感，只把结果放进候选区。',
    placeholder: '描述一个画面、人物困境，或你想探索的情绪…',
    context: ['创作简报', '灵感素材'],
    progress: '正在发散故事方向',
    disclaimer: '灵感由你定夺。AI 候选不会自动写入创作简报。',
    actions: [
      ['扩展方向', '从一个火花生成不同故事可能', '围绕当前灵感扩展三个差异明显的故事方向。'],
      ['寻找冲突', '补足主角欲望与阻力', '找出这条灵感里最有持续性的核心冲突。'],
      ['反套路', '避开题材里的常见走向', '指出当前设定最容易俗套的地方，并给出反套路方案。'],
      ['生成一句话', '压缩成清晰的故事承诺', '把当前灵感提炼成三版一句话故事。']
    ]
  },
  brief: {
    eyebrow: '针对创作简报',
    title: '把模糊方向变成创作约束',
    description: 'AI 会协助澄清受众、内容承诺和边界，后续生成都能引用这些约束。',
    placeholder: '例如：把目标受众再聚焦，并补充节奏原则…',
    context: ['核心灵感', '受众洞察'],
    progress: '正在整理创作约束',
    disclaimer: '简报会影响后续生成，请在采纳前确认定位与表达边界。',
    actions: [
      ['聚焦受众', '明确谁最容易被故事打动', '根据当前方向细化核心受众与观看场景。'],
      ['定义承诺', '写清观众每集能获得什么', '提炼这部作品稳定交付给观众的内容承诺。'],
      ['补充边界', '明确不采用的表达方式', '为当前项目补充题材和表达边界。'],
      ['检查矛盾', '发现定位内部的冲突', '检查创作简报中的受众、节奏与类型是否互相矛盾。']
    ]
  },
  world: {
    eyebrow: '针对世界观',
    title: '让规则既可信又能制造剧情',
    description: 'AI 会检查规则、代价和例外是否互相成立，不会擅自改动正式设定。',
    placeholder: '例如：给当前世界规则增加一个可拍摄的视觉表现…',
    context: ['正式设定', '冲突检查'],
    progress: '正在检查规则一致性',
    disclaimer: '世界观候选需要人工确认，采纳后才会成为项目规则。',
    actions: [
      ['补充代价', '让能力不再万能', '为当前世界规则补充一个清晰且可戏剧化的代价。'],
      ['寻找漏洞', '检查规则可能被绕过之处', '找出已有规则中的漏洞并给出最小修补方案。'],
      ['设计例外', '用一次例外推动主线升级', '设计一条只出现一次、但不破坏底层逻辑的规则例外。'],
      ['转成镜头', '把抽象规则变成可见事件', '将当前规则改写成可以通过动作和画面表达的版本。']
    ]
  },
  characters: {
    eyebrow: '针对人物',
    title: '让每个选择都来自人物',
    description: 'AI 会从欲望、恐惧、秘密和关系变化出发补强角色，而不是堆叠人物标签。',
    placeholder: '例如：强化角色目标与实际行为之间的矛盾…',
    context: ['人物小传', '关系设定'],
    progress: '正在推演人物动机',
    disclaimer: '人物建议可能改变后续行为逻辑，请检查是否符合既有弧光。',
    actions: [
      ['强化矛盾', '让欲望与行为互相拉扯', '找出人物目前最有戏剧性的自我矛盾并具体化。'],
      ['设计秘密', '增加可逐步揭示的信息', '设计一个会改变观众理解、但符合现有设定的人物秘密。'],
      ['推演弧光', '从起点走到关键改变', '将人物弧光拆成三个可在剧情中观察到的阶段。'],
      ['关系压力', '用另一个人逼出真实选择', '设计一段能持续考验主角核心信念的人物关系。']
    ]
  },
  outline: {
    eyebrow: '针对故事结构',
    title: '把灵感推进成完整故事',
    description: 'AI 会围绕阶段目标、关键转折与集尾钩子整理结构，保留你的核心命题。',
    placeholder: '例如：检查第 4—8 集升级是否太慢，并给出调整…',
    context: ['核心命题', '人物弧光'],
    progress: '正在推演结构节拍',
    disclaimer: '结构建议会影响多集内容，采纳前请检查人物弧光与主线节奏。',
    actions: [
      ['拆分阶段', '把故事划成清晰升级', '将当前故事拆成三个目标和压力都递增的阶段。'],
      ['补足转折', '让中段发生不可逆变化', '为故事中段设计一个不可逆的关键转折。'],
      ['生成分集', '把主线拆成单集目标', '根据当前大纲生成 12 集分集目标与结尾钩子。'],
      ['检查节奏', '找出重复或停滞段落', '检查当前大纲是否有重复推进或主线停滞。']
    ]
  },
  references: {
    eyebrow: '针对设定引用',
    title: '检查证据与既有事实',
    description: 'AI 会对照已选知识查找冲突和缺口，检查结果仍以候选形式呈现。',
    placeholder: '例如：检查当前内容有没有违反世界观规则…',
    context: ['当前正文', '知识引用'],
    progress: '正在比对引用与正文',
    disclaimer: '知识库可能包含旧信息，正式采纳前请回看来源。',
    actions: [
      ['检查冲突', '核对正文与正式设定', '检查当前内容是否与已引用设定冲突。'],
      ['补齐证据', '找出缺少依据的剧情信息', '指出当前内容中缺少设定依据的关键情节。'],
      ['压缩上下文', '只保留本次最相关资料', '为下一次生成筛选最相关的知识上下文。'],
      ['列出影响', '说明修改会波及哪些内容', '列出当前修改可能影响的人物、设定和后续分集。']
    ]
  },
  script: {
    eyebrow: '针对当前场景',
    title: '接下来想怎么写？',
    description: 'AI 会参考当前剧本和已选知识，只生成候选稿，不会直接改动正文。',
    placeholder: '描述你想怎么改，或输入下一步情节…',
    context: ['本集大纲', '人物设定'],
    progress: '正在梳理场景节奏',
    disclaimer: 'AI 可能出错。追加前请检查人物和剧情连续性。',
    actions: [
      ['强化悬念', '增加危险感与结尾钩子', '强化当前场景的悬念，增加危险感并设计一个更强的结尾钩子。'],
      ['续写场景', '延续当前语气和节奏', '续写当前场景，保持现有语气和节奏，不提前揭示关键真相。'],
      ['检查连续性', '核对人物与既有设定', '检查当前场景是否与人物设定、世界观和前文冲突。'],
      ['打磨对白', '减少说明，保留潜台词', '将人物对白改得更自然，减少解释性台词。']
    ]
  }
}

function getAssistantProfileKey() {
  if (state.activeTab === 'outline') return 'outline'
  if (state.activeTab === 'references') return 'references'
  if (['idea', 'brief', 'world', 'characters', 'outline'].includes(state.currentDocId)) return state.currentDocId
  return 'script'
}

function setContextChipLabel(button, label) {
  const textNode = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
  if (textNode) textNode.textContent = label
}

function updateAssistantProfile() {
  const profile = assistantProfiles[getAssistantProfileKey()]
  document.querySelector('#assistantEyebrow').textContent = profile.eyebrow
  document.querySelector('#assistantPromptTitle').textContent = profile.title
  document.querySelector('#assistantPromptDescription').textContent = profile.description
  document.querySelector('#assistantDisclaimer').textContent = profile.disclaimer
  elements.promptInput.placeholder = profile.placeholder
  document.querySelectorAll('.context-chip').forEach((chip, index) => {
    setContextChipLabel(chip, ['上游设定', '人物小传', `知识 ${state.knowledge.selectedChunkIds.length}`][index])
  })
  document.querySelectorAll('.quick-action').forEach((button, index) => {
    const action = profile.actions[index]
    button.querySelector('span').textContent = action[0]
    button.querySelector('small').textContent = action[1]
    button.dataset.prompt = action[2]
  })
  renderContextPreview()
}

function getSelectedKnowledgeChunks() {
  const knowledgeChip = document.querySelectorAll('.context-chip')[2]
  if (knowledgeChip?.getAttribute('aria-pressed') !== 'true') return []
  const selectedIds = new Set(state.knowledge.selectedChunkIds)
  return state.knowledge.index.chunks.filter((chunk) => selectedIds.has(chunk.id)).slice(0, 6)
}

function updateCandidateCitations(chunks) {
  const count = chunks.length
  elements.candidateCitations.hidden = count === 0
  const label = elements.candidateCitations.querySelector('span')
  if (label) label.textContent = count ? `参考 ${count} 条知识` : '未使用外部知识'
}


function generationDraft(prompt) {
  return prepareGeneration({
    project: state.project, documentId: state.currentDocId, tabName: state.activeTab,
    documents: state.documents, tabContents: state.tabContents, structure: state.structure, prompt,
    includeUpstream: document.querySelectorAll('.context-chip')[0]?.getAttribute('aria-pressed') === 'true',
    includeCharacters: document.querySelectorAll('.context-chip')[1]?.getAttribute('aria-pressed') === 'true',
    knowledgeChunks: getSelectedKnowledgeChunks()
  })
}

function renderContextPreview(draft = null) {
  const list = document.querySelector('#contextPreviewList')
  if (!list) return
  list.replaceChildren()
  if (!getCurrentDocument()) return
  try {
    const preview = draft || generationDraft(elements.promptInput.value.trim())
    document.querySelector('#contextPreviewSummary').textContent = `发送范围 · ${preview.characters.toLocaleString('zh-CN')} 字符${preview.truncated ? ' · 部分已截断' : ''}`
    for (const item of preview.summary) {
      const line = document.createElement('li')
      line.textContent = `${item.label} · ${item.characters} 字符${item.truncated ? `（原 ${item.originalCharacters}，已截断）` : ''}`
      list.append(line)
    }
    if (!preview.summary.length) list.textContent = '当前正文为空，将只发送项目名称和创作要求。'
  } catch (error) { list.textContent = readableError(error) }
}

function buildGenerationMessages() {
  return state.generationContext.messages
}

function appendGenerationDelta(delta, generationId = state.activeGenerationId) {
  if (!delta || !state.isGenerating || generationId !== state.activeGenerationId) return
  state.generationText += delta
  elements.candidateContent.textContent = state.generationText
  elements.assistantConversation.scrollTop = elements.assistantConversation.scrollHeight
}


let cliSessionConsent = null

function confirmCliGeneration(connection, boundary, signal) {
  const consentKey = JSON.stringify([connection.id, connection.driverId, boundary])
  if (signal.aborted) return Promise.resolve(false)
  if (cliSessionConsent === consentKey) return Promise.resolve(true)
  const dialog = document.querySelector('#cliConsentDialog')
  const remember = document.querySelector('#cliConsentRemember')
  remember.checked = false
  document.querySelector('#cliConsentSummary').textContent = `本次将使用 ${connection.name} 的账号，发送提示词及选中的项目与知识上下文，可能消耗账号额度。`
  document.querySelector('#cliConsentBoundary').textContent = boundary
  dialog.returnValue = ''
  return new Promise((resolve) => {
    const onAbort = () => dialog.close('cancel')
    const onClose = () => {
      signal.removeEventListener('abort', onAbort)
      const confirmed = !signal.aborted && dialog.returnValue === 'confirm'
      if (confirmed && remember.checked) cliSessionConsent = consentKey
      resolve(confirmed)
    }
    if (signal.aborted) { resolve(false); return }
    dialog.addEventListener('close', onClose, { once: true })
    signal.addEventListener('abort', onAbort, { once: true })
    dialogReturnFocus = document.activeElement
    dialog.showModal()
  })
}

async function generateWithConnection(connection, prompt, generationId, submittedDraft = null) {
  let unlisten = null
  const controller = new AbortController()
  state.generationAbortController = controller
  try {
    if (connection.kind !== 'cli') validateProviderBaseUrl(connection.kind, connection.baseUrl)
    const allowUserProfile = connection.kind === 'cli' && ['antigravity', 'codex', 'claude'].includes(connection.driverId)
    const cliBoundary = connection.driverId === 'antigravity'
      ? 'agy 会读取自身用户配置（包括权限、插件和 hooks），并可能保存会话；它不是无工具模式。使用 plan 模式和终端 sandbox。'
      : connection.driverId === 'codex'
        ? 'Codex 使用已有登录态、只读执行模式和临时工作目录，不读取用户 config.toml 或 execpolicy rules，不保留本次会话。只读不等于禁止读取本机信息；不复用自定义模型供应商配置。'
        : 'Claude 优先使用已配置 API Key；否则尝试已有 CLI 登录态。禁用内置工具、外部 MCP、技能和普通 hooks；不保留会话。组织托管策略仍可能生效，CLI 可能读取自身用户上下文。'
    if (allowUserProfile && !await confirmCliGeneration(connection, cliBoundary, controller.signal)) {
      if (generationId === state.activeGenerationId && state.isGenerating) {
        finishGeneration({ stopped: true, silent: true, generationId })
        showToast('已取消本次生成，未调用 CLI')
      }
      return
    }
    if (controller.signal.aborted || generationId !== state.activeGenerationId) return
    if (submittedDraft !== null && elements.promptInput.value === submittedDraft) {
      elements.promptInput.value = ''
      elements.promptInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const messages = buildGenerationMessages(prompt)
    let response
    if (isDesktopRuntime) {
      const secret = ['openai-compatible', 'cli'].includes(connection.kind) ? await connectionSecret(connection) : null
      if (connection.kind === 'openai-compatible' && !secret) {
        throw new Error('API Key 只保留在当前会话，请先到连接中心重新输入并测试')
      }
      if (window.__TAURI__.event?.listen) {
        unlisten = await window.__TAURI__.event.listen('generation-delta', ({ payload }) => {
          if (payload?.taskId === String(generationId)) appendGenerationDelta(payload.delta, generationId)
        })
      }
      if (controller.signal.aborted || generationId !== state.activeGenerationId) return
      const payload = await invokeDesktop('generate_text', {
        request: {
          taskId: String(generationId),
          kind: connection.kind,
          baseUrl: connection.baseUrl || '',
          model: connection.model || '',
          apiKey: secret || null,
          driverId: connection.kind === 'cli' ? connection.driverId : null,
          allowUserProfile,
          messages
        }
      })
      if (generationId === state.activeGenerationId && state.isGenerating && typeof payload?.output === 'string') {
        state.generationText = payload.output
        elements.candidateContent.textContent = payload.output
      }
    } else if (connection.kind === 'cli') {
      response = await fetch('/api/runtime/cli/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driverId: connection.driverId, messages, allowUserProfile }),
        signal: controller.signal
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `CLI 运行桥返回 HTTP ${response.status}`)
      appendGenerationDelta(typeof payload.output === 'string' ? payload.output : '', generationId)
    } else if (connection.kind === 'openai-compatible') {
      const secret = sessionSecrets.get(connection.id)
      if (!secret) throw new Error('API Key 只保留在当前会话，请先到连接中心重新输入并测试')
      response = await fetchProviderResponse(providerEndpointUrl(connection.kind, connection.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: connection.model, messages, stream: true, temperature: 0.7 }),
        signal: controller.signal
      })
      if (!response.ok) {
        const [, message] = classifyProviderError(null, response)
        throw new Error(message)
      }
      await consumeProviderStream(response, { kind: 'openai-compatible', onDelta: delta => appendGenerationDelta(delta, generationId), signal: controller.signal })
    } else {
      if (!connection.model) throw new Error('Ollama 尚未选择模型，请先检测本地服务')
      response = await fetchProviderResponse(providerEndpointUrl(connection.kind, connection.baseUrl, 'api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: connection.model, messages, stream: true }),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`Ollama 返回 HTTP ${response.status}`)
      await consumeProviderStream(response, { kind: 'ollama', onDelta: delta => appendGenerationDelta(delta, generationId), signal: controller.signal })
    }
    if (generationId !== state.activeGenerationId || !state.isGenerating || controller.signal.aborted) return
    if (!state.generationText.trim()) throw new Error('执行端返回了空内容')
    connection.status = 'ready'
    connection.error = null
    finishGeneration({ generationId })
    renderConnections()
  } catch (error) {
    if (generationId !== state.activeGenerationId || error?.name === 'AbortError' || !state.isGenerating) return
    const message = readableError(error, '生成失败')
    connection.status = /login|登录|授权|密钥/i.test(message) ? 'auth_failed' : 'error'
    connection.error = message
    renderConnections()
    await persistWorkspace()
    failGeneration(connection.error, generationId)
  } finally {
    unlisten?.()
    if (generationId === state.activeGenerationId) state.generationAbortController = null
  }
}

function failGeneration(message, generationId = state.activeGenerationId) {
  if (generationId !== state.activeGenerationId) return
  window.clearInterval(state.generationTimer)
  state.generationTimer = null
  state.isGenerating = false
  elements.sendButton.classList.remove('is-generating')
  elements.sendButton.setAttribute('aria-label', '执行 AI 请求')
  elements.sendButton.setAttribute('title', '执行 AI 请求')
  elements.generationState.hidden = true
  elements.candidateCard.classList.add('has-error')
  const hasPartial = Boolean(state.generationText.trim())
  if (!hasPartial) elements.candidateContent.textContent = '未生成可用的候选内容。'
  elements.generationError.hidden = false
  elements.generationError.textContent = `${message}。原消息已保留在对话区，可点击“重新生成”重试${hasPartial ? '，上方部分结果仍可审阅或采纳' : ''}。`
  elements.candidateActions.hidden = false
  elements.candidateActions.querySelectorAll('[data-action="apply-candidate"]').forEach((button) => { button.disabled = !hasPartial })
  updateCandidateCitations(state.generationContext?.knowledgeChunks || [])
  elements.a11yAnnouncements.textContent = `AI 生成失败：${message}`
  showToast(message)
}

function startGeneration(prompt, { clearComposer = true } = {}) {
  if (state.candidateApplying) return showToast('候选正在保存，请稍候')
  if (!getCurrentDocument()) return openDialog(elements.newProjectDialog)
  if (state.isGenerating) {
    stopGeneration()
    return
  }
  const cleanPrompt = prompt.trim()
  if (!cleanPrompt) {
    elements.promptInput.focus()
    showToast('先告诉 AI 你想怎么处理当前内容')
    return
  }
  if (state.activeTab === 'history') {
    showToast('历史版本为只读，请先切换到剧本或大纲')
    return
  }
  const connection = getActiveConnection()
  if (!connection) {
    showToast('请先在连接中心配置一个执行端')
    return
  }
  let prepared
  try { prepared = generationDraft(cleanPrompt) }
  catch (error) { showToast(readableError(error)); return }
  renderContextPreview(prepared)
  state.lastPrompt = cleanPrompt
  const sequence = ++state.generationSequence
  const generationId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${sequence}`
  state.activeGenerationId = generationId
  state.isGenerating = true
  state.generationContext = {
    documentId: state.currentDocId,
    tabName: state.activeTab,
    title: getCurrentDocument().title,
    baseContent: getCurrentContent(),
    selectionStart: elements.scriptEditor.selectionStart,
    selectionEnd: elements.scriptEditor.selectionEnd,
    knowledgeChunks: prepared.knowledgeChunks,
    messages: prepared.messages
  }
  const profileKey = getAssistantProfileKey()
  const profile = assistantProfiles[profileKey]
  state.generationText = ''
  elements.welcome.hidden = true
  elements.conversationThread.hidden = false
  elements.userMessage.textContent = cleanPrompt
  elements.candidateContent.textContent = ''
  elements.generationError.hidden = true
  elements.generationError.textContent = ''
  elements.candidateCard.classList.remove('has-error')
  elements.candidateActions.querySelectorAll('[data-action="apply-candidate"]').forEach((button) => { button.disabled = false })
  elements.generationState.hidden = false
  elements.generationState.lastElementChild.textContent = profile.progress
  elements.candidateActions.hidden = true
  elements.candidateCitations.hidden = true
  updateCandidateCitations([])
  elements.sendButton.classList.add('is-generating')
  elements.sendButton.setAttribute('aria-label', '停止 AI 生成')
  elements.sendButton.setAttribute('title', '停止 AI 生成')

  generateWithConnection(connection, cleanPrompt, generationId, clearComposer && elements.promptInput.value.trim() === cleanPrompt ? elements.promptInput.value : null)
}

function finishGeneration({ stopped = false, silent = false, generationId = state.activeGenerationId } = {}) {
  if (generationId !== state.activeGenerationId) return
  window.clearInterval(state.generationTimer)
  state.generationTimer = null
  state.isGenerating = false
  elements.sendButton.classList.remove('is-generating')
  elements.sendButton.setAttribute('aria-label', '执行 AI 请求')
  elements.sendButton.setAttribute('title', '执行 AI 请求')
  elements.generationState.hidden = true
  elements.candidateActions.hidden = false
  elements.generationError.hidden = true
  const hasCandidate = Boolean(elements.candidateContent.textContent.trim())
  elements.candidateActions.querySelectorAll('[data-action="apply-candidate"]').forEach((button) => {
    button.disabled = !hasCandidate
  })
  updateCandidateCitations(state.generationContext?.knowledgeChunks || [])
  const announcement = stopped
    ? hasCandidate ? 'AI 生成已停止，已保留当前候选内容' : 'AI 生成已停止，尚未生成候选内容'
    : 'AI 候选内容已生成，尚未写入正文'
  elements.a11yAnnouncements.textContent = announcement
  if (stopped && !silent) showToast(hasCandidate ? '已停止生成，部分内容仍可采纳' : '已停止生成，未收到候选内容')
}

function stopGeneration() {
  if (!state.isGenerating) return
  const generationId = state.activeGenerationId
  state.generationAbortController?.abort()
  if (isDesktopRuntime && generationId !== null) {
    invokeDesktop('cancel_generation', { taskId: String(generationId) }).catch(() => {})
  }
  finishGeneration({ stopped: true, generationId })
}

function discardCandidate({ silent = false } = {}) {
  const generationId = state.activeGenerationId
  state.generationAbortController?.abort()
  if (isDesktopRuntime && state.isGenerating && generationId !== null) {
    invokeDesktop('cancel_generation', { taskId: String(generationId) }).catch(() => {})
  }
  if (state.isGenerating) finishGeneration({ stopped: true, silent: true, generationId })
  state.activeGenerationId = null
  state.generationAbortController = null
  elements.conversationThread.hidden = true
  elements.welcome.hidden = false
  elements.candidateContent.textContent = ''
  elements.generationError.hidden = true
  elements.generationError.textContent = ''
  elements.candidateCard.classList.remove('has-error')
  elements.candidateActions.querySelectorAll('[data-action="apply-candidate"]').forEach((button) => { button.disabled = false })
  state.generationContext = null
  elements.a11yAnnouncements.textContent = '候选内容已丢弃'
  if (!silent) showToast('候选内容已丢弃，正文没有变化')
}

function abandonCandidateOnContextChange(documentId, tabName) {
  const context = state.generationContext
  if (!context || (context.documentId === documentId && context.tabName === tabName)) return
  discardCandidate({ silent: true })
  showToast('已取消上一文档的 AI 候选，正文没有变化')
}

function acceptCandidate() {
  applyCandidate('append')
}

async function applyCandidate(mode = 'append') {
  if (state.candidateApplying || state.isGenerating) return
  const candidate = elements.candidateContent.textContent.trim()
  const context = state.generationContext
  if (!candidate || !context) return
  if (context.documentId !== state.currentDocId || context.tabName !== state.activeTab) return showToast('候选属于另一文档，未写入正文')
  const previousText = getContentAt(context.documentId, context.tabName)
  if (mode === 'replace' && previousText !== context.baseContent) return showToast('生成后正文已有修改，请选择插入或追加以保留修改')
  const projectId = activeProjectId
  const startingRevision = editRevision
  const start = elements.scriptEditor.selectionStart ?? previousText.length
  const end = elements.scriptEditor.selectionEnd ?? start
  const acceptedText = mode === 'replace' ? candidate : mode === 'insert'
    ? `${previousText.slice(0, start)}${candidate}${previousText.slice(end)}`
    : [previousText.trimEnd(), candidate].filter(Boolean).join('\n\n')
  const history = getEditHistory(context.documentId, context.tabName)
  const before = {
    undo: [...history.undo], redo: [...history.redo], versions: structuredClone(state.versions[context.documentId] || []),
    counter: state.versionCounters[context.documentId] || 0, selected: state.selectedVersionByDocument[context.documentId]
  }
  const transaction = { before: previousText, after: acceptedText }
  const controls = [...document.querySelectorAll('[data-action="apply-candidate"], [data-action="discard-candidate"], [data-action="retry-generation"]')]
  state.candidateApplying = true
  controls.forEach(button => { button.disabled = true })
  elements.candidateActions.setAttribute('aria-busy', 'true')
  try {
    if (previousText && !before.versions.some(entry => entry.tabName === context.tabName && entry.content === previousText)) {
      addVersion(context.documentId, previousText, 'AI 采纳前快照', { tabName: context.tabName })
    }
    history.undo.push(transaction)
    history.redo.length = 0
    setContentAt(context.documentId, context.tabName, acceptedText)
    elements.scriptEditor.value = acceptedText
    const source = { replace: 'AI 替换正文', insert: 'AI 插入候选', append: '采纳 AI 候选' }[mode]
    const versionNumber = addVersion(context.documentId, acceptedText, source, { tabName: context.tabName, knowledgeChunks: context.knowledgeChunks || [] })
    const saved = await persistWorkspace()
    if (projectId !== activeProjectId) return
    if (!saved) {
      const untouched = editRevision === startingRevision && getContentAt(context.documentId, context.tabName) === acceptedText
      if (untouched) {
        history.undo.splice(0, history.undo.length, ...before.undo)
        history.redo.splice(0, history.redo.length, ...before.redo)
        state.versions[context.documentId] = before.versions
        state.versionCounters[context.documentId] = before.counter
        state.selectedVersionByDocument[context.documentId] = before.selected
        setContentAt(context.documentId, context.tabName, previousText)
        state.tabContents[context.documentId].history = formatVersionHistory(context.documentId)
        if (state.currentDocId === context.documentId && state.activeTab === context.tabName) updateDocumentView()
        elements.generationError.hidden = false
        elements.generationError.textContent = '保存失败，正文已回到采纳前，候选仍保留。请导出备份或重试。'
      } else {
        // The user has edited the candidate while the save was in flight. Never roll those edits back.
        discardCandidate({ silent: true })
        unsavedEdits = true
        showToast('保存失败：候选和后续输入都保留在编辑器中，请立即备份或重新保存')
      }
      setSaveStatus('error')
      return
    }
    discardCandidate({ silent: true })
    updateEditorMetrics()
    renderProjectIdentity()
    document.querySelector('[data-action="show-history"] span').textContent = `v${versionNumber}`
    showToast(`已采纳并建立快照 v${versionNumber}`, { actionLabel: '撤销', onAction: async () => {
      if (activeProjectId !== projectId || getContentAt(context.documentId, context.tabName) !== acceptedText) return showToast('内容已继续修改，请从历史版本恢复')
      const targetHistory = getEditHistory(context.documentId, context.tabName)
      if (targetHistory.undo.at(-1) === transaction) targetHistory.undo.pop()
      targetHistory.redo.push(transaction)
      setContentAt(context.documentId, context.tabName, previousText)
      if (state.currentDocId === context.documentId && state.activeTab === context.tabName) updateDocumentView()
      if (await persistWorkspace()) showToast('已撤销采纳，版本快照仍保留')
    } })
  } finally {
    state.candidateApplying = false
    elements.candidateActions.removeAttribute('aria-busy')
    controls.forEach(button => { button.disabled = false })
  }
}

async function saveManualSnapshot(button) {
  if (!getCurrentDocument() || state.activeTab === 'history' || state.candidateApplying) return
  button.disabled = true
  const projectId = activeProjectId
  const documentId = state.currentDocId
  const tabName = state.activeTab
  try {
    if (!await saveImmediately({ announce: false })) return
    if (projectTransition || projectId !== activeProjectId || documentId !== state.currentDocId || tabName !== state.activeTab) return
    const content = getCurrentContent()
    if (!content.trim()) return showToast('写下一些内容后再保存快照')
    const version = addVersion(state.currentDocId, content, '手动保存快照')
    if (await persistWorkspace()) {
      updateDocumentView()
      showToast(`已保存快照 v${version}，可从历史版本恢复`)
    }
  } finally { button.disabled = state.activeTab === 'history' }
}

async function undoCustom() {
  if (state.activeTab === 'history') return
  const history = getEditHistory()
  const transaction = history.undo.at(-1)
  const currentContent = getCurrentContent()
  if (!transaction || currentContent !== transaction.after) {
    elements.scriptEditor.focus()
    document.execCommand('undo')
    return
  }
  history.undo.pop()
  history.redo.push(transaction)
  elements.scriptEditor.value = transaction.before
  setCurrentContent(transaction.before)
  await persistWorkspace()
  updateEditorMetrics()
  showToast('已撤销上一步修改')
}

async function redoCustom() {
  if (state.activeTab === 'history') return
  const history = getEditHistory()
  const transaction = history.redo.at(-1)
  const currentContent = getCurrentContent()
  if (!transaction || currentContent !== transaction.before) {
    elements.scriptEditor.focus()
    document.execCommand('redo')
    return
  }
  history.redo.pop()
  history.undo.push(transaction)
  elements.scriptEditor.value = transaction.after
  setCurrentContent(transaction.after)
  await persistWorkspace()
  updateEditorMetrics()
  showToast('已重做上一步修改')
}

function createIcon(symbolId) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('class', 'icon')
  icon.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#${symbolId}`)
  icon.append(use)
  return icon
}

function showToast(message, options = {}) {
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.append(createIcon('icon-check'))
  const messageElement = document.createElement('span')
  messageElement.textContent = message
  toast.append(messageElement)
  if (options.actionLabel && options.onAction) {
    const actionButton = document.createElement('button')
    actionButton.type = 'button'
    actionButton.textContent = options.actionLabel
    actionButton.addEventListener('click', () => {
      options.onAction()
      toast.remove()
    }, { once: true })
    toast.append(actionButton)
  }
  elements.toastStack.append(toast)
  window.setTimeout(() => toast.remove(), options.duration || 4200)
}

let dialogReturnFocus = null

function openDialog(dialog) {
  if (dialog === elements.newProjectDialog) {
    document.querySelector('#projectName').value = ''
    dialog.querySelector('[type="submit"]').textContent = '创建项目'
  }
  if (!dialog || dialog.open) return
  dialogReturnFocus = document.activeElement
  dialog.showModal()
  const focusTarget = dialog.querySelector('input:not([type="radio"]), textarea') || dialog.querySelector('button')
  window.setTimeout(() => focusTarget?.focus(), 0)
}

function closeDialog(button) {
  const dialog = button.closest('dialog')
  if (dialog === elements.connectionDialog) invalidateConnectionDraftTest()
  dialog?.close()
}

function openCommandPalette() {
  openDialog(elements.commandDialog)
  elements.commandInput.setAttribute('aria-expanded', 'true')
  elements.commandInput.value = ''
  filterCommands('')
  window.setTimeout(() => elements.commandInput.focus(), 0)
}

function filterCommands(query) {
  const normalized = query.trim().toLowerCase()
  const visibleItems = []
  document.querySelectorAll('.command-item').forEach((item) => {
    const visible = !normalized || item.textContent.toLowerCase().includes(normalized)
    item.hidden = !visible
    item.classList.remove('is-highlighted')
    item.setAttribute('aria-selected', 'false')
    if (visible) visibleItems.push(item)
  })
  if (visibleItems[0]) {
    visibleItems[0].classList.add('is-highlighted')
    visibleItems[0].setAttribute('aria-selected', 'true')
    elements.commandInput.setAttribute('aria-activedescendant', visibleItems[0].id)
  } else {
    elements.commandInput.removeAttribute('aria-activedescendant')
  }
}

function moveCommandHighlight(direction) {
  const visibleItems = [...document.querySelectorAll('.command-item:not([hidden])')]
  if (!visibleItems.length) return
  const currentIndex = visibleItems.findIndex((item) => item.classList.contains('is-highlighted'))
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + direction + visibleItems.length) % visibleItems.length
  visibleItems.forEach((item, index) => {
    const isSelected = index === nextIndex
    item.classList.toggle('is-highlighted', isSelected)
    item.setAttribute('aria-selected', String(isSelected))
  })
  elements.commandInput.setAttribute('aria-activedescendant', visibleItems[nextIndex].id)
  visibleItems[nextIndex].scrollIntoView({ block: 'nearest' })
}

function formatKnowledgeDate(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function syncCurrentDocumentReferences() {
  if (!state.tabContents[state.currentDocId]) return
  const chunks = getSelectedKnowledgeChunks()
  state.tabContents[state.currentDocId].references = chunks.length
    ? `已选择的知识上下文\n\n${chunks.map((chunk, index) => `[K${String(index + 1).padStart(3, '0')}] ${chunk.content}\n来源：${chunk.name} / ${chunk.path}`).join('\n\n')}\n\n这些片段只会在“知识”上下文开关启用时随下一次请求发送。`
    : tabFallbacks.references
}

function renderKnowledgeSources() {
  const list = document.querySelector('#knowledgeSourceList')
  const fragment = document.createDocumentFragment()
  if (!state.knowledge.sources.length) {
    const empty = document.createElement('div')
    empty.className = 'knowledge-empty-state'
    empty.innerHTML = '<strong>还没有知识来源</strong><span>选择一个 Obsidian Vault 或普通资料目录，即可在本机建立检索索引。</span>'
    fragment.append(empty)
  }

  state.knowledge.sources.forEach((source) => {
    const row = document.createElement('article')
    row.className = 'source-row'
    row.dataset.sourceId = source.id
    row.dataset.searchable = `${source.kind} ${source.name} ${source.detail}`.toLowerCase()
    const icon = document.createElement('div')
    icon.className = `source-icon${source.kind === 'obsidian' ? ' source-icon-obsidian' : ''}`
    icon.append(createIcon(source.kind === 'folder' ? 'icon-folder' : source.kind === 'internal' ? 'icon-book' : 'icon-database'))
    const copy = document.createElement('div')
    copy.className = 'source-copy'
    const titleRow = document.createElement('div')
    titleRow.className = 'source-title-row'
    const title = document.createElement('h3')
    title.textContent = source.name
    const type = document.createElement('span')
    type.className = 'source-type'
    type.textContent = source.kind === 'obsidian' ? 'Obsidian Vault' : source.kind === 'folder' ? '本地目录' : '项目资料'
    titleRow.append(title, type)
    const detail = document.createElement('p')
    detail.textContent = source.detail
    copy.append(titleRow, detail)
    if (source.kind !== 'internal') {
      const refresh = document.createElement('button')
      refresh.type = 'button'
      refresh.className = 'text-button'
      refresh.textContent = '重新选择目录并同步'
      refresh.dataset.action = 'refresh-knowledge-source'
      refresh.dataset.sourceId = source.id
      copy.append(refresh)
    }
    const metrics = document.createElement('div')
    metrics.className = 'source-metrics'
    const chunks = state.knowledge.index.chunks.filter((chunk) => chunk.sourceId === source.id).length
    const metricValue = document.createElement('strong')
    metricValue.textContent = String(chunks)
    const metricLabel = document.createElement('span')
    metricLabel.textContent = '片段'
    metrics.append(metricValue, metricLabel)
    const status = document.createElement('div')
    status.className = 'source-status'
    const isUnavailable = source.status === 'error' || chunks === 0
    status.innerHTML = `<span class="status-dot ${isUnavailable ? 'status-dot-warning' : 'status-dot-success'}"></span><span>${source.status === 'error' ? '索引失败' : chunks === 0 ? '无可用片段' : '可检索'}</span><small>${formatKnowledgeDate(source.updatedAt)}</small>`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'icon-button icon-button-compact'
    remove.dataset.action = 'remove-knowledge-source'
    remove.dataset.sourceId = source.id
    remove.setAttribute('aria-label', `移除知识来源 ${source.name}`)
    remove.setAttribute('title', '移除来源')
    remove.append(createIcon('icon-x'))
    if (source.kind === 'internal') remove.disabled = true
    row.append(icon, copy, metrics, status, remove)
    fragment.append(row)
  })
  list.replaceChildren(fragment)
}

function renderKnowledgeResults() {
  const fragment = document.createDocumentFragment()
  if (!state.knowledge.query) {
    const hint = document.createElement('p')
    hint.className = 'knowledge-results-hint'
    hint.textContent = '输入人物、地点、规则或情节问题，查看实际命中的原文片段。'
    fragment.append(hint)
  } else if (!state.knowledge.results.length) {
    const empty = document.createElement('p')
    empty.className = 'knowledge-results-hint'
    empty.textContent = '没有找到相关片段。可以换一个更具体的关键词，或添加新的资料目录。'
    fragment.append(empty)
  } else {
    state.knowledge.results.forEach((result, index) => {
      const selected = state.knowledge.selectedChunkIds.includes(result.chunk.id)
      const card = document.createElement('article')
      card.className = `knowledge-result-card${selected ? ' is-selected' : ''}`
      const header = document.createElement('div')
      header.className = 'knowledge-result-header'
      const source = document.createElement('div')
      const title = document.createElement('strong')
      title.textContent = result.chunk.name || '未命名资料'
      const path = document.createElement('span')
      path.textContent = result.chunk.path || '本地资料'
      source.append(title, path)
      const score = document.createElement('span')
      score.className = 'knowledge-score'
      score.textContent = `相关度 ${Math.max(0, Math.round(result.score * 100))}%`
      header.append(source, score)
      const excerpt = document.createElement('p')
      excerpt.textContent = result.chunk.content.length > 260 ? `${result.chunk.content.slice(0, 260)}…` : result.chunk.content
      const footer = document.createElement('div')
      footer.className = 'knowledge-result-footer'
      const keywords = document.createElement('span')
      keywords.textContent = result.keywords.length ? `命中：${result.keywords.join('、')}` : `结果 ${index + 1}`
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = selected ? 'secondary-button compact-button' : 'primary-button compact-button'
      toggle.dataset.action = 'toggle-knowledge-chunk'
      toggle.dataset.chunkId = result.chunk.id
      toggle.textContent = selected ? '移出上下文' : '加入上下文'
      footer.append(keywords, toggle)
      card.append(header, excerpt, footer)
      fragment.append(card)
    })
  }
  elements.knowledgeResults.replaceChildren(fragment)

  const previewResult = state.knowledge.results[0]
  const preview = document.querySelector('#retrievalPreviewBlockquote')
  const citation = document.querySelector('#retrievalCitation')
  if (previewResult) {
    preview.textContent = `“${previewResult.chunk.content}”`
    citation.replaceChildren()
    const id = document.createElement('span')
    id.textContent = '[命中 01]'
    const date = document.createElement('small')
    date.textContent = `更新于 ${formatKnowledgeDate(previewResult.chunk.updatedAt)}`
    citation.append(id, document.createTextNode(` ${previewResult.chunk.name} / ${previewResult.chunk.path} `), date)
  } else {
    preview.textContent = state.knowledge.index.chunks.length ? '“输入问题后，这里会展示相关度最高的实际片段。”' : '“添加知识来源后，这里会展示 AI 能看到的原文片段。”'
    citation.textContent = state.knowledge.index.chunks.length ? '索引已就绪，等待检索' : '当前没有可检索片段'
  }
}

function takeBalancedKnowledgeChunks(chunks, limit) {
  if (limit <= 0 || !chunks.length) return []
  const groups = new Map()
  chunks.forEach((chunk) => {
    if (!groups.has(chunk.sourceId)) groups.set(chunk.sourceId, [])
    groups.get(chunk.sourceId).push(chunk)
  })
  const buckets = [...groups.values()]
  const selected = []
  let offset = 0
  while (selected.length < limit && buckets.some((bucket) => offset < bucket.length)) {
    buckets.forEach((bucket) => {
      if (selected.length < limit && offset < bucket.length) selected.push(bucket[bucket.length - 1 - offset])
    })
    offset += 1
  }
  return selected.reverse()
}

function mergeKnowledgeChunks(retainedChunks, incomingChunks) {
  const retainedSourceCount = new Set(retainedChunks.map((chunk) => chunk.sourceId)).size
  const retainedReserve = Math.min(retainedChunks.length, retainedSourceCount * 4)
  const incomingCapacity = Math.max(1, MAX_KNOWLEDGE_CHUNKS - retainedReserve)
  const storedIncoming = incomingChunks.slice(0, incomingCapacity)
  const retainedCapacity = Math.max(0, MAX_KNOWLEDGE_CHUNKS - storedIncoming.length)
  const storedRetained = takeBalancedKnowledgeChunks(retainedChunks, retainedCapacity)
  return {
    chunks: [...storedRetained, ...storedIncoming],
    storedIncoming
  }
}

function preserveKnowledgeSelections(previousIndex, selectedIds) {
  const fingerprints = new Set(previousIndex.chunks.filter(chunk => selectedIds.includes(chunk.id)).map(chunk => JSON.stringify([chunk.sourceId, chunk.path, chunk.content])))
  state.knowledge.selectedChunkIds = state.knowledge.index.chunks.filter(chunk => selectedIds.includes(chunk.id) || fingerprints.has(JSON.stringify([chunk.sourceId, chunk.path, chunk.content]))).map(chunk => chunk.id).slice(0, MAX_SELECTED_KNOWLEDGE_CHUNKS)
}

function reconcileKnowledgeSelections(preferredChunkIds = []) {
  const availableIds = new Set(state.knowledge.index.chunks.map((chunk) => chunk.id))
  state.knowledge.selectedChunkIds = [...new Set([
    ...state.knowledge.selectedChunkIds,
    ...preferredChunkIds
  ])].filter((id) => availableIds.has(id)).slice(-MAX_SELECTED_KNOWLEDGE_CHUNKS)
}

function renderKnowledge() {
  reconcileKnowledgeSelections()
  const chunkCount = state.knowledge.index.chunks.length
  const coverage = semanticIndexCoverage(state.knowledge.index, state.knowledge.semantic)
  const coverageLabel = document.querySelector('#semanticCoverage')
  if (coverageLabel) coverageLabel.textContent = state.knowledge.semantic ? `语义索引 ${coverage.indexed} / ${coverage.total} 个片段${coverage.pending ? ` · ${coverage.pending} 个待更新` : ' · 已同步'}` : '未启用语义检索，当前使用本地文本检索'
  const selectedCount = state.knowledge.selectedChunkIds.length
  document.querySelector('#knowledgeChunkCount').textContent = chunkCount.toLocaleString('zh-CN')
  document.querySelector('#knowledgeSourceCount').textContent = String(state.knowledge.sources.length)
  document.querySelector('#knowledgeSelectedCount').textContent = String(selectedCount)
  const searchableSourceIds = new Set(state.knowledge.index.chunks.map((chunk) => chunk.sourceId))
  const readySourceCount = state.knowledge.sources.filter((source) => source.status !== 'error' && searchableSourceIds.has(source.id)).length
  const indexStatus = document.querySelector('#knowledgeIndexStatus')
  indexStatus.querySelector('.status-dot').className = `status-dot ${chunkCount ? 'status-dot-success' : 'status-dot-muted'}`
  indexStatus.querySelector('span:last-child').textContent = chunkCount
    ? `${readySourceCount}/${state.knowledge.sources.length} 个来源可检索`
    : '尚未建立索引'
  const sourceCounts = state.knowledge.sources.reduce((counts, source) => {
    counts[source.kind] = (counts[source.kind] || 0) + 1
    return counts
  }, {})
  const sourceParts = [
    sourceCounts.obsidian ? `${sourceCounts.obsidian} 个 Vault` : '',
    sourceCounts.folder ? `${sourceCounts.folder} 个目录` : '',
    sourceCounts.internal ? `${sourceCounts.internal} 个项目资料源` : ''
  ].filter(Boolean)
  document.querySelector('#knowledgeSourceSummary').textContent = sourceParts.join(' · ') || '还没有绑定来源'
  document.querySelector('#knowledgeSelectionSummary').textContent = selectedCount
    ? '会随下一次 AI 请求发送'
    : '尚未加入 AI 上下文'
  document.querySelector('#promptKnowledgeCount').textContent = String(selectedCount)
  setContextChipLabel(document.querySelector('#knowledgeContextChip'), `知识 ${selectedCount}`)
  const statusButton = document.querySelector('#knowledgeStatusButton')
  statusButton.querySelector('span:last-child').textContent = chunkCount ? `知识库 ${chunkCount}` : '知识库未连接'
  const statusDot = statusButton.querySelector('.status-dot')
  statusDot.className = `status-dot ${chunkCount ? 'status-dot-success' : 'status-dot-muted'}`
  renderKnowledgeSources()
  renderKnowledgeResults()
  syncCurrentDocumentReferences()
}

let knowledgeSearchSequence = 0
let semanticBuildSequence = 0
async function rebuildSemanticIndex(button) {
  if (!activeProjectId || !state.knowledge.index.chunks.length) return showToast('请先在项目中导入知识资料')
  const projectId = activeProjectId
  const sequence = ++semanticBuildSequence
  const snapshot = structuredClone(state.knowledge.index)
  const model = document.querySelector('#embeddingModel').value.trim()
  button.disabled = true
  try {
    const semantic = await buildSemanticIndex(snapshot, model, state.knowledge.semantic, (done, total) => { button.textContent = `${done} / ${total}` })
    if (projectTransition || projectId !== activeProjectId || sequence !== semanticBuildSequence) return
    if (JSON.stringify(snapshot.chunks) !== JSON.stringify(state.knowledge.index.chunks)) return showToast('资料已更新，请重新建立语义索引')
    state.knowledge.semantic = semantic
    if (await persistWorkspace()) showToast(`已建立 ${snapshot.chunks.length} 个语义向量`)
  } catch (error) { showToast(readableError(error, '语义索引建立失败')) }
  finally { button.disabled = false; button.textContent = '建立 / 更新语义索引' }
}

async function searchKnowledge(query) {
  const sequence = ++knowledgeSearchSequence
  const projectId = activeProjectId
  state.knowledge.query = query.trim()
  state.knowledge.results = searchKnowledgeIndex(state.knowledge.index, state.knowledge.query, { limit: 6 })
  if (state.knowledge.query && state.knowledge.semantic?.model) {
    try {
      const results = await semanticSearch(state.knowledge.index, state.knowledge.query, state.knowledge.semantic)
      if (sequence !== knowledgeSearchSequence || projectId !== activeProjectId) return
      state.knowledge.results = results
    } catch (error) {
      if (sequence !== knowledgeSearchSequence || projectId !== activeProjectId) return
      showToast(`语义检索不可用，已使用文本检索：${readableError(error)}`)
    }
  }
  renderKnowledgeResults()
  if (state.knowledge.query) {
    elements.a11yAnnouncements.textContent = `找到 ${state.knowledge.results.length} 条相关知识`
  }
}

async function indexPendingKnowledgeFiles() {
  const projectId = activeProjectId
  if (!projectId) throw new Error('请先创建项目')
  if (state.knowledgeBusy) throw new Error('知识库正在保存，请稍候')
  const plan = planKnowledgeFiles(state.knowledge.pendingFiles)
  const files = plan.accepted
  if (!files.length) throw new Error('请选择包含 Markdown 或 TXT 的目录')
  const sourceType = document.querySelector('input[name="sourceType"]:checked')?.value || 'folder'
  const firstRelativePath = files[0].webkitRelativePath || files[0].name
  const sourceName = firstRelativePath.split('/')[0] || '本地资料'
  const sourceId = elements.knowledgeDialog.dataset.refreshSourceId || `source-${Date.now().toString(36)}`
  const documents = []
  let totalBytes = 0

  for (const file of files) {
    totalBytes += file.size
    const content = await file.text()
    if (!content.trim()) { plan.skipped.push({ path: file.webkitRelativePath || file.name, reason: '空文件' }); continue }
    documents.push({
      id: `${sourceId}:${file.webkitRelativePath || file.name}`,
      sourceId,
      name: file.name.replace(/\.(md|markdown|txt)$/i, ''),
      path: file.webkitRelativePath || file.name,
      content,
      updatedAt: new Date(file.lastModified || Date.now()).toISOString()
    })
  }
  if (!documents.length) throw new Error('没有可建立索引的文本文件')
  if (projectTransition || projectId !== activeProjectId) throw new Error('项目正在切换，本次导入已取消')

  const previousKnowledge = {
    index: state.knowledge.index,
    semantic: state.knowledge.semantic,
    sources: structuredClone(state.knowledge.sources),
    selectedChunkIds: [...state.knowledge.selectedChunkIds]
  }
  const previousPaths = new Set(state.knowledge.index.chunks.filter(chunk => chunk.sourceId === sourceId).map(chunk => chunk.path))
  const incomingPaths = new Set(documents.map(doc => doc.path))
  const removedPaths = [...previousPaths].filter(path => !incomingPaths.has(path))
  if (removedPaths.length && !window.confirm(`本次同步将从索引移除 ${removedPaths.length} 个旧文件（原文件不会删除）：\n${removedPaths.slice(0, 8).join('\n')}\n${plan.skipped.length ? `另有 ${plan.skipped.length} 项跳过，请确认选择了完整的原目录。\n` : ''}继续同步？`)) throw new Error('已取消同步，原索引保留')
  const nextIndex = createKnowledgeIndex(documents)
  const retainedChunks = state.knowledge.index.chunks.filter((chunk) => chunk.sourceId !== sourceId)
  const merged = mergeKnowledgeChunks(retainedChunks, nextIndex.chunks)
  state.knowledge.index = {
    ...nextIndex,
    chunks: merged.chunks
  }
  state.knowledge.sources = state.knowledge.sources.filter(source => source.id !== sourceId)
  state.knowledge.sources.push({
    id: sourceId,
    kind: sourceType,
    name: sourceName,
    detail: `${documents.length} 个可读文件 · 本次授权${merged.storedIncoming.length < nextIndex.chunks.length ? ` · 已保留 ${merged.storedIncoming.length}/${nextIndex.chunks.length} 片段` : ''}`,
    fileCount: documents.length,
    chunkCount: merged.storedIncoming.length,
    status: 'ready',
    updatedAt: new Date().toISOString()
  })
  preserveKnowledgeSelections(previousKnowledge.index, previousKnowledge.selectedChunkIds)
  state.knowledge.semantic = pruneSemanticIndex(state.knowledge.index, state.knowledge.semantic)
  reconcileKnowledgeSelections()
  state.knowledgeBusy = true
  const stored = await persistWorkspace()
  state.knowledgeBusy = false
  if (!stored) {
    state.knowledge.index = previousKnowledge.index
    state.knowledge.semantic = previousKnowledge.semantic
    state.knowledge.sources = previousKnowledge.sources
    state.knowledge.selectedChunkIds = previousKnowledge.selectedChunkIds
    renderKnowledge()
    throw new Error('本地存储空间不足，本次知识索引未保存')
  }
  state.knowledge.pendingFiles = []
  document.querySelector('#knowledgeImportReport').textContent = plan.skipped.length ? `本次跳过 ${plan.skipped.length} 项：${plan.skipped.map(item => `${item.path}（${item.reason}）`).join('；')}` : `本次导入 ${documents.length} 个文件，全部收录。`
  renderKnowledge()
  return {
    sourceName,
    fileCount: documents.length,
    chunkCount: merged.storedIncoming.length,
    totalChunkCount: nextIndex.chunks.length,
    skipped: plan.skipped
  }
}

async function syncKnowledge({ announce = true } = {}) {
  if (!activeProjectId || state.knowledgeBusy) return
  const previous = structuredClone(state.knowledge)
  state.knowledgeBusy = true
  const internalSource = state.knowledge.sources.find((source) => source.kind === 'internal')
  const starterDocuments = createStarterDocuments(state.project.name, state.project.type)
  const internalDocuments = [
    { id: 'source-project:world', sourceId: 'source-project', name: '当前世界观', path: '项目设定/世界观.md', content: state.documents.world?.content || '', updatedAt: new Date().toISOString() },
    { id: 'source-project:characters', sourceId: 'source-project', name: '当前人物设定', path: '项目设定/人物.md', content: state.documents.characters?.content || '', updatedAt: new Date().toISOString() },
    { id: 'source-project:outline', sourceId: 'source-project', name: '当前全剧大纲', path: '项目设定/全剧大纲.md', content: state.documents.outline?.content || '', updatedAt: new Date().toISOString() }
  ].filter((document) => document.content.trim() && document.content !== starterDocuments[document.id.split(':').at(-1)]?.content)
  const rebuilt = createKnowledgeIndex(internalDocuments)
  const merged = mergeKnowledgeChunks(
    state.knowledge.index.chunks.filter((chunk) => chunk.sourceId !== 'source-project'),
    rebuilt.chunks
  )
  state.knowledge.index = {
    ...rebuilt,
    chunks: merged.chunks
  }
  reconcileKnowledgeSelections()
  if (!internalDocuments.length) {
    state.knowledge.sources = state.knowledge.sources.filter((source) => source.id !== 'source-project')
  } else if (internalSource) {
    internalSource.fileCount = internalDocuments.length
    internalSource.chunkCount = rebuilt.chunks.length
    internalSource.updatedAt = new Date().toISOString()
    internalSource.status = 'ready'
  } else {
    state.knowledge.sources.push({ id: 'source-project', kind: 'internal', name: '项目设定', detail: '当前人物、世界观和全剧大纲', fileCount: 3, chunkCount: rebuilt.chunks.length, status: 'ready', updatedAt: new Date().toISOString() })
  }
  preserveKnowledgeSelections(previous.index, previous.selectedChunkIds)
  state.knowledge.semantic = pruneSemanticIndex(state.knowledge.index, state.knowledge.semantic)
  const saved = await persistWorkspace()
  state.knowledgeBusy = false
  if (!saved) { state.knowledge = previous; renderKnowledge(); return }
  renderKnowledge()
  if (announce) {
    showToast('项目设定索引已重建；外部目录需重新选择后更新')
    elements.a11yAnnouncements.textContent = '项目知识索引已重建'
  }
}

function getActiveConnection() {
  return state.connections.find((connection) => connection.isActive) || state.connections[0]
}

function getConnectionStatusCopy(connection) {
  if (connection.status === 'testing') return ['status-dot-warning', '检测中', '正在请求执行端']
  if (connection.status === 'ready') return ['status-dot-success', '可用', connection.lastLatency ? `${connection.lastLatency} ms` : '已就绪']
  if (connection.status === 'installed') return ['status-dot-warning', '已安装', '登录未验证']
  if (connection.status === 'auth_missing') return ['status-dot-warning', '需要密钥', '仅保留在本次会话']
  if (connection.status === 'auth_failed') return ['status-dot-warning', '鉴权失败', '检查 API Key']
  if (connection.status === 'model_missing') return ['status-dot-warning', '模型不可用', '检查模型名称']
  if (connection.status === 'cors_blocked') return ['status-dot-warning', '浏览器受限', '接口未允许本地跨域']
  if (connection.status === 'error') return ['status-dot-warning', '连接失败', connection.error || '检查地址与网络']
  return ['status-dot-muted', '待检测', connection.kind === 'ollama' ? '检测本地服务' : '尚未验证']
}

function createConnectionCard(connection) {
  const card = document.createElement('article')
  const [dotClass, statusCopy, statusDetail] = getConnectionStatusCopy(connection)
  card.className = `connection-card${connection.status === 'ready' ? '' : connection.status === 'unknown' ? ' connection-card-muted' : ' connection-card-warning'}`
  card.dataset.connectionId = connection.id

  const brand = document.createElement('div')
  brand.className = 'connection-brand'
  if (connection.kind === 'ollama') brand.append(createIcon('icon-server'))
  else brand.textContent = connection.name.slice(0, 1).toUpperCase()

  const copy = document.createElement('div')
  copy.className = 'connection-copy'
  const nameRow = document.createElement('div')
  nameRow.className = 'connection-name'
  const name = document.createElement('h3')
  name.textContent = connection.name
  nameRow.append(name)
  if (connection.isActive) {
    const badge = document.createElement('span')
    badge.className = 'default-badge'
    badge.textContent = '当前'
    nameRow.append(badge)
  }
  const detail = document.createElement('p')
  detail.textContent = `${connection.baseUrl || '地址未配置'}${connection.model ? ` · ${connection.model}` : ''}`
  copy.append(nameRow, detail)

  const capabilities = document.createElement('div')
  capabilities.className = 'connection-capabilities'
  const capabilityItems = connection.capabilities.length ? connection.capabilities : ['流式输出']
  capabilityItems.forEach((item) => {
    const tag = document.createElement('span')
    tag.textContent = item
    capabilities.append(tag)
  })

  const health = document.createElement('div')
  health.className = 'connection-health'
  const dot = document.createElement('span')
  dot.className = `status-dot ${dotClass}`
  const healthCopy = document.createElement('span')
  healthCopy.textContent = statusCopy
  const healthDetail = document.createElement('small')
  healthDetail.textContent = statusDetail
  health.append(dot, healthCopy, healthDetail)

  const actions = document.createElement('div')
  actions.className = 'connection-card-actions'
  if (!connection.isActive) {
    const useButton = document.createElement('button')
    useButton.type = 'button'
    useButton.className = 'secondary-button compact-button'
    useButton.dataset.action = 'activate-connection'
    useButton.dataset.connectionId = connection.id
    useButton.textContent = '设为当前 AI'
    actions.append(useButton)
  }
  const testButton = document.createElement('button')
  testButton.type = 'button'
  testButton.className = 'secondary-button compact-button'
  testButton.dataset.action = 'test-connection'
  testButton.dataset.connectionId = connection.id
  testButton.textContent = '测试'
  testButton.disabled = connection.status === 'testing' || connectionBatchTesting
  actions.append(testButton)
  const editButton = document.createElement('button')
  editButton.type = 'button'
  editButton.className = 'icon-button icon-button-compact'
  editButton.dataset.action = 'configure-provider'
  editButton.dataset.connectionId = connection.id
  editButton.setAttribute('aria-label', `编辑 ${connection.name}`)
  editButton.append(createIcon('icon-more'))
  actions.append(editButton)

  card.append(brand, copy, capabilities, health, actions)
  return card
}

function renderRuntimeDrivers() {
  const list = document.querySelector('#cliConnectionList')
  const fragment = document.createDocumentFragment()
  if (state.runtime.status === 'loading') {
    const loading = document.createElement('div')
    loading.className = 'connection-empty-state'
    loading.textContent = '正在检测受支持的本机 CLI…'
    fragment.append(loading)
  } else if (!state.runtime.drivers.length) {
    const empty = document.createElement('div')
    empty.className = 'connection-empty-state'
    empty.textContent = state.runtime.status === 'error' ? '本机运行桥不可用，请通过 npm run dev 启动。' : '尚未检测本机 CLI。'
    fragment.append(empty)
  } else {
    state.runtime.drivers.forEach((driver) => {
      const connection = state.connections.find((item) => item.kind === 'cli' && item.driverId === driver.id)
      const card = document.createElement('article')
      const isReady = driver.status === 'ready'
      const canGenerate = Boolean(isReady && driver.canGenerate && connection)
      const isVerified = canGenerate && connection.status === 'ready'
      const isTranslated = driver.compatibility === 'translated'
      const requiresCredential = driver.executionStatus === 'credential_required'
      card.className = `connection-card${isReady ? '' : ' connection-card-muted'}`
      const brand = document.createElement('div')
      brand.className = 'connection-brand connection-brand-cli'
      brand.append(createIcon('icon-terminal'))
      const copy = document.createElement('div')
      copy.className = 'connection-copy'
      const title = document.createElement('div')
      title.className = 'connection-name'
      const heading = document.createElement('h3')
      heading.textContent = driver.name
      title.append(heading)
      const path = document.createElement('p')
      path.textContent = driver.executablePath || '未在 PATH 中发现'
      copy.append(title, path)
      const capabilities = document.createElement('div')
      capabilities.className = 'connection-capabilities'
      ;[
        canGenerate ? '可执行创作' : requiresCredential ? '安全执行待授权' : '安装检测',
        canGenerate ? driver.id === 'antigravity' ? '用户登录态 · Plan' : driver.id === 'codex' ? '用户登录态 · 只读' : 'API Key / CLI 登录态' : requiresCredential ? '需显式凭据' : '不开放执行',
        isTranslated ? 'Intel 兼容模式' : null
      ].filter(Boolean).forEach((label) => {
        const capability = document.createElement('span')
        capability.textContent = label
        capabilities.append(capability)
      })
      const health = document.createElement('div')
      health.className = 'connection-health'
      const dot = document.createElement('span')
      dot.className = `status-dot ${isReady ? 'status-dot-success' : 'status-dot-muted'}`
      const status = document.createElement('span')
      status.textContent = isVerified
        ? '可用'
        : !isReady
          ? driver.status === 'not_found' ? '未安装' : '检测失败 / 版本不兼容'
        : isTranslated
          ? '已安装 · 实验'
          : requiresCredential
            ? '已安装 · 待授权'
            : isReady
              ? '已安装'
              : driver.status === 'not_found' ? '未安装' : '检测失败 / 版本不兼容'
      const version = document.createElement('small')
      version.textContent = [driver.version, driver.binaryArchitecture].filter(Boolean).join(' · ') || '不影响本地写作'
      health.append(dot, status, version)
      const note = document.createElement('span')
      note.className = 'cli-readonly-note'
      note.textContent = !isReady
        ? driver.status === 'not_found' ? '安装 CLI 后点击重新检测' : '请检查 CLI 版本与运行状态后重新检测；并非账号未授权'
        : driver.id === 'antigravity' && isReady
        ? '先在终端运行 agy 登录；使用默认模型。每次调用需确认用户配置与额度，不是无工具模式。'
        : driver.id === 'codex' && isReady
          ? '先运行 codex login。使用默认供应商与模型；已安装不代表登录或额度已验证。'
        : driver.id === 'claude' && isReady
          ? '配置 API Key 或先运行 claude auth login。未配 Key 时尝试已有登录态；Intel 兼容模式不是禁用原因。'
        : isReady && driver.executionStatus === 'disabled'
        ? '工作台暂未支持调用'
        : isReady && requiresCredential
          ? `${isTranslated ? 'Intel 兼容模式；' : ''}启动时提供环境变量凭据后可安全执行`
        : isTranslated
          ? '需经 Rosetta 运行，长任务稳定性未验证'
          : isVerified
            ? '已通过本次任务验证'
            : isReady
              ? '登录未验证'
              : '可选'
      const actions = document.createElement('div')
      actions.className = 'connection-card-actions'
      if (canGenerate && !connection.isActive) {
        const useButton = document.createElement('button')
        useButton.type = 'button'
        useButton.className = 'secondary-button compact-button'
        useButton.dataset.action = 'activate-connection'
        useButton.dataset.connectionId = connection.id
        useButton.textContent = '设为当前 AI'
        actions.append(useButton)
      } else if (connection?.isActive) {
        const badge = document.createElement('span')
        badge.className = 'default-badge'
        badge.textContent = '当前'
        actions.append(badge)
      }
      card.append(brand, copy, capabilities, health, note, actions)
      fragment.append(card)
    })
  }
  list.replaceChildren(fragment)
}

function renderConnections() {
  const apiList = document.querySelector('#apiConnectionList')
  const localList = document.querySelector('#localConnectionList')
  apiList.replaceChildren(...state.connections.filter((connection) => connection.kind === 'openai-compatible').map(createConnectionCard))
  localList.replaceChildren(...state.connections.filter((connection) => connection.kind === 'ollama').map(createConnectionCard))
  renderRuntimeDrivers()

  const active = getActiveConnection()
  const readyCount = state.connections.filter((connection) => connection.status === 'ready').length
  const overview = document.querySelector('#connectionOverview')
  overview.querySelector('strong').textContent = `${readyCount} 个执行端可用`
  overview.querySelector('div > span:last-child').textContent = `当前使用 ${active.name}`
  overview.querySelector('.status-dot').className = `status-dot ${readyCount ? 'status-dot-success' : 'status-dot-warning'}`

  const executor = document.querySelector('#executorSelect')
  const availableExecutors = state.connections.filter((connection) => connection.kind !== 'cli' || ['installed', 'ready'].includes(connection.status) || connection.isActive)
  executor.replaceChildren(...availableExecutors.map((connection) => {
    const option = document.createElement('option')
    option.value = connection.id
    option.selected = connection.id === active.id
    const statusSuffix = connection.status === 'ready'
      ? ''
      : connection.status === 'installed'
        ? connection.compatibility === 'translated' ? ' · Intel 兼容模式 · 登录未验证' : ' · 登录未验证'
        : ' · 待检测'
    option.textContent = `${connection.name}${connection.kind === 'cli' ? ' · CLI' : ''}${statusSuffix}`
    return option
  }))
  const selector = executor.closest('.model-selector')
  selector.querySelector('.status-dot').className = `status-dot ${active.status === 'ready' ? 'status-dot-success' : 'status-dot-warning'}`
  const chip = document.querySelector('#activeConnectionChip')
  chip.querySelector('span:last-of-type').textContent = active.name
  chip.querySelector('.status-dot').className = `status-dot ${active.status === 'ready' ? 'status-dot-success' : 'status-dot-warning'}`

  const apiConnections = state.connections.filter((connection) => connection.kind === 'openai-compatible')
  const apiReady = apiConnections.filter((connection) => connection.status === 'ready').length
  const apiStatus = document.querySelector('#apiStatusButton')
  apiStatus.querySelector('span:last-child').textContent = apiConnections.length ? `API ${apiReady}/${apiConnections.length} 可用` : 'API 未配置'
  apiStatus.querySelector('.status-dot').className = `status-dot ${apiReady ? 'status-dot-success' : 'status-dot-muted'}`

  const readyCli = state.runtime.drivers.filter((driver) => driver.status === 'ready').length
  const cliStatus = document.querySelector('#cliStatusButton')
  cliStatus.querySelector('span:last-child').textContent = state.runtime.status === 'loading' ? 'CLI 检测中' : `CLI ${readyCli} 个已安装`
  cliStatus.querySelector('.status-dot').className = `status-dot ${readyCli ? 'status-dot-success' : 'status-dot-muted'}`
  const runtimeSummary = document.querySelector('#cliRuntimeSummary')
  if (runtimeSummary) {
    runtimeSummary.textContent = state.runtime.status === 'ready'
      ? `${['darwin', 'macos'].includes(state.runtime.platform) ? 'macOS' : state.runtime.platform || '本机'} · ${state.runtime.architecture || '未知架构'} · 选择当前 AI 后，在创作区发起生成。安装检测不代表登录或额度已验证。`
      : '正在通过本地运行桥检测受支持的 CLI。'
  }
}

function classifyProviderError(error, response = null) {
  if (response?.status === 401 || response?.status === 403) return ['auth_failed', '鉴权失败，请检查 API Key']
  if (response?.status === 404) return ['model_missing', '接口或模型不存在']
  if (response?.status === 429) return ['error', '请求受限，请稍后重试']
  if (error?.name === 'AbortError') return ['error', '连接超时']
  if (error instanceof TypeError) return ['cors_blocked', '浏览器无法访问该地址，可能是 CORS 或网络限制']
  return ['error', readableError(error, '连接失败')]
}

async function testProviderConnection(connection, secretOverride = '', { allowStoredSecret = true, signal: externalSignal = null } = {}) {
  if (!connection) return false
  const testId = ++connectionTestSequence
  connectionTestTasks.get(connection.id)?.controller.abort()
  const startedAt = performance.now()
  connection.status = 'testing'
  connection.error = null
  renderConnections()
  const controller = new AbortController()
  connectionTestTasks.set(connection.id, { id: testId, controller })
  const isCurrentTest = () => connectionTestTasks.get(connection.id)?.id === testId
  const abortFromExternal = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  const timeout = window.setTimeout(() => controller.abort(), 8000)
  try {
    validateProviderBaseUrl(connection.kind, connection.baseUrl)
    const secret = connection.kind === 'openai-compatible'
      ? secretOverride || (allowStoredSecret ? await connectionSecret(connection) : '')
      : ''
    if (connection.kind === 'openai-compatible' && !secret) {
      connection.status = 'auth_missing'
      connection.error = 'API Key 只在当前会话保存，请重新输入'
      return false
    }
    if (isDesktopRuntime) {
      const result = await invokeDesktop('connection_test', {
        input: {
          kind: connection.kind,
          baseUrl: connection.baseUrl,
          model: connection.model || '',
          apiKey: secret || null
        }
      })
      if (!isCurrentTest() || controller.signal.aborted) return false
      const models = Array.isArray(result?.models) ? result.models.map(String).filter(Boolean) : []
      if (connection.kind === 'ollama') {
        connection.availableModels = models
        if (!connection.model && models[0]) connection.model = models[0]
      }
      connection.lastLatency = Number.isFinite(Number(result?.latencyMs))
        ? Math.max(1, Math.round(Number(result.latencyMs)))
        : Math.max(1, Math.round(performance.now() - startedAt))
    } else if (connection.kind === 'openai-compatible') {
      const response = await fetch(providerEndpointUrl(connection.kind, connection.baseUrl, 'models'), {
        headers: { Authorization: `Bearer ${secret}` },
        redirect: 'error',
        signal: controller.signal
      })
      if (!isCurrentTest()) return false
      if (!response.ok) {
        const [status, message] = classifyProviderError(null, response)
        connection.status = status
        connection.error = message
        return false
      }
      const payload = await response.json()
      if (!isCurrentTest()) return false
      if (!Array.isArray(payload?.data) || payload.data.some(item => typeof item?.id !== 'string' || !item.id.trim())) throw new Error('模型目录格式无效，请检查 API 地址')
      const modelIds = payload.data.map(item => item.id)
      if (!modelIds.length) throw new Error('接口可达，但当前账号没有可用模型')
      if (connection.model && !modelIds.includes(connection.model)) {
        connection.status = 'model_missing'
        connection.error = `模型 ${connection.model} 不在当前账号可用列表中`
        return false
      }
    } else {
      const response = await fetch(providerEndpointUrl(connection.kind, connection.baseUrl, 'api/tags'), { signal: controller.signal, redirect: 'error' })
      if (!isCurrentTest()) return false
      if (!response.ok) throw new Error(`Ollama 返回 HTTP ${response.status}`)
      const payload = await response.json()
      if (!isCurrentTest()) return false
      if (!Array.isArray(payload?.models) || payload.models.some(model => typeof model?.name !== 'string' || !model.name.trim())) throw new Error('模型目录格式无效，请检查 Ollama 地址')
      const models = payload.models.map(model => model.name)
      connection.availableModels = models
      if (!connection.model && models[0]) connection.model = models[0]
      if (!models.length) {
        connection.status = 'model_missing'
        connection.error = 'Ollama 已运行，但还没有安装模型'
        return false
      }
      if (connection.model && !models.includes(connection.model)) {
        connection.status = 'model_missing'
        connection.error = `本机 Ollama 中没有模型 ${connection.model}`
        return false
      }
    }
    connection.status = 'ready'
    if (!connection.lastLatency || !isDesktopRuntime) {
      connection.lastLatency = Math.max(1, Math.round(performance.now() - startedAt))
    }
    connection.lastTestedAt = new Date().toISOString()
    return true
  } catch (error) {
    if (!isCurrentTest()) return false
    const [status, message] = classifyProviderError(error)
    connection.status = status
    connection.error = message
    return false
  } finally {
    window.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromExternal)
    if (isCurrentTest()) {
      connectionTestTasks.delete(connection.id)
      renderConnections()
      if (state.connections.includes(connection) && !projectTransition) await persistWorkspace()
    }
  }
}

async function testConnection(button) {
  const connection = state.connections.find((item) => item.id === button.dataset.connectionId)
  if (!connection || button.disabled || connectionBatchTesting || connection.status === 'testing') return
  button.disabled = true
  const succeeded = await testProviderConnection(connection)
  button.disabled = false
  showToast(succeeded ? `${connection.name} 连接正常` : `${connection.name}：${connection.error || '连接失败'}`)
}

function syncCliConnections(drivers) {
  const executableIds = new Set()
  drivers.filter((driver) => driver.canGenerate).forEach((driver) => {
    const connectionId = `cli-${driver.id}`
    executableIds.add(connectionId)
    let connection = state.connections.find((item) => item.id === connectionId && item.kind === 'cli')
    if (!connection) {
      connection = {
        id: connectionId,
        kind: 'cli',
        driverId: driver.id,
        name: driver.name,
        baseUrl: '',
        model: driver.version || '',
        status: 'unknown',
        capabilities: ['受控 CLI', driver.id === 'antigravity' ? '用户配置 · Plan' : driver.id === 'codex' ? '只读执行' : 'API Key / CLI 登录态'],
        binaryArchitecture: driver.binaryArchitecture || null,
        compatibility: driver.compatibility || 'unknown',
        isActive: false,
        error: null
      }
      state.connections.push(connection)
    }
    connection.name = driver.name
    connection.model = driver.version || connection.model
    connection.binaryArchitecture = driver.binaryArchitecture || null
    connection.compatibility = driver.compatibility || 'unknown'
    connection.status = driver.status === 'ready'
      ? connection.status === 'ready' ? 'ready' : 'installed'
      : 'error'
    connection.error = driver.status === 'ready' ? null : '未发现可执行文件'
  })

  state.connections.filter((connection) => connection.kind === 'cli' && !executableIds.has(connection.id)).forEach((connection) => {
    connection.status = 'error'
    connection.error = '当前版本不允许通过该 CLI 生成'
    connection.isActive = false
  })
  const active = state.connections.find((connection) => connection.isActive)
  if (!active || (active.kind === 'cli' && !['installed', 'ready'].includes(active.status))) {
    const fallback = state.connections.find((connection) => connection.kind !== 'cli')
    state.connections.forEach((connection) => { connection.isActive = connection.id === fallback?.id })
  }
}

async function detectRuntime() {
  const discoveryTarget = state.connections.find(connection => connection.kind === 'ollama')
  const discoveryEndpoint = discoveryTarget?.baseUrl || 'http://127.0.0.1:11434'
  state.runtime.status = 'loading'
  renderConnections()
  try {
    let runtime
    let ollamaPayload = null
    if (isDesktopRuntime) {
      runtime = await invokeDesktop('runtime_snapshot', { ollamaBaseUrl: discoveryEndpoint })
      ollamaPayload = runtime?.ollama || null
    } else {
      const [runtimeResponse, ollamaResponse] = await Promise.all([
        fetch('/api/runtime'),
        fetch(`/api/runtime/ollama?baseUrl=${encodeURIComponent(discoveryEndpoint)}`)
      ])
      if (!runtimeResponse.ok) throw new Error(`运行桥返回 HTTP ${runtimeResponse.status}`)
      runtime = await runtimeResponse.json()
      if (ollamaResponse.ok) ollamaPayload = await ollamaResponse.json()
    }
    if (isDesktopRuntime) {
      const claudeConnection = state.connections.find(item => item.id === 'cli-claude') || { id: 'cli-claude', baseUrl: '', rememberSecret: false }
      const secret = await connectionSecret(claudeConnection)
      if (secret) {
        const driver = runtime.drivers?.find(item => item.id === 'claude' && item.status === 'ready')
        if (driver) { driver.canGenerate = true; driver.executionStatus = 'available' }
      }
    }
    state.runtime = {
      platform: runtime.platform || null,
      architecture: runtime.architecture || null,
      drivers: Array.isArray(runtime.drivers) ? runtime.drivers : [],
      checkedAt: runtime.checkedAt || new Date().toISOString(),
      status: 'ready'
    }
    syncCliConnections(state.runtime.drivers)
    const ollama = state.connections.find(connection => connection.id === discoveryTarget?.id && connection.baseUrl === discoveryEndpoint)
    if (ollama && ollamaPayload) {
      ollama.availableModels = Array.isArray(ollamaPayload.models) ? ollamaPayload.models.map((model) => model.name).filter(Boolean) : []
      if (!ollama.model && ollama.availableModels[0]) ollama.model = ollama.availableModels[0]
      const hasModel = ollama.availableModels.includes(ollama.model)
      ollama.status = ollamaPayload.status === 'ready' && hasModel ? 'ready' : ['ready', 'no_models'].includes(ollamaPayload.status) ? 'model_missing' : 'error'
      ollama.error = ollama.status === 'model_missing'
        ? ollama.availableModels.length ? `本机 Ollama 中没有模型 ${ollama.model}` : '服务已启动，但还没有安装模型'
        : ollama.status === 'error'
          ? ({ invalid_url: 'Ollama 地址无效，请使用本机 HTTP 地址', invalid_response: '服务返回的模型目录无效，请检查 Ollama 地址', timeout: '检测 Ollama 超时，请检查服务状态' }[ollamaPayload.status] || '本机未运行 Ollama 服务')
          : null
    }
  } catch (error) {
    state.runtime.status = 'error'
    state.runtime.drivers = []
    syncCliConnections([])
  }
  renderConnections()
}

async function setActiveConnection(connectionId) {
  if (!state.connections.some((connection) => connection.id === connectionId)) return
  if (getActiveConnection()?.id !== connectionId) cliSessionConsent = null
  state.connections.forEach((connection) => { connection.isActive = connection.id === connectionId })
  await persistWorkspace()
  renderConnections()
  showToast(`已切换到 ${getActiveConnection().name}`)
}

function invalidateConnectionDraftTest() {
  connectionDraftTestSequence += 1
  connectionDraftTestController?.abort()
  connectionDraftTestController = null
}

function openConnectionDialog(connectionId = null) {
  invalidateConnectionDraftTest()
  const connection = state.connections.find((item) => item.id === connectionId)
  document.querySelector('#connectionId').value = connection?.id || `connection-${Date.now().toString(36)}`
  document.querySelector('#connectionKind').value = connection?.kind === 'ollama' ? 'ollama' : 'openai-compatible'
  document.querySelector('#connectionName').value = connection?.name || '我的模型'
  document.querySelector('#baseUrl').value = connection?.baseUrl || 'https://api.openai.com/v1'
  document.querySelector('#modelName').value = connection?.model || 'gpt-4.1-mini'
  document.querySelector('#apiKey').value = ''
  document.querySelector('#rememberApiKey').checked = Boolean(connection?.rememberSecret)
  document.querySelector('#rememberApiKeyOption').hidden = !isDesktopRuntime
  document.querySelector('#apiKeyField').hidden = connection?.kind === 'ollama'
  document.querySelector('#connectionForm').dataset.testStatus = ''
  document.querySelector('#connectionForm').dataset.lastLatency = ''
  document.querySelector('#connectionForm').dataset.dirty = 'false'
  elements.connectionTestStatus.innerHTML = ''
  elements.connectionTestStatus.append(createIcon('icon-lock'))
  const copy = document.createElement('span')
  copy.textContent = connection?.error || '尚未测试连接'
  elements.connectionTestStatus.append(copy)
  openDialog(elements.connectionDialog)
}

function hasConnectionEndpointChanged(draft, existing) {
  return Boolean(existing && (draft.kind !== existing.kind || draft.baseUrl !== existing.baseUrl))
}

function getConnectionDraft() {
  const existingId = document.querySelector('#connectionId').value
  const kind = document.querySelector('#connectionKind').value
  return {
    id: existingId || `connection-${Date.now().toString(36)}`,
    kind,
    name: document.querySelector('#connectionName').value.trim() || '未命名连接',
    baseUrl: document.querySelector('#baseUrl').value.trim().replace(/\/$/, ''),
    model: document.querySelector('#modelName').value.trim(),
    status: 'unknown',
    capabilities: kind === 'ollama' ? ['完全本地', '流式输出'] : ['流式输出', 'OpenAI 兼容'],
    isActive: false,
    error: null
  }
}

async function testConnectionDraft(button) {
  invalidateConnectionDraftTest()
  const testId = connectionDraftTestSequence
  const controller = new AbortController()
  connectionDraftTestController = controller
  const draft = getConnectionDraft()
  const secret = document.querySelector('#apiKey').value
  const existing = state.connections.find((connection) => connection.id === draft.id)
  draft.rememberSecret = Boolean(existing?.rememberSecret)
  const endpointChanged = hasConnectionEndpointChanged(draft, existing)
  button.disabled = true
  elements.connectionTestStatus.innerHTML = ''
  elements.connectionTestStatus.append(createIcon('icon-refresh'))
  const testingCopy = document.createElement('span')
  testingCopy.textContent = '正在验证地址、鉴权和模型能力…'
  elements.connectionTestStatus.append(testingCopy)
  const succeeded = await testProviderConnection(draft, secret, {
    allowStoredSecret: !endpointChanged,
    signal: controller.signal
  })
  const form = document.querySelector('#connectionForm')
  if (testId !== connectionDraftTestSequence || !elements.connectionDialog.open) {
    if (button.isConnected) button.disabled = false
    return
  }
  connectionDraftTestController = null
  form.dataset.testStatus = succeeded ? 'ready' : draft.status
  form.dataset.lastLatency = draft.lastLatency ? String(draft.lastLatency) : ''
  form.dataset.dirty = 'false'
  elements.connectionTestStatus.innerHTML = ''
  elements.connectionTestStatus.append(createIcon(succeeded ? 'icon-check' : 'icon-alert'))
  const resultCopy = document.createElement('span')
  resultCopy.textContent = succeeded ? `连接正常 · ${draft.lastLatency} ms` : draft.error || '连接失败'
  elements.connectionTestStatus.append(resultCopy)
  button.disabled = false
}

async function testAllConnections(button) {
  if (button.disabled || connectionBatchTesting || connectionTestTasks.size) {
    showToast('请等待当前连接检测完成')
    return
  }
  connectionBatchTesting = true
  button.disabled = true
  button.textContent = '检测中…'
  renderConnections()
  try {
    await detectRuntime()
    const testable = state.connections.filter((connection) => ['openai-compatible', 'ollama'].includes(connection.kind))
    const results = []
    for (const connection of testable) results.push(await testProviderConnection(connection))
    showToast(testable.length ? `检测完成：${results.filter(Boolean).length}/${testable.length} 个连接可用` : '还没有需要检测的外部连接')
  } finally {
    connectionBatchTesting = false
    button.disabled = false
    button.textContent = '全部检测'
    renderConnections()
  }
}

function populateEpisodeOptions(selectedEpisodeId = null) {
  const select = document.querySelector('#newContentParent')
  select.replaceChildren()
  getEpisodeIds().forEach((episodeId, index) => {
    const option = document.createElement('option')
    option.value = episodeId
    option.textContent = `第 ${index + 1} 集 · ${state.documents[episodeId]?.title || '未命名'}`
    option.selected = episodeId === selectedEpisodeId
    select.append(option)
  })
}

function syncNewContentType() {
  const type = document.querySelector('#newContentType').value
  const parentField = document.querySelector('#newContentParentField')
  parentField.hidden = type !== 'scene'
  if (type === 'scene' && !document.querySelector('#newContentParent').options.length) {
    showToast('请先创建一个分集，再添加分场')
  }
}

function openNewContentDialog({ type = 'episode', parentId = null, actId = null } = {}) {
  if (!state.project.name && !Object.keys(state.documents).length) return openDialog(elements.newProjectDialog)
  const form = document.querySelector('#newContentForm')
  const resolvedParent = parentId || getParentEpisodeId(state.currentDocId) || getEpisodeIds()[0] || null
  form.dataset.actId = actId || state.structure.acts.find((act) => act.episodeIds.includes(resolvedParent))?.id || state.structure.acts[0]?.id || ''
  document.querySelector('#newContentType').value = type
  populateEpisodeOptions(resolvedParent)
  document.querySelector('#newContentName').value = type === 'scene'
    ? `第 ${(state.structure.episodes[resolvedParent]?.sceneIds.length || 0) + 1} 场 · 待命名`
    : `第 ${getEpisodeIds().length + 1} 集 · 待命名`
  syncNewContentType()
  openDialog(elements.newContentDialog)
}

async function createStructuredDocument({ type, title, parentId = null, actId = null, select = true } = {}) {
  if (type === 'scene' && !state.structure.episodes[parentId]) return null
  const documentId = makeUniqueId(type)
  const documentData = createGenericDocument(documentId, title)

  if (type === 'episode') {
    if (!state.structure.acts.length) {
      state.structure.acts.push({ id: 'act-1', title: '第一幕', collapsed: false, episodeIds: [] })
    }
    const targetAct = state.structure.acts.find((act) => act.id === actId) || state.structure.acts[0]
    if (!targetAct) return null
    const episodeNumber = getEpisodeIds().length + 1
    Object.assign(documentData, {
      breadcrumb: `第 ${episodeNumber} 集`,
      kicker: `Episode ${String(episodeNumber).padStart(2, '0')} · draft`,
      sceneTitle: title,
      intent: '明确本集目标、核心冲突和结尾钩子，再拆分为可拍摄的分场。',
      meta: ['0 场', '时长待定', '结构待完善'],
      content: ''
    })
    state.documents[documentId] = documentData
    state.structure.episodes[documentId] = { sceneIds: [] }
    targetAct.episodeIds.push(documentId)
  } else {
    const episodeNumber = getEpisodeIds().indexOf(parentId) + 1
    const sceneNumber = state.structure.episodes[parentId].sceneIds.length + 1
    Object.assign(documentData, {
      breadcrumb: `第 ${episodeNumber} 集 · 场 ${sceneNumber}`,
      kicker: `${episodeNumber}-${sceneNumber} · 场景待定 · 时间待定`,
      sceneTitle: title,
      intent: '明确地点、出场人物，以及这场戏结束时必须发生的变化。',
      meta: ['场景待定', '时间待定', '人物待定']
    })
    state.documents[documentId] = documentData
    state.structure.episodes[parentId].sceneIds.push(documentId)
  }

  state.tabContents[documentId] = structuredClone(tabFallbacks)
  state.versions[documentId] = []
  state.versionCounters[documentId] = 0
  renderProjectIdentity()
  await persistWorkspace()
  if (select) selectDocument(documentId)
  return documentId
}

function refreshStructureMetadata() {
  let episodeNumber = 0
  state.structure.acts.forEach((act) => {
    act.episodeIds.forEach((episodeId) => {
      episodeNumber += 1
      const episode = state.documents[episodeId]
      if (!episode) return
      episode.breadcrumb = `第 ${episodeNumber} 集`
      const scenes = state.structure.episodes[episodeId]?.sceneIds || []
      episode.meta[0] = `${scenes.length} 场`
      scenes.forEach((sceneId, sceneIndex) => {
        const scene = state.documents[sceneId]
        if (!scene) return
        scene.breadcrumb = `第 ${episodeNumber} 集 · 场 ${sceneIndex + 1}`
        scene.kicker = scene.kicker.replace(/^\d+-\d+/, `${episodeNumber}-${sceneIndex + 1}`)
      })
    })
  })
}

function openDocumentDialog() {
  const documentData = getCurrentDocument()
  document.querySelector('#documentName').value = documentData.title
  document.querySelector('#documentIntent').value = documentData.intent
  document.querySelector('#documentKicker').value = documentData.kicker
  document.querySelector('#documentMeta').value = documentData.meta.join('，')
  const isCore = getDocumentKind(state.currentDocId) === 'core'
  document.querySelector('#documentOrderActions').hidden = isCore
  document.querySelector('[data-action="duplicate-document"]').hidden = isCore
  const deleteButton = document.querySelector('[data-action="delete-document"]')
  deleteButton.dataset.confirmed = ''
  deleteButton.textContent = '删除'
  document.querySelector('#deleteDocumentConfirm').hidden = true
  openDialog(elements.documentDialog)
}

async function moveCurrentDocument(direction) {
  const position = getDocumentPosition(state.currentDocId)
  if (!position) return
  const currentIndex = position.kind === 'episode' ? position.episodeIndex : position.sceneIndex
  const nextIndex = currentIndex + direction
  if (nextIndex < 0 || nextIndex >= position.list.length) {
    showToast(direction < 0 ? '已经是第一项' : '已经是最后一项')
    return
  }
  const [documentId] = position.list.splice(currentIndex, 1)
  position.list.splice(nextIndex, 0, documentId)
  refreshStructureMetadata()
  renderProjectIdentity()
  updateDocumentView()
  await persistWorkspace()
  showToast(direction < 0 ? '已上移' : '已下移')
}

async function duplicateCurrentDocument() {
  const position = getDocumentPosition(state.currentDocId)
  if (!position) return
  const originalId = state.currentDocId
  const original = state.documents[originalId]
  const duplicateId = makeUniqueId(position.kind)
  state.documents[duplicateId] = { ...structuredClone(original), title: `${original.title} · 副本`, badge: '待完善' }
  state.tabContents[duplicateId] = structuredClone(state.tabContents[originalId] || tabFallbacks)
  state.versions[duplicateId] = []
  state.versionCounters[duplicateId] = 0

  if (position.kind === 'episode') {
    state.structure.episodes[duplicateId] = { sceneIds: [] }
    position.list.splice(position.episodeIndex + 1, 0, duplicateId)
  } else {
    position.list.splice(position.sceneIndex + 1, 0, duplicateId)
  }
  elements.documentDialog.close()
  refreshStructureMetadata()
  renderProjectIdentity()
  await persistWorkspace()
  selectDocument(duplicateId)
  showToast(`已创建“${state.documents[duplicateId].title}”`)
}

async function deleteCurrentDocument(button) {
  const position = getDocumentPosition(state.currentDocId)
  if (!position) {
    showToast('前期创作文档不能删除')
    return
  }
  const childSceneCount = position.kind === 'episode'
    ? state.structure.episodes[state.currentDocId]?.sceneIds.length || 0
    : 0
  if (childSceneCount && button?.dataset.confirmed !== 'true') {
    button.dataset.confirmed = 'true'
    button.textContent = `确认删除本集与 ${childSceneCount} 个分场`
    const warning = document.querySelector('#deleteDocumentConfirm')
    warning.hidden = false
    warning.querySelector('span').textContent = `此操作会同时删除本集下的 ${childSceneCount} 个分场。删除后仍可在 7 秒内撤销。`
    return
  }
  const removedIds = position.kind === 'episode'
    ? [state.currentDocId, ...(state.structure.episodes[state.currentDocId]?.sceneIds || [])]
    : [state.currentDocId]
  const removedTitle = state.documents[state.currentDocId].title
  const deletedDocumentId = state.currentDocId
  const deletion = {
    kind: position.kind,
    actId: state.structure.acts[position.actIndex]?.id || null,
    episodeId: position.episodeId || deletedDocumentId,
    index: position.kind === 'episode' ? position.episodeIndex : position.sceneIndex,
    episodeStructure: position.kind === 'episode' ? structuredClone(state.structure.episodes[deletedDocumentId]) : null,
    documents: Object.fromEntries(removedIds.map((documentId) => [documentId, structuredClone(state.documents[documentId])])),
    tabContents: Object.fromEntries(removedIds.map((documentId) => [documentId, structuredClone(state.tabContents[documentId])])),
    versions: Object.fromEntries(removedIds.map((documentId) => [documentId, structuredClone(state.versions[documentId] || [])])),
    versionCounters: Object.fromEntries(removedIds.map((documentId) => [documentId, state.versionCounters[documentId] || 0]))
  }

  position.list.splice(position.kind === 'episode' ? position.episodeIndex : position.sceneIndex, 1)
  if (position.kind === 'episode') delete state.structure.episodes[state.currentDocId]
  removedIds.forEach((documentId) => {
    delete state.documents[documentId]
    delete state.tabContents[documentId]
    delete state.versions[documentId]
    delete state.versionCounters[documentId]
  })
  elements.documentDialog.close()
  state.currentDocId = position.kind === 'scene' && state.documents[position.episodeId] ? position.episodeId : 'outline'
  state.activeTab = 'script'
  refreshStructureMetadata()
  renderProjectIdentity()
  updateDocumentView()
  await persistWorkspace()
  showToast(`已删除“${removedTitle}”`, {
    actionLabel: '撤销',
    duration: 7000,
    onAction: async () => {
      if (!await saveImmediately({ announce: false })) return
      if (removedIds.some((documentId) => state.documents[documentId])) {
        showToast('已有同标识的新内容，无法自动恢复；请从历史版本取回')
        return
      }
      const targetAct = deletion.kind === 'episode'
        ? state.structure.acts.find((act) => act.id === deletion.actId) || state.structure.acts[0]
        : null
      const parent = deletion.kind === 'scene' ? state.structure.episodes[deletion.episodeId] : null
      if ((deletion.kind === 'episode' && !targetAct) || (deletion.kind === 'scene' && !parent)) {
        showToast(deletion.kind === 'episode' ? '原分幕已不存在，无法自动恢复' : '原分集已不存在，无法自动恢复')
        return
      }
      Object.assign(state.documents, deletion.documents)
      Object.assign(state.tabContents, deletion.tabContents)
      Object.assign(state.versions, deletion.versions)
      Object.assign(state.versionCounters, deletion.versionCounters)
      if (deletion.kind === 'episode') {
        state.structure.episodes[deletedDocumentId] = deletion.episodeStructure
        targetAct.episodeIds.splice(Math.min(deletion.index, targetAct.episodeIds.length), 0, deletedDocumentId)
      } else {
        parent.sceneIds.splice(Math.min(deletion.index, parent.sceneIds.length), 0, deletedDocumentId)
      }
      state.currentDocId = deletedDocumentId
      state.activeTab = 'script'
      refreshStructureMetadata()
      renderProjectIdentity()
      updateDocumentView()
      await persistWorkspace()
      showToast('已恢复删除的内容')
    }
  })
}

async function advanceStage() {
  const nextDocument = { idea: 'brief', brief: 'world', world: 'characters', characters: 'outline' }[state.currentDocId]
  if (nextDocument) {
    selectDocument(nextDocument)
    showToast(`已进入${state.documents[nextDocument].title}，上一步内容会作为 AI 上下文`)
    return
  }
  if (state.currentDocId === 'outline') {
    if (getEpisodeIds().length < 3) {
      const missingCount = 3 - getEpisodeIds().length
      for (let index = 0; index < missingCount; index += 1) {
        await createStructuredDocument({
          type: 'episode',
          title: `第 ${getEpisodeIds().length + 1} 集 · 待命名`,
          actId: state.structure.acts[0]?.id,
          select: false
        })
      }
      showToast('已从全剧大纲建立 3 集创作骨架')
    }
    selectDocument(getEpisodeIds()[0])
    return
  }
  const kind = getDocumentKind(state.currentDocId)
  if (kind === 'episode') {
    openNewContentDialog({ type: 'scene', parentId: state.currentDocId })
    return
  }
  if (kind === 'scene') openNewContentDialog({ type: 'scene', parentId: getParentEpisodeId(state.currentDocId) })
}

async function handleAction(button, action) {
  switch (action) {
    case 'toggle-theme': {
      const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = nextTheme
      syncThemeControl()
      await persistWorkspace()
      break
    }
    case 'toggle-assistant': {
      if (state.currentView !== 'workspace') switchView('workspace')
      toggleAssistant()
      break
    }
    case 'toggle-explorer': toggleExplorer(); break
    case 'close-drawers': closeDrawers(); break
    case 'focus-assistant': focusAssistant(); break
    case 'open-command': openCommandPalette(); break
    case 'new-project': {
      document.querySelector('#projectLibraryDialog').close()
      openDialog(elements.newProjectDialog)
      break
    }
    case 'project-library': await openProjectLibrary(); break
    case 'toggle-archived-projects': showingArchivedProjects = !showingArchivedProjects; await openProjectLibrary(); break
    case 'archive-project': await archiveCurrentProject(); break
    case 'restore-archived-project': await restoreArchivedProject(button.dataset.projectId); break
    case 'backup-library': await exportLibrary(); break
    case 'recover-library': await recoverPreviousLibrary(); break
    case 'switch-project': await switchProject(button.dataset.projectId); break
    case 'backup-project': await exportProject('json'); break
    case 'export-project': await exportProject('md'); break
    case 'restore-project': document.querySelector('#projectBackupFile').click(); break
    case 'build-semantic-index': await rebuildSemanticIndex(button); break
    case 'clear-semantic-index': {
      semanticBuildSequence += 1
      if (state.knowledgeBusy) break
      const previous = state.knowledge.semantic
      state.knowledge.semantic = null
      state.knowledgeBusy = true
      const saved = await persistWorkspace()
      state.knowledgeBusy = false
      if (!saved) state.knowledge.semantic = previous
      renderKnowledge()
      if (saved) showToast('已关闭语义检索，仍可使用文本检索')
      break
    }
    case 'rename-project': {
      document.querySelector('#renameProjectName').value = state.project.name
      openDialog(document.querySelector('#renameProjectDialog'))
      break
    }
    case 'new-content': openNewContentDialog({
      type: button.dataset.contentType || (getDocumentKind(state.currentDocId) === 'scene' ? 'scene' : 'episode'),
      parentId: button.dataset.parentId || getParentEpisodeId(state.currentDocId),
      actId: button.dataset.actId || null
    }); break
    case 'select-doc': selectDocument(button.dataset.docId); break
    case 'toggle-tree-group': {
      const act = state.structure.acts.find((item) => item.id === button.dataset.actId)
      if (!act) break
      act.collapsed = !act.collapsed
      renderProjectTree()
      await persistWorkspace()
      break
    }
    case 'toggle-focus-mode': {
      const active = elements.appShell.classList.toggle('focus-mode')
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
      showToast(active ? '已进入专注模式' : '已退出专注模式')
      break
    }
    case 'save-snapshot': await saveManualSnapshot(button); break
    case 'show-history': switchTab('history'); break
    case 'restore-version': restoreSelectedVersion(); break
    case 'undo': undoCustom(); break
    case 'redo': redoCustom(); break
    case 'send-prompt': startGeneration(elements.promptInput.value); break
    case 'discard-candidate': discardCandidate(); break
    case 'retry-generation': startGeneration(state.lastPrompt, { clearComposer: false }); break
    case 'accept-candidate': acceptCandidate(); break
    case 'apply-candidate': applyCandidate(button.dataset.applyMode); break
    case 'advance-stage': advanceStage(); break
    case 'edit-document': openDocumentDialog(); break
    case 'move-document-up': moveCurrentDocument(-1); break
    case 'move-document-down': moveCurrentDocument(1); break
    case 'duplicate-document': duplicateCurrentDocument(); break
    case 'delete-document': deleteCurrentDocument(button); break
    case 'sync-knowledge': syncKnowledge(); break
    case 'add-knowledge-source': {
      elements.knowledgeDialog.dataset.refreshSourceId = ''
      state.knowledge.pendingFiles = []
      document.querySelector('#knowledgeImportPreview').textContent = ''
      elements.knowledgeFilePicker.value = ''
      document.querySelector('#sourcePath').value = '尚未选择目录'
      openDialog(elements.knowledgeDialog)
      break
    }
    case 'refresh-knowledge-source': {
      elements.knowledgeDialog.dataset.refreshSourceId = button.dataset.sourceId
      state.knowledge.pendingFiles = []
      document.querySelector('#knowledgeImportPreview').textContent = ''
      elements.knowledgeFilePicker.value = ''
      document.querySelector('#sourcePath').value = '重新选择原目录，同步新增、修改和删除的文件'
      openDialog(elements.knowledgeDialog)
      break
    }
    case 'toggle-knowledge-chunk': {
      const chunkId = button.dataset.chunkId
      const selected = state.knowledge.selectedChunkIds.includes(chunkId)
      state.knowledge.selectedChunkIds = selected
        ? state.knowledge.selectedChunkIds.filter((id) => id !== chunkId)
        : [...state.knowledge.selectedChunkIds, chunkId].slice(-MAX_SELECTED_KNOWLEDGE_CHUNKS)
      syncCurrentDocumentReferences()
      if (!await persistWorkspace()) return
      renderKnowledge()
      showToast(selected ? '已移出本次 AI 上下文' : '已加入本次 AI 上下文')
      break
    }
    case 'remove-knowledge-source': {
      if (state.knowledgeBusy) break
      const previous = structuredClone(state.knowledge)
      const source = state.knowledge.sources.find((item) => item.id === button.dataset.sourceId)
      if (!source || source.kind === 'internal') break
      const removedChunks = state.knowledge.index.chunks.filter((chunk) => chunk.sourceId === source.id)
      state.knowledge.sources = state.knowledge.sources.filter((item) => item.id !== source.id)
      state.knowledge.index.chunks = state.knowledge.index.chunks.filter((chunk) => chunk.sourceId !== source.id)
      const removedIds = new Set(removedChunks.map((chunk) => chunk.id))
      state.knowledge.selectedChunkIds = state.knowledge.selectedChunkIds.filter((id) => !removedIds.has(id))
      state.knowledge.semantic = pruneSemanticIndex(state.knowledge.index, state.knowledge.semantic)
      state.knowledgeBusy = true
      const saved = await persistWorkspace()
      state.knowledgeBusy = false
      if (!saved) { state.knowledge = previous; renderKnowledge(); break }
      renderKnowledge()
      showToast(`已移除“${source.name}”索引；原始文件没有变化`)
      break
    }
    case 'configure-provider': {
      openConnectionDialog(button.dataset.connectionId || null)
      break
    }
    case 'test-connection': testConnection(button); break
    case 'test-all-connections': testAllConnections(button); break
    case 'detect-cli': detectRuntime(); break
    case 'configure-claude': openDialog(document.querySelector('#claudeCredentialDialog')); break
    case 'activate-connection': setActiveConnection(button.dataset.connectionId); break
    case 'open-terminal': showToast('已检测本机 CLI；执行能力将在受控桌面 Runner 中启用'); break
    case 'learn-local-model': openConnectionDialog('ollama-local'); break
    case 'prototype-not-available': showToast('该入口将在正式桌面版开放'); break
    case 'check-updates': await updatesUI.open(); break
    case 'open-shortcuts': openCommandPalette(); break
    case 'close-dialog': closeDialog(button); break
    case 'choose-folder': elements.knowledgeFilePicker.click(); break
    case 'modal-test-connection': {
      testConnectionDraft(button)
      break
    }
  }
}

// Capture before form/tab/shortcut handlers, including while a modal is being closed.
for (const type of ['beforeinput', 'input', 'keydown', 'click', 'submit', 'change', 'drop', 'paste', 'cut', 'cancel']) {
  document.addEventListener(type, blockProjectTransitionInput, true)
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button) return

  if (button.dataset.viewTarget) {
    switchView(button.dataset.viewTarget)
    return
  }

  if (button.dataset.prompt) {
    elements.promptInput.value = button.dataset.prompt
    focusAssistant()
    startGeneration(button.dataset.prompt)
    return
  }

  if (button.dataset.commandView) {
    elements.commandDialog.close()
    switchView(button.dataset.commandView)
    return
  }

  if (button.dataset.commandDoc) {
    elements.commandDialog.close()
    selectDocument(button.dataset.commandDoc)
    return
  }

  if (button.classList.contains('context-chip')) {
    const isPressed = button.getAttribute('aria-pressed') === 'true'
    button.setAttribute('aria-pressed', String(!isPressed))
    renderContextPreview()
    return
  }

  if (button.dataset.action) handleAction(button, button.dataset.action)
})

document.querySelectorAll('.document-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab))
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tabs = [...document.querySelectorAll('.document-tab')]
    const currentIndex = tabs.indexOf(tab)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    void switchTab(tabs[nextIndex].dataset.tab, { focusEditor: false })
  })
})

elements.historyVersionSelect.addEventListener('change', (event) => {
  const versionNumber = Number(event.target.value)
  if (!Number.isInteger(versionNumber)) return
  state.selectedVersionByDocument[state.currentDocId] = versionNumber
  updateDocumentView()
})

elements.scriptEditor.addEventListener('input', () => {
  setCurrentContent(elements.scriptEditor.value)
  updateEditorMetrics()
  renderProjectIdentity()
  scheduleSave()
})

elements.treeSearch.addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase()
  document.querySelectorAll('.tree-item, .scene-item').forEach((item) => {
    item.hidden = Boolean(query) && !item.textContent.toLowerCase().includes(query)
  })
})

document.querySelector('#knowledgeSearch').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase()
  document.querySelectorAll('.source-row').forEach((row) => {
    row.hidden = Boolean(query) && !row.dataset.searchable.toLowerCase().includes(query)
  })
})

document.querySelector('#knowledgeQueryForm').addEventListener('submit', (event) => {
  event.preventDefault()
  searchKnowledge(elements.knowledgeQuery.value)
})

elements.knowledgeFilePicker.addEventListener('change', (event) => {
  state.knowledge.pendingFiles = [...event.target.files]
  const plan = planKnowledgeFiles(state.knowledge.pendingFiles)
  document.querySelector('#knowledgeImportPreview').textContent = `预计收录 ${plan.accepted.length} 个文件${plan.skipped.length ? `，跳过 ${plan.skipped.length} 项：${plan.skipped.map(item => `${item.path}（${item.reason}）`).join('；')}` : '，没有超出限制的文件。'}`
  const firstFile = state.knowledge.pendingFiles[0]
  const rootName = firstFile?.webkitRelativePath?.split('/')[0] || firstFile?.name || '尚未选择目录'
  document.querySelector('#sourcePath').value = state.knowledge.pendingFiles.length
    ? `${rootName} · ${state.knowledge.pendingFiles.length} 个文件`
    : '尚未选择目录'
})

elements.commandInput.addEventListener('input', (event) => filterCommands(event.target.value))
elements.commandInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveCommandHighlight(event.key === 'ArrowDown' ? 1 : -1)
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    document.querySelector('.command-item.is-highlighted')?.click()
  }
})

elements.promptInput.addEventListener('input', () => renderContextPreview())

elements.promptInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    startGeneration(elements.promptInput.value)
  }
})

document.addEventListener('keydown', (event) => {
  const commandKey = event.metaKey || event.ctrlKey
  if (commandKey && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openCommandPalette()
  }
  if (commandKey && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    if (window.matchMedia('(max-width: 899px)').matches) toggleExplorer(true)
    else document.querySelector('#treeSearch').focus()
  }
  if (commandKey && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (state.currentView === 'inspirations') { void inspirationUI.save(); return }
    saveImmediately()
  }
  if (event.key === 'Escape') {
    const openDialogElement = document.querySelector('dialog[open]')
    if (openDialogElement) {
      event.preventDefault()
      openDialogElement.close()
      return
    }
    if (state.isGenerating) {
      stopGeneration()
      return
    }
    closeDrawers()
  }
})

function loadProjectSnapshot(snapshot) {
  elements.toastStack.replaceChildren()
  document.querySelector('#embeddingModel').value = snapshot.workspace.knowledge?.semantic?.model || ''
  discardCandidate({ silent: true })
  window.clearTimeout(state.saveTimer)
  activeProjectId = snapshot.id
  const workspace = snapshot.workspace
  state.connections = normalizeConnections(workspace.connections)
  document.documentElement.dataset.theme = workspace.theme === 'dark' ? 'dark' : 'light'
  syncThemeControl()
  renderConnections()
  document.querySelector('#knowledgeImportReport').textContent = ''
  state.project = normalizeStoredProject(workspace.project)
  const starters = createStarterDocuments(state.project.name, state.project.type)
  state.documents = Object.fromEntries(Object.entries(workspace.documents || {}).map(([id, doc]) => [id, mergeStoredDocument(starters[id] || createGenericDocument(id), doc)]))
  state.structure = normalizeStructure(workspace.structure, state.documents)
  state.tabContents = Object.fromEntries(Object.keys(state.documents).map(id => [id, { ...structuredClone(tabFallbacks), ...workspace.tabContents?.[id] }]))
  state.versions = normalizeStoredVersions(workspace.versions)
  state.versionCounters = workspace.versionCounters || {}
  state.selectedVersionByDocument = {}
  state.editHistories.clear()
  state.knowledge.index = deserializeKnowledgeIndex(JSON.stringify(snapshot.index))
  state.knowledge.semantic = workspace.knowledge?.semantic || null
  state.knowledge.sources = Array.isArray(workspace.knowledge?.sources) ? workspace.knowledge.sources : []
  state.knowledge.selectedChunkIds = workspace.knowledge?.selectedChunkIds || []
  state.knowledge.results = []
  state.knowledge.query = ''
  state.knowledge.pendingFiles = []
  reconcileKnowledgeSelections()
  state.currentDocId = state.documents[workspace.currentDocId] ? workspace.currentDocId : Object.keys(state.documents)[0] || null
  state.activeTab = ['script', 'outline', 'references', 'history'].includes(workspace.activeTab) ? workspace.activeTab : 'script'
  for (const id of Object.keys(state.versions)) {
    if (state.tabContents[id]) state.tabContents[id].history = formatVersionHistory(id)
  }
  elements.promptInput.value = ''
  unsavedEdits = false
  state.storageFailed = false
  setSaveStatus('saved')
  renderProjectIdentity()
  renderKnowledge()
  switchView('workspace')
  updateDocumentView()
}

let showingArchivedProjects = false

async function openProjectLibrary() {
  const list = document.querySelector('#projectList')
  list.replaceChildren()
  const projects = showingArchivedProjects ? listArchivedProjects() : listProjects()
  const metrics = getStorageMetrics()
  document.querySelector('#storageSummary').textContent = `活动库 ${(metrics.activeBytes / 1048576).toFixed(1)} / 64 MiB · 归档 ${(metrics.archiveBytes / 1048576).toFixed(1)} MiB`
  document.querySelector('#archiveViewButton').textContent = showingArchivedProjects ? '返回活动项目' : `查看归档项目（${metrics.archivedCount}）`
  document.querySelector('#archiveViewButton').setAttribute('aria-pressed', String(showingArchivedProjects))
  document.querySelector('#projectCount').textContent = `${projects.length} 个${showingArchivedProjects ? '归档' : '活动'}项目`
  for (const project of projects) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'project-list-item'
    button.dataset.action = showingArchivedProjects ? 'restore-archived-project' : 'switch-project'
    button.dataset.projectId = project.id
    const current = project.id === activeProjectId
    button.classList.toggle('is-current', current)
    if (current) button.setAttribute('aria-current', 'true')
    const details = document.createElement('span')
    details.className = 'project-list-details'
    const name = document.createElement('strong')
    name.textContent = project.name
    const meta = document.createElement('span')
    meta.className = 'project-list-meta'
    const updated = new Date(project.updatedAt)
    meta.textContent = `${project.type} · ${Number.isNaN(updated.getTime()) ? '已保存' : updated.toLocaleDateString('zh-CN')} 更新`
    details.append(name, meta)
    const badge = document.createElement('span')
    badge.className = 'project-list-status'
    badge.textContent = showingArchivedProjects ? '恢复并打开 →' : current ? '当前项目' : '打开项目 →'
    button.append(details, badge)
    list.append(button)
  }
  if (!list.children.length) {
    const empty = document.createElement('div')
    empty.className = 'project-list-empty'
    const title = document.createElement('strong')
    title.textContent = showingArchivedProjects ? '还没有归档项目' : '你的下一个故事，从这里开始'
    const hint = document.createElement('p')
    hint.textContent = showingArchivedProjects ? '完成的项目可归档保存，随时恢复继续创作。' : '新建一个空白项目，或恢复已有备份。'
    empty.append(title, hint)
    list.append(empty)
  }
  document.querySelectorAll('[data-action="backup-project"], [data-action="export-project"], [data-action="rename-project"], [data-action="archive-project"]').forEach(button => { button.disabled = !activeProjectId })
  openDialog(document.querySelector('#projectLibraryDialog'))
}

async function archiveCurrentProject() {
  if (!activeProjectId || projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  setProjectTransition(true)
  try {
    window.clearTimeout(state.saveTimer)
    if (state.activeTab !== 'history') setCurrentContent(elements.scriptEditor.value)
    await archiveProject(activeProjectId, workspaceSnapshot(), state.knowledge.index)
    loadProjectSnapshot(getActiveProject())
    showingArchivedProjects = false
    await openProjectLibrary()
    showToast('项目已归档，已释放活动库空间；可从归档列表恢复')
  } catch (error) { showToast(readableError(error)) }
  finally { setProjectTransition(false) }
}

async function restoreArchivedProject(id) {
  if (projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  setProjectTransition(true)
  try {
    if (!await saveImmediately({ announce: false })) return
    await restoreProject(id)
    loadProjectSnapshot(getActiveProject())
    showingArchivedProjects = false
    document.querySelector('#projectLibraryDialog').close()
    showToast('项目已恢复，可以继续创作')
  } catch (error) { showToast(readableError(error)) }
  finally { setProjectTransition(false) }
}

async function exportLibrary() {
  if (inspirationUI.dirty() && !await inspirationUI.save()) showToast('灵感草稿未保存；此次仍会导出已保存的全部内容')
  // Export the committed library even if current draft persistence fails; also preserve that draft separately.
  const saved = await saveImmediately({ announce: false })
  if (!saved && activeProjectId) await exportProject('json')
  try { showToast(`完整备份已导出：${await downloadDocument('创作工作台完整备份.json', libraryBackup())}`) }
  catch (error) { showToast(readableError(error, '完整备份失败')) }
}

async function recoverPreviousLibrary() {
  if (projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  setProjectTransition(true)
  window.clearTimeout(state.saveTimer)
  try {
    const previous = await readPreviousLibrary()
    if (!previous.available) return showToast('还没有上一份内部快照')
    if (!window.confirm(`将恢复上一份内部快照：${previous.activeProjects} 个活动项目、${previous.archivedProjects} 个归档项目、${previous.inspirations} 条灵感。当前已保存数据会成为新的上一份快照。未保存修改请先导出备份。继续？`)) return
    loadProjectSnapshot(await restorePreviousLibrary())
    inspirationUI.reset()
    unsavedEdits = false
    state.storageFailed = false
    setSaveStatus('saved')
    await openProjectLibrary()
    showToast('已恢复内部快照；再次恢复可回到恢复前的已保存数据')
  } catch (error) { showToast(readableError(error)) }
  finally { setProjectTransition(false) }
}

async function switchProject(id) {
  if (projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy() || id === activeProjectId) return
  setProjectTransition(true)
  try {
    if (!await saveImmediately({ announce: false })) return
    await activateProject(id)
    loadProjectSnapshot(getActiveProject())
    document.querySelector('#projectLibraryDialog').close()
    showToast('已切换项目')
  } catch (error) {
    showToast(readableError(error))
  } finally { setProjectTransition(false) }
}

async function exportProject(format) {
  if (!activeProjectId) return
  if (state.activeTab !== 'history') setCurrentContent(elements.scriptEditor.value)
  const workspace = workspaceSnapshot()
  const content = format === 'json' ? projectBackup(workspace, state.knowledge.index)
    : projectMarkdown(workspace)
  try {
    const path = await downloadDocument(`${state.project.name}.${format}`, content)
    showToast(`已导出到：${path}`)
  } catch (error) { showToast(readableError(error, '导出失败')) }
}

document.querySelector('#newProjectForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  const projectName = String(new FormData(event.currentTarget).get('projectName') || '').trim()
  const contentType = String(new FormData(event.currentTarget).get('contentType') || '短剧')
  if (!projectName || projectName.length > 100) return showToast('项目名称须为 1–100 个字符')
  setProjectTransition(true)
  try {
    if (!await saveImmediately({ announce: false })) return
    await createProject({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      project: { name: projectName, type: contentType, stage: `${contentType} · 新项目`, template: 'blank' },
      documents: createStarterDocuments(projectName, contentType),
      structure: createBlankStructure(), currentDocId: 'idea', activeTab: 'script',
      tabContents: {}, versions: {}, versionCounters: {}, knowledge: { sources: [], selectedChunkIds: [] }
    }, createKnowledgeIndex([]))
    loadProjectSnapshot(getActiveProject())
    elements.newProjectDialog.close()
    showToast(`已创建“${projectName}”，已有项目已保留`)
  } catch (error) { showToast(readableError(error, '创建失败')) }
  finally { setProjectTransition(false) }
})

document.querySelector('#renameProjectForm').addEventListener('submit', async event => {
  event.preventDefault()
  const name = document.querySelector('#renameProjectName').value.trim()
  if (projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  setProjectTransition(true)
  try {
    if (!await saveImmediately({ announce: false })) return
    await renameProject(activeProjectId, name)
    state.project.name = name
    renderProjectIdentity()
    document.querySelector('#renameProjectDialog').close()
    await openProjectLibrary()
  } catch (error) { showToast(readableError(error)) }
  finally { setProjectTransition(false) }
})

document.querySelector('#projectBackupFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  setProjectTransition(true)
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('备份超过 512 MiB')
    const text = await file.text()
    const fullLibrary = JSON.parse(text)?.format === 'ai-creator-workbench-library'
    const data = fullLibrary ? parseLibraryBackup(text) : parseBackup(text)
    if (!await saveImmediately({ announce: false })) return
    if (fullLibrary) { await importLibraryBackup(data); inspirationUI.render() }
    else await createProject(data.workspace, data.index)
    loadProjectSnapshot(getActiveProject())
    document.querySelector('#projectLibraryDialog').close()
    showToast(fullLibrary ? '完整备份已合并为独立副本，原有项目与灵感保留' : '备份已恢复为独立项目，原项目未被覆盖')
  } catch (error) { showToast(readableError(error, '恢复失败')) }
  finally { setProjectTransition(false) }
})

document.querySelector('#newContentType').addEventListener('change', syncNewContentType)

document.querySelector('#newContentForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const formData = new FormData(event.currentTarget)
  const type = String(formData.get('contentType') || 'episode')
  const title = String(formData.get('title') || '').trim()
  const parentId = String(formData.get('parentId') || '')
  if (!title) {
    document.querySelector('#newContentName').focus()
    return
  }
  if (type === 'scene' && !state.structure.episodes[parentId]) {
    showToast('请选择一个有效分集')
    return
  }
  const documentId = await createStructuredDocument({ type, title, parentId, actId: event.currentTarget.dataset.actId })
  if (!documentId) {
    showToast('创建失败，请检查所属分集')
    return
  }
  elements.newContentDialog.close()
  showToast(`已创建“${title}”`)
})

document.querySelector('#documentForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const formData = new FormData(event.currentTarget)
  const documentData = getCurrentDocument()
  const title = String(formData.get('title') || '').trim()
  if (!title) {
    document.querySelector('#documentName').focus()
    return
  }
  documentData.title = title
  documentData.sceneTitle = title
  documentData.intent = String(formData.get('intent') || '').trim() || documentData.intent
  documentData.kicker = String(formData.get('kicker') || '').trim() || documentData.kicker
  const meta = String(formData.get('meta') || '').split(/[，,]/).map((item) => item.trim()).filter(Boolean).slice(0, 8)
  documentData.meta = meta.length ? meta : ['待完善']
  documentData.badge = '创作中'
  elements.documentDialog.close()
  renderProjectIdentity()
  updateDocumentView()
  await persistWorkspace()
  showToast('内容信息已更新')
})

document.querySelector('#connectionKind').addEventListener('change', (event) => {
  invalidateConnectionDraftTest()
  document.querySelector('#connectionForm').dataset.testStatus = ''
  document.querySelector('#connectionForm').dataset.lastLatency = ''
  document.querySelector('#connectionForm').dataset.dirty = 'true'
  const isOllama = event.target.value === 'ollama'
  document.querySelector('#apiKeyField').hidden = isOllama
  if (isOllama) {
    if (!document.querySelector('#connectionName').value.trim() || document.querySelector('#connectionName').value === '我的模型') {
      document.querySelector('#connectionName').value = 'Ollama'
    }
    document.querySelector('#baseUrl').value = 'http://127.0.0.1:11434'
    document.querySelector('#modelName').value = state.connections.find((connection) => connection.kind === 'ollama')?.model || ''
  }
})

;['connectionName', 'baseUrl', 'modelName', 'apiKey'].forEach((fieldId) => {
  document.querySelector(`#${fieldId}`).addEventListener('input', () => {
    invalidateConnectionDraftTest()
    const form = document.querySelector('#connectionForm')
    form.dataset.dirty = 'true'
    if (!form.dataset.testStatus) return
    form.dataset.testStatus = ''
    form.dataset.lastLatency = ''
    elements.connectionTestStatus.replaceChildren(createIcon('icon-alert'), document.createTextNode('配置已修改，保存后请重新测试'))
  })
})

elements.connectionDialog.addEventListener('cancel', invalidateConnectionDraftTest)
elements.connectionDialog.addEventListener('close', invalidateConnectionDraftTest)

document.querySelector('#executorSelect').addEventListener('change', (event) => setActiveConnection(event.target.value))

document.querySelector('#connectionForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const draft = getConnectionDraft()
  const existingIndex = state.connections.findIndex((connection) => connection.id === draft.id)
  const existing = state.connections[existingIndex]
  const endpointChanged = hasConnectionEndpointChanged(draft, existing)
  const isDirty = event.currentTarget.dataset.dirty === 'true'
  draft.isActive = existing?.isActive || !state.connections.some((connection) => connection.isActive)
  draft.status = event.currentTarget.dataset.testStatus || (!isDirty && existing?.status === 'ready' ? 'ready' : 'unknown')
  draft.lastLatency = Number(event.currentTarget.dataset.lastLatency) || (!isDirty ? existing?.lastLatency : null) || null
  const secret = document.querySelector('#apiKey').value
  draft.rememberSecret = isDesktopRuntime && draft.kind === 'openai-compatible' && document.querySelector('#rememberApiKey').checked
  try {
    validateProviderBaseUrl(draft.kind, draft.baseUrl)
    if (isDesktopRuntime && draft.kind === 'openai-compatible') {
      if (draft.rememberSecret) {
        const value = secret || (!endpointChanged && existing ? await connectionSecret(existing) : '')
        if (!value) throw new Error('请填写需要保存的 API Key')
        await invokeDesktop('credential_save', { id: draft.id, endpoint: draft.baseUrl, secret: value })
      } else if (existing?.rememberSecret) {
        await invokeDesktop('credential_save', { id: existing.id, endpoint: existing.baseUrl, secret: '' })
      }
    }
  } catch (error) { showToast(readableError(error)); return }
  if (existingIndex >= 0) state.connections.splice(existingIndex, 1, draft)
  else state.connections.push(draft)
  if (endpointChanged) sessionSecrets.delete(draft.id)
  if (draft.kind === 'openai-compatible' && secret) sessionSecrets.set(draft.id, secret)
  document.querySelector('#apiKey').value = ''
  elements.connectionDialog.close()
  await persistWorkspace()
  renderConnections()
  showToast(draft.rememberSecret ? '连接已保存，密钥保存在 macOS 钥匙串' : '连接已保存；密钥仅用于当前会话')
})

document.querySelector('#claudeCredentialForm').addEventListener('submit', async event => {
  event.preventDefault()
  const input = document.querySelector('#claudeApiKey')
  const secret = input.value.trim()
  if (!isDesktopRuntime || !secret) return
  const rememberSecret = document.querySelector('#rememberClaudeKey').checked
  try {
    let connection = state.connections.find(item => item.id === 'cli-claude')
    if (rememberSecret || connection?.rememberSecret) await invokeDesktop('credential_save', { id: 'cli-claude', endpoint: '', secret: rememberSecret ? secret : '' })
    if (!connection) {
      connection = { id: 'cli-claude', kind: 'cli', driverId: 'claude', name: 'Claude Code', baseUrl: '', model: '', status: 'unknown', capabilities: ['受控 CLI'], isActive: false }
      state.connections.push(connection)
    }
    connection.rememberSecret = rememberSecret
    sessionSecrets.set(connection.id, secret)
    input.value = ''
    if (!await persistWorkspace()) return
    document.querySelector('#claudeCredentialDialog').close()
    await detectRuntime()
    showToast('凭据已保存；请选择已检测到的 Claude CLI 执行创作')
  } catch (error) { showToast(readableError(error)) }
})

document.querySelector('#knowledgeForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const submitButton = event.currentTarget.querySelector('[type="submit"]')
  submitButton.disabled = true
  submitButton.textContent = '正在建立索引…'
  try {
    const result = await indexPendingKnowledgeFiles()
    elements.knowledgeDialog.close()
    switchView('knowledge')
    const chunkCopy = result.chunkCount < result.totalChunkCount
      ? `${result.chunkCount}/${result.totalChunkCount} 个片段（已按原型上限保留）`
      : `${result.chunkCount} 个片段`
    showToast(`已索引“${result.sourceName}”：${result.fileCount} 个文件、${chunkCopy}；未自动加入 AI 上下文`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '知识索引建立失败')
  } finally {
    submitButton.disabled = false
    submitButton.textContent = '添加并建立索引'
  }
})

document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return
    const bounds = dialog.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close()
  })
  dialog.addEventListener('close', () => {
    if (dialog === elements.connectionDialog) document.querySelector('#apiKey').value = ''
    if (dialog.id === 'claudeCredentialDialog') document.querySelector('#claudeApiKey').value = ''
    if (dialog === elements.commandDialog) {
      elements.commandInput.setAttribute('aria-expanded', 'false')
      elements.commandInput.removeAttribute('aria-activedescendant')
    }
    if (dialogReturnFocus instanceof HTMLElement) dialogReturnFocus.focus()
    dialogReturnFocus = null
  })
})

window.addEventListener('resize', () => {
  if (!window.matchMedia('(max-width: 1099px)').matches) {
    elements.appShell.classList.remove('assistant-open')
  }
  if (!window.matchMedia('(max-width: 899px)').matches) elements.appShell.classList.remove('explorer-open')
  syncAssistantAccessibility()
})

document.documentElement.dataset.theme = storedWorkspace.theme === 'dark' ? 'dark' : 'light'
window.addEventListener('beforeunload', event => {
  if (unsavedEdits || pendingSaves || state.storageFailed || inspirationUI.dirty()) {
    event.preventDefault()
    if (inspirationUI.dirty()) {
      switchView('inspirations')
      showToast('灵感有未保存修改或正在保存，请保存完成后再关闭窗口')
      return
    }
    event.returnValue = ''
  }
})
if (isDesktopRuntime && window.__TAURI__.window?.getCurrentWindow) {
  const appWindow = window.__TAURI__.window.getCurrentWindow()
  let closeRequestActive = false
  appWindow.onCloseRequested(async event => {
    event.preventDefault()
    if (closeRequestActive) return
    closeRequestActive = true
    try {
    if (projectTransition || state.candidateApplying || state.knowledgeBusy) return showToast('内容正在保存，请稍候再关闭')
    if (inspirationUI.dirty() && !await inspirationUI.save()) {
      switchView('inspirations')
      showToast('灵感尚未保存，请补全标题与正文后再关闭')
      return
    }
    if (await saveImmediately({ announce: false }) && !unsavedEdits && !pendingSaves && !inspirationUI.dirty()) await appWindow.destroy()
    } finally { closeRequestActive = false }
  }).catch(error => showToast(readableError(error, '关闭前保存监听失败，请手动保存')))
}
document.querySelectorAll('svg.icon').forEach((icon) => icon.setAttribute('aria-hidden', 'true'))
syncThemeControl()
document.querySelector('#claudeCredentialButton').hidden = !isDesktopRuntime
document.querySelector('#embeddingModel').value = state.knowledge.semantic?.model || ''
renderProjectIdentity()
renderKnowledge()
renderConnections()
updateDocumentView()
syncAssistantAccessibility()
detectRuntime()

const inspirationUI = initializeInspirations({
  appendToProject: async item => {
    if (!activeProjectId || !state.documents.idea) throw new Error('请先创建或打开一个项目；灵感已独立保存，不会丢失。')
    const projectId = activeProjectId
    if (!await saveImmediately({ announce: false })) throw new Error('项目保存失败，尚未追加，请重试。')
    if (projectId !== activeProjectId || projectTransition) throw new Error('项目已切换，请在目标项目中重新追加。')
    const original = state.documents.idea.content
    state.documents.idea.content = [original, `${item.title}\n\n${item.content}`].filter(Boolean).join('\n\n')
    if (!await persistWorkspace()) {
      state.documents.idea.content = original
      throw new Error('追加保存失败，请重试。')
    }
    abandonCandidateOnContextChange('idea', 'script')
    state.currentDocId = 'idea'
    state.activeTab = 'script'
    updateDocumentView()
    switchView('workspace')
    showToast('灵感已追加到核心灵感，原文保留')
  }
})

const updatesUI = initializeUpdates({ invoke: isDesktopRuntime ? invokeDesktop : null, openDialog })
