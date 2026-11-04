import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createShot, findMediaVersion } from '../src/storyboard.js'
import { shotImageReadiness } from '../src/shot-workflow.js'
import { imageVisualReviewState, makeVisualReview, visualBaselineText, visualInputFingerprint } from '../src/visual-review.js'

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  assert.ok(match, `missing production function ${name}`)
  const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
  assert.ok(end)
  return body.slice(0, end.index + end[0].length)
}

function harness() {
  const microtasks = [], doc = { activeElement: null }
  class Node {
    constructor(tag = 'div', className = '', text = '') {
      Object.assign(this, { tag, className, textContent: text, children: [], parent: null, dataset: {}, attrs: new Map(), listeners: new Map(), value: '', open: false, disabled: false })
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child) } }
    replaceChildren(...children) {
      for (const child of this.children) child.parent = null
      this.children = []; this.append(...children)
    }
    setAttribute(name, value) { this.attrs.set(name, value) }
    removeAttribute(name) { this.attrs.delete(name) }
    hasAttribute(name) { return this.attrs.has(name) }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback) }
    contains(target) { for (let node = target; node; node = node.parent) if (node === this) return true; return false }
    get isConnected() { return root.contains(this) }
    closest(selector) { for (let node = this; node; node = node.parent) if (selector.split(', ').includes(node.tag)) return node; return null }
    querySelectorAll(selector) {
      const matches = node => {
        const attr = /^\[data-([a-z-]+)(?:="([^"]+)")?\]$/.exec(selector)
        if (attr) {
          const key = attr[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
          return Object.hasOwn(node.dataset, key) && (attr[2] === undefined || node.dataset[key] === attr[2])
        }
        return selector === '*' || node.tag === selector || (selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1)))
      }
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    dispatch(type, values = {}) {
      const event = { target: this, defaultPrevented: false, ...values, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
      const returns = []
      for (let node = this; node; node = node.parent) {
        for (const callback of node.listeners.get(type) || []) returns.push(callback(event))
        if (event.stopped) break
      }
      return { event, returns }
    }
    focus() {
      if (this.disabled || doc.activeElement === this) return
      const previous = doc.activeElement
      doc.activeElement = this
      previous?.dispatch('focusout', { relatedTarget: this })
    }
    showModal() { this.returnFocus = doc.activeElement; this.open = true; this.querySelector('button')?.focus() }
    close() { this.open = false; if (this.returnFocus?.isConnected) this.returnFocus.focus() }
  }
  const el = (...args) => new Node(...args), root = el('body'), workspace = el('main'), shotDetail = el('section')
  workspace.append(shotDetail); root.append(workspace)
  const panel = el('section'); panel.dataset.shotPanel = 'picture'; shotDetail.append(panel)
  const pictureZoom = el('dialog'), close = el('button', '', '关闭图片'), pictureZoomBody = el('div')
  close.addEventListener('click', () => pictureZoom.close()); pictureZoom.append(close, pictureZoomBody); root.append(pictureZoom)
  const shots = ['shot-1', 'shot-2'].map((id, index) => ({ ...createShot({ title: `镜头${index + 1}`, visual: '海面与平台', characterNames: [], sceneNames: [], propNames: [] }, { documentId: 'scene' }), id, selectedImageVersionId: `image-${index + 1}`, references: [{ versionId: 'reference-v1', role: 'reference', scope: 'continuity', origin: 'manual' }] }))
  let data = { projectId: 'project', documents: { scene: { title: '第一场', content: '平台漂浮在海面。' } }, storyboard: { revision: 1, shots } }
  const assets = [{ id: 'reference', name: '固定参考', kind: 'image', role: 'prop', versions: [{ id: 'reference-v1', mimeType: 'image/png' }] },
    { id: 'pictures', name: '分镜图', kind: 'image', role: 'shot', versions: [{ id: 'image-1', mimeType: 'image/png' }, { id: 'image-2', mimeType: 'image/png' }] }]
  const controls = { fail: false, gate: null }, calls = { commits: [], notices: [], renders: 0 }
  doc.querySelectorAll = () => []
  const env = {
    el, document: doc, queueMicrotask: callback => microtasks.push(callback), structuredClone,
    context: () => data, assets, jobs: [], projectId: 'project', loading: false, error: '', operationBusy: false,
    shotDetail, shotDetailOpen: true, pictureZoom, pictureZoomBody, pictureNotes: new Map(),
    selectedShotId: 'shot-1', selectedEpisodeId: 'episode', selectedSourceId: 'scene',
    findMediaVersion, shotImageReadiness, imageVisualReviewState, makeVisualReview, visualBaselineText, visualInputFingerprint,
    preview(version) { const img = el('img'); img.dataset.versionId = version?.id || ''; return img },
    commit: async (patch, metadata) => {
      calls.commits.push({ patch: structuredClone(patch), metadata: structuredClone(metadata) })
      if (controls.gate) await controls.gate
      if (controls.fail) throw new Error('磁盘写入失败')
      if (metadata.projectId !== data.projectId || metadata.revision !== data.storyboard.revision) throw new Error('项目或分镜版本已变化')
      data = { ...data, ...structuredClone(patch) }
    },
    notify: message => calls.notices.push(message), visibleShots: () => data.storyboard.shots,
    renderShots({ detail = true } = {}) { calls.renders++; if (detail) env.renderPictureReview(panel, env.selectedShot()) },
    selectDetailPanel() {}, closeShotDetail() { env.shotDetailOpen = false },
    refreshReferenceDetails() {}, productionOverview: { refresh() {} },
    storyboardView: el('section'), assetsView: el('section'), characterDialog: { open: false },
    updateBatchConfirmation() {}, renderSources() {}, renderGenerationReadiness() {}, scheduleReferenceSync() {}
  }
  vm.createContext(env)
  vm.runInContext(['button', 'field', 'disclosure', 'selectedShot', 'bindShotDetailFocus', 'refreshPictureReview', 'renderPictureReview', 'changeStoryboard', 'saveVisualReview', 'run'].map(productionFunction).join('\n'), env)
  env.bindShotDetailFocus(); env.renderPictureReview(panel, env.selectedShot())
  const flushMicrotasks = () => { while (microtasks.length) microtasks.shift()() }
  // Reproduce WebKit's default blur to the page after mousedown, followed by a
  // microtask checkpoint before mouseup/click. Detached targets never click.
  const mouseClick = async (target, { button = 0, beforeClick } = {}) => {
    const { event } = target.dispatch('mousedown', { button })
    if (!event.defaultPrevented) workspace.focus()
    flushMicrotasks(); beforeClick?.()
    if (!target.isConnected || target.disabled || button !== 0) return event
    target.dispatch('mouseup', { button })
    const { returns } = target.dispatch('click', { button })
    if (target.tag === 'summary') target.parent.open = !target.parent.open
    await Promise.all(returns)
    flushMicrotasks()
    return event
  }
  const find = label => panel.querySelectorAll('button').find(node => node.textContent === label)
  const zoom = () => panel.querySelectorAll('button').find(node => node.attrs.get('aria-label') === '放大查看：镜头1')
  return { env, root, doc, workspace, panel, pictureZoom, pictureZoomBody, controls, calls, mouseClick, flushMicrotasks, find, zoom, get data() { return data } }
}

