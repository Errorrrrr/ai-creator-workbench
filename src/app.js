import { validateCliProxy } from './cli-proxy.js'
import {
  createKnowledgeIndex,
  deserializeKnowledgeIndex,
  searchKnowledgeIndex,
  serializeKnowledgeIndex
} from './knowledge-index.js'
import { initializeProjects, getActiveProject, listProjects, saveProject, createProject, activateProject, renameProject, projectBackup, parseBackup, downloadDocument, archiveProject, restoreProject, deleteProject, listArchivedProjects, libraryBackup, parseLibraryBackup, importLibraryBackup, readPreviousLibrary, restorePreviousLibrary, getStorageMetrics, rawLibrarySnapshot, MAX_BACKUP_BYTES, validateWorkspace } from './project-store.js'
import { buildSemanticIndex, semanticSearch, pruneSemanticIndex, semanticIndexCoverage } from './semantic-search.js'
import { initializeInspirations } from './inspirations.js'
import { initializeUpdates } from './update-ui.js'
import { consumeProviderStream, fetchProviderResponse, providerEndpointUrl, validateProviderBaseUrl } from './provider-stream.js'
import { GENERATION_CHARACTER_LIMIT, prepareGeneration, prepareVersionRestore, projectMarkdown, planKnowledgeFiles } from './creation-workflow.js'
import { contentFingerprint, storyboardSourceFingerprint, emptyStoryboard, normalizeStoryboard, normalizeWorkflow, resolveConnectionRoute, supportsCapability, validateStoryboard } from './storyboard.js'
import { initializeMediaWorkbench } from './media-workbench.js'
import { configuredMediaAdapterId, mediaAdapterFor, mediaAdaptersForKind } from './media-adapters.js'
import { OPERATION_CONTEXT_RESERVE, captureOperationContext, materializeOperationPlan, prepareOperationRequest } from './project-operations.js'
import { initializeProjectPlanUI } from './project-plan-ui.js'
import { creationSteps, initializeCreationNavigation } from './workflow-navigation.js'
import { candidateGeneratedAtLabel, MAX_CANDIDATE_DRAFTS, candidateDraftsFor, upsertCandidateDraft, removeCandidateDraft } from './candidate-drafts.js'
import { createReviewDiff } from './review-diff.js'

let mediaWorkbench = null
let projectPlanUI = null
let creationNavigation = null
const isProjectView = view => ['workspace', 'storyboard', 'assets'].includes(view)

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
let updateInstalling = false
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
  if (!projectTransition || (updateInstalling && event.target?.closest?.('#updateDialog'))) return
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
    if (!secret && connection.kind === 'cli' && connection.driverId === 'claude') throw new Error('工作台保存的 Claude Key 未找到，请重新配置或移除工作台 Key；未切换到其他凭据')
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
    if (!['openai-compatible', 'ollama', 'cli', 'image-api', 'video-api'].includes(connection.kind)) return null
    return {
      id: connection.id,
      kind: connection.kind,
      name: typeof connection.name === 'string' && connection.name.trim() ? connection.name.trim() : '未命名连接',
      baseUrl: typeof connection.baseUrl === 'string' ? connection.baseUrl : '',
      model: typeof connection.model === 'string' ? connection.model : '',
      ...(connection.kind === 'cli' && connection.driverId === 'codex' ? { planningModel: typeof connection.planningModel === 'string' ? connection.planningModel.trim() : '' } : {}),
      adapter: configuredMediaAdapterId(connection),
      driverId: connection.kind === 'cli' && typeof connection.driverId === 'string' ? connection.driverId : null,
      status: 'unknown',
      ...(connection.kind === 'cli' ? { lastExecution: connection.lastExecution && ['ready', 'auth_failed', 'error'].includes(connection.lastExecution.status) ? { status: connection.lastExecution.status, error: typeof connection.lastExecution.error === 'string' ? connection.lastExecution.error : null, at: typeof connection.lastExecution.at === 'string' ? connection.lastExecution.at : null } : null } : {}),
      capabilities: Array.isArray(connection.capabilities) ? connection.capabilities.filter((item) => typeof item === 'string').slice(0, 6) : [],
      isActive: Boolean(connection.isActive),
      defaultFor: [...new Set(Array.isArray(connection.defaultFor) ? connection.defaultFor.filter(capability => ['image', 'video'].includes(capability)) : [])],
      rememberSecret: Boolean(connection.rememberSecret),
      error: null
    }
  }).filter(Boolean)
  if (!connections.some((connection) => ['openai-compatible', 'ollama'].includes(connection.kind))) {
    connections.unshift({ ...structuredClone(defaultConnections[0]), isActive: !connections.length, defaultFor: [] })
  }
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
  workflowStep: null,
  project: initialProject,
  documents: initialDocuments,
  structure: normalizeStructure(storedWorkspace.structure, initialDocuments),
  connections: normalizeConnections(storedWorkspace.connections),
  workflow: normalizeWorkflow(storedWorkspace.workflow),
  storyboard: normalizeStoryboard(storedWorkspace.storyboard),
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
  generationInFlight: null,
  generationAbortController: null,
  generationSequence: 0,
  activeGenerationId: null,
  generationText: '',
  generationContext: null,
  candidateDrafts: structuredClone(storedWorkspace.candidateDrafts || []),
  activeCandidateId: null,
  candidateCreatedAt: null,
  candidateStatus: 'partial',
  candidateSaveTimer: null,
  contextReferenceKeys: [],
  excludedContextKeys: new Map(),
  includeCurrentContext: true,
  includeSelectionContext: false,
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

// View preferences stay separate from project data and generated candidates.
let assistantExpanded = false
const coreNavigationState = new Map()
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
  rememberCurrentCandidate()
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
    candidateDrafts: state.candidateDrafts,
    connections: state.connections.map(connection => ({ ...connection, status: 'unknown', error: null })),
    workflow: state.workflow,
    storyboard: state.storyboard,
    knowledge: { sources: state.knowledge.sources, selectedChunkIds: state.knowledge.selectedChunkIds, semantic: state.knowledge.semantic },
    theme: document.documentElement.dataset.theme
  }
}

