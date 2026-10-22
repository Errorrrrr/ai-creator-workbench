import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')

function productionFunction(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source)
  assert.ok(start, `${name} exists in production source`)
  const body = source.slice(start.index)
  const end = /^\}/m.exec(body)
  assert.ok(end)
  return body.slice(0, end.index + 1)
}

function submitListener(selector) {
  const marker = `document.querySelector('${selector}').addEventListener('submit', async event => {`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `${selector} retains its submit handler`)
  const body = source.slice(start)
  const end = /^\}\)/m.exec(body)
  assert.ok(end)
  return body.slice(0, end.index + 3)
}

function harness({ drivers = [], connections = [], saved = true } = {}) {
  const nodes = new Map()
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag
      this.children = []
      this.dataset = {}
      this.attributes = new Map()
      this.listeners = new Map()
      this.value = ''
      this.textContent = ''
      this.hidden = false
      this.disabled = false
      this.checked = false
      this.open = false
    }
    append(...children) { this.children.push(...children.flatMap(child => child.tagName === 'fragment' ? child.children : [child])) }
    replaceChildren(...children) { this.children = []; this.append(...children) }
    setAttribute(key, value) { this.attributes.set(key, value) }
    getAttribute(key) { return this.attributes.get(key) }
    removeAttribute(key) { this.attributes.delete(key) }
    addEventListener(name, handler) { this.listeners.set(name, handler) }
    querySelector(selector) { if (!this.queries) this.queries = new Map(); if (!this.queries.has(selector)) this.queries.set(selector, new Node()); return this.queries.get(selector) }
    querySelectorAll() { return [] }
    close() { this.open = false }
    focus() {}
  }
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector) }
  const calls = { desktop: [], persisted: [], opened: [], toast: [], detected: 0, rendered: 0 }
  const state = { runtime: { status: 'ready', drivers: structuredClone(drivers) }, connections: structuredClone(connections), isGenerating: false }
  const env = {
    structuredClone, state, projectTransition: false, isDesktopRuntime: true, activeProjectId: null,
    cliSessionConsent: { old: true }, sessionSecrets: new Map(),
    document: { querySelector: get, createElement: tag => new Node(tag), createDocumentFragment: () => new Node('fragment') },
    openDialog: dialog => { dialog.open = true; calls.opened.push(dialog) },
    showToast: message => calls.toast.push(message),
    invokeDesktop: async (command, args) => { calls.desktop.push({ command, args }); return {} },
    persistWorkspace: async options => { calls.persisted.push(structuredClone(state.connections)); if (!saved) options?.onError?.('测试存储失败'); return saved },
    detectRuntime: async () => { calls.detected++ },
    renderConnections: () => { calls.rendered++ },
    setProjectTransition: value => { env.projectTransition = value },
    readableError: error => error.message,
    createIcon: () => new Node('svg'),
    getActiveConnection: () => null,
    window: { setTimeout: callback => { callback(); return 1 } }
  }
  vm.createContext(env)
  return {
    env, state, get, calls,
    load(...names) { vm.runInContext(names.map(productionFunction).join('\n'), env) },
    async submit(selector) {
      if (selector === '#claudeCredentialForm') vm.runInContext(productionFunction('saveClaudeCredential'), env)
      vm.runInContext(submitListener(selector), env)
      const form = get(selector)
      await form.listeners.get('submit')({ preventDefault() {}, currentTarget: form })
    },
    descendants(node) { return node.children.flatMap(child => [child, ...this.descendants(child)]) }
  }
}

const driver = (id, status = 'ready') => ({ id, name: id === 'claude' ? 'Claude Code' : id, status, canGenerate: status === 'ready' && id !== 'gemini', executionStatus: id === 'gemini' ? 'disabled' : 'available' })
const connection = id => ({ id: `cli-${id}`, kind: 'cli', driverId: id, name: id, planningModel: 'existing-model', status: 'ready', error: null, rememberSecret: id === 'claude', isActive: false })

