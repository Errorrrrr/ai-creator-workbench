import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ANTIGRAVITY_ARGS, antigravityInput, parseAntigravityOutput, sanitizeCliError, antigravityExecutionError } from './antigravity-protocol.mjs'
import { checkForUpdates } from '../src/updates.js'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, '..')
const appVersion = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version
const port = Number.parseInt(process.env.PORT || '4173', 10)
const execFileAsync = promisify(execFile)
const cliRuntimeRoot = join(tmpdir(), 'ai-creator-workbench-runtime')
let cliTaskRunning = false
const CLAUDE_LOGIN_ARGS = ['--print', '--output-format', 'text', '--permission-mode', 'dontAsk', '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--no-chrome', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}']

const cliDrivers = [
  { id: 'antigravity', name: 'Antigravity CLI', command: 'agy', versionArgs: ['--help'], generateArgs: ANTIGRAVITY_ARGS },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['exec', '--help'],
    generateArgs: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--color', 'never', '--json', '-c', 'approval_policy="never"']
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    versionArgs: ['--help'],
    generateArgs: ['--print', '--bare', '--output-format', 'text', '--permission-mode', 'dontAsk', '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--no-chrome'],
    requiresEnvironmentCredential: false
  },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', versionArgs: ['--version'] }
]

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  })
  response.end(JSON.stringify(payload))
}

async function findExecutable(command, signal) {
  signal?.throwIfAborted()
  const locator = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which'
  try {
    const { stdout } = await execFileAsync(locator, [command], {
      timeout: 2500,
      signal,
      maxBuffer: 32 * 1024,
      windowsHide: true
    })
    return stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || null
  } catch {
    return null
  }
}

async function inspectExecutableCompatibility(executablePath) {
  if (process.platform !== 'darwin') return { binaryArchitecture: null, compatibility: 'unknown' }
  try {
    const { stdout } = await execFileAsync('/usr/bin/file', ['-Lb', executablePath], {
      timeout: 2000,
      maxBuffer: 16 * 1024,
      windowsHide: true
    })
    const description = stdout.toLowerCase()
    const hasArm64 = description.includes('arm64') || description.includes('aarch64')
    const hasX64 = description.includes('x86_64')
    if (process.arch === 'arm64' && hasX64 && !hasArm64) return { binaryArchitecture: 'x86_64', compatibility: 'translated' }
    if (hasArm64) return { binaryArchitecture: 'arm64', compatibility: 'native' }
    if (hasX64) return { binaryArchitecture: 'x86_64', compatibility: process.arch === 'x64' ? 'native' : 'unknown' }
    return { binaryArchitecture: null, compatibility: 'script' }
  } catch {
    return { binaryArchitecture: null, compatibility: 'unknown' }
  }
}

function getCliExecutionStatus(driver) {
  if (!driver.generateArgs) return 'disabled'
  if (driver.requiresEnvironmentCredential && !process.env.ANTHROPIC_API_KEY) {
    return 'credential_required'
  }
  return 'available'
}

