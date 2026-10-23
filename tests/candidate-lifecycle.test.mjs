import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { MAX_CANDIDATE_DRAFTS, candidateDraftsFor, upsertCandidateDraft, removeCandidateDraft } from '../src/candidate-drafts.js'
import { prepareGeneration } from '../src/creation-workflow.js'
import { contentFingerprint, storyboardSourceFingerprint, createShot, parseStoryboardCandidate, resolveConnectionRoute } from '../src/storyboard.js'
import { validateWorkspace, projectBackup, parseBackup } from '../src/project-store.js'
import { materializeOperationPlan, parseOperationPlan } from '../src/project-operations.js'

const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')

// Run production lifecycle functions while replacing only storage, provider and
// presentation boundaries. No model calls or browser runtime are needed here.
function productionFunction(name) {
  const declaration = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(appSource)
  assert.ok(declaration, `production function ${name} must exist`)
  const next = /^(?:async )?function \w+\(/m.exec(appSource.slice(declaration.index + declaration[0].length))
  const source = appSource.slice(declaration.index, next ? declaration.index + declaration[0].length + next.index : undefined)
  const end = /^\}$/m.exec(source)
  assert.ok(end, `production function ${name} must have a closing declaration`)
  return source.slice(0, end.index + 1)
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function clock() {
  let now = 0, sequence = 0
  const timers = new Map()
  return {
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    get pending() { return [...timers.values()].map(timer => timer.at) },
    get now() { return now },
    async advance(duration) {
      const until = now + duration
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        now = timer.at; timers.delete(id); timer.callback()
        await Promise.resolve(); await Promise.resolve()
      }
      now = until
      await Promise.resolve(); await Promise.resolve()
    }
  }
}

function node() {
  const attributes = new Map(), children = new Map(), classes = new Set()
  return {
    value: '', textContent: '', hidden: false, disabled: false, dataset: {}, selectionStart: 0, selectionEnd: 0,
    lastElementChild: { textContent: '' },
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle: (value, on) => on ? classes.add(value) : classes.delete(value) },
    setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key),
    querySelector(selector) { if (!children.has(selector)) children.set(selector, node()); return children.get(selector) },
    querySelectorAll: () => [], closest() { return this }, replaceChildren() {}, focus() {}
  }
}

function documentData(title, content) {
  return { title, content, sceneTitle: title, breadcrumb: '测试项目', badge: '剧本', kicker: '第一场', intent: '让人物动机清楚', meta: [], mode: '写作', labels: ['正文', '大纲', '引用', '历史'] }
}

function draft(id = 'candidate-script', documentId = 'scene-1', tabName = 'script', text = '她握紧钥匙，却没有推门。') {
  return {
    id, documentId, tabName, prompt: '保留人物的犹豫', text, createdAt: '2026-10-15T09:00:00.000Z', status: 'complete',
    context: {
      projectId: 'project-original', purpose: 'text', sourceFingerprint: '', storyboardRevision: null, operationContext: null,
      documentId, tabName, title: '第一场', baseContent: tabName === 'outline' ? '先犹豫，再决定。' : '她站在门前。',
      selectionStart: 0, selectionEnd: 0, knowledgeChunks: [],
      messages: [{ role: 'system', content: '保持角色设定' }, { role: 'user', content: '正文：她站在门前。\n要求：保留人物的犹豫' }]
    }
  }
}

