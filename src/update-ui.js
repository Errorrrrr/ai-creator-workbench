import { validateUpdateUrl } from './updates.js'

const RELEASE_STATES = new Set(['no_release', 'up_to_date', 'update_available', 'ahead'])

function readableFailure(error) {
  const message = error instanceof Error ? error.message : String(error || '网络请求失败')
  return message.slice(0, 500)
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel)
      const error = new Error('检查已取消')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) return cancel()
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', cancel)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', cancel)
      reject(error)
    })
  })
}

function validateResult(value) {
  if (!value || !RELEASE_STATES.has(value.status) || typeof value.currentVersion !== 'string' || !value.currentVersion.trim()) {
    throw new Error('更新服务返回了无法识别的版本信息')
  }
  if (value.latestVersion !== null && value.latestVersion !== undefined && typeof value.latestVersion !== 'string') throw new Error('更新服务的最新版本格式无效')
  if (value.status !== 'no_release' && (typeof value.latestVersion !== 'string' || !value.latestVersion.trim())) {
    throw new Error('更新服务缺少最新版本信息')
  }
  return {
    ...value,
    releaseUrl: value.releaseUrl ? validateUpdateUrl(value.releaseUrl) : null,
    downloadUrl: value.downloadUrl ? validateUpdateUrl(value.downloadUrl) : null,
    notes: typeof value.notes === 'string' ? value.notes : '',
  }
}

function platformLabel(platform) {
  if (/^(macos|darwin)[-_](aarch64|arm64)$/i.test(platform)) return 'macOS · Apple Silicon'
  if (/^(macos|darwin)[-_](x86_64|x64)$/i.test(platform)) return 'macOS · Intel'
  if (/^(win32|windows)[-_](x86_64|x64)$/i.test(platform)) return 'Windows · x64'
  if (/^linux[-_](x86_64|x64)$/i.test(platform)) return 'Linux · x64'
  return typeof platform === 'string' && platform.trim() ? platform.slice(0, 80) : '当前平台'
}

