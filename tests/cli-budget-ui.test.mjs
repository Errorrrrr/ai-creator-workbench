import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source)
  assert.ok(match, `${name} exists`)
  const body = source.slice(match.index), end = /^\}/m.exec(body)
  return body.slice(0, end.index + 1)
}
function deferred() {
  let resolve
  const promise = new Promise(accept => { resolve = accept })
  return { promise, resolve }
}
function harness({ desktop = false, consent = Promise.resolve(true), payload = { output: '生成结果' }, ok = true, responseGate = null } = {}) {
  const state = { activeGenerationId: 'task', isGenerating: true, generationText: '', generationContext: { purpose: 'asset-extraction', messages: [{ role: 'user', content: '原始剧本' }] } }
  const calls = { requests: [], errors: [], finished: 0, released: [] }
  const elements = { candidateContent: { textContent: '' }, assistantConversation: { scrollTop: 0, scrollHeight: 1 } }
  const env = {
    state, elements, AbortController, isDesktopRuntime: desktop, window: { __TAURI__: {} },
    mediaWorkbench: { releaseStoryboardTask: id => calls.released.push(id) },
    confirmCliGeneration: () => consent, connectionSecret: async () => null, renderConnections() {}, scheduleCandidateSave() {}, showToast() {},
    readableError: error => error.message, persistWorkspace: async () => {},
    finishGeneration: async () => { calls.finished++; state.isGenerating = false },
    failGeneration: error => { calls.errors.push(error); state.isGenerating = false },
    invokeDesktop: async (command, { request }) => { assert.equal(command, 'generate_text'); calls.requests.push(request); if (responseGate) await responseGate; return payload },
    fetch: async (url, options) => { assert.equal(url, '/api/runtime/cli/generate'); calls.requests.push(JSON.parse(options.body)); if (responseGate) await responseGate; return { ok, status: 502, json: async () => payload } },
  }
  vm.createContext(env)
  vm.runInContext(['buildGenerationMessages', 'appendGenerationDelta', 'generateWithConnection'].map(productionFunction).join('\n'), env)
  return { state, calls, env, run: () => env.generateWithConnection({ id: 'agy', kind: 'cli', driverId: 'antigravity', name: 'Antigravity' }, '提取设定', 'task') }
}

test('桌面和浏览器都按提交时的提取任务传递purpose与正文，不受异步确认期间上下文修改影响', async () => {
  for (const desktop of [false, true]) {
    const consent = deferred(), h = harness({ desktop, consent: consent.promise })
    const pending = h.run()
    assert.equal(h.state.generationInFlight, 'task'); assert.equal(h.calls.requests.length, 0)
    h.state.generationContext.purpose = 'text'; h.state.generationContext.messages[0].content = '后来编辑的剧本'
    consent.resolve(true); await pending
    assert.equal(h.calls.requests.length, 1); assert.equal(h.calls.requests[0].purpose, 'asset-extraction')
    assert.equal(h.calls.requests[0].messages[0].content, '原始剧本')
    assert.equal(h.calls.finished, 1); assert.equal(h.state.generationInFlight, null)
  }
})

test('停止确认中的任务不发请求，已提交任务在执行端响应前持续持有锁', async () => {
  const consent = deferred(), cancelled = harness({ consent: consent.promise })
  const pending = cancelled.run(); cancelled.state.generationAbortController.abort(); consent.resolve(false); await pending
  assert.equal(cancelled.calls.requests.length, 0); assert.equal(cancelled.state.generationInFlight, null)
  const response = deferred(), running = harness({ responseGate: response.promise })
  const active = running.run(); await Promise.resolve()
  running.state.isGenerating = false
  assert.equal(running.state.generationInFlight, 'task')
  response.resolve(); await active
  assert.equal(running.state.generationInFlight, null); assert.equal(running.calls.requests.length, 1)
})

test('浏览器CLI错误保留服务端具体原因，兼容字符串和message格式且不自动重试', async () => {
  for (const error of ['Antigravity 处理超过 10 分钟', { message: '代理连接中断' }, null]) {
    const h = harness({ ok: false, payload: { error } }); await h.run()
    assert.deepEqual(h.calls.errors, [typeof error === 'string' ? error : error?.message || 'CLI 运行桥返回 HTTP 502'])
    assert.equal(h.calls.requests.length, 1); assert.equal(h.calls.finished, 0); assert.equal(h.state.generationInFlight, null)
  }
})