function harness({ candidates = [draft()], activeProjectId = 'project-original' } = {}) {
  const timers = clock(), queries = new Map(), controls = Array.from({ length: 3 }, node)
  const calls = { attempts: [], persisted: [], providers: [], statuses: [], toasts: [] }
  const saveOutcomes = []
  const state = {
    project: { name: '候选生命周期回归', type: '短剧' }, currentDocId: 'scene-1', activeTab: 'script',
    documents: { 'scene-1': documentData('第一场', '她站在门前。'), 'scene-2': documentData('第二场', '屋里传来脚步声。') },
    structure: { acts: [], episodes: {} },
    tabContents: { 'scene-1': { outline: '先犹豫，再决定。', references: '', history: '' }, 'scene-2': { outline: '', references: '', history: '' } },
    versions: { 'scene-1': [], 'scene-2': [] }, versionCounters: { 'scene-1': 0, 'scene-2': 0 }, selectedVersionByDocument: {}, editHistories: new Map(),
    knowledge: { sources: [], selectedChunkIds: [], index: null }, workflow: { preset: 'script' }, storyboard: { revision: 0, shots: [] },
    connections: [{ id: 'test-provider', kind: 'openai-compatible', isActive: true, model: 'unused' }],
    candidateDrafts: structuredClone(candidates), activeCandidateId: null, candidateCreatedAt: null, candidateStatus: 'partial',
    generationContext: null, generationText: '', lastPrompt: '', isGenerating: false, candidateApplying: false,
    activeGenerationId: null, generationSequence: 0, candidateSaveTimer: null, storageFailed: false
  }
  const elements = Object.fromEntries([
    'candidateContent', 'candidateActions', 'candidateCard', 'candidateCitations', 'generationError', 'generationState',
    'scriptEditor', 'promptInput', 'welcome', 'conversationThread', 'userMessage', 'sendButton', 'a11yAnnouncements',
    'assistantConversation', 'documentTitle', 'documentBreadcrumb', 'documentBadge', 'sceneKicker', 'sceneTitle', 'sceneIntent', 'historyVersionSelect'
  ].map(key => [key, node()]))
  elements.scriptEditor.value = state.documents['scene-1'].content
  elements.candidateActions.querySelectorAll = () => controls
  const sandbox = {
    state, elements, activeProjectId, WORKSPACE_SCHEMA_VERSION: 2, MAX_CANDIDATE_DRAFTS,
    structuredClone, crypto: webcrypto, saveSequence: 0, pendingSaves: 0, editRevision: 0, unsavedEdits: false,
    projectTransition: false, isDesktopRuntime: false, creationNavigation: null, mediaWorkbench: null,
    tabFallbacks: { outline: '', references: '', history: '' },
    window: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, clearInterval() {}, requestAnimationFrame: callback => callback() },
    document: {
      documentElement: { dataset: { theme: 'light' } }, createElement: node,
      querySelector(selector) { if (!queries.has(selector)) queries.set(selector, node()); return queries.get(selector) },
      querySelectorAll: selector => selector.includes('apply-candidate') ? controls : []
    },
    // VM literals have a different Object prototype; clone at module boundaries
    // so the actual pure-JSON helpers see the same realm as in production.
    upsertCandidateDraft: (drafts, value) => upsertCandidateDraft(structuredClone(drafts), structuredClone(value)),
    removeCandidateDraft: (drafts, id) => removeCandidateDraft(structuredClone(drafts), id),
    candidateDraftsFor: (drafts, documentId, tabName) => candidateDraftsFor(structuredClone(drafts), documentId, tabName),
    saveProject: async (projectId, snapshot) => {
      const copy = structuredClone(snapshot)
      validateWorkspace(copy)
      calls.attempts.push({ projectId, snapshot: copy, at: timers.now })
      const outcome = saveOutcomes.shift()
      outcome?.markEntered(copy)
      if (outcome && !await outcome.promise) throw new Error('测试：磁盘写入失败')
      calls.persisted.push({ projectId, snapshot: copy, at: timers.now })
    },
    setSaveStatus: status => calls.statuses.push(status), showToast: message => calls.toasts.push(message),
    readableError: error => error.message, resolveConnectionRoute, storyboardSourceFingerprint,
    initializeMediaWorkbench: options => options, connectionSecret: async () => null,
    setProjectTransition: value => { sandbox.projectTransition = value },
    validateWorkspace: (workspace, index) => validateWorkspace(structuredClone(workspace), index),
    generationDraft: prompt => prepareGeneration({ ...state, documentId: state.currentDocId, tabName: state.activeTab, prompt }),
    generateWithConnection: (connection, prompt, generationId) => calls.providers.push({ connection, prompt, generationId }),
    getAssistantProfileKey: () => 'writing', assistantProfiles: { writing: { progress: '正在生成' } },
    renderCandidateDrafts() {}, renderContextPreview() {}, renderFollowupContext() {}, updateWritingPreview() {}, updateCandidateCitations() {}, updateAssistantProfile() {},
    updateEditorMetrics() {}, updateStageAdvanceButton() {}, renderProjectIdentity() {}, renderHistoryControls: () => null, syncCurrentDocumentReferences() {},
    switchView() {}, closeDrawers() {}, scheduleSave() { throw new Error('unexpected extra save after candidate transaction') }
  }
  const names = [
    'getCurrentDocument', 'getContentAt', 'setContentAt', 'getCurrentContent', 'setCurrentContent', 'getEditHistory',
    'workspaceSnapshot', 'persistWorkspace', 'formatVersionHistory', 'addVersion', 'updateDocumentView',
    'saveImmediately', 'selectDocument', 'switchTab', 'appendGenerationDelta', 'startGeneration', 'finishGeneration', 'stopGeneration',
    'scheduleCandidateSave', 'rememberCurrentCandidate', 'showSavedCandidate', 'restoreDocumentCandidate',
    'discardCandidate', 'abandonCandidateOnContextChange', 'applyCandidate', 'initializeProjectMediaWorkbench', 'recoverPreviousLibrary'
  ]
  const context = vm.createContext(sandbox)
  vm.runInContext(names.map(productionFunction).join('\n'), context)
  return { context, state, elements, calls, timers, blockNextSave() {
    const entered = deferred(), gate = { ...deferred(), entered: entered.promise, markEntered: entered.resolve }
    saveOutcomes.push(gate)
    return gate
  } }
}