test('WebKit 展开参考后首次按下大图保留按钮到 click，放大与关闭不折叠参考或丢失备注', async () => {
  const h = harness(), references = h.panel.querySelector('details'), summary = references.querySelector('summary')
  const note = h.panel.querySelector('textarea'); note.value = '注意平台结构'; note.dispatch('input'); note.focus()
  const event = await h.mouseClick(summary)
  assert.equal(event.defaultPrevented, true)
  assert.equal(references.open, true)
  assert.equal(h.doc.activeElement, summary)
  const original = h.zoom(), image = original.querySelector('img')
  await h.mouseClick(image, { beforeClick: () => {
    assert.equal(original.isConnected, true, '焦点事件的微任务不得替换尚未收到 click 的按钮')
    assert.equal(h.zoom(), original)
    assert.equal(h.doc.activeElement, original)
  } })
  assert.equal(h.pictureZoom.open, true, '第一次点击即应打开大图')
  assert.equal(h.pictureZoomBody.querySelector('img').dataset.versionId, 'image-1')
  assert.equal(references.open, true)
  assert.equal(h.panel.querySelector('textarea'), note)
  assert.equal(note.value, '注意平台结构')
  await h.mouseClick(h.pictureZoom.querySelector('button'))
  assert.equal(h.pictureZoom.open, false)
  assert.equal(h.doc.activeElement, original, '关闭放大图后回到仍连接的原按钮')
  assert.equal(references.open, true)
  assert.equal(h.calls.commits.length, 0)
})