let saveSequence = 0
let pendingSaves = 0
let unsavedEdits = false
let editRevision = 0
async function persistWorkspace({ onError } = {}) {
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
    const message = readableError(error, '保存失败，请先导出备份')
    showToast(message)
    onError?.(message)
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
  if (CORE_DOCUMENT_IDS.includes(documentId) || documentId === 'draft') return 'core'
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
  const coreSection = document.createElement('details')
  coreSection.className = 'tree-section tree-core-details'
  const isCoreDocument = CORE_DOCUMENT_IDS.concat('draft').includes(state.currentDocId)
  const coreState = coreNavigationState.get(activeProjectId) || { open: isCoreDocument || !getEpisodeIds().length, documentId: state.currentDocId }
  if (coreState.documentId !== state.currentDocId && isCoreDocument) coreState.open = true
  coreState.documentId = state.currentDocId
  coreNavigationState.set(activeProjectId, coreState)
  coreSection.open = coreState.open
  coreSection.addEventListener('toggle', () => {
    if (coreSection.isConnected && !elements.treeSearch.value.trim()) coreState.open = coreSection.open
  })
  const coreHeading = document.createElement('summary')
  coreHeading.className = 'tree-section-heading'
  const coreLabel = document.createElement('span')
  coreLabel.textContent = '前期创作'
  coreHeading.append(coreLabel)
  const coreList = document.createElement('div')
  coreList.className = 'tree-list'
  coreList.setAttribute('role', 'tree')
  coreList.setAttribute('aria-label', '前期创作内容')
  CORE_DOCUMENT_IDS.concat('draft').forEach((documentId) => {
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
    group.dataset.actId = act.id
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
          sceneNumber.className = 'scene-number'
          sceneNumber.textContent = `${episodeIndex + 1}-${sceneIndex + 1}`
          const sceneName = document.createElement('span')
          sceneName.className = 'scene-name'
          sceneName.textContent = scene.sceneTitle || scene.title
          sceneButton.title = sceneName.textContent
          sceneButton.append(sceneNumber, sceneName)
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
  filterProjectTree()
}

function filterProjectTree() {
  const query = elements.treeSearch.value.trim().toLowerCase()
  elements.projectTree.querySelectorAll('.tree-item, .scene-item').forEach(item => {
    item.hidden = Boolean(query) && !item.textContent.toLowerCase().includes(query)
  })
  elements.projectTree.querySelectorAll('.tree-section').forEach(section => {
    const hasMatch = [...section.querySelectorAll('.tree-item, .scene-item')].some(item => !item.hidden)
    section.hidden = Boolean(query) && !hasMatch
    if (section.classList.contains('tree-core-details')) {
      section.open = query ? hasMatch : Boolean(coreNavigationState.get(activeProjectId)?.open)
    }
  })
  elements.projectTree.querySelectorAll('.tree-group-content').forEach(group => {
    const act = state.structure.acts.find(item => item.id === group.dataset.actId)
    group.hidden = query ? false : Boolean(act?.collapsed)
    group.closest('.tree-section').querySelector('.tree-section-toggle')?.setAttribute('aria-expanded', String(!group.hidden))
  })
  elements.projectTree.querySelectorAll('.scene-add-button, .tree-add-button').forEach(button => { button.hidden = Boolean(query) })
}

function updateStageAdvanceButton() {
  if (!elements.stageAdvanceButton) return
  const kind = getDocumentKind(state.currentDocId)
  const labelByDocument = {
    idea: '进入创作简报', brief: '完善世界观', world: '塑造人物', characters: '形成全剧大纲', outline: '拆分为分集'
  }
  const textLabel = { idea: '进入创作简报', brief: '整理大纲', outline: '开始正文', draft: '审阅与导出' }
  const label = (state.workflow.preset === 'text' ? textLabel[state.currentDocId] : null) || (state.currentDocId === 'outline' ? '开始剧本创作' : labelByDocument[state.currentDocId])
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
  creationNavigation?.render()

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

function formatVersionHistory(documentId, entries = state.versions[documentId]) {
  entries = Array.isArray(entries) ? entries : []
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
  if (projectTransition || state.candidateApplying || state.isGenerating) return
  const entry = getSelectedHistoryVersion()
  if (!entry) {
    showToast('当前文档还没有可恢复的快照')
    return
  }
  const documentId = state.currentDocId
  const targetTab = entry.tabName || 'script'
  const previousText = getContentAt(documentId, targetTab)
  if (previousText === entry.content) {
    showToast(`v${entry.number} 与当前内容相同，无需恢复`)
    return
  }
  const owner = activeProjectId
  state.candidateApplying = true
  setProjectTransition(true)
  try {
    if (!await saveImmediately({ announce: false })) return
    const prepared = prepareVersionRestore(workspaceSnapshot(), documentId, entry)
    const next = prepared.workspace
    next.tabContents[documentId].history = formatVersionHistory(documentId, next.versions[documentId])
    validateWorkspace(next, state.knowledge.index)
    setSaveStatus('saving')
    await saveProject(owner, next, state.knowledge.index)
    const history = getEditHistory(documentId, targetTab)
    history.undo.push({ before: prepared.previousText, after: entry.content })
    history.redo.length = 0
    setContentAt(documentId, targetTab, entry.content)
    state.versions[documentId] = next.versions[documentId]
    state.versionCounters[documentId] = prepared.restoredNumber
    state.selectedVersionByDocument[documentId] = prepared.restoredNumber
    state.tabContents[documentId].history = next.tabContents[documentId].history
    abandonCandidateOnContextChange(documentId, targetTab)
    state.activeTab = targetTab
    editRevision += 1
    state.storageFailed = false
    unsavedEdits = false
    updateDocumentView({ keepFocus: true })
    showToast(`已恢复为 v${prepared.restoredNumber}；恢复前内容保留在 v${prepared.beforeNumber}`)
  } catch (error) {
    state.storageFailed = true
    setSaveStatus('error')
    showToast(`恢复未保存，当前内容和历史均保留：${readableError(error)}`)
  } finally {
    state.candidateApplying = false
    setProjectTransition(false)
  }
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
  elements.sceneTitle.hidden = !documentData.sceneTitle || documentData.sceneTitle === documentData.title
  elements.sceneIntent.querySelector('p').textContent = documentData.intent
  elements.sceneIntent.querySelector('.scene-meta').replaceChildren(
    ...documentData.meta.map((value) => {
      const item = document.createElement('span')
      item.textContent = value
      return item
    })
  )
  const isReadOnly = state.activeTab === 'history'
  const characterImageButton = document.querySelector('#characterImageButton')
  if (characterImageButton) characterImageButton.hidden = state.currentDocId !== 'characters' || state.activeTab !== 'script'
  const historyEntry = renderHistoryControls()
  elements.scriptEditor.value = isReadOnly && historyEntry ? historyEntry.content : getCurrentContent()
  elements.scriptEditor.readOnly = isReadOnly
  elements.scriptEditor.setAttribute('aria-readonly', String(isReadOnly))
  elements.scriptEditor.closest('.editor-paper').classList.toggle('is-readonly', isReadOnly)
  document.querySelector('.editor-label').textContent = isReadOnly && historyEntry ? `版本 v${historyEntry.number} 快照（只读）` : isReadOnly ? '历史版本（只读）' : state.activeTab === 'references' ? '参考笔记' : '正文'
  syncCurrentDocumentReferences()
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
  restoreDocumentCandidate()
  updateStageAdvanceButton()
  creationNavigation?.render()
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
  window.clearTimeout(state.candidateSaveTimer)
  state.candidateSaveTimer = null
  if (state.activeTab !== 'history') setCurrentContent(elements.scriptEditor.value)
  const saved = await persistWorkspace()
  if (announce) showToast(saved ? '当前内容已保存到本地' : '本地保存失败，请复制内容后重试')
  return saved
}

async function selectDocument(documentId, { keepStoryboard = false } = {}) {
  if (projectTransition) return false
  if (state.candidateApplying) { showToast('正在保存候选，请稍候再切换内容'); return false }
  if (!state.documents[documentId]) return false
  if (keepStoryboard && mediaWorkbench?.isStoryboardBusy?.()) {
    mediaWorkbench.selectDocument(documentId); switchView('storyboard'); return true
  }
  if (state.isGenerating && documentId !== state.currentDocId) stopGeneration()
  const projectId = activeProjectId
  if (!await saveImmediately({ announce: false })) return false
  if (projectTransition || projectId !== activeProjectId) return false
  abandonCandidateOnContextChange(documentId, 'script')
  state.workflowStep = null
  state.currentDocId = documentId
  state.activeTab = 'script'
  if (keepStoryboard) mediaWorkbench?.selectDocument?.(documentId)
  switchView(keepStoryboard ? 'storyboard' : 'workspace')
  updateDocumentView({ keepFocus: true })
  const saved = await persistWorkspace()
  closeDrawers()
  return saved
}

async function navigateCreationStep(step) {
  if (!activeProjectId || projectTransition || state.candidateApplying) return false
  const owner = activeProjectId
  if (step.id === 'script') {
    const current = getDocumentKind(state.currentDocId)
    const target = ['episode', 'scene'].includes(current) ? state.currentDocId : getEpisodeIds()[0]
    if (!target) { openNewContentDialog({ type: 'episode' }); return false }
    return selectDocument(target)
  }
  if (step.id === 'draft' && !state.documents.draft) {
    if (state.isGenerating) throw new Error('请先等待或停止当前文字任务，再创建正文')
    if (!await saveImmediately({ announce: false }) || owner !== activeProjectId || projectTransition) return false
    state.candidateApplying = true; setProjectTransition(true)
    try {
      const next = structuredClone(workspaceSnapshot())
      next.documents.draft = { ...createGenericDocument('draft', '正文'), intent: '按创作简报和大纲完成内容，保留自己的表达与事实依据。', meta: [state.project.type] }
      next.tabContents.draft = structuredClone(tabFallbacks)
      next.versions.draft = []; next.versionCounters.draft = 0
      next.currentDocId = 'draft'; next.activeTab = 'script'
      validateWorkspace(next, state.knowledge.index)
      await saveProject(owner, next, state.knowledge.index)
      abandonCandidateOnContextChange('draft', 'script')
      for (const key of ['documents', 'tabContents', 'versions', 'versionCounters', 'currentDocId', 'activeTab']) state[key] = next[key]
      renderProjectIdentity(); switchView('workspace'); updateDocumentView()
      setSaveStatus('saved')
    } finally { state.candidateApplying = false; setProjectTransition(false) }
  } else if (step.documentId || step.id === 'source') {
    const target = step.documentId || state.currentDocId
    if (!state.documents[target]) throw new Error('此项目没有对应文档，请从目录选择已有内容或创建新内容')
    if (!await selectDocument(target)) return false
  } else {
    if (!await saveImmediately({ announce: false }) || owner !== activeProjectId || projectTransition) return false
    switchView(step.view || (step.id === 'export' && state.storyboard.shots.length ? 'storyboard' : 'workspace'))
    closeDrawers()
  }
  state.workflowStep = step.id
  if (['storyboard', 'images', 'videos', 'export'].includes(step.id) && state.currentView === 'storyboard') mediaWorkbench?.showStage(step.id)
  creationNavigation?.render()
  return true
}

async function switchTab(tabName, { focusEditor = true } = {}) {
  if (projectTransition) return
  if (state.candidateApplying) return showToast('正在保存候选，请稍候再切换视图')
  if (!Object.hasOwn(tabFallbacks, tabName) && tabName !== 'script') return
  if (state.isGenerating && tabName !== state.activeTab) stopGeneration()
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
  if (['storyboard', 'assets'].includes(viewName)) mediaWorkbench?.refresh()
  if (state.currentView !== viewName) state.workflowStep = null
  state.currentView = viewName
  elements.appShell.dataset.currentView = viewName
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.hidden = panel !== view
  })
  document.querySelectorAll('.rail-button[data-view-target]').forEach((button) => {
    const isActive = button.dataset.viewTarget === viewName || (button.dataset.viewTarget === 'workspace' && isProjectView(viewName))
    button.classList.toggle('is-active', isActive)
    if (isActive) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
  document.querySelectorAll('.project-modes [data-view-target]').forEach(button => {
    if (button.dataset.viewTarget === viewName) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
  elements.appShell.classList.toggle('secondary-view', !isProjectView(viewName))
  creationNavigation?.render()
  if (!isProjectView(viewName)) closeDrawers({ preserveAssistant: true })
  else syncAssistantAccessibility()
  const focusTarget = elements.appShell.classList.contains('assistant-open') ? elements.promptInput : document.querySelector('#workspaceMain')
  focusTarget.focus({ preventScroll: true })
  window.requestAnimationFrame(() => { view.scrollTop = 0 })
}

function toggleAssistant(forceOpen) {
  const usesDrawer = window.matchMedia('(max-width: 1399px)').matches
  const wasOpen = assistantExpanded
  const focusInside = elements.assistantPanel.contains(document.activeElement)
  assistantExpanded = typeof forceOpen === 'boolean' ? forceOpen : !wasOpen
  if (assistantExpanded && !wasOpen && !(usesDrawer && elements.appShell.classList.contains('explorer-open'))) rememberDrawerOpener()
  if (usesDrawer && assistantExpanded) elements.appShell.classList.remove('explorer-open')
  syncAssistantAccessibility()
  if (usesDrawer && assistantExpanded) window.setTimeout(() => elements.promptInput.focus(), 0)
  else if (wasOpen && (usesDrawer || focusInside)) restoreDrawerFocus()
}

function syncAssistantAccessibility() {
  const usesDrawer = window.matchMedia('(max-width: 1399px)').matches
  const projectVisible = !elements.appShell.classList.contains('no-project') && isProjectView(state.currentView)
  if (elements.appShell.classList.contains('no-project')) assistantExpanded = false
  if (!projectVisible) elements.appShell.classList.remove('explorer-open')
  elements.appShell.classList.toggle('assistant-collapsed', !assistantExpanded)
  elements.appShell.classList.toggle('assistant-open', usesDrawer && assistantExpanded && projectVisible)
  const isOpen = projectVisible && (usesDrawer
    ? elements.appShell.classList.contains('assistant-open')
    : !elements.appShell.classList.contains('assistant-collapsed'))
  const topbarToggle = document.querySelector('.titlebar [data-action="toggle-assistant"]')
  topbarToggle.setAttribute('aria-expanded', String(isOpen))
  topbarToggle.setAttribute('aria-label', isOpen ? '收起 AI 助手' : '打开 AI 助手')
  topbarToggle.setAttribute('title', isOpen ? '收起 AI 助手' : '打开 AI 助手')
  elements.assistantPanel.inert = !isOpen
  elements.assistantPanel.setAttribute('aria-hidden', String(!isOpen))
  const explorerUsesDrawer = window.matchMedia('(max-width: 899px)').matches
  const explorerOpen = projectVisible && explorerUsesDrawer && elements.appShell.classList.contains('explorer-open')
  const explorerToggle = document.querySelector('[data-action="toggle-explorer"]')
  explorerToggle?.setAttribute('aria-expanded', String(explorerOpen))
  explorerToggle?.setAttribute('aria-label', explorerOpen ? '关闭内容导航' : '打开内容导航')
  explorerToggle?.setAttribute('title', explorerOpen ? '关闭内容导航' : '打开内容导航')
  const explorerHidden = !projectVisible || elements.appShell.classList.contains('focus-mode') || (explorerUsesDrawer && !explorerOpen)
  elements.resourceExplorer.inert = explorerHidden
  elements.resourceExplorer.setAttribute('aria-hidden', String(explorerHidden))
  const focusToggle = document.querySelector('[data-action="toggle-focus-mode"]')
  if (focusToggle) {
    const active = elements.appShell.classList.contains('focus-mode')
    focusToggle.hidden = !projectVisible
    focusToggle.classList.toggle('is-active', active)
    focusToggle.setAttribute('aria-pressed', String(active))
    focusToggle.setAttribute('aria-label', active ? '退出专注模式' : '进入专注模式')
    focusToggle.setAttribute('title', active ? '退出专注模式' : '进入专注模式')
    focusToggle.querySelector('span').textContent = active ? '退出专注' : '专注模式'
  }

  const modalDrawerOpen = (usesDrawer && isOpen) || explorerOpen
  const backgroundTargets = ['.titlebar', '.activity-rail', '.main-surface', '.statusbar']
  backgroundTargets.forEach((selector) => {
    const target = document.querySelector(selector)
    if (target) target.inert = modalDrawerOpen
  })
  if (usesDrawer && isOpen) elements.resourceExplorer.inert = true
  if (explorerOpen) elements.assistantPanel.inert = true
}

function closeDrawers({ preserveAssistant = false, restoreFocus = true } = {}) {
  const hadOpenDrawer = elements.appShell.classList.contains('assistant-open') || elements.appShell.classList.contains('explorer-open')
  if (!preserveAssistant && window.matchMedia('(max-width: 1399px)').matches && elements.appShell.classList.contains('assistant-open')) assistantExpanded = false
  elements.appShell.classList.remove('assistant-open', 'explorer-open')
  syncAssistantAccessibility()
  if (hadOpenDrawer && restoreFocus) restoreDrawerFocus()
}

function setFocusMode(active) {
  elements.appShell.classList.toggle('focus-mode', active)
  syncAssistantAccessibility()
}

function focusProjectSearch() {
  if (document.querySelector('dialog[open]') || elements.appShell.classList.contains('no-project')) return
  if (!isProjectView(state.currentView)) switchView('workspace')
  setFocusMode(false)
  if (window.matchMedia('(max-width: 899px)').matches) toggleExplorer(true)
  else { closeDrawers({ restoreFocus: false }); elements.treeSearch.focus() }
}

function toggleExplorer(forceOpen) {
  const usesDrawer = window.matchMedia('(max-width: 899px)').matches
  const wasOpen = elements.appShell.classList.contains('explorer-open')
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !wasOpen
  if (shouldOpen) setFocusMode(false)
  if (usesDrawer && shouldOpen && !wasOpen && !elements.appShell.classList.contains('assistant-open')) rememberDrawerOpener()
  if (usesDrawer && shouldOpen) assistantExpanded = false
  elements.appShell.classList.toggle('explorer-open', shouldOpen)
  syncAssistantAccessibility()
  if (usesDrawer && shouldOpen) window.setTimeout(() => elements.treeSearch.focus(), 0)
  if (usesDrawer && wasOpen && !shouldOpen) restoreDrawerFocus()
}

function focusAssistant() {
  if (!isProjectView(state.currentView)) switchView('workspace')
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
  draft: {
    eyebrow: '针对当前正文',
    title: '把方向写成自己的内容',
    description: '结合简报、大纲和已选资料生成文字候选；你决定修改与采纳。',
    placeholder: '描述主题、读者、结构或需要修改的段落…',
    context: ['创作简报', '内容大纲'],
    progress: '正在整理正文候选',
    disclaimer: '采纳前请核对事实、引用和表达，AI 不会自动覆盖正文。',
    actions: [
      ['起草正文', '按简报与大纲展开内容', '结合创作简报和大纲起草正文，不编造事实或引用。'],
      ['局部修改', '保留观点，改进表达', '保留当前观点，改善正文的结构和表达。'],
      ['精简内容', '去掉重复和空泛段落', '精简当前正文，保留关键事实和有价值的论述。'],
      ['核对依据', '标出需要查证的信息', '指出正文中需要查证的事实或引用，不把推测当作已确认信息。']
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
      ['检查连续性', '先核对世界观与上一场', '检查当前场景是否与人物设定、世界观和前文冲突。', 'continuity'],
      ['打磨对白', '减少说明，保留潜台词', '将人物对白改得更自然，减少解释性台词。']
    ]
  }
}

function getAssistantProfileKey() {
  if (state.activeTab === 'outline') return 'outline'
  if (state.activeTab === 'references') return 'references'
  if (['idea', 'brief', 'world', 'characters', 'outline', 'draft'].includes(state.currentDocId)) return state.currentDocId
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
    button.dataset.creativeAction = action[3] || ''
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


function projectOperationContext() {
  return { projectId: activeProjectId, workspace: workspaceSnapshot(), media: mediaWorkbench?.operationContext() }
}

function prepareAssistantAction(prompt, creativeAction = '') {
  if (state.isGenerating || state.generationInFlight || state.candidateApplying) return showToast('当前 AI 任务尚未结束，请稍候再准备新的请求')
  elements.promptInput.value = prompt
  state.creativeActionContext = creativeAction ? { action: creativeAction, projectId: activeProjectId, documentId: state.currentDocId, tabName: state.activeTab } : null
  focusAssistant()
  if (creativeAction === 'continuity') {
    document.querySelector('#assistantRequestMode').value = 'discussion'
    document.querySelector('#reviewExistingPlan').hidden = true
    document.querySelector('#assistantContextSettings').open = true
    document.querySelector('#contextPreviewSummary').closest('details').open = true
    renderContextPreview()
    showToast('已准备连续性检查，可在发送范围移除资料；确认后点击发送')
  } else startGeneration(prompt)
}

function generationDraft(prompt, purpose = document.querySelector('#assistantRequestMode').value, creativeAction = null) {
  const discussionInstruction = purpose === 'discussion' ? '\n本次仅讨论与分析，给出建议，不提供可自动执行的项目操作，不声称修改项目。' : ''
  const availableObjects = contextObjects()
  const objectReferences = state.contextReferenceKeys.map(key => availableObjects.find(item => item.key === key))
  if (objectReferences.some(item => !item)) throw new Error('已引用对象或固定素材版本不再可用，请移除失效引用再发送。')
  const selectedText = state.includeSelectionContext ? editorSelection() : ''
  if (state.includeSelectionContext && !selectedText) throw new Error('编辑器选区已失效，请重新选择或关闭选区上下文。')
  const actionContext = state.creativeActionContext
  creativeAction ??= actionContext?.projectId === activeProjectId && actionContext.documentId === state.currentDocId && actionContext.tabName === state.activeTab ? actionContext.action : ''
  const draft = prepareGeneration({
    project: state.project, documentId: state.currentDocId, tabName: state.activeTab,
    documents: state.documents, tabContents: state.tabContents, structure: state.structure, prompt,
    includeUpstream: document.querySelectorAll('.context-chip')[0]?.getAttribute('aria-pressed') === 'true',
    includeCharacters: document.querySelectorAll('.context-chip')[1]?.getAttribute('aria-pressed') === 'true',
    knowledgeChunks: getSelectedKnowledgeChunks(), includeCurrent: state.includeCurrentContext,
    selectedText, objectReferences, excludedContextKeys: [...state.excludedContextKeys.keys()],
    creativeAction: ['text', 'discussion'].includes(purpose) ? creativeAction : '',
    characterLimit: GENERATION_CHARACTER_LIMIT - (purpose === 'project-plan' ? OPERATION_CONTEXT_RESERVE : discussionInstruction.length)
  })
  if (purpose === 'project-plan') return prepareOperationRequest(draft, captureOperationContext(projectOperationContext(), draft.summary))
  if (purpose === 'discussion') {
    draft.messages[0].content += discussionInstruction
    draft.characters += discussionInstruction.length
  }
  return draft
}

function editorSelection() {
  if (!['script', 'outline'].includes(state.activeTab)) return ''
  return elements.scriptEditor.value.slice(elements.scriptEditor.selectionStart, elements.scriptEditor.selectionEnd)
}

function contextObjects() {
  const documents = Object.entries(state.documents).map(([id, doc]) => ({ key: `document:${id}`, label: doc.title, kind: '文档', content: doc.content }))
  return [...documents, ...(mediaWorkbench?.contextObjects() || [])]
}

function renderContextObjects() {
  const host = document.querySelector('#contextObjectReferences')
  if (!host) return
  const objects = contextObjects()
  host.replaceChildren()
  for (const key of state.contextReferenceKeys) {
    const item = objects.find(item => item.key === key)
    const remove = document.createElement('button')
    remove.type = 'button'; remove.className = 'object-reference-chip'
    remove.textContent = `${item ? `${item.kind} · ${item.label}` : '引用已失效'} ×`
    remove.setAttribute('aria-label', `移除引用：${item?.label || key}`)
    remove.addEventListener('click', () => { state.contextReferenceKeys = state.contextReferenceKeys.filter(value => value !== key); renderContextPreview() })
    host.append(remove)
  }
  const list = document.querySelector('#contextObjectList')
  const query = document.querySelector('#contextObjectSearch').value.trim().toLowerCase()
  list.replaceChildren()
  const matches = objects.filter(item => `${item.kind} ${item.label}`.toLowerCase().includes(query))
  for (const item of matches.slice(0, 40)) {
    const add = document.createElement('button')
    add.type = 'button'; add.className = 'context-object-option'; add.textContent = `${item.kind} · ${item.label}`
    add.disabled = state.contextReferenceKeys.includes(item.key)
    if (add.disabled) add.textContent += ' · 已加入'
    add.addEventListener('click', () => {
      if (state.contextReferenceKeys.length >= 8) return showToast('本次最多主动引用 8 个对象；可先移除不需要的内容')
      state.contextReferenceKeys.push(item.key)
      const position = elements.promptInput.selectionStart
      const prefix = elements.promptInput.value.slice(0, position)
      const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u)
      if (match) {
        const start = prefix.lastIndexOf('@')
        elements.promptInput.setRangeText(`@${item.label} `, start, position, 'end')
      }
      document.querySelector('#contextObjectPicker').open = false
      renderContextPreview(); elements.promptInput.focus()
    })
    list.append(add)
  }
  if (!matches.length) list.textContent = activeProjectId ? '没有匹配对象；可先创作文档或创建镜头、素材。' : '创建或打开项目后可选择对象。'
  if (matches.length > 40) {
    const hint = document.createElement('p'); hint.textContent = `还有 ${matches.length - 40} 项，请输入名称缩小范围。`; list.append(hint)
  }
}

function removeContextItem(item) {
  if (item.key === 'current') state.includeCurrentContext = false
  else if (item.key === 'selection') state.includeSelectionContext = false
  else if (item.key.startsWith('object:')) state.contextReferenceKeys = state.contextReferenceKeys.filter(key => key !== item.key.slice(7))
  else if (item.key.startsWith('knowledge:')) {
    state.knowledge.selectedChunkIds = state.knowledge.selectedChunkIds.filter(id => id !== item.key.slice(10))
    syncCurrentDocumentReferences(); scheduleSave(); renderKnowledge()
  } else state.excludedContextKeys.set(item.key, item.label)
  renderContextPreview()
}

function renderContextPreview(draft = null) {
  creationNavigation?.render()
  const list = document.querySelector('#contextPreviewList')
  if (!list) return
  list.replaceChildren()
  document.querySelector('#contextPreviewMessages').textContent = ''
  document.querySelector('#contextExcludedList').replaceChildren()
  document.querySelector('#includeCurrentContext').checked = state.includeCurrentContext
  document.querySelector('#includeSelectionContext').checked = state.includeSelectionContext
  renderContextObjects()
  if (!getCurrentDocument()) { document.querySelector('#contextPreviewSummary').textContent = '创建或打开项目后查看发送范围'; return }
  try {
    const preview = draft || generationDraft(elements.promptInput.value.trim())
    document.querySelector('#contextPreviewSummary').textContent = `发送范围${preview.creativeAction === 'continuity' ? ' · 连续性检查' : ''} · ${preview.characters.toLocaleString('zh-CN')} 字符${preview.truncated ? ' · 部分已截断' : ''}`
    for (const item of preview.summary) {
      const line = document.createElement('li')
      const details = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('pre')
      summary.textContent = `${item.label} · ${item.characters} 字符${item.truncated ? `（原 ${item.originalCharacters}，已截断）` : ''}`
      content.textContent = item.content || '本项未发送：请求预算不足。'
      details.append(summary, content)
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = '移出下次请求'
      remove.setAttribute('aria-label', `移出下次请求：${item.label}`); remove.addEventListener('click', () => removeContextItem(item))
      line.append(details)
      if (!item.required) line.append(remove)
      list.append(line)
    }
    document.querySelector('#contextPreviewMessages').textContent = JSON.stringify(preview.messages, null, 2)
    const excluded = document.querySelector('#contextExcludedList'); excluded.replaceChildren()
    for (const [key, label] of state.excludedContextKeys) {
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'text-button'; restore.textContent = `加回：${label}`
      restore.addEventListener('click', () => { state.excludedContextKeys.delete(key); renderContextPreview() }); excluded.append(restore)
    }
    if (!preview.summary.length) list.textContent = '未携带正文或资料，仅发送项目标题和创作要求。'
    for (const message of preview.contextWarnings || []) {
      const warning = document.createElement('li'); warning.textContent = message; list.append(warning)
    }
  } catch (error) { list.textContent = readableError(error) }
}

function buildGenerationMessages() {
  return state.generationContext.messages
}

function appendGenerationDelta(delta, generationId = state.activeGenerationId) {
  if (!delta || !state.isGenerating || generationId !== state.activeGenerationId) return
  state.generationText += delta
  mediaWorkbench?.updateStoryboardTask?.(generationId, { phase: 'receiving', characters: state.generationText.length })
  elements.candidateContent.textContent = state.generationText
  scheduleCandidateSave()
  elements.assistantConversation.scrollTop = elements.assistantConversation.scrollHeight
}


let cliSessionConsent = null

function confirmCliGeneration(connection, boundary, signal) {
  const consentKey = JSON.stringify([connection.id, connection.driverId, connection.planningModel || '', boundary])
  if (signal.aborted) return Promise.resolve(false)
  if (cliSessionConsent === consentKey) return Promise.resolve(true)
  const dialog = document.querySelector('#cliConsentDialog')
  const remember = document.querySelector('#cliConsentRemember')
  remember.checked = false
  document.querySelector('#cliConsentSummary').textContent = `本次将使用 ${connection.name}${connection.driverId === 'codex' ? `（规划模型：${connection.planningModel || '跟随本机 CLI 配置'}）` : ''} 的账号，发送提示词及选中的项目与知识上下文，可能消耗账号额度。`
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
  state.generationInFlight = generationId
  const controller = new AbortController()
  state.generationAbortController = controller
  try {
    if (connection.kind !== 'cli') validateProviderBaseUrl(connection.kind, connection.baseUrl)
    const allowUserProfile = connection.kind === 'cli' && ['antigravity', 'codex', 'claude'].includes(connection.driverId)
    const cliBoundary = connection.driverId === 'antigravity'
      ? 'agy 会读取自身用户配置（包括权限、插件和 hooks），并可能保存会话；它不是无工具模式。使用 plan 模式和终端 sandbox。'
      : connection.driverId === 'codex'
        ? 'Codex 使用现有 CLI 登录态和模型设置，生成仍采用只读模式和临时工作目录。仅由 CLI 读取模型配置，不继承用户 hooks、MCP、execpolicy rules 或自定义供应商，不保留本次会话。只读不等于禁止读取本机信息。'
        : 'Claude 优先使用已配置 API Key；否则尝试已有 CLI 登录态。禁用内置工具、外部 MCP、技能和普通 hooks；不保留会话。组织托管策略仍可能生效，CLI 可能读取自身用户上下文。'
    mediaWorkbench?.updateStoryboardTask?.(generationId, { phase: allowUserProfile ? 'confirming' : 'running' })
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
    mediaWorkbench?.updateStoryboardTask?.(generationId, { phase: 'running' })
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
          model: connection.kind === 'cli' ? connection.driverId === 'codex' ? connection.planningModel || '' : '' : connection.model || '',
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
        body: JSON.stringify({ driverId: connection.driverId, model: connection.driverId === 'codex' ? connection.planningModel || '' : '', messages, allowUserProfile }),
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
    if (connection.kind === 'cli') connection.lastExecution = { status: 'ready', error: null, at: new Date().toISOString() }
    await finishGeneration({ generationId })
    renderConnections()
  } catch (error) {
    if (generationId === state.activeGenerationId && !controller.signal.aborted) mediaWorkbench?.updateStoryboardTask?.(generationId, { phase: 'failed', message: readableError(error, '拆镜处理失败，候选已保留') })
    if (generationId !== state.activeGenerationId || error?.name === 'AbortError' || !state.isGenerating) return
    const message = readableError(error, '生成失败')
    connection.status = /login|登录|授权|密钥/i.test(message) ? 'auth_failed' : 'error'
    connection.error = message
    if (connection.kind === 'cli') connection.lastExecution = { status: connection.status, error: message, at: new Date().toISOString() }
    renderConnections()
    await persistWorkspace()
    failGeneration(connection.error, generationId)
  } finally {
    unlisten?.()
    if (state.generationInFlight === generationId) state.generationInFlight = null
    mediaWorkbench?.releaseStoryboardTask?.(generationId)
    if (generationId === state.activeGenerationId) state.generationAbortController = null
  }
}

function failGeneration(message, generationId = state.activeGenerationId) {
  if (generationId !== state.activeGenerationId) return
  window.clearInterval(state.generationTimer)
  state.generationTimer = null
  state.isGenerating = false
  document.querySelector('#assistantRequestMode').disabled = false
  elements.sendButton.classList.remove('is-generating')
  elements.sendButton.setAttribute('aria-label', '执行 AI 请求')
  elements.sendButton.setAttribute('title', '执行 AI 请求')
  elements.generationState.hidden = true
  elements.candidateCard.classList.add('has-error')
  const hasPartial = Boolean(state.generationText.trim())
  document.querySelector('#reviewProjectPlan').disabled = !hasPartial
  if (!hasPartial) elements.candidateContent.textContent = '未生成可用的候选内容。'
  elements.generationError.hidden = false
  elements.generationError.textContent = `${message}。原消息已保留在对话区，可点击“重新生成”重试${hasPartial ? '，上方部分结果仍可审阅或采纳' : ''}。`
  elements.candidateActions.hidden = false
  elements.candidateActions.querySelectorAll('[data-action="apply-candidate"]').forEach((button) => { button.disabled = !hasPartial })
  updateCandidateCitations(state.generationContext?.knowledgeChunks || [])
  elements.a11yAnnouncements.textContent = `AI 生成失败：${message}`
  showToast(message)
  mediaWorkbench?.updateStoryboardTask?.(generationId, { phase: 'failed', message })
  state.candidateStatus = 'error'
  rememberCurrentCandidate()
  renderCandidateDrafts()
  scheduleCandidateSave({ immediate: true })
}

function startGeneration(prompt, { clearComposer = true, purpose = null, creativeAction = null, connectionId = null, sourceFingerprint = '', storyboardRevision = null, storyboardSourceFingerprint: sourceStoryboardFingerprint = '', storyboardTaskId = null } = {}) {
  if (state.candidateApplying) return showToast('候选正在保存，请稍候')
  if (!getCurrentDocument()) return openDialog(elements.newProjectDialog)
  if (state.isGenerating || state.generationInFlight || (mediaWorkbench?.isStoryboardBusy?.() && !storyboardTaskId)) {
    showToast('已有 AI 任务正在执行，请等待任务结束或停止后再发起新任务')
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
  const route = resolveConnectionRoute(connectionId ? { connections: state.connections, workflow: { textConnectionId: connectionId } } : state, 'text')
  const connection = route.connection
  if (!connection) {
    showToast(route.error)
    return
  }
  purpose ||= document.querySelector('#assistantRequestMode').value
  if (['text', 'discussion', 'project-plan'].includes(purpose)) {
    document.querySelector('#assistantRequestMode').value = purpose
    document.querySelector('#reviewExistingPlan').hidden = purpose !== 'project-plan'
  }
  let prepared
  try { prepared = generationDraft(cleanPrompt, purpose, creativeAction) }
  catch (error) { showToast(readableError(error)); return }
  rememberCurrentCandidate()
  if (state.candidateDrafts.length >= MAX_CANDIDATE_DRAFTS) return showToast(`已保留 ${MAX_CANDIDATE_DRAFTS} 份待审稿，请先采纳或丢弃部分候选再生成`)
  renderContextPreview(prepared)
  state.lastPrompt = cleanPrompt
  const sequence = ++state.generationSequence
  const generationId = storyboardTaskId || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${sequence}`
  if (purpose === 'storyboard' && mediaWorkbench?.reserveStoryboardTask) {
    try {
      if (!storyboardTaskId) mediaWorkbench.reserveStoryboardTask({ id: generationId, projectId: activeProjectId, documentId: state.currentDocId, title: getCurrentDocument().title })
      const task = mediaWorkbench.getStoryboardTask(generationId)
      if (task.projectId !== activeProjectId || task.documentId !== state.currentDocId) throw new Error('拆镜来源已切换，未执行其他分场')
      mediaWorkbench.bindStoryboardTask(generationId)
    } catch (error) {
      if (!mediaWorkbench.getStoryboardTask(generationId)?.bound) mediaWorkbench.releaseStoryboardTask(generationId)
      showToast(readableError(error)); return
    }
  }
  state.activeGenerationId = generationId
  state.activeCandidateId = generationId
  state.candidateCreatedAt = new Date().toISOString()
  state.candidateStatus = 'partial'
  state.isGenerating = true
  document.querySelector('#assistantRequestMode').disabled = true
  state.generationContext = {
    projectId: activeProjectId,
    purpose,
    creativeAction: prepared.creativeAction || '',
    sourceFingerprint,
    storyboardRevision,
    ...(purpose === 'storyboard' ? { storyboardSourceFingerprint: sourceStoryboardFingerprint || storyboardSourceFingerprint(state.storyboard, state.currentDocId) } : {}),
    operationContext: prepared.operationContext || null,
    documentId: state.currentDocId,
    tabName: state.activeTab,
    title: getCurrentDocument().title,
    baseContent: getCurrentContent(),
    selectionStart: elements.scriptEditor.selectionStart,
    selectionEnd: elements.scriptEditor.selectionEnd,
    knowledgeChunks: prepared.knowledgeChunks,
    messages: prepared.messages
  }
  document.querySelector('#sentContextMessages').textContent = JSON.stringify(prepared.messages, null, 2)
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
  elements.candidateActions.querySelectorAll('[data-action="apply-candidate"]').forEach((button) => { button.disabled = false; button.hidden = purpose !== 'text' })
  document.querySelector('#reviewProjectPlan').hidden = purpose !== 'project-plan'
  elements.candidateCard.querySelector('.candidate-warning').textContent = purpose === 'discussion' ? '讨论建议 · 不修改项目' : purpose === 'project-plan' ? '项目修改计划 · 尚未执行' : '尚未写入正文'
  elements.generationState.hidden = false
  elements.generationState.lastElementChild.textContent = profile.progress
  elements.candidateActions.hidden = true
  elements.candidateCitations.hidden = true
  updateCandidateCitations([])
  elements.sendButton.classList.add('is-generating')
  elements.sendButton.setAttribute('aria-label', '停止 AI 生成')
  elements.sendButton.setAttribute('title', '停止 AI 生成')
  rememberCurrentCandidate()
  renderCandidateDrafts()
  scheduleCandidateSave({ immediate: true })

  generateWithConnection(connection, cleanPrompt, generationId, clearComposer && elements.promptInput.value.trim() === cleanPrompt ? elements.promptInput.value : null)
  return generationId
}

async function finishGeneration({ stopped = false, silent = false, generationId = state.activeGenerationId } = {}) {
  if (generationId !== state.activeGenerationId) return
  window.clearInterval(state.generationTimer)
  state.generationTimer = null
  state.isGenerating = false
  document.querySelector('#assistantRequestMode').disabled = false
  elements.sendButton.classList.remove('is-generating')
  elements.sendButton.setAttribute('aria-label', '执行 AI 请求')
  elements.sendButton.setAttribute('title', '执行 AI 请求')
  elements.generationState.hidden = true
  elements.candidateActions.hidden = false
  elements.generationError.hidden = true
  const hasCandidate = Boolean(elements.candidateContent.textContent.trim())
  document.querySelector('#reviewProjectPlan').disabled = !hasCandidate
  elements.candidateActions.querySelectorAll('[data-action="apply-candidate"]').forEach((button) => {
    button.disabled = !hasCandidate
  })
  updateCandidateCitations(state.generationContext?.knowledgeChunks || [])
  const announcement = stopped
    ? hasCandidate ? 'AI 生成已停止，已保留当前候选内容' : 'AI 生成已停止，尚未生成候选内容'
    : 'AI 候选内容已生成，尚未写入正文'
  elements.a11yAnnouncements.textContent = announcement
  if (stopped && !silent) showToast(hasCandidate ? '已停止生成，部分内容仍可采纳' : '已停止生成，未收到候选内容')
  state.candidateStatus = stopped ? 'partial' : 'complete'
  rememberCurrentCandidate()
  renderCandidateDrafts()
  scheduleCandidateSave({ immediate: true })
  if (state.generationContext?.purpose === 'storyboard') {
    mediaWorkbench?.updateStoryboardTask?.(generationId, { phase: stopped ? 'cancelling' : 'saving', characters: state.generationText.length })
    if (hasCandidate && state.generationContext.projectId === activeProjectId) {
      const applied = await mediaWorkbench?.receiveCandidate(elements.candidateContent.textContent, state.generationContext, state.activeCandidateId, { autoApply: !stopped, createdAt: state.candidateCreatedAt })
      if (!stopped) mediaWorkbench?.updateStoryboardTask?.(generationId, { phase: applied ? 'completed' : 'review', message: applied ? `已保存 ${applied} 个镜头，并关联可用角色参考图` : '候选已保留，请查看分场中的提示；未覆盖已有镜头' })
    }
  }
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

function scheduleCandidateSave({ immediate = false } = {}) {
  editRevision += 1
  unsavedEdits = true
  setSaveStatus('dirty')
  if (state.candidateSaveTimer && !immediate) return
  window.clearTimeout(state.candidateSaveTimer)
  const owner = activeProjectId
  const save = () => {
    state.candidateSaveTimer = null
    if (owner === activeProjectId && !projectTransition && !state.candidateApplying) persistWorkspace()
  }
  // Continuous tokens must not indefinitely postpone saving like editor debounce.
  if (immediate) save()
  else state.candidateSaveTimer = window.setTimeout(save, 1000)
}

function rememberCurrentCandidate() {
  if (!state.activeCandidateId || !state.generationContext || state.candidateApplying || !activeProjectId) return
  state.candidateDrafts = upsertCandidateDraft(state.candidateDrafts, {
    id: state.activeCandidateId, documentId: state.generationContext.documentId, tabName: state.generationContext.tabName,
    prompt: state.lastPrompt, text: state.generationText, createdAt: state.candidateCreatedAt,
    status: state.isGenerating ? 'partial' : state.candidateStatus,
    context: state.generationContext
  })
}

function renderCandidateDrafts() {
  let shelf = document.querySelector('#candidateDraftShelf')
  if (!shelf) {
    shelf = document.createElement('details'); shelf.id = 'candidateDraftShelf'; shelf.className = 'candidate-draft-shelf'
    const summary = document.createElement('summary'); summary.id = 'candidateDraftSummary'
    const label = document.createElement('label'); label.htmlFor = 'candidateDraftSelect'; label.textContent = '已保留候选'
    const select = document.createElement('select'); select.id = 'candidateDraftSelect'
    select.addEventListener('change', async () => {
      const id = select.value, owner = activeProjectId
      const draft = state.candidateDrafts.find(item => item.id === id)
      if (!draft || state.isGenerating || state.candidateApplying) return
      rememberCurrentCandidate()
      if (state.documents[draft.documentId]) {
        if (draft.documentId !== state.currentDocId && !await selectDocument(draft.documentId)) return
        if (owner !== activeProjectId) return
        if (draft.tabName !== state.activeTab) await switchTab(draft.tabName)
        if (owner !== activeProjectId || state.currentDocId !== draft.documentId || state.activeTab !== draft.tabName) return
      }
      showSavedCandidate(draft)
    })
    const hint = document.createElement('p'); hint.textContent = '旧分镜候选不会自动展示，请按生成时间选择一份打开。采纳或替换成功后移除对应候选，其他待审稿仍保留。'
    shelf.append(summary, label, select, hint)
    elements.assistantConversation.prepend(shelf)
    const review = document.createElement('details'); review.id = 'candidateDiffReview'; review.className = 'candidate-diff-review'
    const reviewTitle = document.createElement('summary'); reviewTitle.textContent = '审阅替换差异'
    const body = document.createElement('div'); body.id = 'candidateDiffBody'
    review.append(reviewTitle, body)
    review.addEventListener('toggle', () => { if (review.open) renderCandidateDiff() })
    elements.candidateContent.after(review)
  }
  const select = shelf.querySelector('select')
  select.replaceChildren()
  const tabs = { script: '正文', outline: '大纲', references: '设定引用' }
  for (const draft of [...state.candidateDrafts].reverse()) {
    const title = state.documents[draft.documentId]?.title || `${draft.context.title}（原文档已删除）`
    const status = { complete: '待审', partial: '部分内容', error: '生成未完成' }[draft.status]
    const option = new Option(`${candidateGeneratedAtLabel(draft.createdAt)} · ${title} · ${draft.context.purpose === 'storyboard' ? '分镜' : tabs[draft.tabName]} · ${status} · ${draft.prompt.slice(0, 28)}`, draft.id)
    select.append(option)
  }
  if (!state.activeCandidateId && state.candidateDrafts.length) select.prepend(new Option('选择一份待审稿', ''))
  select.value = state.activeCandidateId || ''
  select.disabled = state.isGenerating || state.candidateApplying
  shelf.hidden = state.candidateDrafts.length === 0
  shelf.querySelector('summary').textContent = `待审稿 · ${state.candidateDrafts.length}`
  const review = document.querySelector('#candidateDiffReview')
  review.hidden = state.isGenerating || !state.generationText.trim() || state.generationContext?.purpose !== 'text'
  if (review.open && !review.hidden) renderCandidateDiff()
  else document.querySelector('#candidateDiffBody').replaceChildren()
}

function renderCandidateDiff() {
  const body = document.querySelector('#candidateDiffBody'), context = state.generationContext
  body.replaceChildren()
  if (!context || context.purpose !== 'text' || !state.generationText.trim() || state.isGenerating) return
  const current = getContentAt(context.documentId, context.tabName)
  if (current !== context.baseContent) {
    const warning = document.createElement('p'); warning.className = 'candidate-draft-warning'
    warning.textContent = '正文在生成后已有修改。以下对比生成时原文；替换已受保护，可插入或追加保留当前修改。'
    body.append(warning)
  }
  body.append(createReviewDiff({ before: context.baseContent, after: state.generationText.trim(), title: '生成时原文与候选' }))
}

function showSavedCandidate(draft) {
  draft = state.candidateDrafts.find(item => item.id === draft?.id)
  if (!draft) return
  if (state.isGenerating || state.candidateApplying) return
  state.activeCandidateId = draft.id
  state.candidateCreatedAt = draft.createdAt
  state.candidateStatus = draft.status
  state.generationText = draft.text
  // Keep the submitted project/asset identities. An imported plan must fail its
  // existing project guard instead of silently acquiring authority over a copy.
  state.generationContext = structuredClone(draft.context)
  state.lastPrompt = draft.prompt
  state.activeGenerationId = null
  elements.welcome.hidden = true; elements.conversationThread.hidden = false
  elements.userMessage.textContent = draft.prompt
  elements.candidateContent.textContent = draft.text || '尚未收到可用内容，可重新生成。'
  elements.generationState.hidden = true
  const orphaned = !state.documents[draft.documentId]
  elements.generationError.hidden = !orphaned && draft.status === 'complete'
  elements.generationError.textContent = orphaned ? '原文档已删除，候选仍保留在项目中。恢复原文档后再采纳，或复制候选内容。' : draft.status === 'error' ? '上次生成未完成；已有内容已保留，可审阅或重新生成。' : '这是已停止或中断的部分内容，请检查完整性后再采纳。'
  elements.candidateCard.classList.toggle('has-error', draft.status === 'error')
  elements.candidateActions.hidden = false
  const purpose = draft.context.purpose
  if (['text', 'discussion', 'project-plan'].includes(purpose)) {
    document.querySelector('#assistantRequestMode').value = purpose
    document.querySelector('#reviewExistingPlan').hidden = purpose !== 'project-plan'
  }
  elements.candidateActions.querySelectorAll('[data-action="apply-candidate"]').forEach(button => { button.hidden = purpose !== 'text'; button.disabled = orphaned || !draft.text.trim() })
  const planButton = document.querySelector('#reviewProjectPlan')
  planButton.hidden = purpose !== 'project-plan'; planButton.disabled = orphaned || !draft.text.trim()
  elements.candidateCard.querySelector('.candidate-warning').textContent = purpose === 'discussion' ? '讨论建议 · 不修改项目' : purpose === 'project-plan' ? '项目修改计划 · 尚未执行' : '待审稿 · 尚未写入正文'
  document.querySelector('#sentContextMessages').textContent = JSON.stringify(draft.context.messages || [], null, 2)
  updateCandidateCitations(draft.context.knowledgeChunks || [])
  if (purpose === 'storyboard' && draft.context.projectId === activeProjectId) mediaWorkbench?.receiveCandidate(draft.text, state.generationContext, draft.id, { createdAt: draft.createdAt })
  renderCandidateDrafts()
}

function restoreDocumentCandidate() {
  if (state.isGenerating || state.candidateApplying) return
  const context = state.generationContext
  if (context?.documentId === state.currentDocId && context?.tabName === state.activeTab && state.activeCandidateId) {
    renderCandidateDrafts()
    return
  }
  discardCandidate({ silent: true, remove: false, persist: false })
  const draft = candidateDraftsFor(state.candidateDrafts, state.currentDocId, state.activeTab).at(-1)
  if (draft && draft.context.purpose !== 'storyboard') showSavedCandidate(draft)
  else renderCandidateDrafts()
}

function discardCandidate({ silent = false, remove = true, persist = true } = {}) {
  const hadCandidate = Boolean(state.activeCandidateId)
  window.clearTimeout(state.candidateSaveTimer)
  state.candidateSaveTimer = null
  const generationId = state.activeGenerationId
  state.generationAbortController?.abort()
  if (isDesktopRuntime && state.isGenerating && generationId !== null) {
    invokeDesktop('cancel_generation', { taskId: String(generationId) }).catch(() => {})
  }
  if (state.isGenerating) finishGeneration({ stopped: true, silent: true, generationId })
  const previousCount = state.candidateDrafts.length
  if (state.activeCandidateId && (remove || state.generationContext?.purpose === 'storyboard')) mediaWorkbench?.clearCandidate?.(state.activeCandidateId)
  if (remove && state.activeCandidateId) state.candidateDrafts = removeCandidateDraft(state.candidateDrafts, state.activeCandidateId)
  state.activeCandidateId = null
  state.generationText = ''
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
  renderCandidateDrafts()
  if (persist && previousCount !== state.candidateDrafts.length) scheduleSave()
  if (hadCandidate && (!silent || !remove)) elements.a11yAnnouncements.textContent = remove ? '候选内容已丢弃' : '候选已保留，可从待审稿继续审阅'
  if (!silent) showToast('候选内容已丢弃，正文没有变化')
}

function abandonCandidateOnContextChange(documentId, tabName) {
  const context = state.generationContext
  if (!context || (context.documentId === documentId && context.tabName === tabName)) return
  rememberCurrentCandidate()
  discardCandidate({ silent: true, remove: false, persist: false })
}

function acceptCandidate() {
  applyCandidate('append')
}

async function applyCandidate(mode = 'append') {
  if (state.candidateApplying || state.isGenerating) return
  const candidate = elements.candidateContent.textContent.trim()
  const context = state.generationContext
  if (!candidate || !context) return
  if (context.purpose === 'storyboard') return mediaWorkbench?.applyCandidate(mode === 'replace')
  if (context.purpose && context.purpose !== 'text') return showToast('此请求不是文字候选，请使用对应的审阅入口')
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
    counter: state.versionCounters[context.documentId] || 0, selected: state.selectedVersionByDocument[context.documentId],
    candidateDrafts: state.candidateDrafts
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
    if (state.activeCandidateId) state.candidateDrafts = removeCandidateDraft(state.candidateDrafts, state.activeCandidateId)
    const saved = await persistWorkspace()
    if (projectId !== activeProjectId) return
    if (!saved) {
      const untouched = editRevision === startingRevision && getContentAt(context.documentId, context.tabName) === acceptedText
      if (untouched) {
        state.candidateDrafts = before.candidateDrafts
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
    renderCandidateDrafts()
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
    document.querySelector('#projectFlowPreset').value = 'script'
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
  if (dialog === elements.connectionDialog && document.querySelector('#connectionForm').dataset.saving === 'true') return
  if (dialog?.id === 'cliSettingsDialog' && dialog.querySelector('form[data-saving="true"]')) return
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
  let panel = document.querySelector('#referenceKnowledgePreview')
  if (!panel) {
    panel = document.createElement('details')
    panel.id = 'referenceKnowledgePreview'
    panel.className = 'scene-intent reference-knowledge-preview'
    elements.scriptEditor.closest('.editor-paper').before(panel)
  }
  panel.hidden = state.activeTab !== 'references' || !state.tabContents[state.currentDocId]
  if (panel.hidden) return
  const chunks = getSelectedKnowledgeChunks()
  const summary = document.createElement('summary')
  summary.textContent = `已选知识资料 · ${chunks.length} 条（只读）`
  const hint = document.createElement('p')
  hint.textContent = '资料随知识选择与上下文开关更新；下方参考笔记单独保存。实际发送片段和截断情况可在 AI 助手的“发送范围”查看。'
  panel.replaceChildren(summary, hint)
  for (const [index, chunk] of chunks.entries()) {
    const details = document.createElement('details'), title = document.createElement('summary'), content = document.createElement('pre')
    title.textContent = `K${index + 1} · ${chunk.name} / ${chunk.path}`
    content.textContent = chunk.content
    details.append(title, content); panel.append(details)
  }
  if (!chunks.length) {
    const empty = document.createElement('p'); empty.textContent = '未启用知识资料。可在知识库选择资料，并打开 AI 助手的知识上下文开关。'; panel.append(empty)
  }
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
  return resolveConnectionRoute(state, 'text').connection
}

function renderGlobalExecutors() {
  const host = document.querySelector('#globalExecutors')
  host.replaceChildren()
  for (const [capability, name] of [['text', '文字'], ['image', '图片'], ['video', '视频']]) {
    const label = document.createElement('label'), title = document.createElement('span'), select = document.createElement('select')
    label.className = 'media-field'
    title.textContent = `${name}默认`
    select.setAttribute('aria-label', `全局${name}默认执行端`)
    const route = resolveConnectionRoute({ connections: state.connections }, capability)
    select.append(new Option(route.error && route.source === 'global' && !route.selectedId && route.error.startsWith('存在多个') ? route.error : '不设默认 · 项目需自行选择', ''))
    for (const connection of state.connections.filter(item => supportsCapability(item, capability))) {
      select.append(new Option(`${connection.name}${connection.kind === 'cli' ? ' · CLI' : ''}`, connection.id))
    }
    if (route.selectedId && ![...select.options].some(option => option.value === route.selectedId)) select.append(new Option(route.error, route.selectedId))
    select.value = route.selectedId
    select.addEventListener('change', () => { select.disabled = true; void setGlobalExecutor(capability, select.value) })
    label.append(title, select); host.append(label)
  }
  const help = document.createElement('p')
  help.className = 'media-help'
  help.textContent = '拆镜未单独选择时先沿用项目文字，再沿用全局文字。默认只决定路由，不代表登录、额度或生成能力已验证。'
  host.append(help)
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
  if (connection.isActive || connection.defaultFor?.length) {
    const badge = document.createElement('span')
    badge.className = 'default-badge'
    badge.textContent = [connection.isActive ? '全局文字默认' : '', ...(connection.defaultFor || []).map(capability => `全局${capability === 'image' ? '图片' : '视频'}默认`)].filter(Boolean).join(' · ')
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
  if (getActiveConnection()?.id !== connection.id && supportsCapability(connection, 'text')) {
    const useButton = document.createElement('button')
    useButton.type = 'button'
    useButton.className = 'secondary-button compact-button'
    useButton.dataset.action = 'activate-connection'
    useButton.dataset.connectionId = connection.id
    useButton.textContent = activeProjectId ? '用于当前项目文字' : '设为全局文字默认'
    actions.append(useButton)
  }
  const testButton = document.createElement('button')
  testButton.type = 'button'
  testButton.className = 'secondary-button compact-button'
  testButton.dataset.action = 'test-connection'
  testButton.dataset.connectionId = connection.id
  testButton.textContent = ['image-api', 'video-api'].includes(connection.kind) ? '检查配置' : '测试'
  if (['image-api', 'video-api'].includes(connection.kind)) {
    testButton.dataset.action = 'configure-provider'
  }
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
    empty.textContent = state.runtime.status === 'error' ? '本机运行时检测失败，请重新检测。原执行端选择已保留，未自动切换资源。' : '尚未检测本机 CLI。'
    fragment.append(empty)
  } else {
    state.runtime.drivers.forEach((driver) => {
      const connection = state.connections.find((item) => item.kind === 'cli' && item.driverId === driver.id)
      const card = document.createElement('article')
      const isReady = driver.status === 'ready'
      const canGenerate = Boolean(isReady && driver.canGenerate && connection)
      const isVerified = canGenerate && connection.status === 'ready'
      const executionFailed = ['auth_failed', 'error'].includes(connection?.lastExecution?.status || connection?.status)
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
      status.textContent = driver.credentialError ? '已安装 · 凭据读取失败' : isReady && executionFailed ? '已安装 · 上次调用失败' : isVerified
        ? '已安装 · 上次调用成功'
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
        ? `先在终端运行 agy 登录；使用默认模型。每次调用需确认用户配置与额度，不是无工具模式。`
        : driver.id === 'codex' && isReady
          ? `沿用现有 Codex CLI 登录态。规划模型：${connection?.planningModel || '跟随本机 CLI 配置'}；不复用自定义供应商。已安装或已配置不代表账号可用。`
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
      const settingsButton = document.createElement('button')
      settingsButton.type = 'button'
      settingsButton.className = 'secondary-button compact-button'
      settingsButton.dataset.action = 'configure-cli'
      settingsButton.dataset.driverId = driver.id
      settingsButton.setAttribute('aria-label', `${driver.name} 设置`)
      settingsButton.textContent = '设置'
      actions.append(settingsButton)
      if (canGenerate && getActiveConnection()?.id !== connection.id) {
        const useButton = document.createElement('button')
        useButton.type = 'button'
        useButton.className = 'secondary-button compact-button'
        useButton.dataset.action = 'activate-connection'
        useButton.dataset.connectionId = connection.id
        useButton.textContent = activeProjectId ? '用于当前项目文字' : '设为全局文字默认'
        actions.append(useButton)
      } else if (connection && getActiveConnection()?.id === connection.id) {
        const badge = document.createElement('span')
        badge.className = 'default-badge'
        badge.textContent = activeProjectId ? '当前项目文字' : '全局文字默认'
        actions.append(badge)
      }
      if (driver.credentialError) note.textContent = `Claude 凭据读取失败：${driver.credentialError}。请检查钥匙串或在设置中移除工作台 Key；未改用 CLI 登录。`
      else if (connection?.lastExecution || (executionFailed && connection?.error)) {
        const last = connection.lastExecution
        const when = last?.at ? new Date(last.at).toLocaleString('zh-CN', { hour12: false }) : '时间未记录'
        note.textContent += ` 上次调用（${when}）：${last?.error || connection.error || '成功'}。重新检测只检查安装状态。`
      }
      card.append(brand, copy, capabilities, health, note, actions)
      fragment.append(card)
    })
  }
  list.replaceChildren(fragment)
}

function renderConnections() {
  renderGlobalExecutors()
  const apiList = document.querySelector('#apiConnectionList')
  const localList = document.querySelector('#localConnectionList')
  apiList.replaceChildren(...state.connections.filter((connection) => ['openai-compatible', 'image-api', 'video-api'].includes(connection.kind)).map(createConnectionCard))
  localList.replaceChildren(...state.connections.filter((connection) => connection.kind === 'ollama').map(createConnectionCard))
  renderRuntimeDrivers()

  const textRoute = resolveConnectionRoute(state, 'text')
  const active = textRoute.connection || { id: '', name: textRoute.error, status: 'unknown' }
  const readyCount = state.connections.filter((connection) => connection.status === 'ready').length
  const overview = document.querySelector('#connectionOverview')
  overview.querySelector('strong').textContent = `${readyCount} 个执行端可用`
  overview.querySelector('div > span:last-child').textContent = textRoute.connection ? `当前使用 ${active.name}` : textRoute.error
  overview.querySelector('.status-dot').className = `status-dot ${readyCount ? 'status-dot-success' : 'status-dot-warning'}`

  const executor = document.querySelector('#executorSelect')
  const availableExecutors = state.connections.filter((connection) => supportsCapability(connection, 'text') && (connection.kind !== 'cli' || ['installed', 'ready'].includes(connection.status) || connection.isActive || connection.id === active.id))
  executor.replaceChildren(...availableExecutors.map((connection) => {
    const option = document.createElement('option')
    option.value = connection.id
    option.selected = connection.id === active.id
    const statusSuffix = connection.status === 'ready'
      ? ''
      : connection.status === 'installed'
        ? connection.compatibility === 'translated' ? ' · Intel 兼容模式 · 登录未验证' : ' · 登录未验证'
        : ` · ${getConnectionStatusCopy(connection)[1]}`
    option.textContent = `${connection.name}${connection.kind === 'cli' ? ' · CLI' : ''}${connection.driverId === 'codex' ? ` · ${connection.planningModel || '跟随本机 CLI 配置'}` : ''}${statusSuffix}`
    return option
  }))
  if (!active.id) executor.prepend(new Option(textRoute.error, '', true, true))
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
  cliStatus.querySelector('span:last-child').textContent = state.runtime.status === 'loading' ? 'CLI 检测中' : state.runtime.status === 'error' ? 'CLI 检测失败' : `CLI ${readyCli} 个已安装`
  cliStatus.querySelector('.status-dot').className = `status-dot ${state.runtime.status === 'error' ? 'status-dot-warning' : readyCli ? 'status-dot-success' : 'status-dot-muted'}`
  const runtimeSummary = document.querySelector('#cliRuntimeSummary')
  if (runtimeSummary) {
    runtimeSummary.textContent = state.runtime.status === 'ready'
      ? `${['darwin', 'macos'].includes(state.runtime.platform) ? 'macOS' : state.runtime.platform || '本机'} · ${state.runtime.architecture || '未知架构'} · 选择当前 AI 后，在创作区发起生成。安装检测不代表登录或额度已验证。`
      : state.runtime.status === 'error' ? '检测失败，请重新检测；未修改已选执行端，也不能据此判断 CLI 未安装。' : '正在通过本地运行桥检测受支持的 CLI。'
  }
  mediaWorkbench?.renderEndpoints()
  creationNavigation?.render()
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
  drivers.filter((driver) => driver.canGenerate || driver.credentialError).forEach((driver) => {
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
    // Discovery confirms installation only. Account results belong to the last real call.
    const last = connection.lastExecution
    const discoveryRecovered = connection.discoveryError && !driver.credentialError
    connection.discoveryError = driver.credentialError || null
    connection.status = driver.credentialError ? 'auth_failed' : driver.status === 'ready'
      ? last?.status || (!discoveryRecovered && connection.status === 'ready' ? 'ready' : 'installed')
      : 'error'
    connection.error = driver.credentialError || (driver.status === 'ready'
      ? last?.error || null
      : driver.status === 'not_found' ? '未发现可执行文件' : 'CLI 检测失败或版本不兼容，请重新检测')
  })

  state.connections.filter((connection) => connection.kind === 'cli' && !executableIds.has(connection.id)).forEach((connection) => {
    connection.status = 'error'
    const driver = drivers.find(item => item.id === connection.driverId)
    connection.error = driver?.status === 'not_found' ? '未发现可执行文件' : '当前版本不允许通过该 CLI 生成'
  })
}

function syncCliProxyFields() {
  const manual = document.querySelector('#cliProxyMode').value === 'manual'
  document.querySelector('#cliProxyAddressField').hidden = !manual
  document.querySelector('#cliProxyAddress').disabled = !manual
}

async function openCliProxyDialog() {
  if (!isDesktopRuntime) return showToast('浏览器版使用浏览器和运行服务的网络代理；此设置用于桌面工作台')
  if (projectTransition || state.isGenerating) return showToast('请等待当前保存或文字任务完成，再设置代理')
  const status = document.querySelector('#cliProxyStatus')
  try {
    const settings = await invokeDesktop('network_proxy_get')
    document.querySelector('#cliProxyMode').value = settings.mode || 'auto'
    document.querySelector('#cliProxyAddress').value = settings.url || ''
    status.textContent = '对所有项目生效，保存后从下一次新建网络连接或 CLI 调用开始使用。'
  } catch (error) {
    document.querySelector('#cliProxyMode').value = 'auto'
    document.querySelector('#cliProxyAddress').value = ''
    status.textContent = readableError(error, '无法读取全局代理设置，可重新保存以修复')
  }
  syncCliProxyFields()
  openDialog(document.querySelector('#cliProxyDialog'))
}

function openCliSettingsDialog(driverId) {
  if (projectTransition || state.isGenerating) return showToast('请先等待当前保存或文字任务完成，再设置 CLI')
  const driver = state.runtime.drivers.find(item => item.id === driverId)
  if (!driver) return showToast('未找到此 CLI，请重新检测后再打开设置')
  const connection = state.connections.find(item => item.kind === 'cli' && item.driverId === driver.id)
  const dialog = document.querySelector('#cliSettingsDialog')
  dialog.dataset.driverId = driver.id
  document.querySelector('#cliSettingsTitle').textContent = `${driver.name} 设置`
  const runtimeStatus = driver.status === 'ready' ? '已安装' : driver.status === 'not_found' ? '未安装 · 安装后请重新检测' : '检测失败 · 请检查版本后重新检测'
  document.querySelector('#cliSettingsRuntime').textContent = [runtimeStatus, driver.version].filter(Boolean).join(' · ')
  const descriptions = {
    antigravity: '使用本机 Antigravity CLI 的登录和默认模型。在终端运行 agy 完成登录后即可在工作台选择；账号及模型由 CLI 管理。',
    codex: '使用本机 Codex CLI 的已有登录。模型默认跟随 CLI 配置，可在下面为此连接指定规划模型。',
    claude: 'API Key 为可选项。未提供 Key 时，工作台会尝试使用本机 Claude CLI 已有登录；尚未登录可在终端运行 claude auth login。',
    gemini: '登录和模型由本机 Gemini CLI 管理。工作台目前仅支持安装检测，暂未开放 Gemini 的创作执行。'
  }
  document.querySelector('#cliSettingsSource').textContent = descriptions[driver.id] || '登录与模型由本机 CLI 管理。'
  if (driver.id === 'codex' && !connection) document.querySelector('#cliSettingsSource').textContent += ' 安装并重新检测后，可在这里保存模型设置。'
  const form = document.querySelector('#cliModelForm')
  form.hidden = driver.id !== 'codex' || !connection
  form.dataset.connectionId = connection?.id || ''
  const input = document.querySelector('#cliPlanningModel')
  input.value = driver.id === 'codex' ? connection?.planningModel || '' : ''
  input.removeAttribute('aria-invalid')
  document.querySelector('#cliModelStatus').textContent = '保存不验证账号权限或消耗生成额度。生成失败不会自动更换模型、供应商或计费路径。'
  const credentialForm = document.querySelector('#claudeCredentialForm')
  credentialForm.hidden = driver.id !== 'claude' || !isDesktopRuntime
  document.querySelector('#claudeKeyDetails').open = false
  document.querySelector('#removeClaudeKey').disabled = !(connection?.rememberSecret || sessionSecrets.has('cli-claude'))
  document.querySelector('#claudeApiKey').value = ''
  document.querySelector('#rememberClaudeKey').checked = Boolean(driver.id === 'claude' && connection?.rememberSecret)
  document.querySelector('#claudeCredentialStatus').textContent = driver.id === 'claude' && connection?.rememberSecret
    ? '已设置从 macOS 钥匙串读取 Key。留空保存保留现有设置。'
    : driver.id === 'claude' && sessionSecrets.has('cli-claude') ? '已设置当前会话 Key。留空保存保留现有设置。' : '无需填写 API Key 即可关闭；未提供 Key 时尝试本机已有登录。'
  if (driver.id === 'claude' && driver.credentialError) document.querySelector('#claudeCredentialStatus').textContent = `凭据读取失败：${driver.credentialError}。请重新保存 Key，或移除工作台 Key 后使用本机凭据。`
  if (driver.id === 'claude' && !isDesktopRuntime) document.querySelector('#cliSettingsSource').textContent += ' 工作台内的可选 API Key 设置仅在桌面版提供。'
  document.querySelector('#cliSettingsDone').hidden = !form.hidden || !credentialForm.hidden
  openDialog(dialog)
  window.setTimeout(() => (!form.hidden ? input : dialog.querySelector('[data-action="close-dialog"]'))?.focus(), 0)
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
      const claudeConnection = state.connections.find(item => item.id === 'cli-claude') || { id: 'cli-claude', kind: 'cli', driverId: 'claude', baseUrl: '', rememberSecret: false }
      const driver = runtime.drivers?.find(item => item.id === 'claude')
      try {
        const secret = await connectionSecret(claudeConnection)
        if (secret && driver?.status === 'ready') { driver.canGenerate = true; driver.executionStatus = 'available' }
      } catch (error) {
        // A locked/refused credential affects Claude only; never fall back to another identity.
        if (driver) { driver.credentialError = readableError(error, 'Claude 凭据读取失败'); driver.canGenerate = false; driver.executionStatus = 'credential_error' }
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
    state.connections.filter(connection => connection.kind === 'cli').forEach(connection => {
      connection.status = 'error'
      connection.error = '运行时检测失败，未能确认 CLI 是否可用；请重新检测'
    })
  }
  renderConnections()
}

async function setActiveConnection(connectionId) {
  if (projectTransition) return showToast('项目正在切换或保存，请稍后选择执行端')
  if (!state.connections.some((connection) => connection.id === connectionId && supportsCapability(connection, 'text'))) return
  if (!activeProjectId) return setGlobalExecutor('text', connectionId)
  if (getActiveConnection()?.id !== connectionId) cliSessionConsent = null
  state.workflow.textConnectionId = connectionId
  const saved = await persistWorkspace()
  renderConnections()
  if (saved) showToast(`当前项目文字已切换到 ${getActiveConnection().name}；全局默认未改变`)
}

async function setGlobalExecutor(capability, connectionId) {
  if (projectTransition || (connectionId && !state.connections.some(connection => connection.id === connectionId && supportsCapability(connection, capability)))) {
    renderConnections()
    return showToast('当前无法修改默认，请等待保存完成或重新选择支持该能力的资源')
  }
  const previousTextId = getActiveConnection()?.id
  state.connections.forEach(connection => {
    if (capability === 'text') connection.isActive = connection.id === connectionId
    else connection.defaultFor = [...(connection.defaultFor || []).filter(item => item !== capability), ...(connection.id === connectionId ? [capability] : [])]
  })
  if (previousTextId !== getActiveConnection()?.id) cliSessionConsent = null
  const saved = await persistWorkspace()
  renderConnections()
  if (saved) showToast(`全局${{ text: '文字', image: '图片', video: '视频' }[capability]}默认已${connectionId ? '更新' : '清空'}；项目显式选择未改变`)
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
  document.querySelector('#connectionKind').value = ['ollama', 'image-api', 'video-api'].includes(connection?.kind) ? connection.kind : 'openai-compatible'
  renderConnectionAdapters(document.querySelector('#connectionKind').value, configuredMediaAdapterId(connection || { kind: document.querySelector('#connectionKind').value }))
  document.querySelector('#connectionName').value = connection?.name || '我的模型'
  document.querySelector('#baseUrl').value = connection?.baseUrl || 'https://api.openai.com/v1'
  document.querySelector('#modelName').value = connection?.model || 'gpt-4.1-mini'
  document.querySelector('#apiKey').value = ''
  document.querySelector('#rememberApiKey').checked = Boolean(connection?.rememberSecret)
  document.querySelector('#rememberApiKeyOption').hidden = !isDesktopRuntime
  document.querySelector('#apiKeyField').hidden = connection?.kind === 'ollama'
  document.querySelector('#connectionDialogTitle').textContent = '配置资源连接'
  document.querySelector('[data-action="modal-test-connection"]').textContent = ['image-api', 'video-api'].includes(connection?.kind) ? '检查配置（不调用生成）' : '测试连接'
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
  return Boolean(existing && (draft.kind !== existing.kind || draft.baseUrl !== existing.baseUrl || draft.adapter !== existing.adapter))
}

function renderConnectionAdapters(kind, selectedId) {
  const select = document.querySelector('#connectionAdapter')
  document.querySelector('#connectionAdapterField').hidden = !['image-api', 'video-api'].includes(kind)
  select.replaceChildren(new Option('明确选择协议适配器', ''))
  for (const adapter of mediaAdaptersForKind(kind)) select.append(new Option(adapter.name || adapter.id, adapter.id))
  if (selectedId && ![...select.options].some(option => option.value === selectedId)) select.append(new Option(`${selectedId} · 尚未实现，请重新选择`, selectedId))
  select.value = selectedId || ''
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
    adapter: ['image-api', 'video-api'].includes(kind) ? document.querySelector('#connectionAdapter').value : null,
    status: 'unknown',
    capabilities: kind === 'image-api' ? ['图片生成', '参考图编辑 · 待实测'] : kind === 'video-api' ? ['异步视频', '输入组合由协议校验'] : kind === 'ollama' ? ['完全本地', '流式输出'] : ['流式输出', 'OpenAI 兼容'],
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
  if (['image-api', 'video-api'].includes(draft.kind)) {
    try {
      if (!mediaAdapterFor(draft, draft.kind === 'image-api' ? 'image' : 'video')) throw new Error('请选择已实现的协议适配器；不会自动更换资源')
      validateProviderBaseUrl('openai-compatible', draft.baseUrl)
      if (!draft.model) throw new Error('请填写实际资源支持的模型')
      elements.connectionTestStatus.replaceChildren(createIcon('icon-check'), document.createTextNode('配置格式有效；尚未验证账号、额度或真实生成能力'))
    } catch (error) { elements.connectionTestStatus.replaceChildren(createIcon('icon-alert'), document.createTextNode(readableError(error))) }
    return
  }
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
    if (button.isConnected) button.disabled = form.dataset.saving === 'true'
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
  if (state.workflow.preset === 'text') {
    const steps = creationSteps('text')
    const index = steps.findIndex(step => step.documentId === state.currentDocId)
    if (index >= 0) { await navigateCreationStep(steps[index + 1] || steps.at(-1)); return }
  }
  const nextDocument = { idea: 'brief', brief: 'world', world: 'characters', characters: 'outline' }[state.currentDocId]
  if (nextDocument) {
    if (await selectDocument(nextDocument)) showToast(`已进入${state.documents[nextDocument].title}，上一步内容会作为 AI 上下文`)
    return
  }
  if (state.currentDocId === 'outline') {
    if (getEpisodeIds().length) await selectDocument(getEpisodeIds()[0])
    else openNewContentDialog({ type: 'episode' })
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
      if (!isProjectView(state.currentView)) switchView('workspace')
      toggleAssistant()
      break
    }
    case 'toggle-explorer': toggleExplorer(); break
    case 'close-drawers': closeDrawers(); break
    case 'focus-assistant': focusAssistant(); break
    case 'character-images': await mediaWorkbench?.openCharacterImages(); break
    case 'open-command': openCommandPalette(); break
    case 'new-project': {
      document.querySelector('#projectLibraryDialog').close()
      openDialog(elements.newProjectDialog)
      break
    }
    case 'project-library': await openProjectLibrary(); break
    case 'toggle-archived-projects': showingArchivedProjects = !showingArchivedProjects; await openProjectLibrary(); break
    case 'archive-project': await archiveCurrentProject(); break
    case 'delete-project': await deleteSelectedProject(button.dataset.projectId); break
    case 'restore-archived-project': await restoreArchivedProject(button.dataset.projectId); break
    case 'backup-library': await exportLibrary(); break
    case 'recover-library': await recoverPreviousLibrary(); break
    case 'switch-project': await switchProject(button.dataset.projectId); break
    case 'backup-project': await exportProject('json'); break
    case 'export-project': await exportProject('md'); break
    case 'restore-project': document.querySelector('#projectBackupFile').click(); break
    case 'restore-media-package': document.querySelector('#projectLibraryDialog').close(); await mediaWorkbench?.restorePackage(); break
    case 'pending-media-imports': document.querySelector('#projectLibraryDialog').close(); await mediaWorkbench?.showPendingImports(); break
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
    case 'select-doc': selectDocument(button.dataset.docId, { keepStoryboard: state.currentView === 'storyboard' }); break
    case 'toggle-tree-group': {
      const act = state.structure.acts.find((item) => item.id === button.dataset.actId)
      if (!act) break
      act.collapsed = !act.collapsed
      renderProjectTree()
      await persistWorkspace()
      break
    }
    case 'toggle-focus-mode': {
      const active = !elements.appShell.classList.contains('focus-mode')
      setFocusMode(active)
      showToast(active ? '已进入专注模式' : '已退出专注模式')
      break
    }
    case 'save-snapshot': await saveManualSnapshot(button); break
    case 'show-history': switchTab('history'); break
    case 'restore-version': restoreSelectedVersion(); break
    case 'undo': undoCustom(); break
    case 'redo': redoCustom(); break
    case 'send-prompt': if (state.isGenerating) stopGeneration(); else startGeneration(elements.promptInput.value); break
    case 'discard-candidate': discardCandidate(); break
    case 'retry-generation': startGeneration(state.lastPrompt, { clearComposer: false, purpose: state.generationContext?.purpose || 'text', creativeAction: state.generationContext?.creativeAction || '', storyboardRevision: state.storyboard.revision, storyboardSourceFingerprint: storyboardSourceFingerprint(state.storyboard, state.currentDocId), sourceFingerprint: contentFingerprint(getCurrentContent()) }); break
    case 'review-project-plan': projectPlanUI?.open(elements.candidateContent.textContent, state.generationContext?.operationContext, { candidateId: state.activeCandidateId }); break
    case 'review-existing-plan': if (state.isGenerating) showToast('请先停止或等待当前任务'); else projectPlanUI?.open(); break
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
    case 'configure-cli': openCliSettingsDialog(button.dataset.driverId); break
    case 'configure-cli-proxy': openCliProxyDialog(); break
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
    if (button.closest('.project-modes')) closeDrawers()
    switchView(button.dataset.viewTarget)
    return
  }

  if (button.dataset.prompt) {
    prepareAssistantAction(button.dataset.prompt, button.dataset.creativeAction)
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
    syncCurrentDocumentReferences()
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

elements.treeSearch.addEventListener('input', filterProjectTree)

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

elements.promptInput.addEventListener('input', () => {
  if (!elements.promptInput.value.trim()) state.creativeActionContext = null
  renderContextPreview()
  const prefix = elements.promptInput.value.slice(0, elements.promptInput.selectionStart)
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u)
  if (match) {
    document.querySelector('#assistantContextSettings').open = true
    document.querySelector('#contextObjectPicker').open = true
    document.querySelector('#contextObjectSearch').value = match[1]
    renderContextObjects()
  }
})
document.querySelector('#addContextObject').addEventListener('click', () => {
  const picker = document.querySelector('#contextObjectPicker'); picker.open = !picker.open
  if (picker.open) { document.querySelector('#assistantContextSettings').open = true; document.querySelector('#contextObjectSearch').value = ''; renderContextObjects(); document.querySelector('#contextObjectSearch').focus() }
})
document.querySelector('#contextObjectSearch').addEventListener('input', renderContextObjects)
document.querySelector('#contextObjectPicker').addEventListener('toggle', event => document.querySelector('#addContextObject').setAttribute('aria-expanded', String(event.target.open)))
document.querySelector('#contextObjectPicker').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); document.querySelector('#contextObjectPicker').open = false; elements.promptInput.focus() }
})
for (const [id, key] of [['includeCurrentContext', 'includeCurrentContext'], ['includeSelectionContext', 'includeSelectionContext']]) {
  document.querySelector(`#${id}`).addEventListener('change', event => { state[key] = event.target.checked; renderContextPreview() })
}
elements.scriptEditor.addEventListener('select', () => { if (state.includeSelectionContext) renderContextPreview() })
document.querySelector('#resetContextScope').addEventListener('click', () => {
  state.includeCurrentContext = true; state.includeSelectionContext = false; state.excludedContextKeys.clear(); state.contextReferenceKeys = []
  document.querySelectorAll('.context-chip').forEach(chip => chip.setAttribute('aria-pressed', 'true'))
  syncCurrentDocumentReferences()
  renderContextPreview()
})

elements.promptInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    startGeneration(elements.promptInput.value)
  }
})

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || projectTransition) return
  const commandKey = event.metaKey || event.ctrlKey
  if (elements.connectionDialog.open && document.querySelector('#connectionForm').dataset.saving === 'true') {
    if (event.key === 'Escape' || (commandKey && ['k', 'p', 's'].includes(event.key.toLowerCase()))) event.preventDefault()
    return
  }
  if (commandKey && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openCommandPalette()
  }
  if (commandKey && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    focusProjectSearch()
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
  projectPlanUI?.reset()
  elements.toastStack.replaceChildren()
  document.querySelector('#embeddingModel').value = snapshot.workspace.knowledge?.semantic?.model || ''
  discardCandidate({ silent: true, remove: false, persist: false })
  window.clearTimeout(state.saveTimer)
  activeProjectId = snapshot.id
  state.workflowStep = null
  state.contextReferenceKeys = []; state.excludedContextKeys.clear(); state.includeCurrentContext = true; state.includeSelectionContext = false
  document.querySelector('#contextObjectPicker').open = false
  const workspace = snapshot.workspace
  state.candidateDrafts = structuredClone(workspace.candidateDrafts || [])
  state.connections = normalizeConnections(workspace.connections)
  state.workflow = normalizeWorkflow(workspace.workflow)
  state.storyboard = normalizeStoryboard(workspace.storyboard)
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
  mediaWorkbench?.refresh()
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
    const row = document.createElement('div')
    row.className = 'project-list-row'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'text-button danger-button'
    remove.dataset.action = 'delete-project'
    remove.dataset.projectId = project.id
    remove.textContent = '删除'
    remove.setAttribute('aria-label', `删除项目“${project.name}”`)
    row.append(button, remove)
    list.append(row)
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

function confirmProjectDeletion(project) {
  const dialog = document.querySelector('#deleteProjectDialog')
  if (dialog.open) return Promise.resolve(false)
  document.querySelector('#deleteProjectName').textContent = project.name
  dialog.returnValue = ''
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true })
    openDialog(dialog)
  })
}

