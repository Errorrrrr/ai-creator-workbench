import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
const media = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
function productionFunction(source, name) {
  const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  assert.ok(match, `${name} exists`)
  const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
  return body.slice(0, end.index + end[0].length)
}

function harness({ choice = 'cancel', saveFailure = false, archiveFailure = false, deleteFailure = false } = {}) {
  const calls = { writes: [], archives: [], deleted: [], choices: [], messages: [], refreshes: 0, rendered: 0, locks: [] }
  let projects = [{ id: 'p1', name: '第一项目' }, { id: 'p2', name: '第二项目' }]
  const env = {
    activeProjectId: 'p1', projectTransition: false, operationBusy: false, referenceSyncBusy: false,
    assetDrafts: new Map([['p1:a1', { name: '修改一', role: 'character' }], ['p1:a2', { name: '修改二', role: 'scene' }], ['p2:a3', { name: '另一项目', role: 'prop' }]]),
    context: () => ({ projectId: env.activeProjectId }),
    renderAssetDetail() { calls.rendered++ }, desktop() {},
    refresh: async () => { calls.refreshes++ },
    invoke: async (command, args) => {
      if (command === 'media_list') return { assets: ['a1', 'a2', 'a3'].map(id => ({ id, selectedVersionId: `latest-${id}` })) }
      if (saveFailure) throw new Error('素材写入失败')
      calls.writes.push(args)
    },
    state: { candidateApplying: false, knowledgeBusy: false, isGenerating: false, activeTab: 'script', knowledge: { index: {} } },
    inspirationUI: { isBusy: () => false }, elements: { scriptEditor: { value: '已编辑正文' } },
    listProjects: () => projects, listArchivedProjects: () => [],
    confirmProjectDeletion: async () => true,
    saveImmediately: async () => true,
    deleteProject: async id => {
      if (deleteFailure) throw new Error('删除写入失败')
      calls.deleted.push(id); projects = projects.filter(project => project.id !== id)
      return {}
    },
    archiveProject: async id => {
      if (archiveFailure) throw new Error('归档写入失败')
      calls.archives.push(id); projects = projects.filter(project => project.id !== id)
    },
    getActiveProject: () => projects[0], loadProjectSnapshot: snapshot => { env.activeProjectId = snapshot?.id },
    openProjectLibrary: async () => {}, showingArchivedProjects: false,
    setProjectTransition: value => { env.projectTransition = value; calls.locks.push(value) },
    window: { clearTimeout() {} }, setCurrentContent() {}, workspaceSnapshot: () => ({}),
    showToast: message => calls.messages.push(message), readableError: String,
    requestAssetDraftDecision: async options => { calls.choices.push(options); return choice },
    switchProject: async id => { env.activeProjectId = id }
  }
  vm.createContext(env)
  vm.runInContext(['pendingAssetDraft', 'discardAssetDrafts', 'saveAssetDrafts'].map(name => productionFunction(media, name)).join('\n'), env)
  env.mediaWorkbench = {
    pendingAssetDraft: env.pendingAssetDraft, discardAssetDrafts: env.discardAssetDrafts, saveAssetDrafts: env.saveAssetDrafts,
    hasPendingWork: () => env.operationBusy || env.referenceSyncBusy,
    refresh: env.refresh, showAssetDraft: () => true
  }
  vm.runInContext(['deleteSelectedProject', 'archiveCurrentProject', 'resolveAssetDraftsBeforeClose'].map(name => productionFunction(app, name)).join('\n'), env)
  return { env, calls }
}

test('素材草稿按项目定位与清理，不误删其他项目或相近 ID', () => {
  const { env } = harness()
  env.assetDrafts.set('p10:a1', { name: '相近项目', role: 'other' })
  assert.deepEqual({ ...env.pendingAssetDraft('p2') }, { projectId: 'p2', assetId: 'a3' })
  env.discardAssetDrafts('p1', 'a1')
  assert.equal(env.assetDrafts.has('p1:a2'), true)
  env.discardAssetDrafts('p1')
  assert.equal(env.pendingAssetDraft('p1'), null)
  assert.equal(env.assetDrafts.has('p2:a3'), true)
  assert.equal(env.assetDrafts.has('p10:a1'), true)
})