function storyboardDraft() {
  const candidate = draft('candidate-storyboard')
  candidate.text = JSON.stringify({ shots: [{ title: '门前犹豫', visual: '她握着钥匙站在门前。', duration: 5 }] })
  candidate.context.purpose = 'storyboard'
  candidate.context.sourceFingerprint = contentFingerprint(candidate.context.baseContent)
  candidate.context.storyboardRevision = 0
  return candidate
}

test('workspace persistence includes the current candidate text, exact request and original baseline', async () => {
  const h = harness()
  const candidate = draft()
  h.context.showSavedCandidate(candidate)
  h.state.generationText += '\n这是流式结果的末句。'
  h.state.isGenerating = true
  const originalBaseline = candidate.context.baseContent
  h.state.documents['scene-1'].content = '用户后来修改了正文。'
  assert.equal(await h.context.persistWorkspace(), true)
  const saved = h.calls.persisted.at(-1).snapshot.candidateDrafts[0]
  assert.equal(saved.text, h.state.generationText)
  assert.equal(saved.status, 'partial')
  assert.equal(saved.prompt, candidate.prompt)
  assert.deepEqual(saved.context.messages, candidate.context.messages)
  assert.equal(saved.context.baseContent, originalBaseline)
  h.state.generationContext.messages[0].content = '修改内存上下文'
  assert.equal(saved.context.messages[0].content, '保持角色设定', 'persisted request is an independent snapshot')
})

test('switching documents and tabs saves outgoing work and restores only the matching latest draft', async () => {
  const outline = draft('candidate-outline', 'scene-1', 'outline', '先铺垫声音，再让她决定。')
  const second = draft('candidate-second', 'scene-2', 'script', '她听见屋内有人叫她。')
  const h = harness({ candidates: [draft(), outline, second] })
  h.context.showSavedCandidate(h.state.candidateDrafts[0])
  h.state.generationText += '\n未审阅的补充句。'
  const outgoing = h.state.generationText
  await h.context.switchTab('outline')
  assert.equal(h.state.activeTab, 'outline')
  assert.equal(h.state.activeCandidateId, outline.id)
  assert.equal(h.elements.candidateContent.textContent, outline.text)
  assert.equal(h.calls.persisted[0].snapshot.candidateDrafts.find(value => value.id === 'candidate-script').text, outgoing)
  assert.equal(await h.context.selectDocument('scene-2'), true)
  assert.equal(h.state.currentDocId, 'scene-2')
  assert.equal(h.state.activeTab, 'script')
  assert.equal(h.state.activeCandidateId, second.id)
  assert.equal(h.elements.candidateContent.textContent, second.text)
  await h.context.selectDocument('scene-1')
  assert.equal(h.state.activeCandidateId, 'candidate-script')
  assert.equal(h.elements.candidateContent.textContent, outgoing)
  await h.context.switchTab('references')
  assert.equal(h.state.activeCandidateId, null)
  assert.equal(h.elements.conversationThread.hidden, true)
  assert.equal(h.state.candidateDrafts.length, 3, 'a view without a candidate does not delete other pending drafts')
  await h.context.switchTab('outline')
  assert.equal(h.state.activeCandidateId, outline.id)
})

test('a failed outgoing save keeps the current document, editor and candidate available', async () => {
  const h = harness()
  h.context.showSavedCandidate(h.state.candidateDrafts[0])
  const gate = h.blockNextSave()
  const switching = h.context.selectDocument('scene-2')
  gate.resolve(false)
  assert.equal(await switching, false)
  assert.equal(h.state.currentDocId, 'scene-1')
  assert.equal(h.state.activeCandidateId, 'candidate-script')
  assert.equal(h.elements.candidateContent.textContent, draft().text)
  assert.equal(h.calls.persisted.length, 0)
})