function requestAssetDraftDecision({ title, message, allowSave = false }) {
  if (document.querySelector('#assetDraftDecisionDialog')) return Promise.resolve('cancel')
  const returnTarget = document.activeElement
  const dialog = document.createElement('dialog')
  dialog.id = 'assetDraftDecisionDialog'; dialog.className = 'app-dialog form-dialog'
  dialog.setAttribute('aria-labelledby', 'assetDraftDecisionTitle')
  dialog.setAttribute('aria-describedby', 'assetDraftDecisionMessage')
  const form = document.createElement('form'); form.method = 'dialog'
  const heading = document.createElement('h2'); heading.id = 'assetDraftDecisionTitle'; heading.textContent = title
  const description = document.createElement('p'); description.id = 'assetDraftDecisionMessage'; description.className = 'dialog-description'; description.textContent = message
  const actions = document.createElement('div'); actions.className = 'dialog-actions'
  for (const [value, label] of [['cancel', '取消'], ['discard', allowSave ? '放弃修改并归档' : '放弃这些修改'], ...(allowSave ? [['save', '保存并归档']] : [])]) {
    const button = document.createElement('button')
    button.type = 'submit'; button.value = value; button.textContent = label
    button.className = value === 'save' ? 'primary-button' : 'secondary-button'
    if (value === 'cancel') button.autofocus = true
    actions.append(button)
  }
  form.append(heading, description, actions); dialog.append(form); document.body.append(dialog)
  return new Promise(resolve => {
    // A project-library dialog may remain open below this decision.
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); dialog.close('cancel')
    })
    dialog.addEventListener('close', () => {
      const choice = dialog.returnValue
      dialog.remove()
      if (returnTarget?.isConnected) returnTarget.focus()
      resolve(['save', 'discard'].includes(choice) ? choice : 'cancel')
    }, { once: true })
    dialog.showModal()
  })
}

