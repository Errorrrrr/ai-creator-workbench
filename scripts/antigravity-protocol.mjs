export const ANTIGRAVITY_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--print-timeout', '110s']

export function antigravityInput(prompt) {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`
}

export function sanitizeCliError(diagnostics) {
  if (/user location is not supported|unsupported_country_region_territory|country is not supported|region is not supported/i.test(diagnostics)) return 'CLI 上游服务不支持当前账号或请求所在地区；请使用可用的其他执行端'
  if (/login|log in|auth|api[ _-]?key|credential|unauthorized/i.test(diagnostics)) return 'CLI 尚未登录或授权已失效'
  if (/avx|architecture|bad cpu|exec format/i.test(diagnostics)) return 'CLI 与当前芯片架构不兼容'
  if (/rate.?limit|quota|too many requests/i.test(diagnostics)) return 'CLI 上游服务暂时受限'
  if (/network|resolve|dns|connect|socket|timeout/i.test(diagnostics)) return 'CLI 无法连接上游服务'
  return 'CLI 运行失败，请在终端检查登录和版本'
}

export function antigravityExecutionError(diagnostics, output) {
  let category = sanitizeCliError(diagnostics)
  for (const line of output.split(/\r?\n/)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event?.event !== 'result' || event.result?.status === 'SUCCESS') continue
    const error = event.result?.error
    const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
    const classified = sanitizeCliError(message)
    if (classified !== sanitizeCliError('')) category = classified
  }
  return category
}

export function parseAntigravityOutput(output) {
  let result
  for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
    let event
    try { event = JSON.parse(line) } catch { throw new Error('Antigravity 返回了无效的流数据') }
    if (event?.event === 'result') {
      if (result !== undefined) throw new Error('Antigravity 返回了多个结果，已停止采纳')
      result = event.result
    }
  }
  if (!result) throw new Error('Antigravity 未返回完整结果')
  if (result.status !== 'SUCCESS') throw new Error(antigravityExecutionError('', output))
  if (typeof result.response !== 'string' || !result.response.trim()) throw new Error('Antigravity 未返回内容')
  return result.response.trim()
}