test('retry creates a separate candidate and retains the first completed draft through saving', async () => {
  const h = harness()
  h.context.showSavedCandidate(h.state.candidateDrafts[0])
  const previous = structuredClone(h.state.candidateDrafts[0])
  h.context.startGeneration(previous.prompt, { purpose: 'text' })
  assert.equal(h.calls.providers.length, 1)
  const retryId = h.state.activeCandidateId
  assert.notEqual(retryId, previous.id)
  h.context.appendGenerationDelta('这是重新生成的另一个版本。', retryId)
  h.context.finishGeneration({ generationId: retryId })
  await Promise.resolve(); await Promise.resolve()
  const saved = h.calls.persisted.at(-1).snapshot.candidateDrafts
  assert.deepEqual(saved.find(value => value.id === previous.id), previous)
  assert.equal(saved.find(value => value.id === retryId).text, '这是重新生成的另一个版本。')
  assert.equal(saved.find(value => value.id === retryId).status, 'complete')
  assert.equal(saved.length, 2)
})

test('accepting text persists the new document and candidate removal in one transaction', async () => {
  const other = draft('keep-outline', 'scene-1', 'outline', '尚未审阅的大纲')
  const h = harness({ candidates: [draft(), other] })
  h.context.showSavedCandidate(h.state.candidateDrafts[0])
  const gate = h.blockNextSave()
  const accepting = h.context.applyCandidate('replace')
  assert.equal(h.calls.attempts.length, 1)
  const pending = h.calls.attempts[0].snapshot
  assert.equal(pending.documents['scene-1'].content, draft().text)
  assert.deepEqual(pending.candidateDrafts.map(value => value.id), ['keep-outline'])
  assert.ok(pending.versions['scene-1'].some(value => value.content === draft().context.baseContent))
  assert.ok(pending.versions['scene-1'].some(value => value.content === draft().text))
  assert.equal(h.state.candidateApplying, true)
  gate.resolve(true)
  await accepting
  assert.equal(h.calls.persisted.length, 1, 'candidate removal does not need a second fragile save')
  assert.deepEqual(h.state.candidateDrafts, [other])
  assert.equal(h.state.activeCandidateId, null)
  assert.equal(h.state.candidateApplying, false)
  assert.notEqual(h.elements.a11yAnnouncements.textContent, '候选内容已丢弃', 'successful adoption must not announce that its candidate was discarded')
  assert.ok(h.calls.toasts.some(message => /^已采纳并建立快照 v\d+$/.test(message)))
})

test('failed acceptance rolls back document and history while restoring the same candidate for retry', async () => {
  const h = harness()
  h.context.showSavedCandidate(h.state.candidateDrafts[0])
  const before = structuredClone(h.context.workspaceSnapshot())
  const gate = h.blockNextSave()
  const accepting = h.context.applyCandidate('replace')
  gate.resolve(false)
  await accepting
  assert.equal(h.state.documents['scene-1'].content, before.documents['scene-1'].content)
  assert.equal(h.elements.scriptEditor.value, before.documents['scene-1'].content)
  assert.deepEqual(h.state.versions, before.versions)
  assert.deepEqual(h.state.candidateDrafts, before.candidateDrafts)
  assert.equal(h.state.activeCandidateId, 'candidate-script')
  assert.equal(h.elements.candidateContent.textContent, draft().text)
  assert.equal(h.elements.generationError.hidden, false)
  assert.equal(h.calls.persisted.length, 0)
  assert.equal(await h.context.persistWorkspace(), true)
  assert.deepEqual(h.calls.persisted[0].snapshot.candidateDrafts, before.candidateDrafts)
  await h.context.applyCandidate('replace')
  assert.equal(h.state.documents['scene-1'].content, draft().text)
  assert.equal(h.calls.persisted.at(-1).snapshot.candidateDrafts.length, 0)
})

test('an imported project plan keeps its original authority while ordinary saves remain valid', async () => {
  const plan = draft('imported-plan')
  plan.text = JSON.stringify({ version: 1, summary: '修改正文', operations: [{ tool: 'write_document', documentId: 'scene-1', tabName: 'script', mode: 'replace', content: '计划中的新正文' }] })
  plan.context.purpose = 'project-plan'
  plan.context.operationContext = {
    projectId: 'project-original', documents: { 'scene-1': { title: '第一场', script: '她站在门前。', outline: '先犹豫，再决定。', references: '' } },
    shots: {}, mediaVersions: {}, storyboardRevision: 0
  }
  const original = harness({ candidates: [plan] })
  const imported = parseBackup(projectBackup(structuredClone(original.context.workspaceSnapshot()), null))
  const h = harness({ candidates: imported.workspace.candidateDrafts, activeProjectId: 'project-copy' })
  h.context.showSavedCandidate(h.state.candidateDrafts[0])
  assert.equal(await h.context.persistWorkspace(), true)
  const saved = h.calls.persisted[0]
  assert.equal(saved.projectId, 'project-copy')
  assert.equal(saved.snapshot.candidateDrafts[0].context.projectId, 'project-original')
  const base = saved.snapshot.candidateDrafts[0].context.operationContext
  assert.equal(base.projectId, 'project-original')
  assert.throws(() => materializeOperationPlan(parseOperationPlan(plan.text, base), base, { projectId: 'project-copy', workspace: saved.snapshot, media: null }), /项目已切换/)
  assert.equal(saved.snapshot.documents['scene-1'].content, '她站在门前。')
})