async function resolveAssetDraftsBeforeClose() {
  let draft
  while ((draft = mediaWorkbench?.pendingAssetDraft())) {
    const project = listProjects().find(item => item.id === draft.projectId)
    if (project) {
      if (activeProjectId !== draft.projectId) await switchProject(draft.projectId)
      if (activeProjectId !== draft.projectId) { showToast('尚未切回素材草稿所在项目，请稍后再关闭'); return false }
      await mediaWorkbench.refresh()
      if (mediaWorkbench.showAssetDraft(draft.assetId)) {
        showToast('素材信息尚未保存，请保存或放弃修改后再关闭')
        return false
      }
    }
    const archived = !project && listArchivedProjects().some(item => item.id === draft.projectId)
    const message = project ? '暂时无法定位待保存的素材。可取消后在素材库重新读取，或放弃此素材的未保存修改。'
      : archived ? '素材草稿所属项目已归档。可取消后从项目库恢复项目再保存，或放弃该项目的未保存素材修改。'
        : '素材草稿所属项目已不存在。放弃该项目的未保存素材修改后，即可继续关闭应用。'
    if (await requestAssetDraftDecision({ title: '处理未保存的素材修改', message }) !== 'discard') return false
    mediaWorkbench.discardAssetDrafts(draft.projectId, project ? draft.assetId : null)
  }
  return true
}

