import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { providerEndpointUrl, validateProviderBaseUrl } from '../src/provider-stream.js'
import { prepareGeneration } from '../src/creation-workflow.js'

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
function productionFunction(name, nextName) {
  return source.slice(source.indexOf(`async function ${name}(`), source.indexOf(`\nasync function ${nextName}(`))
}

test('provider endpoints match desktop URL policy, including custom ports and IPv6', () => {
  for (const base of ['http://localhost:12345/', 'http://127.0.0.2:11435', 'http://[::1]:11435', 'http://[0:0:0:0:0:0:0:1]:11435']) {
    assert.doesNotThrow(() => validateProviderBaseUrl('ollama', base))
    assert.doesNotThrow(() => validateProviderBaseUrl('openai-compatible', base))
  }
  for (const base of ['http://example.invalid', 'http://192.168.1.1', 'http://[::ffff:127.0.0.1]']) {
    assert.throws(() => validateProviderBaseUrl('openai-compatible', base), /HTTPS/)
    assert.throws(() => validateProviderBaseUrl('ollama', base), /本机/)
  }
  for (const suffix of ['?key=x', '?', '#section', '#']) {
    assert.throws(() => validateProviderBaseUrl('openai-compatible', `https://example.invalid/v1${suffix}`), /查询参数或片段/)
  }
  assert.throws(() => validateProviderBaseUrl('openai-compatible', 'https://user:pass@example.invalid'), /凭据/)
  assert.throws(() => validateProviderBaseUrl('ollama', 'https://localhost'), /本机 HTTP/)
  assert.equal(providerEndpointUrl('openai-compatible', 'https://example.invalid/v1///', 'chat/completions'), 'https://example.invalid/v1/chat/completions')
  assert.equal(providerEndpointUrl('ollama', 'http://[::1]:11435/custom/', '/api/tags'), 'http://[::1]:11435/custom/api/tags')
})

function connectionTestHarness(connection, payload) {
  const calls = []
  const state = { connections: [connection] }
  let saves = 0
  const context = vm.createContext({
    state, projectTransition: false,
    connectionTestSequence: 0, connectionTestTasks: new Map(), performance,
    isDesktopRuntime: false, renderConnections() {}, persistWorkspace: async () => { saves++; return true },
    AbortController, window: { setTimeout, clearTimeout }, providerEndpointUrl, validateProviderBaseUrl,
    connectionSecret: async () => 'mock-only', classifyProviderError: error => ['error', error.message],
    fetch: async url => { calls.push(url); return new Response(JSON.stringify(payload)) }
  })
  vm.runInContext(productionFunction('testProviderConnection', 'testConnection'), context)
  return { calls, context, state, saves: () => saves, run: () => context.testProviderConnection(connection) }
}

test('connection testing rejects invalid endpoints before credentials can be sent', async () => {
  for (const baseUrl of ['https://example.invalid/v1?key=x', 'https://example.invalid/v1#fragment', 'http://example.invalid/v1']) {
    const connection = { id: 'test', kind: 'openai-compatible', baseUrl, model: 'mock' }
    const harness = connectionTestHarness(connection, { data: [{ id: 'mock' }] })
    assert.equal(await harness.run(), false)
    assert.equal(harness.calls.length, 0)
    assert.equal(connection.status, 'error')
  }
})

test('browser Ollama tests use the configured IPv6 endpoint and require a valid model list', async () => {
  for (const [payload, expected] of [[{ models: [{ name: 'mock' }] }, true], [{ models: [{ name: 12 }] }, false], [{}, false], [{ models: [] }, false]]) {
    const connection = { id: 'ollama', kind: 'ollama', baseUrl: 'http://[::1]:11435/custom/', model: 'mock' }
    const harness = connectionTestHarness(connection, payload)
    assert.equal(await harness.run(), expected)
    assert.deepEqual(harness.calls, ['http://[::1]:11435/custom/api/tags'])
  }
})

test('late connection tests and draft tests cannot save over a switched or restoring project', async () => {
  for (const mode of ['current', 'switched', 'transition', 'draft']) {
    const connection = { id: 'test', kind: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'mock' }
    const harness = connectionTestHarness(connection, { data: [{ id: 'mock' }] })
    let releaseResponse
    let enteredFetch
    const fetched = new Promise(resolve => { enteredFetch = resolve })
    harness.context.fetch = () => { enteredFetch(); return new Promise(resolve => { releaseResponse = resolve }) }
    if (mode === 'draft') harness.state.connections = []
    const pending = harness.run()
    await fetched
    if (mode === 'switched') harness.state.connections = [{ ...connection }]
    if (mode === 'transition') harness.context.projectTransition = true
    releaseResponse(new Response(JSON.stringify({ data: [{ id: 'mock' }] })))
    await pending
    assert.equal(harness.saves(), mode === 'current' ? 1 : 0, mode)
    assert.equal(harness.context.connectionTestTasks.size, 0, 'completed tests still release their task registration')
  }
})

