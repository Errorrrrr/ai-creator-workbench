export const UPDATE_REPOSITORY = 'Errorrrrr/ai-creator-workbench'
export const RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`
const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_NOTES_CHARACTERS = 12000

function updateError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode })
}

function parsedUpdateUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('更新链接无效') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.href.includes('?') || url.href.includes('#')) throw new Error('只允许打开本项目的 GitHub 官方发布链接')
  let segments
  try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) }
  catch { throw new Error('更新链接路径无效') }
  if (segments.some(segment => /[/\\\u0000-\u001f\u007f]/.test(segment) || segment === '.' || segment === '..')) throw new Error('更新链接路径无效')
  const prefix = segments[0] === 'Errorrrrr' && segments[1] === 'ai-creator-workbench' && segments[2] === 'releases'
  const validPage = segments.length === 3 || (segments.length === 4 && segments[3] === 'latest') || (segments.length === 5 && segments[3] === 'tag')
  const validAsset = segments.length === 6 && segments[3] === 'download'
  if (!prefix || (!validPage && !validAsset)) throw new Error('只允许打开本项目的 GitHub 官方发布链接')
  return { url: url.href, segments }
}

export function validateUpdateUrl(value) {
  return parsedUpdateUrl(value).url
}

function semver(value) {
  const version = typeof value === 'string' ? value.replace(/^[vV]/, '') : ''
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(version)
  if (!match || match[0] !== version) throw new Error('发布版本号不是有效的语义版本，暂时无法比较')
  const numbers = match.slice(1, 4).map(BigInt)
  if (numbers.some(number => number > 18446744073709551615n)) throw new Error('发布版本号超出支持范围')
  const prerelease = match[4]?.split('.') || []
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error('发布版本号不是有效的语义版本，暂时无法比较')
  return { version, numbers, prerelease }
}

export function compareVersions(left, right) {
  const a = semver(left)
  const b = semver(right)
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1
    if (numericX !== numericY) return numericX ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function platformInfo(platform, architecture) {
  const os = ['darwin', 'macos'].includes(platform) ? 'macos' : platform || 'unknown'
  const arch = ['arm64', 'aarch64'].includes(architecture) ? 'aarch64' : ['x64', 'x86_64', 'amd64'].includes(architecture) ? 'x86_64' : architecture || 'unknown'
  return { os, arch, label: `${os}-${arch}` }
}

function assetScore(name, arch) {
  const value = name.toLowerCase()
  if (!value.endsWith('.dmg')) return 0
  const arm = /(?:^|[_-])(?:aarch64|arm64)(?:[_.-]|$)/.test(value)
  const intel = /(?:^|[_-])(?:x86_64|x64|amd64)(?:[_.-]|$)/.test(value)
  if (arm && intel) return 0
  if ((arch === 'aarch64' && arm) || (arch === 'x86_64' && intel)) return 2
  if (!arm && !intel && /(?:^|[_-])universal2?(?:[_.-]|$)/.test(value)) return 1
  return 0
}

function emptyResult(currentVersion, platform, architecture) {
  semver(currentVersion)
  return { status: 'no_release', currentVersion, latestVersion: null, publishedAt: null, notes: '未找到可访问的稳定发布；可能尚未发布，或仓库当前不可访问。', releaseUrl: RELEASES_URL, downloadUrl: null, assetName: null, platform: platformInfo(platform, architecture).label }
}

export function parseRelease(payload, { currentVersion, platform, architecture }) {
  if (!payload || typeof payload !== 'object' || payload.draft !== false || payload.prerelease !== false || typeof payload.tag_name !== 'string') throw new Error('GitHub 返回的稳定发布信息无效')
  const latest = semver(payload.tag_name)
  if (latest.prerelease.length) throw new Error('最新发布不是稳定版本，暂不提供更新')
  const release = parsedUpdateUrl(payload.html_url)
  if (release.segments.length !== 5 || release.segments[3] !== 'tag' || release.segments[4] !== payload.tag_name) throw new Error('GitHub 发布页与版本信息不一致')
  const info = platformInfo(platform, architecture)
  let chosen = null
  let score = 0
  if (info.os === 'macos' && Array.isArray(payload.assets)) {
    for (const asset of payload.assets) {
      if (!asset || typeof asset.name !== 'string' || asset.state !== 'uploaded') continue
      const rank = assetScore(asset.name, info.arch)
      if (rank <= score) continue
      try {
        const link = parsedUpdateUrl(asset.browser_download_url)
        if (link.segments.length !== 6 || link.segments[3] !== 'download' || link.segments[4] !== payload.tag_name || link.segments[5] !== asset.name) continue
        chosen = { name: asset.name, url: link.url }
        score = rank
      } catch { /* An invalid asset never hides the valid official release page. */ }
    }
  }
  const comparison = compareVersions(latest.version, currentVersion)
  return {
    status: comparison > 0 ? 'update_available' : comparison < 0 ? 'ahead' : 'up_to_date',
    currentVersion, latestVersion: latest.version,
    publishedAt: typeof payload.published_at === 'string' && Number.isFinite(Date.parse(payload.published_at)) ? payload.published_at : null,
    notes: typeof payload.body === 'string' ? [...payload.body].slice(0, MAX_NOTES_CHARACTERS).join('') : '',
    releaseUrl: release.url, downloadUrl: chosen?.url || null, assetName: chosen?.name || null, platform: info.label
  }
}

async function readReleaseJson(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { response.body?.cancel().catch(() => {}); throw updateError('GitHub 发布信息超过 1 MiB 限制') }
  if (!response.body) throw updateError('GitHub 没有返回发布信息')
  const reader = response.body.getReader()
  const onAbort = () => { reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  const chunks = []
  let length = 0
  try {
    while (true) {
      if (signal.aborted) throw updateError('检查更新超时，请稍后重试', 504)
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw updateError('GitHub 发布信息超过 1 MiB 限制')
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw updateError('GitHub 返回了无法解析的发布信息') }
  } finally { signal.removeEventListener('abort', onAbort); reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function checkForUpdates({ currentVersion, platform, architecture, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  const empty = emptyResult(currentVersion, platform, architecture)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('更新检查超时配置无效')
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(updateError('检查更新超时，请稍后重试', 504))
    }, timeoutMs)
  })
  const request = (async () => {
    let response
    try {
      response = await fetchImpl(LATEST_RELEASE_API, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `AI-Creator-Workbench/${currentVersion}` }
      })
    } catch { throw updateError('无法连接 GitHub 检查更新，请检查网络后重试') }
    if (controller.signal.aborted) { response.body?.cancel().catch(() => {}); throw updateError('检查更新超时，请稍后重试', 504) }
    if (!response.ok) {
      response.body?.cancel().catch(() => {})
      if (response.status === 404) return empty
      if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) throw updateError('GitHub 检查更新次数已达上限，请稍后重试', 429)
      if (response.status === 401 || response.status === 403) throw updateError('GitHub 暂时拒绝访问此发布信息，请稍后重试')
      throw updateError(`GitHub 检查更新返回 HTTP ${response.status}`)
    }
    return parseRelease(await readReleaseJson(response, controller.signal), { currentVersion, platform, architecture })
  })()
  try { return await Promise.race([request, deadline]) }
  finally { clearTimeout(timer) }
}