async function deleteSelectedProject(id) {
  if (projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  if (mediaWorkbench?.hasPendingWork()) return showToast('素材正在保存或同步，请稍后再删除项目')
  const project = [...listProjects(), ...listArchivedProjects()].find(item => item.id === id)
  if (!project) return showToast('未找到项目，请重新打开项目库')
  if (state.isGenerating) return showToast('请先停止当前文字生成，再删除项目')
  if (!await confirmProjectDeletion(project)) return
  if (projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy() || state.isGenerating) return
  if (mediaWorkbench?.hasPendingWork()) return showToast('素材正在保存或同步，请稍后再删除项目')
  setProjectTransition(true)
  try {
    // Save only the project that survives deletion. A damaged/full target must remain deletable.
    if (activeProjectId !== id && !await saveImmediately({ announce: false })) return
    window.clearTimeout(state.saveTimer)
    const result = await deleteProject(id)
    mediaWorkbench?.discardAssetDrafts(id)
    if (activeProjectId === id) loadProjectSnapshot(getActiveProject())
    await openProjectLibrary()
    showToast(result.cleanupPending ? '项目已删除，部分媒体文件待清理；重新打开应用时会自动重试' : '项目已永久删除')
  } catch (error) { showToast(readableError(error, '删除失败，项目已保留')) }
  finally { setProjectTransition(false) }
}

async function archiveCurrentProject() {
  if (!activeProjectId || projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  if (mediaWorkbench?.hasPendingWork()) return showToast('素材正在保存或同步，请稍后再归档')
  const owner = activeProjectId
  let draftChoice = null
  if (mediaWorkbench?.pendingAssetDraft(owner)) {
    draftChoice = await requestAssetDraftDecision({ title: '归档前处理素材修改', message: '当前项目有尚未保存的素材名称或用途。请选择保存、放弃这些修改，或取消归档继续编辑。', allowSave: true })
    if (draftChoice === 'cancel') return
  }
  if (owner !== activeProjectId || projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  if (mediaWorkbench?.hasPendingWork()) return showToast('素材正在保存或同步，请稍后再归档')
  setProjectTransition(true)
  try {
    if (state.isGenerating) stopGeneration()
    if (draftChoice === 'save') {
      await mediaWorkbench.saveAssetDrafts(owner)
      if (mediaWorkbench.pendingAssetDraft(owner)) throw new Error('素材还有未保存修改，请完成保存后再归档')
    }
    window.clearTimeout(state.saveTimer)
    if (state.activeTab !== 'history') setCurrentContent(elements.scriptEditor.value)
    await archiveProject(owner, workspaceSnapshot(), state.knowledge.index)
    if (draftChoice === 'discard') mediaWorkbench.discardAssetDrafts(owner)
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
    if (state.isGenerating) stopGeneration()
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
  try { showToast(`文字／结构库备份已导出（不含实际媒体）：${await downloadDocument('创作工作台文字库备份.json', libraryBackup())}`) }
  catch (error) { showToast(readableError(error, '文字库备份失败')) }
}

async function recoverPreviousLibrary() {
  if (projectTransition || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy()) return
  if (state.isGenerating) return showToast('请先停止当前生成并确认保存，再恢复内部快照')
  setProjectTransition(true)
  window.clearTimeout(state.saveTimer)
  window.clearTimeout(state.candidateSaveTimer)
  state.candidateSaveTimer = null
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
    if (state.isGenerating) stopGeneration()
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
  const flowPreset = String(new FormData(event.currentTarget).get('flowPreset') || 'script')
  if (!['text', 'script', 'storyboard'].includes(flowPreset)) return showToast('创作路径无效，请重新选择')
  if (!projectName || projectName.length > 100) return showToast('项目名称须为 1–100 个字符')
  setProjectTransition(true)
  try {
    if (state.isGenerating) stopGeneration()
    if (!await saveImmediately({ announce: false })) return
    await createProject({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      project: { name: projectName, type: contentType, stage: `${contentType} · 新项目`, template: 'blank' },
      workflow: normalizeWorkflow({ preset: flowPreset }), storyboard: emptyStoryboard(),
      documents: createStarterDocuments(projectName, contentType),
      structure: createBlankStructure(), currentDocId: 'idea', activeTab: 'script',
      tabContents: {}, versions: {}, versionCounters: {}, knowledge: { sources: [], selectedChunkIds: [] }
    }, createKnowledgeIndex([]))
    loadProjectSnapshot(getActiveProject())
    elements.newProjectDialog.close()
    if (flowPreset === 'storyboard') switchView('storyboard')
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
    if (state.isGenerating) stopGeneration()
    if (!await saveImmediately({ announce: false })) return
    if (fullLibrary) { await importLibraryBackup(data); inspirationUI.render() }
    else await createProject(data.workspace, data.index)
    loadProjectSnapshot(getActiveProject())
    document.querySelector('#projectLibraryDialog').close()
    showToast(fullLibrary ? '文字库备份已合并为独立副本，原有项目与灵感保留；实际媒体需使用完整项目包恢复' : '文字／结构备份已恢复为独立项目，原项目未被覆盖；实际媒体需使用完整项目包恢复')
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
  const mediaKind = ['image-api', 'video-api'].includes(event.target.value)
  renderConnectionAdapters(event.target.value, null)
  document.querySelector('[data-action="modal-test-connection"]').textContent = mediaKind ? '检查配置（不调用生成）' : '测试连接'
  if (mediaKind) {
    document.querySelector('#modelName').value = ''
    document.querySelector('#modelName').placeholder = '填写该资源实际支持的模型名称'
    if (event.target.value === 'video-api') document.querySelector('#baseUrl').value = ''
  }
  if (isOllama) {
    if (!document.querySelector('#connectionName').value.trim() || document.querySelector('#connectionName').value === '我的模型') {
      document.querySelector('#connectionName').value = 'Ollama'
    }
    document.querySelector('#baseUrl').value = 'http://127.0.0.1:11434'
    document.querySelector('#modelName').value = state.connections.find((connection) => connection.kind === 'ollama')?.model || ''
  }
})

;['connectionName', 'connectionAdapter', 'baseUrl', 'modelName', 'apiKey'].forEach((fieldId) => {
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

elements.connectionDialog.addEventListener('cancel', event => {
  if (document.querySelector('#connectionForm').dataset.saving === 'true') event.preventDefault()
  else invalidateConnectionDraftTest()
})
elements.connectionDialog.addEventListener('close', invalidateConnectionDraftTest)

document.querySelector('#executorSelect').addEventListener('change', (event) => setActiveConnection(event.target.value))

document.querySelector('#connectionForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  if (form.dataset.saving === 'true') return
  const draft = getConnectionDraft()
  const existingIndex = state.connections.findIndex((connection) => connection.id === draft.id)
  const existing = state.connections[existingIndex]
  const endpointChanged = hasConnectionEndpointChanged(draft, existing)
  const isDirty = form.dataset.dirty === 'true'
  draft.isActive = Boolean(existing?.isActive)
  draft.defaultFor = [...(existing?.defaultFor || [])]
  draft.status = form.dataset.testStatus || (!isDirty && existing?.status === 'ready' ? 'ready' : 'unknown')
  draft.lastLatency = Number(form.dataset.lastLatency) || (!isDirty ? existing?.lastLatency : null) || null
  const secret = document.querySelector('#apiKey').value
  draft.rememberSecret = isDesktopRuntime && draft.kind !== 'ollama' && document.querySelector('#rememberApiKey').checked
  invalidateConnectionDraftTest()
  const controls = [...form.querySelectorAll('input, select, button')].map(control => ({ control, disabled: control.disabled }))
  const submitButton = form.querySelector('[type="submit"]')
  const submitLabel = submitButton.textContent
  form.dataset.saving = 'true'
  form.setAttribute('aria-busy', 'true')
  controls.forEach(({ control }) => { control.disabled = true })
  submitButton.textContent = '保存中…'
  try {
    if (['image-api', 'video-api'].includes(draft.kind) && !mediaAdapterFor(draft, draft.kind === 'image-api' ? 'image' : 'video')) throw new Error('请选择已实现的协议适配器；不会自动更换资源')
    validateProviderBaseUrl(['image-api', 'video-api'].includes(draft.kind) ? 'openai-compatible' : draft.kind, draft.baseUrl)
    if (!draft.model) throw new Error('请填写实际支持的模型名称')
    if (isDesktopRuntime && draft.kind !== 'ollama') {
      if (draft.rememberSecret) {
        const value = secret || (!endpointChanged && existing ? await connectionSecret(existing) : '')
        if (!value) throw new Error('请填写需要保存的 API Key')
        await invokeDesktop('credential_save', { id: draft.id, endpoint: draft.baseUrl, secret: value })
      } else if (existing?.rememberSecret) {
        await invokeDesktop('credential_save', { id: existing.id, endpoint: existing.baseUrl, secret: '' })
      }
    }
    if (existingIndex >= 0) state.connections.splice(existingIndex, 1, draft)
    else state.connections.push(draft)
    if (endpointChanged) sessionSecrets.delete(draft.id)
    if (draft.kind !== 'ollama' && secret) sessionSecrets.set(draft.id, secret)
    const saved = await persistWorkspace({
      onError: message => elements.connectionTestStatus.replaceChildren(createIcon('icon-alert'), document.createTextNode(`连接尚未保存：${message}。输入已保留。`))
    })
    renderConnections()
    if (!saved) return
    document.querySelector('#apiKey').value = ''
    elements.connectionDialog.close()
    showToast(draft.rememberSecret ? '连接已保存，密钥保存在 macOS 钥匙串' : '连接已保存；密钥仅用于当前会话')
  } catch (error) {
    const message = readableError(error)
    elements.connectionTestStatus.replaceChildren(createIcon('icon-alert'), document.createTextNode(message))
    showToast(message)
  } finally {
    form.dataset.saving = 'false'
    form.removeAttribute('aria-busy')
    controls.forEach(({ control, disabled }) => { control.disabled = control.matches('[data-action="modal-test-connection"]') ? false : disabled })
    submitButton.textContent = submitLabel
  }
})

document.querySelector('#cliProxyMode').addEventListener('change', syncCliProxyFields)
document.querySelector('#cliProxyForm').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.currentTarget, status = document.querySelector('#cliProxyStatus')
  if (form.dataset.saving === 'true' || projectTransition) return
  if (state.isGenerating) { status.textContent = '请等待当前文字任务完成后再保存。'; return }
  let settings
  try { settings = validateCliProxy({ mode: document.querySelector('#cliProxyMode').value, url: document.querySelector('#cliProxyAddress').value }) }
  catch (error) { status.textContent = error.message; document.querySelector('#cliProxyAddress').focus(); return }
  const controls = [...form.querySelectorAll('input, select, button')]
  form.dataset.saving = 'true'; controls.forEach(control => { control.disabled = true })
  try {
    await invokeDesktop('network_proxy_save', { settings })
    document.querySelector('#globalProxyStatus').textContent = `当前模式：${({ auto: '自动', manual: '手动代理', direct: '直连' })[settings.mode]} · 全部项目共用`
    document.querySelector('#cliProxyDialog').close()
    showToast('全局代理已保存，所有执行端的新请求将使用此设置')
  } catch (error) { status.textContent = readableError(error, '保存失败，原代理设置保留') }
  finally {
    form.dataset.saving = 'false'; controls.forEach(control => { control.disabled = false })
    syncCliProxyFields()
    if (!document.querySelector('#cliProxyDialog').open) document.querySelector('[data-action="configure-cli-proxy"]')?.focus()
  }
})

document.querySelector('#cliPlanningModel').addEventListener('input', event => {
  event.target.removeAttribute('aria-invalid')
  document.querySelector('#cliModelStatus').textContent = '尚未保存。只保存模型选择，不调用生成或验证账号权限。'
})

document.querySelector('#cliModelForm').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.currentTarget
  if (form.dataset.saving === 'true' || projectTransition) return
  const input = document.querySelector('#cliPlanningModel'), status = document.querySelector('#cliModelStatus')
  const connection = state.connections.find(item => item.id === form.dataset.connectionId && item.kind === 'cli' && item.driverId === 'codex')
  if (!connection || state.isGenerating) { status.textContent = '执行端已变化或文字任务仍在运行，请关闭后重新设置。'; return }
  const model = input.value.trim()
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
    input.setAttribute('aria-invalid', 'true')
    status.textContent = '请输入不超过 128 字符的模型 ID：以字母或数字开头，仅可含字母、数字、点、下划线、冒号、斜线和连字符。'
    input.focus()
    return
  }
  const previous = { planningModel: connection.planningModel, status: connection.status, error: connection.error, lastExecution: connection.lastExecution }
  const controls = [...form.querySelectorAll('input, button')]
  const submit = form.querySelector('[type="submit"]')
  form.dataset.saving = 'true'; controls.forEach(control => { control.disabled = true }); submit.textContent = '保存中…'
  status.textContent = '正在保存规划模型，不调用生成…'
  setProjectTransition(true)
  try {
    connection.planningModel = model
    connection.lastExecution = null
    if (state.runtime.drivers.some(driver => driver.id === 'codex' && driver.status === 'ready')) {
      connection.status = 'installed'; connection.error = null
    } else if (connection.status === 'ready') connection.status = 'unknown'
    if (!await persistWorkspace({ onError: message => { status.textContent = `设置未保存：${message}。原设置和输入保留，请重试。` } })) {
      Object.assign(connection, previous)
      if (previous.planningModel === undefined) delete connection.planningModel
      if (previous.lastExecution === undefined) delete connection.lastExecution
      renderConnections()
      return
    }
    cliSessionConsent = null
    renderConnections()
    document.querySelector('#cliSettingsDialog').close()
    showToast(model ? 'Codex 规划模型已保存；实际账号可用性尚未验证' : '已恢复使用 CLI 默认规划模型；不会自动挑选其他模型')
  } finally {
    form.dataset.saving = 'false'; controls.forEach(control => { control.disabled = false }); submit.textContent = '保存设置'
    setProjectTransition(false)
    if (document.querySelector('#cliSettingsDialog').open) input.focus()
    else document.querySelector('[data-action="configure-cli"][data-driver-id="codex"]')?.focus()
  }
})

