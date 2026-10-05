const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUTS = { firstChunkMs: 120000, idleMs: 45000, totalMs: 600000 }

export function validateProviderBaseUrl(kind, value) {
  if (!['openai-compatible', 'ollama'].includes(kind)) throw new Error('不支持的连接类型')
  let url
  try { url = new URL(value.trim()) }
  catch { throw new Error('执行端地址格式无效') }
  if (url.username || url.password || url.href.includes('?') || url.href.includes('#')) throw new Error('执行端地址不能包含凭据、查询参数或片段')
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if (kind === 'ollama') {
    if (url.protocol !== 'http:' || !loopback) throw new Error('Ollama 连接只允许本机 HTTP 地址')
  } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('模型 API 必须使用 HTTPS；本机回环地址可使用 HTTP')
  }
  return url
}

export function providerEndpointUrl(kind, baseUrl, suffix) {
  const base = validateProviderBaseUrl(kind, baseUrl)
  return `${base.href.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

function cancelledError() {
  const error = new Error('生成已取消')
  error.name = 'AbortError'
  return error
}

function timeoutError(message) {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

/** Fetch only through response headers; consumeProviderStream owns body deadlines. */
export function fetchProviderResponse(url, options = {}, timeoutMs = 120000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('生成超时配置无效'))
  const externalSignal = options.signal
  if (externalSignal?.aborted) return Promise.reject(cancelledError())
  const controller = new AbortController()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, response) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(response)
    }
    const abort = error => {
      if (settled) return
      controller.abort(error)
      finish(error)
    }
    const onAbort = () => abort(cancelledError())
    const timer = setTimeout(() => abort(timeoutError('等待模型响应超时，请检查服务或换用较小模型')), timeoutMs)
    externalSignal?.addEventListener('abort', onAbort, { once: true })
    if (externalSignal?.aborted) { onAbort(); return }
    try {
      Promise.resolve(fetch(url, { ...options, redirect: 'error', signal: controller.signal })).then(
        response => {
          if (settled) { response.body?.cancel().catch(() => {}); return }
          finish(null, response)
        },
        error => finish(error)
      )
    } catch (error) { finish(error) }
  })
}

function readWithDeadline(reader, milliseconds, message, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelledError()); return }
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result)
    }
    const onAbort = () => finish(cancelledError())
    const timer = setTimeout(() => finish(timeoutError(message)), milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
    // Race with a user cancellation even for a mocked or custom ReadableStream.
    if (signal?.aborted) { onAbort(); return }
    reader.read().then(result => finish(null, result), error => {
      finish(error?.name === 'AbortError' ? error : new Error('读取执行端响应失败，当前片段尚未完成'))
    })
  })
}

function parsePayload(data) {
  let payload
  try { payload = JSON.parse(data) }
  catch { throw new Error('执行端返回了无法解析的数据，当前片段尚未完成') }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('执行端返回的数据格式无效')
  }
  if (payload.error !== undefined && payload.error !== null) {
    throw new Error('模型在生成过程中返回错误，请检查服务后重试')
  }
  return payload
}

function textContent(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Read a provider response with bounded memory, cancellation and explicit completion.
 * The caller controls the fetch/header timeout; this function times the response body.
 * Timeouts can be shortened by a caller (or tests) without changing provider parsing.
 */
export async function consumeProviderStream(response, { kind, onDelta = () => {}, signal, timeouts = {} } = {}) {
  if (!['openai-compatible', 'ollama'].includes(kind)) throw new Error('不支持的连接类型')
  if (!response.ok) throw new Error(`执行端返回 HTTP ${response.status}`)
  if (signal?.aborted) {
    response.body?.cancel().catch(() => {})
    throw cancelledError()
  }
  if (!response.body) throw new Error('执行端没有返回可读取的内容')
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts }
  if (Object.values(limits).some(value => !Number.isFinite(value) || value <= 0)) throw new Error('生成超时配置无效')
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    response.body.cancel().catch(() => {})
    throw new Error('执行端响应超过 2 MiB 限制')
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const isJson = contentType.includes('application/json') && !contentType.includes('ndjson') && !contentType.includes('jsonl')
  let format = isJson ? 'json' : kind === 'openai-compatible' ? 'sse' : 'ndjson'
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const startedAt = Date.now()
  let receivedBytes = 0
  let receivedAny = false
  let sniffed = false
  let buffer = ''
  let eventData = []
  let complete = false
  let output = ''

  const append = value => {
    const delta = textContent(value)
    if (!delta) return
    if (signal?.aborted) throw cancelledError()
    output += delta
    onDelta(delta)
  }

  const event = data => {
    if (format === 'sse' && data.trim() === '[DONE]') { complete = true; return }
    const payload = parsePayload(data)
    if (format === 'sse') {
      append(payload.choices?.[0]?.delta?.content ?? payload.delta)
      if (payload.choices?.[0]?.finish_reason != null) complete = true
    } else {
      append(payload.message?.content ?? payload.response)
      if (payload.done === true) complete = true
    }
  }

  const line = value => {
    if (complete) return
    if (format === 'sse') {
      if (!value) {
        if (eventData.length) {
          const data = eventData.join('\n')
          eventData = []
          event(data)
        }
      } else if (value.startsWith('data:')) {
        eventData.push(value.slice(5).replace(/^ /, ''))
      }
    } else if (value.trim()) event(value)
  }

  const processLines = eof => {
    // A CR at a chunk boundary may still be followed by LF in the next chunk.
    while (!complete) {
      const index = buffer.search(/[\r\n]/)
      if (index === -1) break
      if (buffer[index] === '\r' && index === buffer.length - 1 && !eof) break
      const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1
      const value = buffer.slice(0, index)
      buffer = buffer.slice(index + width)
      line(value)
    }
    if (eof && !complete) {
      if (buffer) { line(buffer); buffer = '' }
      if (format === 'sse' && eventData.length) line('')
    }
  }

  try {
    while (!complete) {
      const remaining = limits.totalMs - (Date.now() - startedAt)
      if (remaining <= 0) throw timeoutError('模型生成超过总时长限制，已停止本次请求')
      const idle = receivedAny ? limits.idleMs : limits.firstChunkMs
      const deadline = Math.min(remaining, idle)
      const message = remaining <= idle
        ? '模型生成超过总时长限制，已停止本次请求'
        : receivedAny
          ? '模型长时间没有返回新数据，已停止本次请求'
          : '等待模型内容超时，请检查服务或换用较小模型'
      const { value, done } = await readWithDeadline(reader, deadline, message, signal)
      if (signal?.aborted) throw cancelledError()
      if (value?.length) {
        receivedAny = true
        receivedBytes += value.byteLength
        if (receivedBytes > MAX_RESPONSE_BYTES) throw new Error('执行端响应超过 2 MiB 限制')
      }
      try { buffer += decoder.decode(value, { stream: !done }) }
      catch { throw new Error('执行端流包含无效文字编码，当前片段尚未完成') }
      if (!sniffed && buffer.trim()) {
        sniffed = true
        // A few compatible APIs return ordinary JSON without its content type.
        if (format === 'sse' && buffer.trimStart().startsWith('{')) format = 'json'
      }
      if (format !== 'json') processLines(done)
      if (done) break
    }
    if (format === 'json') {
      const payload = parsePayload(buffer)
      append(kind === 'openai-compatible' ? payload.choices?.[0]?.message?.content ?? payload.output_text : payload.message?.content ?? payload.response)
      if (kind === 'ollama' && payload.done === false) throw new Error('模型输出流提前结束，当前片段尚未完成，请重试')
      complete = true
    }
    if (!complete) throw new Error('模型输出流提前结束，当前片段尚未完成，请重试')
    if (!output.trim()) throw new Error('执行端返回了空内容')
    if (signal?.aborted) throw cancelledError()
    return output
  } finally {
    // Stop a provider that leaves the transport open after its terminal marker.
    // Do not await a custom stream's potentially unbounded cancel callback.
    reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