test('continuous deltas are saved at bounded intervals and stale callbacks cannot write another project', async () => {
  const h = harness()
  h.context.showSavedCandidate(h.state.candidateDrafts[0])
  h.state.isGenerating = true
  h.state.activeGenerationId = 'stream-1'
  h.context.appendGenerationDelta('A', 'stream-1')
  for (const delta of ['B', 'C', 'D', 'E']) {
    await h.timers.advance(200)
    h.context.appendGenerationDelta(delta, 'stream-1')
  }
  assert.equal(h.calls.persisted.length, 0)
  await h.timers.advance(200)
  assert.equal(h.calls.persisted.length, 1, 'tokens arriving every 200 ms must not postpone the first one-second save')
  assert.equal(h.calls.persisted[0].at, 1000)
  assert.equal(h.calls.persisted[0].snapshot.candidateDrafts[0].text, draft().text + 'ABCDE')
  h.context.appendGenerationDelta('F', 'stream-1')
  await h.timers.advance(1000)
  assert.equal(h.calls.persisted.length, 2)
  assert.equal(h.calls.persisted[1].snapshot.candidateDrafts[0].text, draft().text + 'ABCDEF')
  h.context.appendGenerationDelta('G', 'stream-1')
  h.context.activeProjectId = 'new-project'
  h.state.documents['scene-1'].content = '新项目独立正文'
  await h.timers.advance(1000)
  assert.equal(h.calls.attempts.length, 2, 'a callback owned by the previous project cannot persist new-project state')
  assert.ok(h.calls.persisted.every(value => value.projectId === 'project-original'))
})

test('candidate autosave skips transition and acceptance locks, then saves retained text after unlocking', async () => {
  for (const lock of ['projectTransition', 'candidateApplying']) {
    const h = harness()
    h.context.showSavedCandidate(h.state.candidateDrafts[0])
    h.state.isGenerating = true
    h.state.activeGenerationId = 'locked-stream'
    h.context.appendGenerationDelta('等待期间收到的内容。', 'locked-stream')
    const lockedState = lock === 'projectTransition' ? h.context : h.state
    lockedState[lock] = true
    await h.timers.advance(1000)
    assert.equal(h.calls.attempts.length, 0, `${lock}: a previously scheduled callback cannot submit a snapshot while locked`)
    assert.equal(h.context.unsavedEdits, true, `${lock}: skipped autosave must leave the retained text marked unsaved`)
    h.context.scheduleCandidateSave({ immediate: true })
    await Promise.resolve()
    assert.equal(h.calls.attempts.length, 0, `${lock}: an immediate autosave must respect the same lock`)
    lockedState[lock] = false
    h.context.appendGenerationDelta('解锁后继续收到的内容。', 'locked-stream')
    await h.timers.advance(1000)
    assert.equal(h.calls.persisted.length, 1, `${lock}: a skipped callback must not prevent future saves`)
    assert.equal(h.calls.persisted[0].projectId, 'project-original')
    assert.equal(h.calls.persisted[0].snapshot.candidateDrafts[0].text, draft().text + '等待期间收到的内容。解锁后继续收到的内容。')
    assert.equal(h.context.unsavedEdits, false, `${lock}: successful resumed saving clears the dirty state`)
  }
})

