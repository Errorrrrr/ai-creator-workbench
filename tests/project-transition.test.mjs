import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
const between = (start, end) => {
  const left = source.indexOf(start)
  const right = source.indexOf(end, left + start.length)
  assert.ok(left >= 0 && right > left, `${start} must exist in the application`)
  return source.slice(left, right)
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function node(inert = false) {
  const attributes = new Map()
  return { inert, attributes, getAttribute: key => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key), focus() {} }
}
function harness({ inspirationBusy = false } = {}) {
  const save = deferred()
  const app = node(), dialog = node(), alreadyInert = node(true)
  const nodes = [app, dialog, alreadyInert]
  const handlers = new Map()
  const stored = { a: 'A 的已保存正文', b: 'B 的已保存正文' }
  const calls = { save: 0, loaded: 0, selected: 0, timers: [], toasts: [] }
  const state = { candidateApplying: false, knowledgeBusy: false, storageFailed: false, currentView: 'workspace', currentDocId: 'idea', activeTab: 'script', documents: { idea: { content: stored.a }, oldScene: { content: 'A 独有的分场' } } }
  const context = vm.createContext({
    state, elements: { scriptEditor: { value: stored.a, focus() {} } }, activeProjectId: 'a', projectTransition: false, projectTransitionNodes: new Map(), unsavedEdits: false,
    inspirationUI: { isBusy: () => inspirationBusy, reset() {} },
    document: { querySelectorAll: () => nodes, querySelector: () => ({ close() {}, focus() {} }), addEventListener(type, handler, capture) { handlers.set(type, { handler, capture }) } },
    window: { clearTimeout() {}, setTimeout(callback, delay) { calls.timers.push({ callback, delay }); return calls.timers.length }, confirm: () => false },
    saveImmediately: async () => { calls.save++; const value = state.documents.idea.content; const success = await save.promise; if (success) stored.a = value; return success },
    persistWorkspace: async () => true,
    activateProject: async () => {},
    getActiveProject: () => ({ id: 'b', content: stored.b }),
    loadProjectSnapshot(snapshot) { calls.loaded++; context.activeProjectId = snapshot.id; state.documents = { idea: { content: snapshot.content } } },
    updateDocumentView: () => { calls.selected++ },
    abandonCandidateOnContextChange() {}, switchView() {}, closeDrawers() {},
    readPreviousLibrary: async () => ({ available: true, activeProjects: 1, archivedProjects: 0, inspirations: 0 }),
    showToast: message => calls.toasts.push(message), readableError: String,
  })
  vm.runInContext([
    between('function setProjectTransition(', 'const desktopInvoke'),
    between("for (const type of ['beforeinput'", "\ndocument.addEventListener('click'"),
    between('async function switchProject(', 'async function exportProject('),
    between('async function selectDocument(', 'async function switchTab('),
    between('async function recoverPreviousLibrary(', 'async function switchProject('),
  ].join('\n'), context)
  function dispatch(type) {
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } }
    const registration = handlers.get(type)
    assert.ok(registration?.capture, `${type} is guarded before target handlers`)
    registration.handler(event)
    return event
  }
  return { context, save, nodes, stored, state, calls, dispatch }
}

test('project switches lock editing, modal escape, shortcuts and inspiration changes until the save completes', async () => {
  const h = harness()
  const pending = h.context.switchProject('b')
  assert.equal(h.context.projectTransition, true)
  assert.ok(h.nodes.every(item => item.inert && item.getAttribute('aria-busy') === 'true'))
  for (const eventType of ['beforeinput', 'input', 'keydown', 'click', 'submit', 'change', 'paste', 'cut', 'drop', 'cancel']) {
    const event = h.dispatch(eventType)
    assert.equal(event.prevented, true)
    assert.equal(event.stopped, true)
  }
  const lateInput = h.dispatch('beforeinput')
  if (!lateInput.prevented) h.state.documents.idea.content = '本来会在等待期间丢失的新句子'
  h.save.resolve(true)
  await pending
  assert.equal(h.stored.a, 'A 的已保存正文')
  assert.equal(h.context.activeProjectId, 'b')
  assert.equal(h.calls.loaded, 1)
  assert.equal(h.context.projectTransition, false)
  assert.deepEqual(h.nodes.map(item => item.inert), [false, false, true])
  assert.ok(h.nodes.every(item => item.getAttribute('aria-busy') === null))
  assert.equal(h.dispatch('beforeinput').prevented, false)
})

test('failed switches unlock the existing project and do not claim a successful switch', async () => {
  const h = harness()
  const pending = h.context.switchProject('b')
  h.save.resolve(false)
  await pending
  assert.equal(h.context.activeProjectId, 'a')
  assert.equal(h.calls.loaded, 0)
  assert.equal(h.context.projectTransition, false)
  assert.deepEqual(h.nodes.map(item => item.inert), [false, false, true])
  assert.equal(h.calls.toasts.includes('已切换项目'), false)
  assert.equal(h.dispatch('beforeinput').prevented, false)
})

test('in-progress inspiration saves prevent project transitions from resetting their form', async () => {
  const h = harness({ inspirationBusy: true })
  await h.context.switchProject('b')
  assert.equal(h.calls.save, 0)
  assert.equal(h.calls.loaded, 0)
  assert.equal(h.context.projectTransition, false)
})

test('a document selection that began before a project transition cannot modify the next project', async () => {
  const h = harness()
  const selecting = h.context.selectDocument('oldScene')
  h.context.setProjectTransition(true)
  h.context.activeProjectId = 'b'
  h.state.documents = { idea: { content: h.stored.b } }
  h.save.resolve(true)
  await selecting
  assert.equal(h.state.currentDocId, 'idea')
  assert.equal(h.calls.selected, 0)
  h.context.setProjectTransition(false)
})

test('cancelling snapshot recovery resumes a previously scheduled draft save', async () => {
  const h = harness()
  h.context.unsavedEdits = true
  await h.context.recoverPreviousLibrary()
  assert.equal(h.context.projectTransition, false)
  assert.equal(h.calls.loaded, 0)
  assert.equal(h.calls.timers.length, 1)
  assert.equal(h.calls.timers[0].delay, 300)
  assert.equal(h.context.unsavedEdits, true, 'unlocking must not falsely mark a draft saved')
})
