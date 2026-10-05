import test from 'node:test'
import assert from 'node:assert/strict'
import { consumeProviderStream, fetchProviderResponse } from '../src/provider-stream.js'

const encoder = new TextEncoder()
const sse = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

function chunkResponse(chunks, contentType = 'text/event-stream') {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    }
  }), { headers: { 'content-type': contentType } })
}

test('OpenAI SSE preserves UTF-8 across every chunk boundary and emits exact deltas', async () => {
  const bytes = encoder.encode(`${sse('你好🌿')}${sse('世界')}data: [DONE]\n\n`)
  for (let boundary = 0; boundary < bytes.length; boundary++) {
    const deltas = []
    const output = await consumeProviderStream(chunkResponse([bytes.slice(0, boundary), bytes.slice(boundary)]), {
      kind: 'openai-compatible', onDelta: delta => deltas.push(delta)
    })
    assert.equal(output, '你好🌿世界')
    assert.deepEqual(deltas, ['你好🌿', '世界'])
  }
})

test('SSE supports multiline data, comments, CR-only lines, and EOF without newline', async () => {
  const stream = ': heartbeat\rdata: {"choices":\rdata: [{"delta":{"content":"正文"}}]}\r\rdata: [DONE]'
  assert.equal(await consumeProviderStream(chunkResponse([stream]), { kind: 'openai-compatible' }), '正文')
})

test('Ollama NDJSON handles byte-by-byte input and final done content', async () => {
  const bytes = encoder.encode('{"message":{"content":"正文"},"done":false}\n{"message":{"content":"结尾"},"done":true}')
  const deltas = []
  const output = await consumeProviderStream(chunkResponse([...bytes].map(byte => Uint8Array.of(byte)), 'application/x-ndjson'), {
    kind: 'ollama', onDelta: delta => deltas.push(delta)
  })
  assert.equal(output, '正文结尾')
  assert.deepEqual(deltas, ['正文', '结尾'])
})

test('normal JSON fallback supports both providers and ignored stream flags', async () => {
  for (const [kind, payload] of [
    ['openai-compatible', { choices: [{ message: { content: '完整正文\n' } }] }],
    ['ollama', { message: { content: '完整正文\n' } }]
  ]) {
    const deltas = []
    const response = chunkResponse([JSON.stringify(payload, null, 2)], 'application/json; charset=utf-8')
    assert.equal(await consumeProviderStream(response, { kind, onDelta: delta => deltas.push(delta) }), '完整正文\n')
    assert.deepEqual(deltas, ['完整正文\n'])
  }
  assert.equal(await consumeProviderStream(chunkResponse(['{"choices":[{"message":{"content":"JSON without type"}}]}'], ''), { kind: 'openai-compatible' }), 'JSON without type')
})

test('truncated SSE and NDJSON reject after retaining partial content', async () => {
  for (const [kind, stream, type] of [
    ['openai-compatible', sse('半段'), 'text/event-stream'],
    ['ollama', '{"message":{"content":"半段"},"done":false}\n', 'application/x-ndjson'],
    ['ollama', '{"message":{"content":"半段"},"done":false}', 'application/json']
  ]) {
    const deltas = []
    await assert.rejects(consumeProviderStream(chunkResponse([stream], type), { kind, onDelta: delta => deltas.push(delta) }), /提前结束/)
    assert.deepEqual(deltas, ['半段'])
  }
})

test('provider errors and malformed events are explicit, without leaking diagnostic data', async () => {
  const cases = [
    [sse('半段') + 'data: {"error":{"message":"private-upstream-detail"}}\n\n', 'text/event-stream', 'openai-compatible'],
    ['{"message":{"content":"半段"},"done":false}\n{"error":"private-upstream-detail"}\n', 'application/x-ndjson', 'ollama'],
    ['{"error":"private-upstream-detail"}', 'application/json', 'openai-compatible'],
    [sse('半段') + 'data: invalid-json\n\n', 'text/event-stream', 'openai-compatible'],
    ['{"message":{"content":"半段"},"done":false}\n{broken', 'application/x-ndjson', 'ollama']
  ]
  for (const [stream, type, kind] of cases) {
    await assert.rejects(consumeProviderStream(chunkResponse([stream], type), { kind }), error => {
      assert.doesNotMatch(error.message, /private-upstream-detail/)
      assert.match(error.message, /错误|无法解析/)
      return true
    })
  }
})

test('terminal marker closes the reader without waiting for a provider to close its socket', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DO'))
    },
    cancel() { cancelled = true }
  }), { headers: { 'content-type': 'text/event-stream' } })
  assert.equal(await consumeProviderStream(response, { kind: 'openai-compatible', timeouts: { idleMs: 20 } }), '完成')
  assert.equal(cancelled, true)
})

