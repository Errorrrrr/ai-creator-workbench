import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, '..')
const port = Number.parseInt(process.env.PORT || '4173', 10)
const execFileAsync = promisify(execFile)
const cliRuntimeRoot = join(tmpdir(), 'ai-creator-workbench-runtime')
mkdirSync(cliRuntimeRoot, { recursive: true, mode: 0o700 })
let cliTaskRunning = false

const cliDrivers = [
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version']
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    generateArgs: ['--print', '--bare', '--output-format', 'text', '--permission-mode', 'dontAsk', '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--no-chrome'],
    requiresEnvironmentCredential: true
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

async function findExecutable(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which'
  try {
    const { stdout } = await execFileAsync(locator, [command], {
      timeout: 2500,
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
    const version = `${stdout || ''}\n${stderr || ''}`.trim().split(/\r?\n/)[0].slice(0, 160)
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

function readJsonBody(request, maxBytes = 96 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    let exceeded = false
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        exceeded = true
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (exceeded) {
        const error = new Error('请求内容过大')
        error.statusCode = 413
        rejectBody(error)
        return
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        const error = new Error('请求 JSON 格式无效')
        error.statusCode = 400
        rejectBody(error)
      }
    })
    request.on('error', rejectBody)
  })
}

function createCliPrompt(messages) {
  const safeMessages = Array.isArray(messages) ? messages.slice(0, 12) : []
  const content = safeMessages.map((message) => {
    const role = message?.role === 'system' ? '系统约束' : '用户内容'
    const value = typeof message?.content === 'string' ? message.content.slice(0, 24000) : ''
    return value ? `## ${role}\n${value}` : ''
  }).filter(Boolean).join('\n\n')
  if (!content) throw Object.assign(new Error('缺少可执行的创作请求'), { statusCode: 400 })
  if (content.length > 60000) throw Object.assign(new Error('发送给 CLI 的上下文过长'), { statusCode: 413 })
  return `你正在执行一次纯文本创作任务。不要调用工具、不要读取本机文件、不要修改环境；只输出可供用户审阅的中文候选内容。\n\n${content}`
}

function buildCliEnvironment(driverId, isolatedHome) {
  const commonNames = ['USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']
  const authNames = driverId === 'claude'
    ? ['ANTHROPIC_API_KEY']
    : ['OPENAI_API_KEY']
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

function sanitizeCliError(diagnostics) {
  if (/login|log in|auth|api[ _-]?key|credential|unauthorized/i.test(diagnostics)) return 'CLI 尚未登录或授权已失效'
  if (/avx|architecture|bad cpu|exec format/i.test(diagnostics)) return 'CLI 与当前芯片架构不兼容'
  if (/rate.?limit|quota|too many requests/i.test(diagnostics)) return 'CLI 上游服务暂时受限'
  if (/network|resolve|dns|connect|socket|timeout/i.test(diagnostics)) return 'CLI 无法连接上游服务'
  return 'CLI 运行失败，请在终端检查登录和版本'
}

function runCliProcess(executablePath, args, input, { driverId, cwd, signal, timeoutMs = 120000, maxOutputBytes = 1024 * 1024 } = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executablePath, args, {
      cwd,
      env: { ...buildCliEnvironment(driverId, cwd), NO_COLOR: '1', TERM: 'dumb' },
      shell: false,
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
        rejectProcess(Object.assign(new Error(sanitizeCliError(diagnostics)), { statusCode: 502 }))
      } else if (!output) {
        rejectProcess(Object.assign(new Error('CLI 未返回内容'), { statusCode: 502 }))
      } else {
        resolveProcess(output)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

async function handleCliGenerateRequest(request, response) {
  const origin = request.headers.origin
  let originAllowed = !origin
  if (origin) {
    try {
      const originUrl = new URL(origin)
      originAllowed = ['127.0.0.1', 'localhost'].includes(originUrl.hostname) && Number(originUrl.port) === port
    } catch {
      originAllowed = false
    }
  }
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
  try {
    const payload = await readJsonBody(request)
    const driver = cliDrivers.find((item) => item.id === payload.driverId && item.generateArgs)
    if (!driver) throw Object.assign(new Error('该 CLI 未在受控驱动列表中'), { statusCode: 400 })
    if (getCliExecutionStatus(driver) !== 'available') {
      throw Object.assign(new Error('CLI 安全模式需要通过环境变量显式提供模型凭据'), { statusCode: 401 })
    }
    const executablePath = await findExecutable(driver.command)
    if (!executablePath) throw Object.assign(new Error(`${driver.name} 未安装或不在 PATH 中`), { statusCode: 404 })
    const prompt = createCliPrompt(payload.messages)
    runDirectory = mkdtempSync(join(cliRuntimeRoot, 'run-'))
    const controller = new AbortController()
    const closeHandler = () => {
      if (!response.writableEnded) controller.abort()
    }
    response.on('close', closeHandler)
    const output = await runCliProcess(executablePath, driver.generateArgs, prompt, {
      cwd: runDirectory,
      driverId: driver.id,
      signal: controller.signal
    })
    response.off('close', closeHandler)
    sendJson(response, 200, { output, driverId: driver.id })
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      sendJson(response, Number(error?.statusCode) || 500, {
        error: error instanceof Error ? error.message : 'CLI 生成失败'
      })
    }
  } finally {
    cliTaskRunning = false
    if (runDirectory) rmSync(runDirectory, { recursive: true, force: true })
  }
}

async function handleRuntimeRequest(requestUrl, response) {
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
      const ollamaResponse = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal })
      if (!ollamaResponse.ok) throw new Error(`HTTP ${ollamaResponse.status}`)
      const payload = await ollamaResponse.json()
      sendJson(response, 200, {
        status: 'ready',
        models: Array.isArray(payload.models)
          ? payload.models.map((model) => ({ name: String(model.name || ''), size: Number(model.size || 0) }))
          : []
      })
    } catch (error) {
      sendJson(response, 200, {
        status: error?.name === 'AbortError' ? 'timeout' : 'not_running',
        models: []
      })
    } finally {
      clearTimeout(timeout)
    }
    return true
  }

  return false
}

async function handleRequest(request, response) {
  let requestUrl
  try {
    requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
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

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream'
  })
  createReadStream(filePath).pipe(response)
}

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

server.listen(port, '127.0.0.1', () => {
  console.log(`AI Creator Workbench is running at http://127.0.0.1:${port}`)
})
