export const ANTIGRAVITY_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--print-timeout', '110s']

export function antigravityInput(prompt) {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`
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
  if (result.status !== 'SUCCESS') throw new Error('Antigravity 任务失败，请在终端检查登录、额度与权限配置')
  if (typeof result.response !== 'string' || !result.response.trim()) throw new Error('Antigravity 未返回内容')
  return result.response.trim()
}