test('empty output and invalid UTF-8 are failures', async () => {
  await assert.rejects(consumeProviderStream(chunkResponse(['data: [DONE]\n\n']), { kind: 'openai-compatible' }), /空内容/)
  await assert.rejects(consumeProviderStream(chunkResponse(['{}'], 'application/json'), { kind: 'ollama' }), /空内容/)
  await assert.rejects(consumeProviderStream(chunkResponse([Uint8Array.of(0xff)]), { kind: 'openai-compatible' }), /文字编码/)
})

test('pre-cancelled and pending-reader cancellation both reject promptly', async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(consumeProviderStream(chunkResponse([sse('should not emit')]), { kind: 'openai-compatible', signal: cancelled.signal }), { name: 'AbortError' })
  const pending = new AbortController()
  let readerCancelled = false
  const response = new Response(new ReadableStream({ cancel() { readerCancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
  const result = consumeProviderStream(response, { kind: 'openai-compatible', signal: pending.signal })
  pending.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(readerCancelled, true)
})

test('cancelling inside delta callback preserves the partial and never reports success', async () => {
  const controller = new AbortController()
  const deltas = []
  await assert.rejects(consumeProviderStream(chunkResponse([`${sse('partial')}${sse('ignored')}data: [DONE]\n\n`]), {
    kind: 'openai-compatible', signal: controller.signal,
    onDelta: delta => { deltas.push(delta); controller.abort() }
  }), { name: 'AbortError' })
  assert.deepEqual(deltas, ['partial'])
})

test('first chunk, idle and total deadlines all cancel the response reader', async () => {
  for (const [mode, timeouts, expected] of [
    ['first', { firstChunkMs: 15 }, /等待模型内容超时/],
    ['idle', { idleMs: 15 }, /没有返回新数据/],
    ['total', { totalMs: 15, idleMs: 100 }, /总时长限制/]
  ]) {
    let cancelled = false
    const response = new Response(new ReadableStream({
      start(controller) { if (mode !== 'first') controller.enqueue(encoder.encode(sse('partial'))) },
      cancel() { cancelled = true }
    }), { headers: { 'content-type': 'text/event-stream' } })
    await assert.rejects(consumeProviderStream(response, { kind: 'openai-compatible', timeouts }), error => {
      assert.equal(error.name, 'TimeoutError')
      assert.match(error.message, expected)
      return true
    })
    assert.equal(cancelled, true)
  }
})

test('responses have a byte limit even without content-length', async () => {
  await assert.rejects(consumeProviderStream(chunkResponse(['x'.repeat(2 * 1024 * 1024 + 1)]), { kind: 'openai-compatible' }), /2 MiB/)
  let cancelled = false
  const declaredLarge = new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })
  await assert.rejects(consumeProviderStream(declaredLarge, { kind: 'openai-compatible' }), /2 MiB/)
  assert.equal(cancelled, true)
})

test('fetch headers preserve options and distinguish timeout from user cancellation', async t => {
  let captured
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    captured = options
    return new Promise(() => {})
  })
  const timed = fetchProviderResponse('https://mock.invalid/chat', { method: 'POST', body: 'mock-body' }, 15)
  await assert.rejects(timed, { name: 'TimeoutError' })
  assert.equal(captured.signal.aborted, true)
  assert.equal(captured.method, 'POST')
  assert.equal(captured.body, 'mock-body')
  assert.equal(captured.redirect, 'error')
  const user = new AbortController()
  const cancelled = fetchProviderResponse('https://mock.invalid/chat', { signal: user.signal })
  user.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.equal(captured.signal.aborted, true)
})

test('pre-cancelled fetch never sends a request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch') })
  const user = new AbortController()
  user.abort()
  await assert.rejects(fetchProviderResponse('https://mock.invalid/chat', { signal: user.signal }), { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 0)
})

test('header deadline and external listener end at headers; body reader owns subsequent cancellation', async t => {
  let fetchSignal
  let responseCancelled = false
  const body = new ReadableStream({ cancel() { responseCancelled = true } })
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    fetchSignal = options.signal
    return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
  })
  const user = new AbortController()
  const response = await fetchProviderResponse('https://mock.invalid/chat', { signal: user.signal }, 15)
  const output = consumeProviderStream(response, { kind: 'openai-compatible', signal: user.signal })
  user.abort()
  await assert.rejects(output, { name: 'AbortError' })
  assert.equal(fetchSignal.aborted, false)
  assert.equal(responseCancelled, true)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(fetchSignal.aborted, false)
})

test('a late response after the header timeout is cancelled', async t => {
  let deliverResponse
  let cancelled = false
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { deliverResponse = resolve }))
  await assert.rejects(fetchProviderResponse('https://mock.invalid/chat', {}, 15), { name: 'TimeoutError' })
  deliverResponse(new Response(new ReadableStream({ cancel() { cancelled = true } })))
  await Promise.resolve()
  assert.equal(cancelled, true)
})
