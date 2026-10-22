import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
const mediaSource = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')

function productionFunction(source, name) {
  const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  assert.ok(match, `${name} exists in production source`)
  const body = source.slice(match.index)
  const end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
  assert.ok(end, `${name} has a closing declaration`)
  return body.slice(0, end.index + end[0].length)
}

// Browser boundaries are replaced; state transitions and accessibility updates
// execute the actual application functions rather than a copy of their logic.
function layoutHarness(width = 1399, view = 'workspace') {
  let viewportWidth = width
  const scheduled = []
  const document = { activeElement: null }
  class Element {
    constructor(parent = null) {
      this.parentElement = parent
      this.inert = false
      this.isConnected = true
      this.dataset = {}
      this.attributes = new Map()
      this.classes = new Set()
      this.classList = {
        contains: name => this.classes.has(name),
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
        toggle: (name, force) => { const next = force ?? !this.classes.has(name); if (next) this.classes.add(name); else this.classes.delete(name); return next }
      }
    }
    setAttribute(key, value) { this.attributes.set(key, String(value)) }
    getAttribute(key) { return this.attributes.get(key) }
    contains(target) { for (let node = target; node; node = node.parentElement) if (node === this) return true; return false }
    focus() { for (let node = this; node; node = node.parentElement) if (node.inert) return; document.activeElement = this }
  }
  document.body = new Element()
  const queries = new Map(['.titlebar', '.activity-rail', '.main-surface', '.statusbar'].map(selector => [selector, new Element()]))
  const opener = new Element(queries.get('.titlebar'))
  queries.set('.titlebar [data-action="toggle-assistant"]', opener)
  queries.set('[data-action="toggle-explorer"]', new Element(queries.get('.main-surface')))
  document.querySelector = selector => queries.get(selector) || null
  const elements = Object.fromEntries(['appShell', 'assistantPanel', 'resourceExplorer'].map(name => [name, new Element()]))
  elements.promptInput = new Element(elements.assistantPanel)
  elements.treeSearch = new Element(elements.resourceExplorer)
  const closeAssistant = new Element(elements.assistantPanel)
  const state = { currentView: view }
  const calls = []
  const sandbox = {
    document, elements, state, HTMLElement: Element, assistantExpanded: false, drawerReturnFocus: null,
    window: {
      matchMedia: query => ({ matches: viewportWidth <= Number(/max-width:\s*(\d+)/.exec(query)?.[1] || 0) }),
      setTimeout: callback => { scheduled.push(callback); return scheduled.length }
    },
    switchView: next => { state.currentView = next; calls.push(next) }
  }
  vm.createContext(sandbox)
  const projectPredicate = appSource.match(/^const isProjectView = .+$/m)?.[0]
  assert.ok(projectPredicate)
  vm.runInContext(`${projectPredicate}\n${['rememberDrawerOpener', 'restoreDrawerFocus', 'toggleAssistant', 'syncAssistantAccessibility', 'closeDrawers', 'setFocusMode', 'focusProjectSearch', 'toggleExplorer', 'focusAssistant'].map(name => productionFunction(appSource, name)).join('\n')}`, sandbox)
  opener.focus()
  sandbox.syncAssistantAccessibility()
  return {
    ...sandbox, queries, opener, closeAssistant, calls,
    flush() { while (scheduled.length) scheduled.shift()() },
    resize(width) { viewportWidth = width; sandbox.syncAssistantAccessibility() }
  }
}

test('助手在 1399 边界切换布局，显式收起后调整窗口不会自行重开', () => {
  const h = layoutHarness()
  assert.equal(h.elements.assistantPanel.inert, true)
  h.toggleAssistant(true); h.flush()
  assert.equal(h.elements.appShell.classList.contains('assistant-open'), true)
  assert.equal(h.elements.assistantPanel.inert, false)
  assert.equal(h.queries.get('.main-surface').inert, true)
  assert.equal(h.document.activeElement, h.elements.promptInput)
  h.resize(1400)
  assert.equal(h.elements.appShell.classList.contains('assistant-open'), false)
  assert.equal(h.elements.assistantPanel.inert, false)
  assert.equal(h.queries.get('.main-surface').inert, false)
  h.resize(1399)
  assert.equal(h.elements.appShell.classList.contains('assistant-open'), true)
  h.closeDrawers(); h.flush()
  assert.equal(h.document.activeElement, h.opener)
  for (const width of [1400, 1399, 800]) {
    h.resize(width)
    assert.equal(h.elements.assistantPanel.inert, true)
    assert.equal(h.elements.appShell.classList.contains('assistant-open'), false)
    assert.equal(h.queries.get('.main-surface').inert, false)
  }
})

test('窄屏助手与内容导航互斥，切换后关闭返回最初外部入口', () => {
  for (const order of [['assistant', 'explorer'], ['explorer', 'assistant']]) {
    const h = layoutHarness(800)
    for (const type of order) {
      h[type === 'assistant' ? 'toggleAssistant' : 'toggleExplorer'](true); h.flush()
      assert.equal(h.elements.appShell.classList.contains(`${type}-open`), true)
      assert.equal(h.elements.appShell.classList.contains(`${type === 'assistant' ? 'explorer' : 'assistant'}-open`), false)
      assert.equal(h.elements[type === 'assistant' ? 'assistantPanel' : 'resourceExplorer'].inert, false)
      assert.equal(h.queries.get('.main-surface').inert, true)
    }
    h.closeDrawers(); h.flush()
    assert.equal(h.document.activeElement, h.opener)
    assert.equal(h.elements.assistantPanel.inert, true)
    assert.equal(h.elements.resourceExplorer.inert, true)
    assert.equal(h.queries.get('.main-surface').inert, false)
  }
})