test('storyboard JSON edits persist in the shared pending draft and restore with the same baseline', async () => {
  const candidate = storyboardDraft()
  const h = harness({ candidates: [candidate] })
  const media = h.context.initializeProjectMediaWorkbench()
  h.context.showSavedCandidate(candidate)
  const edited = JSON.stringify({ shots: [{ title: '门前犹豫', visual: '她收起钥匙，转身离开。', dialogue: '下次吧。', duration: 8 }] })
  media.onCandidateChange(candidate.id, edited)
  assert.equal(h.state.generationText, edited)
  assert.equal(h.elements.candidateContent.textContent, edited)
  await h.timers.advance(1000)
  const saved = h.calls.persisted.at(-1).snapshot.candidateDrafts[0]
  assert.equal(saved.text, edited)
  assert.deepEqual(saved.context, candidate.context)
  const restarted = harness({ candidates: [saved] })
  const received = []
  restarted.context.mediaWorkbench = { receiveCandidate: (...args) => received.push(args), clearCandidate() {} }
  restarted.context.restoreDocumentCandidate()
  assert.equal(restarted.state.activeCandidateId, null, 'restart does not display old storyboard drafts')
  assert.equal(received.length, 0)
  restarted.context.showSavedCandidate(saved)
  assert.equal(received[0][0], edited)
  assert.equal(received[0][3].createdAt, saved.createdAt)
  assert.deepEqual(restarted.state.generationContext, saved.context)
  await restarted.context.selectDocument('scene-2')
  await restarted.context.selectDocument('scene-1')
  assert.equal(restarted.state.activeCandidateId, null, 'returning to the scene does not reopen the old candidate')
  assert.equal(received.length, 1)
  restarted.context.activeProjectId = 'another-project'
  restarted.context.showSavedCandidate(saved)
  assert.equal(received.length, 1, 'imported draft keeps its original project ownership')
})

test('storyboard acceptance commits new shots and resolves the candidate in the same saved snapshot', async () => {
  const candidate = storyboardDraft(), unrelated = draft()
  const h = harness({ candidates: [candidate, unrelated] })
  h.context.showSavedCandidate(candidate)
  const existing = createShot({ title: '已有镜头', visual: '走廊空无一人。' })
  h.state.storyboard.shots.push(existing)
  const next = { revision: 1, shots: [existing, ...parseStoryboardCandidate(candidate.text, { documentId: candidate.documentId, fingerprint: candidate.context.sourceFingerprint })] }
  const media = h.context.initializeProjectMediaWorkbench()
  const preflight = h.blockNextSave(), finalSave = h.blockNextSave()
  const accepting = media.commit({ storyboard: next }, { projectId: 'project-original', revision: 0, resolvedCandidateId: candidate.id })
  await preflight.entered
  preflight.resolve(true)
  const staged = await finalSave.entered
  assert.equal(staged.storyboard.shots.length, 2)
  assert.deepEqual(staged.candidateDrafts.map(value => value.id), [unrelated.id])
  assert.equal(h.state.storyboard.shots.length, 1, 'the visible original remains authoritative until the commit succeeds')
  assert.ok(h.state.candidateDrafts.some(value => value.id === candidate.id))
  finalSave.resolve(true)
  await accepting
  assert.equal(h.state.activeCandidateId, null, 'commit itself clears the active buffer before any UI callback')
  assert.deepEqual(h.context.workspaceSnapshot().candidateDrafts.map(value => value.id), [unrelated.id], 'later autosave cannot revive the resolved draft')
  h.context.showSavedCandidate(candidate)
  assert.equal(h.state.activeCandidateId, null, 'a stale history selection cannot reopen a resolved draft')
  media.onCandidateResolved(candidate.id, { committed: true })
  assert.deepEqual(h.state.storyboard, next)
  assert.deepEqual(h.state.candidateDrafts, [unrelated])
  assert.equal(h.state.activeCandidateId, null)
  assert.equal(h.calls.persisted.length, 2, 'one preflight save and one atomic acceptance; no follow-up deletion save')
  assert.equal(h.calls.persisted[0].snapshot.storyboard.shots.length, 1)
  assert.ok(h.calls.persisted[0].snapshot.candidateDrafts.some(value => value.id === candidate.id))
  assert.equal(h.calls.persisted[1].snapshot.storyboard.shots.length, 2)
  assert.deepEqual(h.calls.persisted[1].snapshot.candidateDrafts.map(value => value.id), [unrelated.id])
  assert.equal(h.state.candidateApplying, false)
  assert.equal(h.context.projectTransition, false)
})

