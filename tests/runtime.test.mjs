import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import {
  createCliPrompt, handleCliGenerateRequest, handleRequest, isAllowedHost,
  isAllowedStaticPath, isLoopbackUrl, readJsonBody, runCliProcess
} from '../scripts/dev-server.mjs'
import { antigravityInput, parseAntigravityOutput } from '../scripts/antigravity-protocol.mjs'

function responseMock() {
  const response = new EventEmitter()
  Object.assign(response, { destroyed: false, writableEnded: false, headersSent: false })
  response.writeHead = code => { response.statusCode = code; response.headersSent = true }
  response.end = body => { response.body = body; response.writableEnded = true }
  return response
}

function requestMock() {
  const request = new EventEmitter()
  request.headers = { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }
  return request
}

test('CLI preserves the final instruction beyond 24000 characters', () => {
  const instruction = '结尾必须保留角色名字，不得添加对白'
  const content = `${'前'.repeat(24000)}\n${instruction}`
  assert.ok(createCliPrompt([{ role: 'user', content }]).endsWith(instruction))
})

test('CLI rejects oversized or malformed messages instead of silently trimming', () => {
  assert.throws(() => createCliPrompt([{ role: 'user', content: '汉'.repeat(33000) }]), { statusCode: 413 })
  assert.throws(() => createCliPrompt(Array.from({ length: 13 }, () => ({ role: 'user', content: 'a' }))), { statusCode: 400 })
  assert.throws(() => createCliPrompt([{ role: 'invalid', content: 'a' }]), { statusCode: 400 })
})

test('Host validation accepts exact local origins and rejects rebinding targets', () => {
  for (const host of ['127.0.0.1:4173', 'localhost:4173', '[::1]:4173']) assert.equal(isAllowedHost(host), true, host)
  for (const host of ['attacker.example:4173', 'localhost.attacker:4173', 'localhost:4174', 'localhost', 'localhost:4173/path', 'user@localhost:4173', undefined]) assert.equal(isAllowedHost(host), false, host)
})

test('Ollama URL validation accepts IPv6/custom ports without accepting remote or credential URLs', () => {
  for (const url of ['http://[::1]:11435', 'http://localhost:12345/api-prefix', 'http://127.0.0.1:11434']) assert.equal(isLoopbackUrl(new URL(url)), true)
  for (const url of ['https://localhost:11434', 'http://example.com', 'http://user@localhost', 'http://localhost?secret=x', 'http://localhost#x']) assert.equal(isLoopbackUrl(new URL(url)), false)
})

test('static allowlist excludes git, env, scripts, reports and nested/dot files', async () => {
  for (const path of ['/.git/HEAD', '/.env', '/src/.secret.js', '/src/nested/test.js', '/package.json', '/scripts/dev-server.mjs', '/specs/report.md', '/src/../.env']) assert.equal(isAllowedStaticPath(path), false)
  for (const path of ['/index.html', '/src/app.js', '/src/styles.css', '/assets/app-icon.svg']) assert.equal(isAllowedStaticPath(path), true)
  for (const url of ['/.git/HEAD', '/%2egit/HEAD', '/src/%2e%2e/%2egit/HEAD']) {
    const response = responseMock()
    await handleRequest({ method: 'GET', url, headers: { host: '127.0.0.1:4173' } }, response)
    assert.equal(response.statusCode, 403, url)
  }
  const response = responseMock()
  await handleRequest({ method: 'GET', url: '/index.html', headers: { host: 'attacker.example:4173' } }, response)
  assert.equal(response.statusCode, 403)
})

test('disconnect during executable lookup never launches CLI and releases the task lock', async () => {
  let finishLookup
  let enteredLookup
  let launches = 0
  let lookupSignal
  const lookupStarted = new Promise(resolve => { enteredLookup = resolve })
  const request = requestMock()
  const response = responseMock()
  const running = handleCliGenerateRequest(request, response, {
    findExecutable: (_command, signal) => {
      lookupSignal = signal
      enteredLookup()
      return new Promise(resolve => { finishLookup = resolve })
    },
    runCliProcess: async () => { launches += 1; return 'must not execute' }
  })
  request.emit('data', Buffer.from(JSON.stringify({ driverId: 'antigravity', allowUserProfile: true, messages: [{ role: 'user', content: 'mock only' }] })))
  request.emit('end')
  await lookupStarted
  response.destroyed = true
  response.emit('close')
  assert.equal(lookupSignal.aborted, true)
  finishLookup('/mock/never-executed')
  await running
  assert.equal(launches, 0)
  assert.equal(response.listenerCount('close'), 0)
  assert.equal(request.listenerCount('aborted'), 0)
  const nextRequest = requestMock()
  const nextResponse = responseMock()
  const next = handleCliGenerateRequest(nextRequest, nextResponse)
  nextRequest.emit('data', Buffer.from('{}'))
  nextRequest.emit('end')
  await next
  assert.equal(nextResponse.statusCode, 400)
})

test('disconnect while reading request body settles promptly without launching', async () => {
  const request = requestMock()
  const response = responseMock()
  let lookups = 0
  const running = handleCliGenerateRequest(request, response, { findExecutable: async () => { lookups++; return null } })
  response.destroyed = true
  response.emit('close')
  await running
  assert.equal(lookups, 0)
  assert.equal(request.listenerCount('data'), 0)
})

test('body parser rejects oversized input immediately and honors cancellation', async () => {
  const request = requestMock()
  const reading = readJsonBody(request, 4)
  request.emit('data', Buffer.from('12345'))
  await assert.rejects(reading, { statusCode: 413 })
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(readJsonBody(requestMock(), 4, aborted.signal), { statusCode: 499 })
})

test('process cancellation before spawn rejects without invoking executable', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runCliProcess('/this/path/must/not/be/executed', [], '', { signal: controller.signal }), { statusCode: 499 })
})

test('process cancellation and deadline kill a real isolated mock child', async () => {
  const controller = new AbortController()
  const running = runCliProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], '', {
    driverId: 'claude', cwd: tmpdir(), signal: controller.signal, timeoutMs: 2000
  })
  controller.abort()
  await assert.rejects(running, { statusCode: 499 })
  await assert.rejects(runCliProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], '', {
    driverId: 'claude', cwd: tmpdir(), timeoutMs: 30
  }), { statusCode: 504 })
})

test('Antigravity protocol accepts one successful result and rejects ambiguous/malformed output', () => {
  const success = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '正文' } })
  assert.equal(JSON.parse(antigravityInput('正文')).message.content, '正文')
  assert.equal(parseAntigravityOutput(`${JSON.stringify({ event: 'progress' })}\n${success}`), '正文')
  assert.throws(() => parseAntigravityOutput(`${success}\n${success}`), /多个结果/)
  assert.throws(() => parseAntigravityOutput('not-json'), /无效/)
  assert.throws(() => parseAntigravityOutput('{"event":"progress"}'), /完整结果/)
})