test('每个 CLI 卡片都有统一设置入口，未安装与只检测驱动不能被激活', () => {
  const drivers = [driver('codex'), driver('claude', 'not_found'), driver('antigravity'), driver('gemini')]
  const h = harness({ drivers, connections: drivers.map(item => connection(item.id)) })
  h.load('renderRuntimeDrivers')
  h.env.renderRuntimeDrivers()
  const cards = h.get('#cliConnectionList').children
  assert.equal(cards.length, 4)
  for (let index = 0; index < cards.length; index++) {
    const controls = h.descendants(cards[index])
    const settings = controls.find(node => node.dataset.action === 'configure-cli')
    assert.ok(settings)
    assert.equal(settings.dataset.driverId, drivers[index].id)
    assert.equal(settings.disabled, false)
    assert.equal(controls.some(node => node.dataset.action === 'activate-connection'), ['codex', 'antigravity'].includes(drivers[index].id))
  }
  assert.deepEqual(h.calls.desktop, [])
  assert.deepEqual(h.calls.persisted, [])
})

test('统一设置正确显示各驱动配置，未安装也可打开，打开不读密钥、不保存或检测', () => {
  for (const installed of [true, false]) {
    const drivers = ['codex', 'claude', 'antigravity', 'gemini'].map(id => driver(id, installed ? 'ready' : 'not_found'))
    const h = harness({ drivers, connections: installed ? drivers.map(item => connection(item.id)) : [] })
    const previous = structuredClone(h.state.connections)
    h.env.sessionSecrets.set('cli-claude', 'test-only-existing-secret')
    h.env.sessionSecrets.get = () => { throw new Error('opening settings must not read credentials') }
    h.load('openCliSettingsDialog')
    for (const item of drivers) {
      h.get('#claudeApiKey').value = 'test-only-unsaved-input'
      h.env.openCliSettingsDialog(item.id)
      assert.equal(h.get('#cliSettingsDialog').open, true)
      assert.equal(h.get('#cliSettingsDialog').dataset.driverId, item.id)
      assert.equal(h.get('#cliSettingsTitle').textContent, `${item.name} 设置`)
      assert.equal(h.get('#cliModelForm').hidden, !(item.id === 'codex' && installed))
      assert.equal(h.get('#claudeCredentialForm').hidden, item.id !== 'claude')
      assert.equal(h.get('#claudeApiKey').value, '')
      assert.equal(h.get('#claudeKeyDetails').open, false)
      if (!installed) assert.match(h.get('#cliSettingsRuntime').textContent, /未安装/)
    }
    assert.deepEqual(h.state.connections, previous)
    assert.deepEqual(h.calls.desktop, [])
    assert.deepEqual(h.calls.persisted, [])
    assert.equal(h.calls.detected, 0)
  }
})

test('浏览器版不展示 Claude 密钥表单，未知驱动和进行中的任务不会打开设置', () => {
  const h = harness({ drivers: [driver('claude')], connections: [connection('claude')] })
  h.load('openCliSettingsDialog')
  h.env.isDesktopRuntime = false
  h.env.openCliSettingsDialog('claude')
  assert.equal(h.get('#claudeCredentialForm').hidden, true)
  assert.equal(h.get('#cliSettingsDone').hidden, false)
  h.get('#cliSettingsDialog').close()
  for (const mode of ['unknown', 'generating', 'transition']) {
    h.state.isGenerating = mode === 'generating'
    h.env.projectTransition = mode === 'transition'
    h.env.openCliSettingsDialog(mode === 'unknown' ? 'unknown' : 'claude')
    assert.equal(h.get('#cliSettingsDialog').open, false)
  }
  assert.deepEqual(h.calls.desktop, [])
  assert.deepEqual(h.calls.persisted, [])
})

