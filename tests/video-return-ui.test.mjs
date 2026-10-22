import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { parseVideoManifest, planVideoReturn, applyVideoReturn } from '../src/video-return.js'

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  assert.ok(match)
  const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
  return body.slice(0, end.index + end[0].length)
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function harness() {
  const document = { activeElement: null, listeners: new Map(), addEventListener(type, callback) { this.listeners.set(type, callback) } }
  // The same DOM boundary used by workbench-reliability, with modal events added.
  class Node {
    constructor(tag = 'div', className = '', text = '') {
      Object.assign(this, { tag, className, textContent: text, children: [], dataset: {}, listeners: new Map(), attrs: new Map(), open: false, value: '', disabled: false, inert: false })
    }
    append(...children) { for (const child of children) { if (child.parent) child.remove(); child.parent = this; this.children.push(child) } }
    replaceChildren(...children) { this.children.forEach(child => { child.parent = null }); this.children = []; this.append(...children) }
    setAttribute(name, value) { this.attrs.set(name, String(value)) }
    removeAttribute(name) { this.attrs.delete(name) }
    hasAttribute(name) { return this.attrs.has(name) }
    addEventListener(type, callback) { this.listeners.set(type, callback) }
    querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(node => selector === '*' || node.tag === selector || (selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))) || (selector === 'dialog[open]' && node.tag === 'dialog' && node.open)) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    get isConnected() { for (let node = this; node; node = node.parent) if (node === document.body) return true; return false }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null }
    focus() { document.activeElement = this }
    showModal() { this.open = true }
    close() { this.open = false; this.listeners.get('close')?.() }
    async click() { if (!this.disabled) return this.listeners.get('click')?.({ target: this }) }
  }
  const el = (...args) => new Node(...args)
  document.body = el('body')
  document.querySelector = selector => document.body.querySelector(selector)
  document.querySelectorAll = selector => document.body.querySelectorAll(selector)
  const data = { projectId: 'p1', documents: { scene1: { title: '第一场' } }, storyboard: { revision: 3, shots: [
    { id: 's1', title: '第一镜', sourceDocumentId: 'scene1', selectedVideoVersionId: 'old-v', reviewedVideoVersionId: 'old-v' },
    { id: 's2', title: '第二镜', sourceDocumentId: 'scene1', selectedVideoVersionId: '', reviewedVideoVersionId: '' }
  ] } }
  const assets = [
    { id: 'old', name: '原视频.mp4', kind: 'video', versions: [{ id: 'old-v', name: '原视频.mp4', mimeType: 'video/mp4' }] },
    { id: 'new', name: 'video-s1.mp4', kind: 'video', versions: [{ id: 'new-v', name: 'video-s1.mp4', mimeType: 'video/mp4' }] }
  ]
  const calls = { messages: [], commits: [], routes: [], sources: [], stages: [], imports: [] }
  const env = {
    document, el, Option: class extends Node { constructor(text, value) { super('option', '', text); this.value = value } },
    parseVideoManifest, planVideoReturn, applyVideoReturn,
    context: () => data, assets, error: '', projectId: 'p1', operationBusy: false, projectTransition: false,
    storyboardView: el('section'), assetsView: el('section'), characterDialog: el('dialog'),
    elements: { connectionDialog: { open: false } }, state: { isGenerating: false },
    requireProject() {}, desktop() {}, refresh: async () => {}, notify: message => calls.messages.push(message),
    updateBatchConfirmation() {}, renderSources() {}, renderGenerationReadiness() {}, scheduleReferenceSync() {},
    invoke: async (command, args) => { calls.imports.push({ command, args }); return [assets[1]] },
    commit: async (patch, options) => { calls.commits.push({ patch, options }); data.storyboard = patch.storyboard },
    navigate: view => calls.routes.push(view), showSource: id => calls.sources.push(id), showStage: stage => calls.stages.push(stage),
    selectedShotId: '', selectedEpisodeId: '', selectedSourceId: '', lastContextDocId: null, OTHER_EPISODE: 'other', UNASSIGNED_SOURCE: 'unassigned', closeDrawers() {}
  }
  vm.createContext(env)
  vm.runInContext(['button', 'field', 'run', 'openVideoReturn'].map(productionFunction).join('\n'), env)
  const keyMarker = "document.addEventListener('keydown', (event) => {", keyTail = appSource.slice(appSource.indexOf(keyMarker))
  vm.runInContext(keyTail.slice(0, /^\}\)/m.exec(keyTail).index + 3), env)
  const dialog = () => document.body.querySelector('dialog')
  const action = text => dialog().querySelectorAll('button').find(node => node.textContent === text)
  const escape = () => {
    const event = { key: 'Escape', defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
    dialog().listeners.get('keydown')?.(event)
    if (!event.stopped) document.listeners.get('keydown')(event)
    return event
  }
  return { env, data, calls, dialog, action, escape }
}

test('回填读取清单与导入期间 Escape 不能越过忙碌保护，空闲时可关闭', async () => {
  for (const phase of ['manifest', 'import']) {
    const h = harness(), wait = deferred()
    await h.env.openVideoReturn()
    const dialog = h.dialog()
    let pending
    if (phase === 'manifest') {
      const input = dialog.querySelectorAll('input').find(node => node.type === 'file')
      input.files = [{ size: 10, text: () => wait.promise }]
      pending = input.listeners.get('change')()
    } else {
      h.env.invoke = () => wait.promise
      pending = h.action('导入视频文件').click()
    }
    const event = h.escape()
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true)
    assert.equal(dialog.open, true); assert.equal(dialog.isConnected, true)
    assert.equal(h.action('取消').disabled, true)
    wait.resolve(phase === 'manifest' ? JSON.stringify({ format: 'google-flow-handoff', version: 1, projectId: 'p1', shots: [] }) : [])
    await pending
    assert.equal(h.action('取消').disabled, false)
    h.escape()
    assert.equal(dialog.open, false); assert.equal(dialog.isConnected, false)
  }
})