async function saveClaudeCredential({ remove = false } = {}) {
  const form = document.querySelector('#claudeCredentialForm')
  const status = document.querySelector('#claudeCredentialStatus')
  if (form.dataset.saving === 'true' || projectTransition) return
  if (state.isGenerating) { status.textContent = '请等待当前文字任务完成后再保存。'; return }
  const input = document.querySelector('#claudeApiKey')
  const secret = input.value.trim()
  if (!isDesktopRuntime) return
  if (!secret && !remove) {
    document.querySelector('#cliSettingsDialog').close()
    showToast('未填写新 API Key，现有 CLI 设置保持不变')
    return
  }
  const rememberSecret = !remove && document.querySelector('#rememberClaudeKey').checked
  const controls = [...form.querySelectorAll('input, button')]
  form.dataset.saving = 'true'; controls.forEach(control => { control.disabled = true })
  setProjectTransition(true)
  try {
    const index = state.connections.findIndex(item => item.id === 'cli-claude')
    const previous = index >= 0 ? state.connections[index] : null
    const connection = { ...(previous || { id: 'cli-claude', kind: 'cli', driverId: 'claude', name: 'Claude Code', baseUrl: '', model: '', status: 'unknown', capabilities: ['受控 CLI'], isActive: false }), rememberSecret, status: 'installed', error: null, lastExecution: null, discoveryError: null }
    const restoreConnection = () => {
      if (previous) state.connections.splice(index, 1, previous)
      else state.connections = state.connections.filter(item => item !== connection)
    }
    if (previous) state.connections.splice(index, 1, connection)
    else state.connections.push(connection)
    if (!await persistWorkspace({ onError: message => { status.textContent = `设置未保存：${message}。现有 Key 保留，请重试。` } })) {
      restoreConnection()
      renderConnections()
      return
    }
    try {
      if (remove || rememberSecret || previous?.rememberSecret) await invokeDesktop('credential_save', { id: 'cli-claude', endpoint: '', secret: rememberSecret ? secret : '' })
    } catch (error) {
      restoreConnection()
      const restored = await persistWorkspace({ onError: () => {} })
      renderConnections()
      throw new Error(`${readableError(error)}。新 Key 未用于当前会话。${restored ? '保存选项已恢复，请重试。' : '保存选项恢复失败，请保留窗口并重试。'}`)
    }
    // Do not switch the live credential until both metadata and keychain writes succeed.
    if (remove) sessionSecrets.delete(connection.id)
    else sessionSecrets.set(connection.id, secret)
    input.value = ''
    cliSessionConsent = null
    document.querySelector('#cliSettingsDialog').close()
    await detectRuntime()
    showToast(remove ? '工作台 Claude Key 已移除；下次尝试本机凭据，启动环境中的 Key 仍可能优先于 CLI 登录' : 'Claude 可选 API Key 已保存；下次调用将使用该 Key，账号权限尚未验证')
  } catch (error) { status.textContent = readableError(error); showToast(status.textContent) }
  finally {
    form.dataset.saving = 'false'; controls.forEach(control => { control.disabled = false })
    document.querySelector('#removeClaudeKey').disabled = !(state.connections.find(item => item.id === 'cli-claude')?.rememberSecret || sessionSecrets.has('cli-claude'))
    setProjectTransition(false)
    if (document.querySelector('#cliSettingsDialog').open) {
      document.querySelector('#claudeKeyDetails').open = true
      input.focus()
    }
    else document.querySelector('[data-action="configure-cli"][data-driver-id="claude"]')?.focus()
  }
}