test('Claude 留空 Key 保留当前会话与钥匙串配置，不触发凭据保存', async () => {
  for (const checked of [true, false]) {
    const h = harness({ drivers: [driver('claude')], connections: [connection('claude')] })
    const previous = structuredClone(h.state.connections)
    h.env.sessionSecrets.set('cli-claude', 'test-only-existing-secret')
    h.get('#claudeApiKey').value = '  '
    h.get('#rememberClaudeKey').checked = checked
    await h.submit('#claudeCredentialForm')
    assert.equal(h.env.sessionSecrets.get('cli-claude'), 'test-only-existing-secret')
    assert.deepEqual(h.state.connections, previous)
    assert.deepEqual(h.calls.desktop, [])
    assert.deepEqual(h.calls.persisted, [])
  }
})

test('Codex 模型保存保留原有语义：有效 ID 才保存，留空跟随 CLI，失败回滚', async () => {
  for (const [value, saved] of [[' gpt-test/model:1 ', true], ['', true], ['new-model', false], ['not a model', true]]) {
    const h = harness({ drivers: [driver('codex')], connections: [connection('codex'), connection('claude')], saved })
    const form = h.get('#cliModelForm')
    form.dataset.connectionId = 'cli-codex'
    h.get('#cliPlanningModel').value = value
    h.get('#cliSettingsDialog').open = true
    const previous = structuredClone(h.state.connections)
    await h.submit('#cliModelForm')
    const invalid = value === 'not a model'
    assert.equal(h.calls.persisted.length, invalid ? 0 : 1)
    assert.deepEqual(h.calls.desktop, [], 'saving a planning model does not invoke a provider')
    assert.deepEqual(h.state.connections[1], previous[1])
    if (saved && !invalid) {
      assert.equal(h.state.connections[0].planningModel, value.trim())
      assert.equal(h.state.connections[0].status, 'installed', 'a saved model is not account verification')
      assert.equal(h.env.cliSessionConsent, null)
    } else {
      assert.deepEqual(h.state.connections, previous)
      assert.equal(h.get('#cliPlanningModel').value, value)
      assert.notEqual(h.env.cliSessionConsent, null)
    }
    if (invalid) assert.equal(h.get('#cliPlanningModel').getAttribute('aria-invalid'), 'true')
    assert.equal(h.env.projectTransition, false)
  }
})

test('Claude 会话 Key 保存失败保留原设置和输入，成功后才采用新 Key', async () => {
  for (const saved of [false, true]) {
    const configured = { ...connection('claude'), rememberSecret: false }
    const h = harness({ drivers: [driver('claude')], connections: [configured], saved })
    const previous = structuredClone(h.state.connections)
    h.env.sessionSecrets.set('cli-claude', 'test-only-old-secret')
    h.get('#cliSettingsDialog').open = true
    h.get('#claudeApiKey').value = ' test-only-new-secret '
    h.get('#rememberClaudeKey').checked = false
    await h.submit('#claudeCredentialForm')
    assert.deepEqual(h.calls.desktop, [])
    assert.equal(h.calls.persisted.length, 1)
    assert.equal(h.env.projectTransition, false)
    assert.equal(h.get('#claudeCredentialForm').dataset.saving, 'false')
    if (saved) {
      assert.equal(h.env.sessionSecrets.get('cli-claude'), 'test-only-new-secret')
      assert.equal(h.get('#cliSettingsDialog').open, false)
      assert.equal(h.get('#claudeApiKey').value, '')
      assert.equal(h.env.cliSessionConsent, null)
      assert.equal(h.calls.detected, 1)
      assert.equal(h.state.connections[0].status, 'installed')
      assert.equal(h.state.connections[0].lastExecution, null)
    } else {
      assert.equal(h.env.sessionSecrets.get('cli-claude'), 'test-only-old-secret')
      assert.deepEqual(h.state.connections, previous)
      assert.equal(h.get('#cliSettingsDialog').open, true)
      assert.equal(h.get('#claudeApiKey').value, ' test-only-new-secret ')
      assert.notEqual(h.env.cliSessionConsent, null)
      assert.equal(h.calls.detected, 0)
      assert.match(h.get('#claudeCredentialStatus').textContent, /未保存/)
    }
  }
})