async function inspectCli(driver) {
  const executionStatus = getCliExecutionStatus(driver)
  const executablePath = await findExecutable(driver.command)
  if (!executablePath) {
    return {
      id: driver.id,
      name: driver.name,
      status: 'not_found',
      executablePath: null,
      version: null,
      canGenerate: executionStatus === 'available',
      executionStatus,
      binaryArchitecture: null,
      compatibility: 'unknown'
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(executablePath, driver.versionArgs, {
      timeout: 3500,
      maxBuffer: 64 * 1024,
      windowsHide: true
    })
    const help = `${stdout || ''}\n${stderr || ''}`
    const requiredFlags = driver.id === 'codex' ? ['--sandbox', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-last-message'] : driver.id === 'claude' ? ['--bare', '--tools', '--setting-sources', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'] : []
    if (!requiredFlags.every(flag => help.includes(flag))) throw new Error('CLI 必需参数不受支持')
    if (driver.id === 'antigravity' && !['--input-format', '--output-format', '--sandbox', '--mode', '--disable-slash-commands', '--print-timeout'].every(flag => help.includes(flag))) throw new Error('agy headless flags unavailable')
    const version = ['antigravity', 'codex', 'claude'].includes(driver.id) ? '非交互调用参数已检测' : help.trim().split(/\r?\n/)[0].slice(0, 160)
    const compatibility = await inspectExecutableCompatibility(executablePath)
    return {
      id: driver.id,
      name: driver.name,
      status: 'ready',
      executablePath,
      version: version || '已安装',
      canGenerate: executionStatus === 'available',
      executionStatus,
      ...compatibility
    }
  } catch (error) {
    return {
      id: driver.id,
      name: driver.name,
      status: error?.killed ? 'timeout' : 'error',
      executablePath,
      version: null,
      canGenerate: executionStatus === 'available',
      executionStatus,
      binaryArchitecture: null,
      compatibility: 'unknown'
    }
  }
}

export function readJsonBody(request, maxBytes = 128 * 1024, signal) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAbort)
      signal?.removeEventListener('abort', onAbort)
      if (error) { request.resume?.(); rejectBody(error) } else resolveBody(value)
    }
    const onError = error => finish(error)
    const onAbort = () => finish(cancelledError())
    const onData = chunk => {
      size += chunk.length
      if (size > maxBytes) { finish(Object.assign(new Error('请求内容过大'), { statusCode: 413 })); return }
      chunks.push(chunk)
    }
    const onEnd = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { finish(Object.assign(new Error('请求 JSON 格式无效'), { statusCode: 400 })) }
    }
    const timer = setTimeout(() => finish(Object.assign(new Error('接收请求超时'), { statusCode: 408 })), 10000)
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    // An aborted IncomingMessage can emit ECONNRESET after its aborted event.
    request.once('close', () => request.off('error', onError))
    request.once('aborted', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted || request.aborted) onAbort()
  })
}

export function createCliPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 12) {
    throw Object.assign(new Error('生成上下文数量无效'), { statusCode: 400 })
  }
  let totalBytes = 0
  const content = messages.map((message) => {
    if (!['system', 'user', 'assistant'].includes(message?.role) || typeof message?.content !== 'string') {
      throw Object.assign(new Error('生成上下文格式无效'), { statusCode: 400 })
    }
    const role = message.role === 'system' ? '系统约束' : message.role === 'assistant' ? '助手内容' : '用户内容'
    const value = message.content
    totalBytes += Buffer.byteLength(value, 'utf8')
    return value.trim() ? `## ${role}\n${value}` : ''
  }).filter(Boolean).join('\n\n')
  if (!content) throw Object.assign(new Error('缺少可执行的创作请求'), { statusCode: 400 })
  if (totalBytes > 96 * 1024) throw Object.assign(new Error('发送给 CLI 的上下文超过 96 KiB，请缩短正文或减少知识引用后重试；本次未调用 CLI'), { statusCode: 413 })
  return `你正在执行一次纯文本创作任务。不要调用工具、不要读取本机文件、不要修改环境；只输出可供用户审阅的中文候选内容。\n\n${content}`
}

function cancelledError() {
  return Object.assign(new Error('CLI 生成已取消'), { statusCode: 499 })
}

export function isLoopbackUrl(url) {
  return url.protocol === 'http:' && (['localhost', '[::1]'].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
    && !url.username && !url.password && !url.href.includes('?') && !url.href.includes('#')
}

export function isAllowedHost(host, expectedPort = port) {
  if (typeof host !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(host)) return false
  try {
    const url = new URL(`http://${host}`)
    return isLoopbackUrl(url) && Number(url.port || 80) === expectedPort
  } catch { return false }
}

function isAllowedOrigin(origin) {
  if (!origin) return true
  try {
    const url = new URL(origin)
    return isLoopbackUrl(url) && url.pathname === '/' && isAllowedHost(url.host)
  } catch { return false }
}

function buildCliEnvironment(driverId, isolatedHome) {
  const commonNames = ['USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']
  const authNames = driverId === 'claude'
    ? ['ANTHROPIC_API_KEY']
    : ['OPENAI_API_KEY']
  if (['antigravity', 'codex', 'claude-login'].includes(driverId)) {
    if (!process.env.HOME) throw new Error('无法定位 CLI 用户目录')
    const extra = driverId === 'codex' ? ['CODEX_HOME'] : driverId === 'claude-login' ? ['CLAUDE_CONFIG_DIR'] : []
    return { ...Object.fromEntries([...commonNames, ...extra, 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]])), ...(driverId === 'claude-login' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}) }
  }
  return {
    ...Object.fromEntries([...commonNames, ...authNames]
    .filter((name) => typeof process.env[name] === 'string')
      .map((name) => [name, process.env[name]])),
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache')
  }
}