test('WebKit 参考缩略图也在首次点击放大；键盘移出画面仍刷新且保留输入草稿', async () => {
  const h = harness(), references = h.panel.querySelector('details')
  await h.mouseClick(references.querySelector('summary'))
  const note = h.panel.querySelector('textarea'); note.value = '参考颜色偏冷'; note.dispatch('input'); note.focus()
  const view = references.querySelector('button')
  await h.mouseClick(view.querySelector('img'))
  assert.equal(h.pictureZoom.open, true)
  assert.equal(h.pictureZoomBody.querySelector('img').dataset.versionId, 'reference-v1')
  assert.equal(references.open, true)
  await h.mouseClick(h.pictureZoom.querySelector('button'))
  note.focus()
  h.data.storyboard.shots[0].visual = '新机位'
  h.workspace.focus(); h.flushMicrotasks()
  assert.notEqual(h.panel.querySelector('textarea'), note, '真实离开画面后仍可刷新最新信息')
  assert.equal(h.panel.querySelector('textarea').value, '参考颜色偏冷')
})

test('WebKit 审阅按钮首次点击原子保存；失败保留当前镜头和备注，重试成功后才进入下一镜', async () => {
  const h = harness(), note = h.panel.querySelector('textarea')
  note.value = '结构和日光均一致'; note.dispatch('input'); note.focus()
  h.controls.fail = true
  const approve = h.find('确认并看下一镜')
  await h.mouseClick(approve)
  assert.equal(h.calls.commits.length, 1)
  assert.equal(h.calls.commits[0].metadata.atomic, true)
  assert.equal(h.env.selectedShotId, 'shot-1')
  assert.equal(h.data.storyboard.shots[0].visualReview, undefined)
  assert.equal(h.panel.querySelector('textarea'), note)
  assert.equal(note.value, '结构和日光均一致')
  assert.match(h.calls.notices[0], /磁盘写入失败/)
  h.controls.fail = false
  await h.mouseClick(approve)
  assert.equal(h.calls.commits.length, 2)
  assert.equal(h.calls.commits[1].metadata.atomic, true)
  assert.equal(h.data.storyboard.shots[0].visualReview.notes, '结构和日光均一致')
  assert.equal(h.env.selectedShotId, 'shot-2')
  assert.equal(h.env.pictureNotes.size, 0)
})

test('保存等待期间不重复提交，真实键盘离开与非主键鼠标不会被按下保护拦截', async () => {
  const h = harness(); let release
  h.controls.gate = new Promise(resolve => { release = resolve })
  const approve = h.find('确认并看下一镜')
  const pending = h.mouseClick(approve)
  await h.mouseClick(approve)
  assert.equal(h.calls.commits.length, 1)
  assert.equal(h.env.selectedShotId, 'shot-1')
  release(); await pending
  assert.equal(h.env.selectedShotId, 'shot-2')
  const note = h.panel.querySelector('textarea'); note.focus()
  const event = await h.mouseClick(h.find('标记需要修改'), { button: 2 })
  assert.equal(event.defaultPrevented, false)
  assert.equal(h.calls.commits.length, 1)
})