test('Claude 钥匙串写入失败恢复保存选项和旧会话 Key，新建连接也可回滚', async () => {
  for (const previousRemember of [true, false, null]) {
    const existing = previousRemember === null ? [] : [{ ...connection('claude'), rememberSecret: previousRemember }]
    const h = harness({ drivers: [driver('claude')], connections: existing })
    const previous = structuredClone(h.state.connections)
    h.env.sessionSecrets.set('cli-claude', 'test-only-old-secret')
    h.get('#cliSettingsDialog').open = true
    h.get('#claudeApiKey').value = 'test-only-new-secret'
    h.get('#rememberClaudeKey').checked = !previousRemember
    h.env.invokeDesktop = async (command, args) => {
      h.calls.desktop.push({ command, args })
      throw new Error('测试钥匙串不可写')
    }
    await h.submit('#claudeCredentialForm')
    assert.equal(h.calls.desktop.length, 1)
    assert.equal(h.calls.desktop[0].command, 'credential_save')
    assert.equal(h.calls.persisted.length, 2)
    assert.deepEqual(h.calls.persisted[1], previous, 'rollback restores the persisted save option too')
    assert.deepEqual(h.state.connections, previous)
    assert.equal(h.env.sessionSecrets.get('cli-claude'), 'test-only-old-secret')
    assert.equal(h.get('#claudeApiKey').value, 'test-only-new-secret')
    assert.equal(h.get('#cliSettingsDialog').open, true)
    assert.equal(h.env.projectTransition, false)
    assert.notEqual(h.env.cliSessionConsent, null)
    assert.equal(h.calls.detected, 0)
    assert.match(h.get('#claudeCredentialStatus').textContent, /测试钥匙串不可写/)
  }
})

test('Claude 凭据读取失败只影响 Claude，恢复钥匙串后回到待验证，不误报所有 CLI 失效', async () => {
  const drivers = ['codex', 'claude', 'antigravity'].map(id => driver(id))
  const h = harness({ drivers, connections: drivers.map(item => connection(item.id)) })
  let refused = true
  h.env.invokeDesktop = async command => {
    if (command === 'runtime_snapshot') return { drivers: structuredClone(drivers), ollama: null }
    if (command === 'credential_load') { if (refused) throw new Error('测试钥匙串被拒绝'); return 'test-only-key' }
    throw new Error(command)
  }
  h.load('connectionSecret', 'syncCliConnections', 'detectRuntime')
  await h.env.detectRuntime()
  assert.equal(h.state.runtime.status, 'ready')
  assert.equal(h.state.runtime.drivers.length, 3)
  for (const id of ['codex', 'antigravity']) {
    assert.equal(h.state.connections.find(item => item.driverId === id).status, 'ready')
    assert.equal(h.state.runtime.drivers.find(item => item.id === id).canGenerate, true)
  }
  assert.equal(h.state.connections.find(item => item.driverId === 'claude').status, 'auth_failed')
  assert.equal(h.state.runtime.drivers.find(item => item.id === 'claude').canGenerate, false)
  refused = false
  await h.env.detectRuntime()
  assert.equal(h.state.connections.find(item => item.driverId === 'claude').status, 'installed')
  assert.equal(h.state.connections.find(item => item.driverId === 'claude').error, null)
})

test('已配置但缺失的 Claude Key 不自动降级到 CLI 登录', async () => {
  const h = harness()
  h.env.invokeDesktop = async () => ''
  h.load('connectionSecret')
  await assert.rejects(h.env.connectionSecret(connection('claude')), /未切换到其他凭据/)
  assert.equal(h.env.sessionSecrets.size, 0)
})