function codexDiagnosticMessage(message) {
  for (const [pattern, detail] of [
    [/unexpected argument|unrecognized option|unknown option/i, '命令行选项'],
    [/invalid type/i, '字段类型'],
    [/unknown field/i, '未知字段'],
    [/missing field/i, '缺少字段'],
    [/unknown method/i, '未知方法'],
    [/invalid params|invalid parameter/i, '请求参数']
  ]) {
    if (pattern.test(message)) return `CLI 协议或参数不兼容（${detail}）；未自动重试`
  }
  if (/not supported when using codex with a chatgpt account/i.test(message)) {
    return '当前 Codex CLI 的 ChatGPT 登录方式不支持所选规划模型；请在现有 CLI 中确认可用模型。未自动切换模型或计费路径'
  }
  if (/model_not_found|unsupported_model/i.test(message) || message.split('\n').some(line => /model/i.test(line) && /not supported|unsupported|not available|unavailable|does not exist|not found|do not have access|not have access|not permitted/i.test(line))) {
    return 'CLI 返回模型拒绝相关错误；未切换模型或计费路径'
  }
  return message.trim() ? sanitizeCliError(message) : 'CLI 未提供可分类的退出诊断；具体原因未确认'
}

function codexExecutionError(diagnostics, events, code, terminationSignal, args) {
  let category = codexDiagnosticMessage(diagnostics), phase = 'CLI 轮次阶段未确认', httpStatus = null
  for (const line of events.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    let message
    if (event.type === 'thread.started') phase = 'CLI 已报告线程创建'
    else if (event.type === 'turn.started') phase = 'CLI 已报告轮次开始'
    else if (event.type === 'turn.completed') phase = 'CLI 已报告轮次完成后退出异常'
    else if (event.type === 'turn.failed') { phase = 'CLI 已报告轮次失败'; message = event.error?.message }
    else if (event.type === 'error') message = event.message
    // Never inspect agent/tool item content or return original event text.
    if (typeof message === 'string' && message.trim()) {
      const classified = codexDiagnosticMessage(message)
      if (classified !== sanitizeCliError('')) {
        category = classified
        httpStatus = null
        try {
          const error = JSON.parse(message)
          if (error?.type === 'error' && error.error && typeof error.error === 'object' && !Array.isArray(error.error) && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) httpStatus = error.status
        } catch { /* Only a known serialized upstream envelope has an HTTP status. */ }
      }
    }
  }
  const exit = Number.isInteger(code) ? `退出码 ${code}` : terminationSignal ? '信号终止' : '退出码未知'
  const model = args[args.indexOf('--model') + 1]
  const modelContext = args.includes('--model') && typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) ? `；请求规划模型：${model}` : ''
  return `Codex 文字执行失败（${exit}；${phase}）：${category}${httpStatus ? `；CLI 报告上游 HTTP ${httpStatus}` : ''}${modelContext}`
}