test('runtime rediscovery keeps a missing configured model in model_missing state', async () => {
  const connection = { id: 'local', kind: 'ollama', baseUrl: 'http://127.0.0.1:12345', model: 'deleted-model' }
  const calls = []
  const context = vm.createContext({
    state: { connections: [connection], runtime: {} }, isDesktopRuntime: false,
    renderConnections() {}, syncCliConnections() {}, Date, encodeURIComponent,
    fetch: async url => {
      calls.push(url)
      return new Response(JSON.stringify(url.startsWith('/api/runtime/ollama') ? { status: 'ready', models: [{ name: 'other-model' }] } : { drivers: [] }))
    }
  })
  vm.runInContext(productionFunction('detectRuntime', 'setActiveConnection'), context)
  await context.detectRuntime()
  assert.equal(connection.status, 'model_missing')
  assert.equal(connection.model, 'deleted-model')
  assert.match(connection.error, /deleted-model/)
  assert.ok(calls.includes('/api/runtime/ollama?baseUrl=http%3A%2F%2F127.0.0.1%3A12345'))
  connection.model = ''
  await context.detectRuntime()
  assert.equal(connection.model, 'other-model')
  assert.equal(connection.status, 'ready')
})

function desktopGenerationHarness({ secret } = {}) {
  let deliver
  let entered
  const invoked = new Promise(resolve => { entered = resolve })
  const calls = { unlisten: 0, finish: 0, fail: 0, invoke: 0 }
  let listener
  const input = { project: { name: '测试', type: '短剧' }, documentId: 'scene', tabName: 'script', documents: { scene: { title: '第一场', content: '原始正文' } }, tabContents: {}, structure: {}, prompt: '原始要求', knowledgeChunks: [{ id: 'k', name: '资料', path: '资料.md', content: '原始知识' }] }
  const prepared = prepareGeneration(input)
  const state = { activeGenerationId: 'test-task', isGenerating: true, generationText: '', generationContext: { messages: prepared.messages, knowledgeChunks: prepared.knowledgeChunks } }
  const elements = { candidateContent: { textContent: '' }, assistantConversation: { scrollTop: 0, scrollHeight: 0 } }
  const context = vm.createContext({
    state, elements, AbortController, isDesktopRuntime: true, validateProviderBaseUrl,
    connectionSecret: secret || (async () => 'mock-only'), renderConnections() {}, readableError: error => error.message,
    persistWorkspace: async () => true, scheduleCandidateSave() {},
    finishGeneration: () => { calls.finish++; state.isGenerating = false },
    failGeneration: () => { calls.fail++; state.isGenerating = false },
    window: { __TAURI__: { event: { listen: async (_name, callback) => { listener = callback; return () => { calls.unlisten++ } } } } },
    invokeDesktop: async (_command, payload) => { calls.invoke++; calls.request = payload.request; entered(); return new Promise(resolve => { deliver = resolve }) }
  })
  vm.runInContext(source.slice(source.indexOf('function buildGenerationMessages('), source.indexOf('\nlet cliSessionConsent')), context)
  vm.runInContext(source.slice(source.indexOf('async function generateWithConnection('), source.indexOf('\nfunction failGeneration(')), context)
  return { input, calls, state, elements, invoked, run: () => context.generateWithConnection({ id: 'mock', kind: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'mock' }, 'original', 'test-task'), emit: payload => listener({ payload }), complete: output => deliver({ output }) }
}

test('desktop event integration sends frozen context, filters task IDs and removes the listener', async () => {
  const harness = desktopGenerationHarness()
  harness.input.documents.scene.content = '后续修改正文'
  harness.input.knowledgeChunks[0].content = '后续修改知识'
  const running = harness.run()
  await harness.invoked
  const request = harness.calls.request.messages[1].content
  assert.match(request, /原始正文/)
  assert.match(request, /原始知识/)
  assert.doesNotMatch(request, /后续修改/)
  harness.emit({ taskId: 'different', delta: '不能串入' })
  harness.emit({ taskId: 'test-task', delta: '已收到' })
  assert.equal(harness.state.generationText, '已收到')
  harness.complete('已收到最终全文')
  await running
  assert.equal(harness.state.generationText, '已收到最终全文')
  assert.equal(harness.calls.unlisten, 1)
  assert.equal(harness.calls.finish, 1)
  harness.emit({ taskId: 'test-task', delta: '迟到内容' })
  assert.equal(harness.state.generationText, '已收到最终全文')
})

test('cancelling while loading desktop credentials never invokes generation', async () => {
  let releaseSecret
  const secret = new Promise(resolve => { releaseSecret = resolve })
  const harness = desktopGenerationHarness({ secret: () => secret })
  const running = harness.run()
  harness.state.generationAbortController.abort()
  harness.state.isGenerating = false
  releaseSecret('mock-only')
  await running
  assert.equal(harness.calls.invoke, 0)
  assert.equal(harness.calls.unlisten, 1)
  assert.equal(harness.calls.finish, 0)
})

test('a desktop result arriving after stop does not overwrite the retained partial or report completion', async () => {
  const harness = desktopGenerationHarness()
  const running = harness.run()
  await harness.invoked
  harness.emit({ taskId: 'test-task', delta: '保留半段' })
  harness.state.generationAbortController.abort()
  harness.state.isGenerating = false
  harness.complete('迟到的全部结果')
  await running
  assert.equal(harness.state.generationText, '保留半段')
  assert.equal(harness.calls.finish, 0)
  assert.equal(harness.calls.unlisten, 1)
})