document.querySelector('#claudeCredentialForm').addEventListener('submit', async event => {
  event.preventDefault()
  await saveClaudeCredential()
})
document.querySelector('#removeClaudeKey').addEventListener('click', () => saveClaudeCredential({ remove: true }))

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
  dialog.addEventListener('cancel', event => {
    if (dialog.id === 'cliSettingsDialog' && dialog.querySelector('form[data-saving="true"]')) event.preventDefault()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return
    if (dialog.id === 'cliSettingsDialog' && dialog.querySelector('form[data-saving="true"]')) return
    const bounds = dialog.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close()
  })
  dialog.addEventListener('close', () => {
    if (dialog === elements.connectionDialog) document.querySelector('#apiKey').value = ''
    if (dialog.id === 'cliSettingsDialog') document.querySelector('#claudeApiKey').value = ''
    if (dialog === elements.commandDialog) {
      elements.commandInput.setAttribute('aria-expanded', 'false')
      elements.commandInput.removeAttribute('aria-activedescendant')
    }
    const returnTarget = dialog.id === 'cliSettingsDialog'
      ? [...document.querySelectorAll('[data-action="configure-cli"]')].find(button => button.dataset.driverId === dialog.dataset.driverId) || dialogReturnFocus
      : dialogReturnFocus
    if (returnTarget instanceof HTMLElement) returnTarget.focus()
    dialogReturnFocus = null
  })
})