test('归档批量保存素材使用最新选用版本，只清已成功且未继续编辑的草稿', async () => {
  const h = harness(), { env, calls } = h
  const originalInvoke = env.invoke
  env.invoke = async (command, args) => {
    if (command === 'media_update_asset' && args.assetId === 'a1') env.assetDrafts.set('p1:a1', { name: '保存中继续编辑', role: 'character' })
    return originalInvoke(command, args)
  }
  await env.saveAssetDrafts('p1')
  assert.deepEqual(calls.writes.map(item => [item.assetId, item.selectedVersionId]), [['a1', 'latest-a1'], ['a2', 'latest-a2']])
  assert.equal(env.assetDrafts.get('p1:a1').name, '保存中继续编辑')
  assert.equal(env.assetDrafts.has('p1:a2'), false)
  assert.equal(env.assetDrafts.has('p2:a3'), true)
  assert.equal(env.operationBusy, false)
})

test('保存验证与写入失败保留待处理草稿，并解除媒体锁', async () => {
  const invalid = harness()
  invalid.env.assetDrafts.get('p1:a2').name = '   '
  await assert.rejects(invalid.env.saveAssetDrafts('p1'), /素材名称/)
  assert.equal(invalid.calls.writes.length, 0)
  assert.equal(invalid.env.assetDrafts.size, 3)
  assert.equal(invalid.env.operationBusy, false)
  const failed = harness({ saveFailure: true })
  await assert.rejects(failed.env.saveAssetDrafts('p1'), /素材写入失败/)
  assert.equal(failed.env.assetDrafts.size, 3)
  assert.equal(failed.env.operationBusy, false)
})

test('删除成功才清理该项目草稿，取消或删除失败保留；其他项目不受影响', async () => {
  for (const mode of ['success', 'cancel', 'failure']) {
    const { env, calls } = harness({ deleteFailure: mode === 'failure' })
    if (mode === 'cancel') env.confirmProjectDeletion = async () => false
    await env.deleteSelectedProject('p1')
    assert.equal(Boolean(env.pendingAssetDraft('p1')), mode !== 'success')
    assert.equal(Boolean(env.pendingAssetDraft('p2')), true)
    assert.equal(calls.deleted.length, mode === 'success' ? 1 : 0)
  }
})

test('归档提供保存、放弃和取消，保存失败或归档失败不会丢弃草稿', async () => {
  for (const choice of ['save', 'discard', 'cancel']) {
    const { env, calls } = harness({ choice })
    await env.archiveCurrentProject()
    assert.equal(calls.choices[0].allowSave, true)
    assert.equal(calls.archives.length, choice === 'cancel' ? 0 : 1)
    assert.equal(Boolean(env.pendingAssetDraft('p1')), choice === 'cancel')
    assert.equal(calls.writes.length, choice === 'save' ? 2 : 0)
    assert.equal(Boolean(env.pendingAssetDraft('p2')), true)
  }
  for (const options of [{ choice: 'save', saveFailure: true }, { choice: 'discard', archiveFailure: true }]) {
    const { env, calls } = harness(options)
    await env.archiveCurrentProject()
    assert.equal(calls.archives.length, 0)
    assert.equal(env.assetDrafts.size, 3)
    assert.equal(env.projectTransition, false)
  }
})

test('素材操作进行中不能删除或归档项目，确认后也再次检查', async () => {
  for (const method of ['deleteSelectedProject', 'archiveCurrentProject']) {
    const { env, calls } = harness({ choice: 'discard' })
    env.operationBusy = true
    await env[method]('p1')
    assert.equal(calls.archives.length + calls.deleted.length, 0)
    assert.equal(calls.choices.length, 0)
    assert.equal(env.assetDrafts.size, 3)
  }
  const { env, calls } = harness()
  env.confirmProjectDeletion = async () => { env.operationBusy = true; return true }
  await env.deleteSelectedProject('p1')
  assert.equal(calls.deleted.length, 0)
})