test('a failed storyboard acceptance preserves original shots and the editable candidate for retry', async () => {
  const candidate = storyboardDraft()
  const h = harness({ candidates: [candidate] })
  h.context.showSavedCandidate(candidate)
  h.state.storyboard.shots.push(createShot({ title: '已有镜头', visual: '走廊空无一人。' }))
  const original = structuredClone(h.state.storyboard)
  const next = { revision: 1, shots: parseStoryboardCandidate(candidate.text, { documentId: candidate.documentId, fingerprint: candidate.context.sourceFingerprint }) }
  const media = h.context.initializeProjectMediaWorkbench()
  const preflight = h.blockNextSave(), finalSave = h.blockNextSave()
  const accepting = media.commit({ storyboard: next }, { projectId: 'project-original', revision: 0, resolvedCandidateId: candidate.id })
  await preflight.entered
  preflight.resolve(true)
  await finalSave.entered
  finalSave.resolve(false)
  await assert.rejects(accepting, /磁盘写入失败/)
  assert.deepEqual(h.state.storyboard, original)
  assert.deepEqual(h.state.candidateDrafts, [candidate])
  assert.equal(h.elements.candidateContent.textContent, candidate.text)
  assert.equal(h.state.activeCandidateId, candidate.id)
  assert.equal(h.state.storageFailed, true)
  assert.equal(h.state.candidateApplying, false)
  assert.equal(h.context.projectTransition, false)
  assert.equal(h.calls.persisted.length, 1)
  assert.deepEqual(h.calls.persisted[0].snapshot.storyboard, original)
  assert.deepEqual(h.calls.persisted[0].snapshot.candidateDrafts, [candidate])
  assert.equal(await h.context.persistWorkspace(), true)
  assert.deepEqual(h.calls.persisted.at(-1).snapshot.candidateDrafts, [candidate])
})

test('pending JSON autosave cannot enqueue the old storyboard while acceptance is being committed', async () => {
  const candidate = storyboardDraft()
  const h = harness({ candidates: [candidate] })
  h.context.showSavedCandidate(candidate)
  const media = h.context.initializeProjectMediaWorkbench()
  const edited = JSON.stringify({ shots: [{ title: '修改后的镜头', visual: '她收起钥匙，转身离开。', duration: 8 }] })
  media.onCandidateChange(candidate.id, edited)
  const next = { revision: 1, shots: parseStoryboardCandidate(edited, { documentId: candidate.documentId, fingerprint: candidate.context.sourceFingerprint }) }
  const preflight = h.blockNextSave(), finalSave = h.blockNextSave()
  const accepting = media.commit({ storyboard: next }, { projectId: 'project-original', revision: 0, resolvedCandidateId: candidate.id })
  await preflight.entered
  preflight.resolve(true)
  await finalSave.entered
  await h.timers.advance(1000)
  const submissionsWhileCommitting = h.calls.attempts.length
  finalSave.resolve(true)
  await accepting
  media.onCandidateResolved(candidate.id, { committed: true })
  assert.equal(submissionsWhileCommitting, 2, 'only the preflight and acceptance snapshots may be submitted; a third old snapshot could overwrite the queued acceptance')
  assert.deepEqual(h.calls.attempts.at(-1).snapshot.storyboard, next)
  assert.deepEqual(h.calls.attempts.at(-1).snapshot.candidateDrafts, [])
})

test('restoring the previous library cancels pending candidate autosave before asynchronous recovery', async () => {
  const candidate = storyboardDraft()
  const h = harness({ candidates: [candidate] })
  h.context.showSavedCandidate(candidate)
  const media = h.context.initializeProjectMediaWorkbench()
  media.onCandidateChange(candidate.id, JSON.stringify({ shots: [{ title: '尚未保存的修改', visual: '她离开门口。', duration: 8 }] }))
  assert.equal(h.timers.pending.length, 1, 'editing the candidate schedules its one-second save')
  const recoveryEntered = deferred(), recoveryDiskWrite = deferred()
  const restored = { id: 'project-original', workspace: { marker: '上一份权威快照' } }
  let loaded = null
  Object.assign(h.context, {
    inspirationUI: { isBusy: () => false, reset() {} },
    readPreviousLibrary: async () => ({ available: true, activeProjects: 1, archivedProjects: 0, inspirations: 0 }),
    restorePreviousLibrary: async () => { recoveryEntered.resolve(); await recoveryDiskWrite.promise; return restored },
    loadProjectSnapshot: snapshot => { loaded = snapshot },
    openProjectLibrary: async () => {},
  })
  h.context.window.confirm = () => true
  const recovering = h.context.recoverPreviousLibrary()
  await recoveryEntered.promise
  assert.equal(h.context.projectTransition, true)
  await h.timers.advance(1500)
  assert.equal(h.calls.attempts.length, 0, 'old candidate data must not enqueue a write behind the recovery transaction')
  assert.equal(h.state.candidateSaveTimer, null)
  recoveryDiskWrite.resolve()
  await recovering
  assert.equal(loaded, restored)
  assert.equal(h.context.projectTransition, false)
  assert.equal(h.timers.pending.length, 0)
  assert.equal(h.calls.persisted.length, 0, 'recovery must not advance the previous snapshot through an extra autosave')
})

