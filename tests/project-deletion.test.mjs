import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf('async function deleteSelectedProject('), source.indexOf('async function archiveCurrentProject('))
function harness({ confirm = true, save = true, failure = false, current = 'a', generating = false } = {}) {
  const calls = { saves: 0, deleted: [], loaded: 0, messages: [], locks: [] }
  const context = vm.createContext({
    projectTransition: false, activeProjectId: current, mediaWorkbench: null,
    state: { candidateApplying: false, knowledgeBusy: false, isGenerating: generating },
    inspirationUI: { isBusy: () => false },
    listProjects: () => [{ id: 'a', name: '甲' }], listArchivedProjects: () => [{ id: 'b', name: '乙' }],
    confirmProjectDeletion: async () => confirm,
    saveImmediately: async () => { calls.saves++; return save },
    deleteProject: async id => { if (failure) throw new Error('写入失败'); calls.deleted.push(id); return { cleanupPending: 0 } },
    setProjectTransition(value) { context.projectTransition = value; calls.locks.push(value) },
    window: { clearTimeout() {} }, getActiveProject: () => ({}),
    loadProjectSnapshot() { calls.loaded++ }, openProjectLibrary: async () => {},
    showToast: message => calls.messages.push(message), readableError: String,
  })
  vm.runInContext(handler, context)
  return { context, calls }
}

test('cancel and generating state never delete or save', async () => {
  for (const options of [{ confirm: false }, { generating: true }]) {
    const h = harness(options)
    await h.context.deleteSelectedProject('a')
    assert.equal(h.calls.saves, 0)
    assert.deepEqual(h.calls.deleted, [])
    assert.equal(h.calls.loaded, 0)
  }
})

test('deleting current project switches only after success and need not save the doomed draft', async () => {
  const h = harness()
  await h.context.deleteSelectedProject('a')
  assert.equal(h.calls.saves, 0)
  assert.deepEqual(h.calls.deleted, ['a'])
  assert.equal(h.calls.loaded, 1)
  assert.deepEqual(h.calls.locks, [true, false])
})

test('deleting an archived project saves and preserves the current editor', async () => {
  const h = harness()
  await h.context.deleteSelectedProject('b')
  assert.equal(h.calls.saves, 1)
  assert.deepEqual(h.calls.deleted, ['b'])
  assert.equal(h.calls.loaded, 0)
  const failed = harness({ save: false })
  await failed.context.deleteSelectedProject('b')
  assert.deepEqual(failed.calls.deleted, [])
  assert.equal(failed.context.projectTransition, false)
})

test('storage failure keeps the current editor and unlocks input', async () => {
  const h = harness({ failure: true })
  await h.context.deleteSelectedProject('a')
  assert.equal(h.calls.loaded, 0)
  assert.equal(h.context.projectTransition, false)
  assert.ok(h.calls.messages.some(message => message.includes('写入失败')))
  assert.ok(!h.calls.messages.includes('项目已永久删除'))
})
