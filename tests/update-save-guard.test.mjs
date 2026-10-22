import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
const callback = source.split('  beforeInstall: async () => {')[1].split('\n  }\n})')[0]
function harness({ generating = false, saveResult = true, inspirationDirty = false, inspirationSave = true } = {}) {
  const events = [], dialog = { inert: true }
  const context = vm.createContext({
    projectTransition: false, updateInstalling: false, state: { isGenerating: generating }, unsavedEdits: false, pendingSaves: 0,
    mediaWorkbench: { hasPendingWork: () => false, pendingAssetDraft: () => null },
    inspirationUI: { isBusy: () => false, dirty: () => inspirationDirty, save: async () => { events.push('inspiration'); if (inspirationSave) inspirationDirty = false; return inspirationSave } },
    setProjectTransition(value) { context.projectTransition = value; events.push(value ? 'lock' : 'unlock') },
    document: { getElementById: () => dialog },
    saveImmediately: async () => { events.push('save'); return saveResult },
  })
  return { events, context, run: vm.runInContext(`(async () => {${callback}\n})`, context) }
}
test('real app update guard saves inspiration and workspace only after locking editing', async () => {
  const h = harness({ inspirationDirty: true }); const unlock = await h.run()
  assert.deepEqual(h.events, ['lock', 'inspiration', 'save']); assert.equal(h.context.updateInstalling, true)
  unlock(); assert.equal(h.context.updateInstalling, false); assert.equal(h.context.projectTransition, false)
})
test('active generation prevents freezing and installation preparation', async () => {
  const h = harness({ generating: true }); await assert.rejects(h.run(), /等待/); assert.deepEqual(h.events, [])
})
test('workspace and inspiration save failures restore editing before reporting failure', async () => {
  for (const options of [{ saveResult: false }, { inspirationDirty: true, inspirationSave: false }]) {
    const h = harness(options); await assert.rejects(h.run(), /保存/)
    assert.equal(h.events.at(-1), 'unlock'); assert.equal(h.context.updateInstalling, false)
  }
})


test('未保存的素材草稿阻止安装更新，不锁界面或启动保存', async () => {
  const h = harness()
  h.context.mediaWorkbench.pendingAssetDraft = () => ({ projectId: 'p1', assetId: 'a1' })
  await assert.rejects(h.run(), /素材信息尚未保存/)
  assert.deepEqual(h.events, [])
  assert.equal(h.context.projectTransition, false)
})