// Ask the installed CLI to parse its own config. This connection never creates a thread/turn.
// Only the validated model ID crosses into the isolated generation process.
export function readCodexConfiguredModel(executablePath, cwd, signal) {
  return new Promise((resolveModel, rejectModel) => {
    if (signal?.aborted) { rejectModel(cancelledError()); return }
    const args = ['app-server', '--listen', 'stdio://']
    for (const feature of ['hooks', 'plugins', 'apps', 'memories', 'multi_agent', 'shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'workspace_dependencies', 'code_mode', 'code_mode_only']) args.push('--disable', feature)
    for (const setting of ['approval_policy="never"', 'sandbox_mode="workspace-write"', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'project_doc_max_bytes=0', 'notify=[]', 'web_search="disabled"']) args.push('-c', setting)
    const child = spawn(executablePath, args, {
      cwd,
      env: { ...buildCliEnvironment('codex', cwd), TMPDIR: cwd, NO_COLOR: '1', TERM: 'dumb' },
      shell: false, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    let settled = false
    let buffer = ''
    let outputBytes = 0
    const finish = (error, model) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (child.pid) {
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { child.kill('SIGKILL') }
      }
      if (error) rejectModel(error)
      else resolveModel(model)
    }
    const readError = () => new Error('无法读取现有 Codex CLI 模型设置；未提交生成')
    const onAbort = () => finish(cancelledError())
    const timer = setTimeout(() => finish(new Error('读取现有 Codex CLI 模型设置超时；未提交生成')), 8000)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', () => finish(readError()))
    child.on('close', () => { if (!settled) finish(readError()) })
    child.stdin.on('error', () => finish(readError()))
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (settled) return
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 2 * 1024 * 1024) { finish(readError()); return }
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0 || settled) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { finish(readError()); return }
        if (message.method && message.id !== undefined) {
          send({ id: message.id, error: { code: -32601, message: 'This host only reads model settings.' } })
          continue
        }
        if (message.id === 1) {
          if (message.error || !message.result) { finish(readError()); return }
          send({ method: 'initialized', params: {} })
          send({ id: 2, method: 'config/read', params: { includeLayers: false, cwd } })
        } else if (message.id === 2) {
          const config = message.result?.config
          if (message.error || !config || typeof config !== 'object' || Array.isArray(config)) { finish(readError()); return }
          if (config.model_provider != null && config.model_provider !== 'openai') {
            finish(new Error('现有 Codex CLI 配置了自定义供应商；当前接入不会继承其计费路径或自动换服务'))
            return
          }
          if (config.model == null) finish(null, null)
          else if (typeof config.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(config.model)) finish(null, config.model)
          else finish(new Error('现有 Codex CLI 模型设置无效；未回退到其他模型'))
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ai_creator_workbench_settings', version: appVersion } } })
    if (signal?.aborted) onAbort()
  })
}

export function runCliProcess(executablePath, args, input, { driverId, cwd, signal, timeoutMs = 120000, maxOutputBytes = 1024 * 1024 } = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    if (signal?.aborted) { rejectProcess(cancelledError()); return }
    const child = spawn(executablePath, args, {
      cwd,
      env: { ...buildCliEnvironment(driverId, cwd), NO_COLOR: '1', TERM: 'dumb' },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let settled = false
    let timedOut = false

    const stop = () => {
      if (settled) return
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
        return
      }
      child.kill('SIGTERM')
      const forceTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 800)
      forceTimer.unref?.()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const onAbort = () => stop()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    const capture = (target) => (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        stop()
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', capture(stdout))
    child.stderr.on('data', capture(stderr))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      rejectProcess(error)
    })
    child.on('close', (code, terminationSignal) => {
      if (settled) return
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* No remaining descendants. */ }
      }
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      const output = Buffer.concat(stdout).toString('utf8').trim()
      const diagnostics = Buffer.concat(stderr).toString('utf8').trim()
      if (timedOut) {
        rejectProcess(Object.assign(new Error('CLI 生成超时'), { statusCode: 504 }))
      } else if (signal?.aborted) {
        rejectProcess(Object.assign(new Error('CLI 生成已取消'), { statusCode: 499 }))
      } else if (outputBytes > maxOutputBytes) {
        rejectProcess(Object.assign(new Error('CLI 输出超过限制'), { statusCode: 413 }))
      } else if (code !== 0) {
        const message = driverId === 'codex' ? codexExecutionError(diagnostics, output, code, terminationSignal, args) : driverId === 'antigravity' ? antigravityExecutionError(diagnostics, output) : sanitizeCliError(diagnostics)
        rejectProcess(Object.assign(new Error(message), { statusCode: 502 }))
      } else if (!output && driverId !== 'codex') {
        rejectProcess(Object.assign(new Error('CLI 未返回内容'), { statusCode: 502 }))
      } else {
        resolveProcess(output)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export async function handleCliGenerateRequest(request, response, dependencies = {}) {
  const lookupExecutable = dependencies.findExecutable || findExecutable
  const executeCli = dependencies.runCliProcess || runCliProcess
  const originAllowed = isAllowedOrigin(request.headers.origin)
  if (!originAllowed) {
    sendJson(response, 403, { error: '拒绝来自其他页面的 CLI 执行请求' })
    return
  }
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
    sendJson(response, 415, { error: '仅接受 JSON 请求' })
    return
  }
  if (cliTaskRunning) {
    sendJson(response, 409, { error: '已有一个 CLI 创作任务在运行' })
    return
  }

  cliTaskRunning = true
  let runDirectory = null
  const controller = new AbortController()
  const closeHandler = () => { if (!response.writableEnded) controller.abort() }
  const abortedHandler = () => controller.abort()
  response.on('close', closeHandler)
  request.on('aborted', abortedHandler)
  const assertConnected = () => {
    if (response.destroyed || request.aborted || controller.signal.aborted) throw cancelledError()
  }
  try {
    assertConnected()
    const payload = await readJsonBody(request, 128 * 1024, controller.signal)
    assertConnected()
    if (['antigravity', 'codex', 'claude'].includes(payload.driverId) && payload.allowUserProfile !== true) throw Object.assign(new Error('请先确认本次 CLI 调用的登录态与上下文使用'), { statusCode: 403 })
    const driver = cliDrivers.find((item) => item.id === payload.driverId && item.generateArgs)
    if (!driver) throw Object.assign(new Error('该 CLI 未在受控驱动列表中'), { statusCode: 400 })
    if (driver.id === 'codex' && payload.model !== undefined && (typeof payload.model !== 'string' || (payload.model.trim() && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(payload.model.trim())))) throw Object.assign(new Error('Codex 规划模型 ID 无效；未提交生成'), { statusCode: 400 })
    if (getCliExecutionStatus(driver) !== 'available') {
      throw Object.assign(new Error('CLI 安全模式需要通过环境变量显式提供模型凭据'), { statusCode: 401 })
    }
    const prompt = createCliPrompt(payload.messages)
    const executablePath = await lookupExecutable(driver.command, controller.signal)
    assertConnected()
    if (!executablePath) throw Object.assign(new Error(`${driver.name} 未安装或不在 PATH 中`), { statusCode: 404 })
    mkdirSync(cliRuntimeRoot, { recursive: true, mode: 0o700 })
    runDirectory = mkdtempSync(join(cliRuntimeRoot, 'run-'))
    const claudeLogin = driver.id === 'claude' && !process.env.ANTHROPIC_API_KEY
    const answerPath = join(runDirectory, 'answer.txt')
    const args = driver.id === 'codex' ? [...driver.generateArgs, '--output-last-message', answerPath] : claudeLogin ? CLAUDE_LOGIN_ARGS : driver.generateArgs
    if (driver.id === 'codex') {
      const model = payload.model?.trim() || await (dependencies.readCodexConfiguredModel || readCodexConfiguredModel)(executablePath, runDirectory, controller.signal)
      if (model) args.push('--model', model)
    }
    assertConnected()
    let output = await executeCli(executablePath, args, driver.id === 'antigravity' ? antigravityInput(prompt) : prompt, {
      cwd: runDirectory,
      driverId: claudeLogin ? 'claude-login' : driver.id,
      signal: controller.signal
    })
    assertConnected()
    if (driver.id === 'codex') {
      if (!existsSync(answerPath) || statSync(answerPath).size > 1024 * 1024) throw new Error('Codex 未返回有效的最终答复')
      output = readFileSync(answerPath, 'utf8').trim()
      if (!output) throw new Error('Codex 未返回内容')
    }
    sendJson(response, 200, { output: driver.id === 'antigravity' ? parseAntigravityOutput(output) : output, driverId: driver.id })
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      sendJson(response, Number(error?.statusCode) || 500, {
        error: error instanceof Error ? error.message : 'CLI 生成失败'
      })
    }
  } finally {
    response.off('close', closeHandler)
    request.off('aborted', abortedHandler)
    cliTaskRunning = false
    if (runDirectory) rmSync(runDirectory, { recursive: true, force: true })
  }
}

async function handleRuntimeRequest(requestUrl, response) {
  if (requestUrl.pathname === '/api/app/version') {
    sendJson(response, 200, { version: appVersion })
    return true
  }

  if (requestUrl.pathname === '/api/app/updates') {
    try {
      const result = await checkForUpdates({ currentVersion: appVersion, platform: process.platform, architecture: process.arch })
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, Number(error?.statusCode) || 502, { error: error instanceof Error ? error.message : '检查更新失败，请稍后重试' })
    }
    return true
  }

  if (requestUrl.pathname === '/api/runtime') {
    const drivers = await Promise.all(cliDrivers.map(inspectCli))
    sendJson(response, 200, {
      platform: process.platform,
      architecture: process.arch,
      drivers,
      checkedAt: new Date().toISOString()
    })
    return true
  }

  if (requestUrl.pathname === '/api/runtime/ollama') {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    try {
      let baseUrl
      try { baseUrl = new URL(requestUrl.searchParams.get('baseUrl') || 'http://127.0.0.1:11434') }
      catch { throw Object.assign(new Error('Ollama 地址格式无效'), { code: 'INVALID_URL' }) }
      if (!isLoopbackUrl(baseUrl)) throw Object.assign(new Error('Ollama 只允许本机 HTTP 地址'), { code: 'INVALID_URL' })
      const ollamaResponse = await fetch(`${baseUrl.href.replace(/\/$/, '')}/api/tags`, { signal: controller.signal, redirect: 'error' })
      if (!ollamaResponse.ok) throw new Error(`HTTP ${ollamaResponse.status}`)
      const payload = await readProviderJson(ollamaResponse)
      if (!Array.isArray(payload.models) || payload.models.some(model => typeof model?.name !== 'string' || !model.name.trim())) throw Object.assign(new Error('Ollama 模型目录格式无效'), { code: 'INVALID_RESPONSE' })
      sendJson(response, 200, {
        status: payload.models.length ? 'ready' : 'no_models',
        models: payload.models.map(model => ({ name: model.name, size: Number(model.size || 0) }))
      })
    } catch (error) {
      sendJson(response, 200, {
        status: error?.name === 'AbortError' ? 'timeout' : error?.code === 'INVALID_RESPONSE' ? 'invalid_response' : error?.code === 'INVALID_URL' ? 'invalid_url' : 'not_running',
        models: []
      })
    } finally {
      clearTimeout(timeout)
    }
    return true
  }

  return false
}

async function readProviderJson(response) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) throw new Error('模型目录响应过大')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw Object.assign(new Error('模型目录响应格式无效'), { code: 'INVALID_RESPONSE' })
  }
}