/** No requests occur at initialization: open/check must be triggered by the user. */
export function initializeUpdates({
  documentRef = globalThis.document,
  fetchImpl = globalThis.fetch,
  invoke = null,
  openDialog = dialog => dialog.showModal(),
  openExternal = url => globalThis.window.open(url, '_blank', 'noopener,noreferrer'),
  timeoutMs = 20000,
} = {}) {
  const ids = ['updateDialog', 'updateStatus', 'updateCurrentVersion', 'updateLatestVersion', 'updatePlatform', 'updatePublished', 'updateNotes', 'updateNotesSection', 'updateAsset', 'updateCheckButton', 'updateReleaseButton', 'updateDownloadButton']
  const elements = Object.fromEntries(ids.map(id => {
    const element = documentRef.getElementById(id)
    if (!element) throw new Error(`缺少更新界面控件：${id}`)
    return [id, element]
  }))
  let sequence = 0
  let controller = null
  let checking = false
  let openingLink = false
  let result = null

  const current = id => id === sequence && elements.updateDialog.open
  function setStatus(message, state) {
    elements.updateStatus.textContent = message
    elements.updateStatus.dataset.state = state
  }
  function syncButtons() {
    elements.updateCheckButton.disabled = checking || openingLink
    elements.updateCheckButton.textContent = checking ? '正在检查…' : '重新检查'
    elements.updateReleaseButton.disabled = checking || openingLink || !result?.releaseUrl
    elements.updateDownloadButton.disabled = checking || openingLink || !result?.downloadUrl
    elements.updateDialog.setAttribute('aria-busy', String(checking))
  }
  function clearRelease() {
    result = null
    elements.updateLatestVersion.textContent = '尚未确认'
    elements.updatePlatform.textContent = '等待检查'
    elements.updatePublished.textContent = ''
    elements.updateAsset.textContent = ''
    elements.updateNotes.textContent = ''
    elements.updateNotesSection.hidden = true
    syncButtons()
  }
  async function jsonRequest(path, signal) {
    const response = await fetchImpl(path, { cache: 'no-store', headers: { Accept: 'application/json' }, signal })
    let body
    try { body = await response.json() } catch { body = null }
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) throw new Error('更新服务暂时限制请求，请稍后重新检查')
      throw new Error(typeof body?.error === 'string' ? body.error : `更新请求失败（HTTP ${response.status}）`)
    }
    return body
  }
  async function readVersion(signal) {
    const value = invoke ? await invoke('app_version') : (await jsonRequest('/api/app/version', signal))?.version
    if (typeof value !== 'string' || !value.trim()) throw new Error('无法读取当前应用版本')
    return value.trim()
  }
  function renderRelease(next) {
    result = next
    elements.updateCurrentVersion.textContent = next.currentVersion
    elements.updateLatestVersion.textContent = next.latestVersion || '暂无可确认的稳定版本'
    elements.updatePlatform.textContent = platformLabel(next.platform)
    const published = next.publishedAt ? new Date(next.publishedAt) : null
    elements.updatePublished.textContent = published && Number.isFinite(published.getTime()) ? `发布于 ${published.toLocaleDateString('zh-CN')}` : ''
    elements.updateNotes.textContent = next.notes || '此版本未提供更新说明。'
    elements.updateNotesSection.hidden = next.status === 'no_release' && !next.notes
    elements.updateAsset.textContent = next.downloadUrl
      ? `下载文件：${typeof next.assetName === 'string' ? next.assetName : '对应当前平台的安装包'}`
      : next.status === 'no_release' ? '' : '没有匹配当前平台与架构的安装包，可到发布页查看其他文件。'
    elements.updateDownloadButton.textContent = next.status === 'ahead' ? '下载稳定版本' : '下载对应安装包'
    const messages = {
      no_release: '未找到可访问的公开稳定版本；可能尚未发布，或仓库目前不可访问。',
      up_to_date: '当前版本已是最新公开稳定版。',
      update_available: `发现新版本 ${next.latestVersion}，可查看说明后选择下载。`,
      ahead: '当前版本高于最新公开稳定版，无需更新。',
    }
    setStatus(messages[next.status], next.status)
  }
  async function check() {
    if (checking || openingLink || !elements.updateDialog.open) return
    const id = ++sequence
    const request = new AbortController()
    controller = request
    checking = true
    clearRelease()
    setStatus('正在检查公开发布信息…', 'checking')
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; request.abort() }, timeoutMs)
    try {
      const [version, release] = await Promise.allSettled([
        abortable(readVersion(request.signal), request.signal),
        abortable(invoke ? Promise.resolve().then(() => invoke('check_for_updates')) : jsonRequest('/api/app/updates', request.signal), request.signal),
      ])
      if (!current(id)) return
      if (version.status === 'fulfilled') elements.updateCurrentVersion.textContent = version.value
      else elements.updateCurrentVersion.textContent = '无法读取'
      if (release.status === 'rejected') throw release.reason
      const next = validateResult(release.value)
      if (version.status === 'fulfilled' && next.currentVersion !== version.value) throw new Error('当前版本信息不一致，请重新检查')
      renderRelease(next)
    } catch (error) {
      if (!current(id)) return
      clearRelease()
      setStatus(`${timedOut ? '检查超时，请稍后重试' : `检查失败：${readableFailure(error)}`}。未能确认是否为最新版本。`, 'error')
    } finally {
      clearTimeout(timer)
      if (current(id)) {
        checking = false
        controller = null
        syncButtons()
      }
    }
  }
  function cancel() {
    sequence += 1
    controller?.abort()
    controller = null
    checking = false
    openingLink = false
    clearRelease()
    setStatus('检查已结束，点击“重新检查”获取发布信息。', 'idle')
  }
  async function openLink(kind) {
    if (checking || openingLink || !elements.updateDialog.open) return
    const raw = kind === 'download' ? result?.downloadUrl : result?.releaseUrl
    if (!raw) return
    const id = sequence
    openingLink = true
    syncButtons()
    try {
      const url = validateUpdateUrl(raw)
      if (invoke) await invoke('open_update_link', { url })
      else openExternal(url)
      if (current(id)) setStatus('已请求在系统浏览器中打开链接。下载后请自行安装，应用不会自动安装。', 'opened')
    } catch (error) {
      if (current(id)) setStatus(`无法打开链接：${readableFailure(error)}`, 'error')
    } finally {
      if (current(id)) { openingLink = false; syncButtons() }
    }
  }
  elements.updateCheckButton.addEventListener('click', () => { void check() })
  elements.updateReleaseButton.addEventListener('click', () => { void openLink('release') })
  elements.updateDownloadButton.addEventListener('click', () => { void openLink('download') })
  elements.updateDialog.addEventListener('close', cancel)
  elements.updateDialog.addEventListener('cancel', cancel)
  return {
    open() { openDialog(elements.updateDialog); return check() },
    check,
    cancel,
  }
}