test('storyboard completion records complete draft before automatic handoff; stopped output is review-only', async () => {
  for (const stopped of [false, true]) {
    const h = harness({ candidates: [] })
    h.context.startGeneration('拆镜', { purpose: 'storyboard', sourceFingerprint: contentFingerprint('她站在门前。'), storyboardRevision: 0 })
    const id = h.state.activeCandidateId
    h.context.appendGenerationDelta(storyboardDraft().text, h.state.activeGenerationId)
    let received = false
    h.context.mediaWorkbench = { receiveCandidate(text, context, draftId, options) {
      received = true
      assert.equal(draftId, id)
      assert.equal(options.autoApply, !stopped)
      assert.equal(h.state.isGenerating, false)
      assert.equal(h.state.candidateDrafts.find(draft => draft.id === id).status, stopped ? 'partial' : 'complete')
    } }
    h.context.finishGeneration({ stopped, generationId: h.state.activeGenerationId })
    assert.equal(received, true)
  }
})


test('重复生成不会停止或替换当前任务，拆镜期间侧栏仅切换查看范围', async () => {
  const h = harness({ candidates: [] })
  h.context.startGeneration('拆镜', { purpose: 'storyboard' })
  const id = h.state.activeGenerationId
  h.context.startGeneration('重复点击', { purpose: 'storyboard' })
  assert.equal(h.calls.providers.length, 1)
  assert.equal(h.state.activeGenerationId, id)
  assert.equal(h.state.isGenerating, true)
  let viewed
  h.context.mediaWorkbench = { isStoryboardBusy: () => true, selectDocument: id => { viewed = id } }
  assert.equal(await h.context.selectDocument('scene-2', { keepStoryboard: true }), true)
  assert.equal(viewed, 'scene-2')
  assert.equal(h.state.currentDocId, 'scene-1')
  assert.equal(h.state.generationContext.documentId, 'scene-1')
  assert.equal(h.state.isGenerating, true)
  h.state.isGenerating = false; h.state.generationInFlight = id
  h.context.startGeneration('保存中再次点击', { purpose: 'storyboard' })
  assert.equal(h.calls.providers.length, 1)
})


test('替换分镜事务清除对应旧候选，不影响正在审阅的另一份候选', async () => {
  const resolved = storyboardDraft(), other = draft('other')
  const h = harness({ candidates: [resolved, other] })
  h.context.showSavedCandidate(other)
  const cleared = []
  h.context.mediaWorkbench = { clearCandidate: id => cleared.push(id) }
  const media = h.context.initializeProjectMediaWorkbench()
  const next = { revision: 1, shots: parseStoryboardCandidate(resolved.text) }
  await media.commit({ storyboard: next }, { projectId: 'project-original', revision: 0, resolvedCandidateId: resolved.id })
  assert.equal(h.state.activeCandidateId, other.id)
  assert.deepEqual(h.context.workspaceSnapshot().candidateDrafts.map(d => d.id), [other.id])
  assert.ok(cleared.includes(resolved.id))
  assert.deepEqual(h.calls.persisted.at(-1).snapshot.candidateDrafts.map(d => d.id), [other.id])
})

test('automatic reference save is atomic, retains candidates and refuses stale or foreign snapshots', async () => {
  for (const succeeds of [false, true]) {
    const candidate = storyboardDraft(), h = harness({ candidates: [candidate] })
    h.context.showSavedCandidate(candidate)
    const shot = createShot({ visual: '陆骁抬头' })
    h.state.storyboard.shots.push(shot)
    const original = structuredClone(h.state.storyboard)
    const next = structuredClone(original); next.revision++; next.shots[0].references.push({ versionId: 'auto-image', role: 'reference' })
    const media = h.context.initializeProjectMediaWorkbench()
    await assert.rejects(media.commit({ storyboard: next }, { projectId: 'foreign', revision: 0, atomic: true }), /项目已切换/)
    await assert.rejects(media.commit({ storyboard: next }, { projectId: 'project-original', revision: 99, atomic: true }), /分镜已有新的修改/)
    const preflight = h.blockNextSave(), finalSave = h.blockNextSave()
    const saving = media.commit({ storyboard: next }, { projectId: 'project-original', revision: 0, atomic: true })
    await preflight.entered; preflight.resolve(true)
    const staged = await finalSave.entered
    assert.deepEqual(staged.candidateDrafts, [candidate])
    assert.deepEqual(h.state.storyboard, original)
    finalSave.resolve(succeeds)
    if (succeeds) await saving
    else await assert.rejects(saving, /磁盘写入失败/)
    assert.deepEqual(h.state.storyboard, succeeds ? next : original)
    assert.equal(h.state.activeCandidateId, candidate.id)
    assert.deepEqual(h.state.candidateDrafts, [candidate])
    assert.equal(h.context.projectTransition, false)
  }
})