window.addEventListener('resize', () => {
  if (!window.matchMedia('(max-width: 899px)').matches) elements.appShell.classList.remove('explorer-open')
  syncAssistantAccessibility()
})

document.documentElement.dataset.theme = storedWorkspace.theme === 'dark' ? 'dark' : 'light'
window.addEventListener('beforeunload', event => {
  if (mediaWorkbench?.pendingAssetDraft()) { event.preventDefault(); event.returnValue = ''; return }
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
    if (mediaWorkbench?.hasPendingWork()) return showToast('素材正在保存或同步，请稍候再关闭')
    if (!await resolveAssetDraftsBeforeClose()) return
    if (state.isGenerating) stopGeneration()
    if (inspirationUI.dirty() && !await inspirationUI.save()) {
      switchView('inspirations')
      showToast('灵感尚未保存，请补全标题与正文后再关闭')
      return
    }
    if (await saveImmediately({ announce: false }) && !unsavedEdits && !pendingSaves && !inspirationUI.dirty() && !mediaWorkbench?.pendingAssetDraft() && !mediaWorkbench?.hasPendingWork()) await appWindow.destroy()
    } finally { closeRequestActive = false }
  }).catch(error => showToast(readableError(error, '关闭前保存监听失败，请手动保存')))
}
function initializeProjectMediaWorkbench() {
  return initializeMediaWorkbench({
  getContext: () => ({ projectId: activeProjectId, project: state.project, documents: state.documents, structure: state.structure, currentDocId: state.currentDocId, connections: state.connections, workflow: state.workflow, storyboard: state.storyboard, textGenerating: state.isGenerating || Boolean(state.generationInFlight), mutationBusy: projectTransition || state.candidateApplying }),
  commit: async (patch, { projectId, revision = null, immediate = true, resolvedCandidateId = null, atomic = false } = {}) => {
    if (!activeProjectId || activeProjectId !== projectId || projectTransition) throw new Error('项目已切换或正在保存，未修改其他项目')
    if (revision !== null && state.storyboard.revision !== revision) throw new Error('分镜已有新的修改，请重试；未覆盖当前内容')
    if (resolvedCandidateId || atomic) {
      if (state.isGenerating || state.candidateApplying) throw new Error('请先等待或停止当前任务')
      rememberCurrentCandidate()
      state.candidateApplying = true
      setProjectTransition(true)
      try {
        if (!await saveImmediately({ announce: false })) throw new Error('原项目保存失败，尚未采纳分镜')
        const next = structuredClone(workspaceSnapshot())
        next.storyboard = patch.storyboard
        if (resolvedCandidateId) next.candidateDrafts = removeCandidateDraft(next.candidateDrafts, resolvedCandidateId)
        validateWorkspace(next, state.knowledge.index)
        try { await saveProject(projectId, next, state.knowledge.index) }
        catch (error) { state.storageFailed = true; setSaveStatus('error'); throw error }
        state.storyboard = next.storyboard
        state.candidateDrafts = next.candidateDrafts
        // Clear the active buffer before releasing the save lock, so a later
        // workspace snapshot cannot put the resolved draft back into storage.
        if (resolvedCandidateId && state.activeCandidateId === resolvedCandidateId) discardCandidate({ silent: true, remove: false, persist: false })
        if (resolvedCandidateId) mediaWorkbench?.clearCandidate?.(resolvedCandidateId)
        editRevision += 1; unsavedEdits = false; state.storageFailed = false
        creationNavigation?.render(); setSaveStatus('saved')
      } finally { state.candidateApplying = false; setProjectTransition(false); renderCandidateDrafts() }
      return
    }
    if (patch.storyboard) { validateStoryboard(patch.storyboard); state.storyboard = patch.storyboard; creationNavigation?.render() }
    if (patch.workflow) {
      const previousTextId = getActiveConnection()?.id
      const previousStoryboardId = resolveConnectionRoute(state, 'storyboard').connection?.id
      state.workflow = normalizeWorkflow(patch.workflow)
      if (previousTextId !== getActiveConnection()?.id || previousStoryboardId !== resolveConnectionRoute(state, 'storyboard').connection?.id) cliSessionConsent = null
      renderConnections()
    }
    if (!immediate) { scheduleSave(); return }
    unsavedEdits = true
    editRevision += 1
    if (!await persistWorkspace()) throw new Error('保存失败，当前编辑仍保留，请重试保存或导出备份')
  },
  openSavedCandidates: () => {
    toggleAssistant(true)
    renderCandidateDrafts()
    const shelf = document.querySelector('#candidateDraftShelf')
    if (!state.candidateDrafts.length) return showToast('暂无待审候选')
    shelf.open = true
    shelf.scrollIntoView({ block: 'nearest' })
    document.querySelector('#candidateDraftSelect').focus()
  },
  onCandidateChange: (id, text) => {
    if (projectTransition || state.candidateApplying) throw new Error('项目正在保存，请稍后编辑候选')
    const draft = state.candidateDrafts.find(item => item.id === id)
    if (!draft) throw new Error('待审稿已失效，请重新打开')
    state.candidateDrafts = upsertCandidateDraft(state.candidateDrafts, { ...draft, text })
    if (state.activeCandidateId === id) { state.generationText = text; elements.candidateContent.textContent = text }
    scheduleCandidateSave()
  },
  onCandidateResolved: (id, { committed }) => {
    if (state.activeCandidateId === id) discardCandidate({ silent: true, remove: !committed, persist: !committed })
    else if (!committed) {
      state.candidateDrafts = removeCandidateDraft(state.candidateDrafts, id)
      scheduleSave(); renderCandidateDrafts()
    }
  },
  invoke: isDesktopRuntime ? invokeDesktop : null,
  secret: connectionSecret,
  beforeSubmit: async () => { if (!await saveImmediately({ announce: false })) throw new Error('请先保存当前项目再生成媒体') },
  stopText: stopGeneration,
  requestText: async (prompt, metadata) => {
    const owner = activeProjectId
    if (state.isGenerating || state.generationInFlight) return showToast('请先等待当前文字任务完成或停止')
    if (!await selectDocument(metadata.documentId) || owner !== activeProjectId) return false
    if (state.activeTab !== 'script') await switchTab('script')
    if (owner !== activeProjectId || state.currentDocId !== metadata.documentId || contentFingerprint(getCurrentContent()) !== metadata.sourceFingerprint) throw new Error('拆镜来源在准备期间已变化，请重新执行')
    const started = startGeneration(prompt, { ...metadata, clearComposer: false })
    switchView('storyboard')
    return started
  },
  notify: showToast,
  navigate: switchView,
  portableProject: async () => {
    if (!await saveImmediately({ announce: false })) throw new Error('请先保存当前项目再导出完整包')
    return JSON.parse(projectBackup(workspaceSnapshot(), state.knowledge.index))
  },
  importPackage: async (data, projectId) => {
    validateWorkspace(data.workspace, data.index)
    if (state.isGenerating) stopGeneration()
    if (!await saveImmediately({ announce: false })) throw new Error('当前项目保存失败，原项目和已导入媒体均保留，未切换项目')
    await createProject(data.workspace, data.index, projectId, { mediaImportId: data.importId })
    loadProjectSnapshot(getActiveProject())
    switchView('assets')
  }
  })
}

document.querySelectorAll('svg.icon').forEach((icon) => icon.setAttribute('aria-hidden', 'true'))
syncThemeControl()
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

const updatesUI = initializeUpdates({
  invoke: isDesktopRuntime ? invokeDesktop : null, openDialog,
  beforeInstall: async () => {
    if (mediaWorkbench?.pendingAssetDraft()) throw new Error('素材信息尚未保存，请在对应项目素材库保存或放弃修改后再更新')
    if (projectTransition || state.isGenerating || state.candidateApplying || state.knowledgeBusy || inspirationUI.isBusy() || mediaWorkbench?.hasPendingWork()) {
      throw new Error('请先等待当前生成、导入或保存任务结束')
    }
    updateInstalling = true
    setProjectTransition(true)
    document.getElementById('updateDialog').inert = false
    const unlock = () => { updateInstalling = false; setProjectTransition(false) }
    try {
      if (inspirationUI.dirty() && !await inspirationUI.save()) throw new Error('灵感尚未保存成功')
      if (!await saveImmediately({ announce: false }) || unsavedEdits || pendingSaves || inspirationUI.dirty()) throw new Error('创作内容尚未保存成功')
      return unlock
    } catch (error) { unlock(); throw error }
  }
})
mediaWorkbench = initializeProjectMediaWorkbench()
mediaWorkbench.refresh()
creationNavigation = initializeCreationNavigation({
  getContext: () => ({ projectId: activeProjectId, workflow: state.workflow, documents: state.documents, documentId: state.currentDocId, structure: state.structure, storyboard: state.storyboard, view: state.currentView, step: state.workflowStep, connections: state.connections, textConnection: getActiveConnection(), connectionStatus: connection => getConnectionStatusCopy(connection)[1], knowledgeCount: getSelectedKnowledgeChunks().length }),
  navigate: navigateCreationStep,
  notify: showToast
})
creationNavigation.render()
projectPlanUI = initializeProjectPlanUI({
  getContext: projectOperationContext,
  captureContext: () => {
    if (state.isGenerating || state.candidateApplying) throw new Error('请先等待或停止当前任务')
    return captureOperationContext(projectOperationContext(), generationDraft(elements.promptInput.value.trim(), 'text').summary)
  },
  commit: async (plan, base, { candidateId = null } = {}) => {
    if (projectTransition || state.candidateApplying || state.isGenerating) throw new Error('当前任务尚未结束，请稍候再采纳')
    const sourceDraft = candidateId ? state.candidateDrafts.find(draft => draft.id === candidateId && draft.context.purpose === 'project-plan' && draft.context.projectId === base.projectId) : null
    if (candidateId && !sourceDraft) throw new Error('来源候选已失效，请重新打开计划；尚未采纳修改')
    state.candidateApplying = true
    setProjectTransition(true)
    try {
      if (!await saveImmediately({ announce: false })) throw new Error('原项目保存失败，尚未采纳修改')
      const versionIds = [...new Set(plan.operations.filter(operation => operation.tool === 'select_shot_media').map(operation => operation.versionId))]
      if (versionIds.length) {
        if (!isDesktopRuntime) throw new Error('选用媒体前须在桌面版核验真实文件，未修改项目')
        const verified = await invokeDesktop('media_verify_versions', { projectId: base.projectId, versionIds })
        if (verified.length !== versionIds.length || versionIds.some(id => !verified.some(version => version.id === id && version.mimeType === base.mediaVersions[id].mimeType && version.bytes === base.mediaVersions[id].bytes))) throw new Error('媒体核验结果与计划不一致，请刷新后重新审阅')
      }
      const result = materializeOperationPlan(plan, base, projectOperationContext(), { recordVersions: true, knowledgeChunks: sourceDraft?.context.knowledgeChunks || [] })
      if (result.hasWorkspaceChanges) {
        if (sourceDraft) result.workspace.candidateDrafts = removeCandidateDraft(result.workspace.candidateDrafts || [], sourceDraft.id)
        validateWorkspace(result.workspace, state.knowledge.index)
        try { await saveProject(activeProjectId, result.workspace, state.knowledge.index) }
        catch (error) { state.storageFailed = true; setSaveStatus('error'); throw error }
        for (const key of ['documents', 'tabContents', 'versions', 'versionCounters', 'storyboard', 'candidateDrafts']) state[key] = result.workspace[key]
        for (const id of new Set(result.changes.map(change => change.documentId).filter(Boolean))) {
          for (const tab of ['script', 'outline', 'references']) state.editHistories.delete(`${id}:${tab}`)
          state.selectedVersionByDocument[id] = state.versionCounters[id]
          state.tabContents[id].history = formatVersionHistory(id)
        }
        editRevision += 1; unsavedEdits = false; state.storageFailed = false
      }
      if (sourceDraft && state.activeCandidateId === sourceDraft.id) discardCandidate({ silent: true })
      else if (sourceDraft && !result.hasWorkspaceChanges) {
        state.candidateDrafts = removeCandidateDraft(state.candidateDrafts, sourceDraft.id)
        scheduleSave()
      }
      renderProjectTree(); updateDocumentView(); mediaWorkbench.refresh(); setSaveStatus('saved')
      return result
    } finally { state.candidateApplying = false; setProjectTransition(false); renderCandidateDrafts() }
  },
  renderMedia: versionId => mediaWorkbench.previewVersion(versionId),
  queryTasks: async ({ projectId, shotIds }) => {
    if (!isDesktopRuntime) throw new Error('请在桌面版读取持久化任务；浏览器未伪造查询结果')
    if (activeProjectId !== projectId || shotIds.some(id => !state.storyboard.shots.some(shot => shot.id === id))) throw new Error('查询目标已失效，请在原项目重新预览')
    const result = await invokeDesktop('media_query_jobs', { projectId, targetIds: shotIds })
    if (activeProjectId !== projectId || result?.projectId !== projectId || JSON.stringify(result.targetIds) !== JSON.stringify(shotIds)) throw new Error('项目或查询范围已改变，请重新预览；未修改项目')
    if (!Array.isArray(result.jobs) || result.jobs.length > 20 || typeof result.hasMore !== 'boolean' || typeof result.queriedAt !== 'string' || result.jobs.some(job => !shotIds.includes(job.targetId) || typeof job.id !== 'string' || typeof job.status !== 'string' || !['image', 'video'].includes(job.capability))) throw new Error('本地任务摘要格式无效，未修改项目')
    return result
  },
  openMediaPlan: options => mediaWorkbench.openBatchPlan(options),
  notify: showToast, openDialog
})
document.querySelector('#assistantRequestMode').addEventListener('change', () => {
  document.querySelector('#reviewExistingPlan').hidden = document.querySelector('#assistantRequestMode').value !== 'project-plan'
  renderContextPreview()
})

if (isDesktopRuntime) {
  invokeDesktop('network_proxy_get').then(settings => {
    document.querySelector('#globalProxyStatus').textContent = `当前模式：${({ auto: '自动', manual: '手动代理', direct: '直连' })[settings.mode || 'auto'] || '待配置'} · 全部项目共用`
  }).catch(() => { document.querySelector('#globalProxyStatus').textContent = '配置读取失败，请打开代理设置重新保存' })
} else {
  document.querySelector('#globalProxyStatus').textContent = '浏览器版沿用浏览器与运行服务的代理设置'
}