test('安装检测保留实际调用失败、时间与成功结果，配置变化后恢复待验证', () => {
  for (const status of ['error', 'auth_failed', 'ready']) {
    const lastExecution = { status, error: status === 'ready' ? null : '测试账号错误', at: '2026-10-23T00:00:00Z' }
    const h = harness({ connections: [{ ...connection('codex'), status: 'unknown', error: null, lastExecution }] })
    h.load('syncCliConnections', 'renderRuntimeDrivers', 'normalizeConnections')
    h.env.configuredMediaAdapterId = () => null
    h.env.defaultConnections = [{ id: 'api', kind: 'ollama' }]
    h.state.connections = h.env.normalizeConnections(h.state.connections)
    const normalized = h.state.connections.find(item => item.driverId === 'codex')
    assert.deepEqual(JSON.parse(JSON.stringify(normalized.lastExecution)), lastExecution)
    const drivers = [driver('codex')]
    h.env.syncCliConnections(drivers)
    h.env.syncCliConnections(drivers)
    assert.equal(normalized.status, status)
    assert.equal(normalized.error, lastExecution.error)
    h.state.runtime.drivers = drivers
    h.env.renderRuntimeDrivers()
    const texts = h.descendants(h.get('#cliConnectionList')).map(node => node.textContent).join(' ')
    assert.match(texts, status === 'ready' ? /上次调用成功/ : /上次调用失败/)
    normalized.lastExecution = null; normalized.status = 'installed'; normalized.error = null
    h.env.syncCliConnections(drivers)
    assert.equal(normalized.status, 'installed')
  }
})

test('移除 Claude Key 成功后才清理会话和授权；元数据或钥匙串失败完整回滚', async () => {
  for (const failure of ['none', 'metadata', 'keychain']) {
    const configured = { ...connection('claude'), lastExecution: { status: 'ready', error: null, at: '2026-10-23T00:00:00Z' } }
    const h = harness({ connections: [configured], saved: failure !== 'metadata' })
    h.load('saveClaudeCredential')
    h.env.sessionSecrets.set('cli-claude', 'test-only-existing-key')
    h.get('#cliSettingsDialog').open = true
    h.get('#claudeApiKey').value = 'test-only-unsaved-input'
    h.env.invokeDesktop = async (command, args) => {
      h.calls.desktop.push({ command, args })
      if (failure === 'keychain') throw new Error('测试钥匙串不可写')
    }
    await h.env.saveClaudeCredential({ remove: true })
    if (failure === 'none') {
      assert.deepEqual(h.calls.desktop.map(item => ({ ...item.args })), [{ id: 'cli-claude', endpoint: '', secret: '' }])
      assert.equal(h.env.sessionSecrets.has('cli-claude'), false)
      assert.equal(h.state.connections[0].rememberSecret, false)
      assert.equal(h.state.connections[0].status, 'installed')
      assert.equal(h.state.connections[0].lastExecution, null)
      assert.equal(h.env.cliSessionConsent, null)
      assert.equal(h.get('#cliSettingsDialog').open, false)
    } else {
      assert.deepEqual(h.state.connections, [configured])
      assert.equal(h.env.sessionSecrets.get('cli-claude'), 'test-only-existing-key')
      assert.notEqual(h.env.cliSessionConsent, null)
      assert.equal(h.get('#cliSettingsDialog').open, true)
      if (failure === 'metadata') assert.equal(h.calls.desktop.length, 0)
      else assert.equal(h.calls.persisted.length, 2)
    }
    assert.equal(h.env.projectTransition, false)
  }
})


test('安装检测本身失败后恢复，不冒充一次账号调用失败', () => {
  const h = harness({ connections: [{ ...connection('codex'), status: 'error', error: '运行时检测失败', lastExecution: null }] })
  h.load('syncCliConnections')
  h.env.syncCliConnections([driver('codex')])
  assert.equal(h.state.connections[0].status, 'installed')
  assert.equal(h.state.connections[0].error, null)
})