test('宽屏从助手内部收起时恢复焦点，分镜页打开助手保留当前页面', () => {
  const h = layoutHarness(1600, 'storyboard')
  h.focusAssistant(); h.flush()
  assert.equal(h.state.currentView, 'storyboard')
  assert.deepEqual(h.calls, [])
  assert.equal(h.document.activeElement, h.elements.promptInput)
  h.closeAssistant.focus()
  h.toggleAssistant(false); h.flush()
  assert.equal(h.elements.assistantPanel.inert, true)
  assert.equal(h.document.activeElement, h.opener)
})

test('设置页面与无项目页面不留下助手遮罩或不可交互的背景', () => {
  const h = layoutHarness(1200)
  h.toggleAssistant(true); h.flush()
  h.state.currentView = 'connections'
  h.closeDrawers({ preserveAssistant: true }); h.flush()
  assert.equal(h.elements.appShell.classList.contains('assistant-open'), false)
  assert.equal(h.elements.assistantPanel.getAttribute('aria-hidden'), 'true')
  assert.equal(h.queries.get('.main-surface').inert, false)
  h.state.currentView = 'workspace'; h.syncAssistantAccessibility()
  assert.equal(h.elements.appShell.classList.contains('assistant-open'), true)
  h.closeDrawers(); h.flush()
  h.elements.appShell.classList.add('no-project')
  h.toggleAssistant(true); h.flush()
  assert.equal(h.elements.appShell.classList.contains('assistant-open'), false)
  assert.equal(h.elements.assistantPanel.inert, true)
  assert.equal(h.queries.get('.main-surface').inert, false)
})

test('镜头详情重绘保存各折叠区状态，切换镜头不串联状态', () => {
  let nodes = []
  const sandbox = { detailShotId: 'first', shotDisclosureState: new Map(), shotDetail: { querySelectorAll: () => nodes } }
  vm.createContext(sandbox)
  vm.runInContext(['rememberShotDisclosures', 'restoreShotDisclosures'].map(name => productionFunction(mediaSource, name)).join('\n'), sandbox)
  const section = (key, open) => ({ dataset: { layoutKey: key }, open })
  nodes = [section('continuity', true), section('generation-settings', false), section('reference-matching', true)]
  sandbox.rememberShotDisclosures()
  nodes = [section('continuity', false), section('generation-settings', true), section('reference-matching', false), section('new-section', true)]
  sandbox.restoreShotDisclosures()
  assert.deepEqual(nodes.map(node => node.open), [true, false, true, true])
  sandbox.detailShotId = 'second'
  nodes = [section('continuity', false), section('generation-settings', true)]
  sandbox.restoreShotDisclosures()
  assert.deepEqual(nodes.map(node => node.open), [false, true])
  sandbox.rememberShotDisclosures()
  sandbox.detailShotId = 'first'
  sandbox.restoreShotDisclosures()
  assert.deepEqual(nodes.map(node => node.open), [true, false])
})

test('各项目视图专注模式下定位内容搜索会显示可用导航，关闭助手抽屉，窄屏恢复入口', () => {
  for (const view of ['workspace', 'storyboard', 'assets']) for (const width of [800, 1200, 1600]) {
    const h = layoutHarness(width, view)
    h.setFocusMode(true)
    assert.equal(h.elements.resourceExplorer.inert, true)
    h.toggleAssistant(true); h.flush()
    h.focusProjectSearch(); h.flush()
    assert.equal(h.elements.appShell.classList.contains('focus-mode'), false)
    assert.equal(h.elements.resourceExplorer.inert, false)
    assert.equal(h.elements.appShell.classList.contains('assistant-open'), false)
    assert.equal(h.document.activeElement, h.elements.treeSearch)
    assert.equal(h.state.currentView, view)
  }
})

test('窄屏助手通过快捷键转到搜索，重复定位后关闭仍回到最初外部入口', () => {
  for (const view of ['workspace', 'storyboard', 'assets']) {
    const h = layoutHarness(800, view)
    h.toggleAssistant(true); h.flush()
    h.focusProjectSearch(); h.flush()
    h.focusProjectSearch(); h.flush()
    assert.equal(h.document.activeElement, h.elements.treeSearch)
    h.closeDrawers(); h.flush()
    assert.equal(h.document.activeElement, h.opener)
    assert.equal(h.elements.resourceExplorer.inert, true)
    assert.equal(h.elements.assistantPanel.inert, true)
  }
})

test('全局键盘处理尊重已消费的 Escape，⌘P 使用可见导航', () => {
  const marker = "document.addEventListener('keydown', (event) => {"
  const start = appSource.indexOf(marker), tail = appSource.slice(start)
  const listener = tail.slice(0, /^\}\)/m.exec(tail).index + 3)
  let handler, stops = 0, searches = 0
  const env = {
    document: { addEventListener: (_, callback) => { handler = callback }, querySelector: () => null },
    projectTransition: false, elements: { connectionDialog: { open: false } }, state: { isGenerating: true },
    stopGeneration: () => { stops++ }, focusProjectSearch: () => { searches++ }
  }
  vm.runInNewContext(listener, env)
  handler({ key: 'Escape', defaultPrevented: true })
  assert.equal(stops, 0)
  handler({ key: 'Escape', defaultPrevented: false })
  assert.equal(stops, 1)
  handler({ key: 'p', metaKey: true, preventDefault() {} })
  assert.equal(searches, 1)
})