test('回填审阅后分镜变化必须重新核对，不能直接提交旧匹配', async () => {
  const h = harness(); await h.env.openVideoReturn()
  await h.action('导入视频文件').click()
  h.data.storyboard.revision++
  await h.action('确认关联选中的视频').click()
  assert.equal(h.calls.commits.length, 0)
  assert.equal(h.data.storyboard.shots[0].selectedVideoVersionId, 'old-v')
  assert.equal(h.dialog().open, true)
  assert.ok(h.calls.messages.some(message => message.includes('重新核对')))
  await h.action('确认关联选中的视频').click()
  assert.equal(h.calls.commits.length, 1)
  assert.equal(h.calls.commits[0].options.revision, 4)
})

test('回填保存失败保持旧选用及审核，保留窗口可重试；成功后再关闭与定位', async () => {
  const h = harness(); await h.env.openVideoReturn()
  await h.action('导入视频文件').click()
  const before = structuredClone(h.data.storyboard), successfulCommit = h.env.commit
  h.env.commit = async () => { throw new Error('模拟保存失败') }
  await h.action('确认关联选中的视频').click()
  assert.deepEqual(h.data.storyboard, before)
  assert.equal(h.dialog().open, true)
  assert.equal(h.calls.routes.length, 0)
  assert.equal(h.action('确认关联选中的视频').disabled, false)
  h.env.commit = successfulCommit
  const dialog = h.dialog(); await h.action('确认关联选中的视频').click()
  assert.equal(h.data.storyboard.shots[0].selectedVideoVersionId, 'new-v')
  assert.equal(h.data.storyboard.shots[0].reviewedVideoVersionId, '')
  assert.deepEqual(h.data.storyboard.shots[1], before.shots[1])
  assert.equal(h.calls.commits[0].options.atomic, true)
  assert.equal(h.calls.commits[0].options.projectId, 'p1')
  assert.equal(dialog.isConnected, false)
  assert.deepEqual(h.calls.routes, ['storyboard']); assert.deepEqual(h.calls.sources, ['scene1']); assert.deepEqual(h.calls.stages, ['export'])
})

test('清单读取期间项目切换，不产生未处理异常或启用旧项目确认', async () => {
  const h = harness(), wait = deferred(); await h.env.openVideoReturn()
  const input = h.dialog().querySelectorAll('input').find(node => node.type === 'file')
  input.files = [{ size: 10, text: () => wait.promise }]
  const reading = input.listeners.get('change')()
  h.data.projectId = 'p2'
  wait.resolve(JSON.stringify({ format: 'google-flow-handoff', version: 1, projectId: 'p1', shots: [] }))
  await reading
  assert.equal(h.action('确认关联选中的视频').disabled, true)
  assert.equal(h.calls.commits.length, 0)
  assert.ok(h.dialog().querySelectorAll('p').some(node => node.textContent.includes('项目已切换')))
})

test('回填已删除来源的镜头后定位到未归属范围', async () => {
  const h = harness(); h.data.storyboard.shots[0].sourceDocumentId = 'deleted-scene'
  await h.env.openVideoReturn(); await h.action('导入视频文件').click(); await h.action('确认关联选中的视频').click()
  assert.equal(h.env.selectedSourceId, 'unassigned'); assert.equal(h.env.selectedEpisodeId, 'other')
  assert.equal(h.env.selectedShotId, 's1'); assert.equal(h.data.storyboard.shots[0].selectedVideoVersionId, 'new-v')
})

test('新清单改变编号归属时，已有 shot-001 视频不被默认迁移到另一镜头', async () => {
  const h = harness()
  h.env.assets = [h.env.assets[0]]
  h.env.assets[0].name = 'shot-001.mp4'; h.env.assets[0].versions[0].name = 'shot-001.mp4'
  const before = structuredClone(h.data.storyboard)
  await h.env.openVideoReturn()
  assert.equal(h.dialog().querySelectorAll('.video-return-row').length, 0)
  const includeExisting = h.dialog().querySelectorAll('input').find(node => node.type === 'checkbox')
  includeExisting.checked = true; includeExisting.listeners.get('change')()
  const manifest = h.dialog().querySelectorAll('input').find(node => node.type === 'file')
  manifest.files = [{ size: 100, text: async () => JSON.stringify({ format: 'google-flow-handoff', version: 1, projectId: 'p1', shots: [{ number: 1, id: 's2' }] }) }]
  await manifest.listeners.get('change')()
  const row = h.dialog().querySelector('.video-return-row')
  assert.equal(row.querySelector('select').value, 's2', '显示按新清单建议的归属，但不能代替用户确认')
  assert.equal(row.querySelector('input').checked, false)
  assert.equal(h.action('确认关联选中的视频').disabled, true)
  assert.ok(row.querySelectorAll('p').some(node => node.textContent.includes('当前已用于：第一镜')))
  assert.deepEqual(h.data.storyboard, before)
  assert.equal(h.calls.commits.length, 0)
})