test('关闭时孤儿项目草稿可明确放弃或取消；有效草稿仍定位到素材', async () => {
  for (const choice of ['discard', 'cancel']) {
    const { env, calls } = harness({ choice })
    env.assetDrafts.delete('p2:a3')
    env.listProjects = () => []
    assert.equal(await env.resolveAssetDraftsBeforeClose(), choice === 'discard')
    assert.equal(env.assetDrafts.size, choice === 'discard' ? 0 : 2)
    assert.equal(calls.choices.length, 1)
    assert.match(calls.choices[0].message, /已不存在/)
  }
  const { env, calls } = harness({ choice: 'discard' })
  env.activeProjectId = 'p2'
  assert.equal(await env.resolveAssetDraftsBeforeClose(), false)
  assert.equal(env.activeProjectId, 'p1')
  assert.equal(calls.refreshes, 1)
  assert.equal(calls.choices.length, 0)
  assert.equal(env.assetDrafts.size, 3)
})

test('关闭时归档项目提示恢复或放弃，单项素材缺失不清同项目其他草稿', async () => {
  const archived = harness({ choice: 'cancel' })
  archived.env.listProjects = () => []
  archived.env.listArchivedProjects = () => [{ id: 'p1' }]
  assert.equal(await archived.env.resolveAssetDraftsBeforeClose(), false)
  assert.match(archived.calls.choices[0].message, /从项目库恢复/)
  const { env, calls } = harness({ choice: 'discard' })
  env.mediaWorkbench.showAssetDraft = id => id !== 'a1'
  assert.equal(await env.resolveAssetDraftsBeforeClose(), false)
  assert.equal(calls.choices.length, 1)
  assert.equal(env.assetDrafts.has('p1:a1'), false)
  assert.equal(env.assetDrafts.has('p1:a2'), true)
  assert.equal(env.assetDrafts.has('p2:a3'), true)
})

test('原生关闭回调仅在孤儿草稿被明确放弃后销毁窗口', async () => {
  for (const choice of ['discard', 'cancel']) {
    const { env } = harness({ choice })
    env.listProjects = () => []
    env.inspirationUI.dirty = () => false
    env.unsavedEdits = false; env.pendingSaves = 0
    let onClose, destroyed = 0
    env.appWindow = {
      onCloseRequested: callback => { onClose = callback; return Promise.resolve() },
      destroy: async () => { destroyed++ }
    }
    const start = app.indexOf('appWindow.onCloseRequested(async event => {')
    const registration = app.slice(start, app.indexOf('\n}', start))
    vm.runInContext(`let closeRequestActive = false\n${registration}`, env)
    await onClose({ preventDefault() {} })
    assert.equal(destroyed, choice === 'discard' ? 1 : 0)
  }
})

test('素材决策弹窗的三种操作与 Escape 返回结果正确，不关闭下层项目库', async () => {
  for (const choice of ['save', 'discard', 'cancel', 'Escape']) {
    let focusRestored = 0
    const opener = { isConnected: true, focus() { focusRestored++ } }
    class Node {
      constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.returnValue = ''; this.isConnected = true }
      setAttribute() {}
      append(...children) { for (const child of children) { child.parent = this; this.children.push(child) } }
      addEventListener(type, callback) { this.listeners.set(type, callback) }
      showModal() { this.open = true }
      close(value = '') { this.open = false; this.returnValue = value; this.listeners.get('close')?.() }
      remove() { this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false }
    }
    const document = { activeElement: opener, body: new Node('body'), createElement: tag => new Node(tag) }
    document.querySelector = () => document.body.children.find(node => node.id === 'assetDraftDecisionDialog') || null
    const env = vm.createContext({ document })
    vm.runInContext(productionFunction(app, 'requestAssetDraftDecision'), env)
    const result = env.requestAssetDraftDecision({ title: '归档前保存', message: '说明', allowSave: true })
    const dialog = document.body.children[0]
    const actions = dialog.children[0].children[2].children
    assert.deepEqual(actions.map(button => button.value), ['cancel', 'discard', 'save'])
    assert.equal(actions[0].autofocus, true)
    if (choice === 'Escape') {
      let prevented = false, stopped = false
      dialog.listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
      assert.equal(prevented, true); assert.equal(stopped, true)
    } else dialog.close(choice)
    assert.equal(await result, choice === 'Escape' ? 'cancel' : choice)
    assert.equal(document.body.children.length, 0)
    assert.equal(focusRestored, 1)
  }
})