export async function handleRequest(request, response) {
  if (!isAllowedHost(request.headers.host)) {
    sendJson(response, 403, { error: '拒绝无效的本地 Host' })
    return
  }
  let requestUrl
  try {
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new Error('Invalid request target')
    requestUrl = new URL(request.url, `http://${request.headers.host}`)
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Bad request')
    return
  }
  if (request.method === 'GET' && await handleRuntimeRequest(requestUrl, response)) return
  if (request.method === 'POST' && requestUrl.pathname === '/api/runtime/cli/generate') {
    await handleCliGenerateRequest(request, response)
    return
  }
  if (requestUrl.pathname.startsWith('/api/')) {
    sendJson(response, request.method === 'GET' ? 404 : 405, { error: '本地运行桥不支持该请求' })
    return
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Method not allowed')
    return
  }

  let requestedPath
  try {
    requestedPath = requestUrl.pathname === '/' ? '/index.html' : decodeURIComponent(requestUrl.pathname)
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Bad request')
    return
  }
  if (!isAllowedStaticPath(requestedPath)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Forbidden')
    return
  }
  const relativePath = normalize(requestedPath).replace(/^[/\\]+/, '')
  const filePath = resolve(join(projectRoot, relativePath))

  if (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}${sep}`)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Forbidden')
    return
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }

  if (!realpathSync(filePath).startsWith(`${realpathSync(projectRoot)}${sep}`)) {
    response.writeHead(403)
    response.end('Forbidden')
    return
  }
  response.writeHead(200, {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream'
  })
  createReadStream(filePath).pipe(response)
}

export function isAllowedStaticPath(path) {
  return path === '/index.html' || ['/src/styles.css', '/src/review-diff.css', '/src/candidate-drafts-ui.css'].includes(path) || /^\/src\/[a-zA-Z0-9_-]+\.js$/.test(path) || path === '/assets/app-icon.svg'
}

export function createDevServer() {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Internal server error')
      } else if (!response.writableEnded) {
        response.destroy()
      }
    })
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createDevServer()
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI Creator Workbench is running at http://127.0.0.1:${port}`)
  })
}
