import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { initializeUpdates } from '../src/update-ui.js'

const CURRENT = '17.4.8'
const LATEST = '17.5.0'
const RELEASE = `https://github.com/Errorrrrr/ai-creator-workbench/releases/tag/v${LATEST}`
const DOWNLOAD = `https://github.com/Errorrrrr/ai-creator-workbench/releases/download/v${LATEST}/Workbench_aarch64.dmg`
const ids = ['updateDialog', 'updateStatus', 'updateCurrentVersion', 'updateLatestVersion', 'updatePlatform', 'updatePublished', 'updateNotes', 'updateNotesSection', 'updateAsset', 'updateCheckButton', 'updateReleaseButton', 'updateDownloadButton', 'updateInstallButton', 'updateCancelButton']

class Element extends EventTarget {
  textContent = ''
  dataset = {}
  hidden = false
  disabled = false
  open = false
  attributes = new Map()
  set innerHTML(_value) { throw new Error('Update content must never use innerHTML') }
  setAttribute(name, value) { this.attributes.set(name, value) }
  showModal() { this.open = true }
  close() { this.open = false; this.dispatchEvent(new Event('close')) }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')) }
}

function release(overrides = {}) {
  return {
    status: 'update_available', currentVersion: CURRENT, latestVersion: LATEST,
    publishedAt: '2026-10-05T00:00:00Z', notes: '保存更可靠。', releaseUrl: RELEASE,
    downloadUrl: DOWNLOAD, assetName: 'Workbench_aarch64.dmg', platform: 'macos-aarch64',
    ...overrides,
  }
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness({ fetcher, invoke, timeoutMs = 20000, defaultBrowserOpen = false } = {}) {
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]))
  const requests = []
  const opened = []
  const ui = initializeUpdates({
    documentRef: { getElementById: id => elements[id] },
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return fetcher ? fetcher(url, options) : response(url.endsWith('/version') ? { version: CURRENT } : release())
    },
    invoke,
    ...(defaultBrowserOpen ? {} : { openExternal: url => opened.push(url) }),
    timeoutMs,
  })
  return { ui, elements, requests, opened }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('更新入口与对话框具有完整语义控件，初始化不会自动请求网络', async () => {
  const h = harness()
  assert.equal(h.requests.length, 0)
  assert.equal(h.elements.updateDialog.open, false)
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
  for (const id of ids) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id)
  assert.match(html, /data-action="check-updates"[^>]*aria-controls="updateDialog"/)
  assert.match(html, /id="updateStatus"[^>]*role="status"[^>]*aria-live="polite"/)
  assert.match(app, /case 'check-updates': await updatesUI\.open\(\)/)
})

test('用户检查后显示API版本与架构，发布说明作为纯文本且不会自动打开下载', async () => {
  const notes = '<img src=x onerror="throw Error(1)">\n**这是发布者提供的文字**'
  const h = harness({ fetcher: url => response(url.endsWith('/version') ? { version: CURRENT } : release({ notes })) })
  await h.ui.open()
  assert.equal(h.requests.length, 2)
  assert.deepEqual(h.requests.map(item => item.url).sort(), ['/api/app/updates', '/api/app/version'])
  assert.ok(h.requests.every(item => item.options.cache === 'no-store' && item.options.signal instanceof AbortSignal))
  assert.equal(h.elements.updateCurrentVersion.textContent, CURRENT)
  assert.equal(h.elements.updateLatestVersion.textContent, LATEST)
  assert.equal(h.elements.updatePlatform.textContent, 'macOS · Apple Silicon')
  assert.equal(h.elements.updateNotes.textContent, notes)
  assert.equal(h.elements.updateNotesSection.hidden, false)
  assert.equal(h.elements.updateStatus.dataset.state, 'update_available')
  assert.equal(h.elements.updateReleaseButton.disabled, false)
  assert.equal(h.elements.updateDownloadButton.disabled, false)
  assert.equal(h.elements.updateCheckButton.disabled, false)
  assert.deepEqual(h.opened, [])
  h.elements.updateReleaseButton.click()
  await tick()
  assert.deepEqual(h.opened, [RELEASE])
  h.elements.updateDownloadButton.click()
  await tick()
  assert.deepEqual(h.opened, [RELEASE, DOWNLOAD])
})

test('浏览器链接在用户点击后使用noopener及noreferrer打开', async () => {
  const previous = globalThis.window
  const opened = []
  globalThis.window = { open: (...args) => opened.push(args) }
  try {
    const h = harness({ defaultBrowserOpen: true })
    await h.ui.open()
    assert.deepEqual(opened, [])
    h.elements.updateReleaseButton.click()
    await tick()
    assert.deepEqual(opened, [[RELEASE, '_blank', 'noopener,noreferrer']])
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})

test('未找到稳定发布时解释不可访问的可能性，不误报已是最新', async () => {
  const h = harness({ fetcher: url => response(url.endsWith('/version') ? { version: CURRENT } : release({
    status: 'no_release', latestVersion: null, downloadUrl: null, assetName: null,
    releaseUrl: 'https://github.com/Errorrrrr/ai-creator-workbench/releases',
    notes: '尚无公开稳定版本，或仓库无法访问。',
  })) })
  await h.ui.open()
  assert.equal(h.elements.updateStatus.dataset.state, 'no_release')
  assert.match(h.elements.updateStatus.textContent, /尚未发布.*不可访问/)
  assert.doesNotMatch(h.elements.updateStatus.textContent, /已是最新/)
  assert.equal(h.elements.updateDownloadButton.disabled, true)
  assert.equal(h.elements.updateReleaseButton.disabled, false)
})

for (const status of [404, 403, 429, 503]) {
  test(`HTTP ${status} 失败保留当前版本并标明未确认，禁止旧下载操作`, async () => {
    const h = harness({ fetcher: url => url.endsWith('/version') ? response({ version: CURRENT }) : response({ error: '连接发布服务失败' }, status) })
    await h.ui.open()
    assert.equal(h.elements.updateCurrentVersion.textContent, CURRENT)
    assert.equal(h.elements.updateStatus.dataset.state, 'error')
    assert.match(h.elements.updateStatus.textContent, /未能确认/)
    assert.doesNotMatch(h.elements.updateStatus.textContent, /已是最新/)
    assert.equal(h.elements.updateLatestVersion.textContent, '尚未确认')
    assert.equal(h.elements.updateReleaseButton.disabled, true)
    assert.equal(h.elements.updateDownloadButton.disabled, true)
  })
}

test('检查中重复点击不重发请求，关闭时取消且迟到结果不能覆盖新检查', async () => {
  const oldResponse = deferred()
  let releaseCalls = 0
  const h = harness({ fetcher: url => {
    if (url.endsWith('/version')) return response({ version: CURRENT })
    releaseCalls += 1
    return releaseCalls === 1 ? oldResponse.promise : response(release({ status: 'up_to_date', latestVersion: CURRENT, notes: '第二次检查' }))
  } })
  const first = h.ui.open()
  await h.ui.check()
  assert.equal(h.requests.length, 2)
  assert.equal(h.elements.updateCheckButton.disabled, true)
  h.elements.updateDialog.close()
  await first
  assert.ok(h.requests[0].options.signal.aborted)
  await h.ui.open()
  assert.equal(h.elements.updateStatus.dataset.state, 'up_to_date')
  assert.equal(h.elements.updateLatestVersion.textContent, CURRENT)
  oldResponse.resolve(response(release({ latestVersion: '99.0.0', notes: '迟到旧结果' })))
  await tick()
  assert.equal(h.elements.updateLatestVersion.textContent, CURRENT)
  assert.equal(h.elements.updateNotes.textContent, '第二次检查')
  assert.equal(h.elements.updateCheckButton.disabled, false)
})

test('重新检查先清空旧链接，失败后仍不能下载旧结果', async () => {
  let attempt = 0
  const pending = deferred()
  const h = harness({ fetcher: url => {
    if (url.endsWith('/version')) return response({ version: CURRENT })
    return ++attempt === 1 ? response(release()) : pending.promise
  } })
  await h.ui.open()
  const checking = h.ui.check()
  assert.equal(h.elements.updateDownloadButton.disabled, true)
  h.elements.updateDownloadButton.click()
  assert.deepEqual(h.opened, [])
  pending.resolve(response({ error: '网络不可用' }, 502))
  await checking
  assert.equal(h.elements.updateDownloadButton.disabled, true)
  assert.equal(h.elements.updateStatus.dataset.state, 'error')
})

test('桌面经invoke读取版本与检查，显式点击后仅调用打开链接命令', async () => {
  const calls = []
  const h = harness({ invoke: async (command, args) => {
    calls.push({ command, args })
    if (command === 'app_version') return CURRENT
    if (command === 'check_for_updates') return release()
    if (command === 'open_update_link') return
    throw new Error(`unexpected command ${command}`)
  } })
  assert.deepEqual(calls, [])
  await h.ui.open()
  assert.deepEqual(calls.map(call => call.command).sort(), ['app_version', 'check_for_updates'])
  assert.equal(h.requests.length, 0)
  h.elements.updateDownloadButton.click()
  await tick()
  assert.deepEqual(calls.at(-1), { command: 'open_update_link', args: { url: DOWNLOAD } })
  assert.equal(calls.length, 3, 'there is no auto-download/install command')
})

test('缺少对应架构安装包时保留发布页，禁用下载并说明原因', async () => {
  const h = harness({ fetcher: url => response(url.endsWith('/version') ? { version: CURRENT } : release({ downloadUrl: null, assetName: null, platform: 'linux-aarch64' })) })
  await h.ui.open()
  assert.equal(h.elements.updateReleaseButton.disabled, false)
  assert.equal(h.elements.updateDownloadButton.disabled, true)
  assert.match(h.elements.updateAsset.textContent, /没有匹配当前平台与架构/)
})

for (const url of ['javascript:alert(1)', 'https://evil.example/download', 'https://github.com/Other/repo/releases/tag/v1', 'https://github.com/Errorrrrr/ai-creator-workbench/issues/1']) {
  test(`拒绝非项目发布链接 ${url}`, async () => {
    const h = harness({ fetcher: path => response(path.endsWith('/version') ? { version: CURRENT } : release({ downloadUrl: url })) })
    await h.ui.open()
    assert.equal(h.elements.updateStatus.dataset.state, 'error')
    assert.equal(h.elements.updateDownloadButton.disabled, true)
    assert.equal(h.elements.updateReleaseButton.disabled, true)
    h.elements.updateDownloadButton.click()
    assert.deepEqual(h.opened, [])
  })
}

test('异常状态和版本不一致不能变成“已是最新”', async () => {
  for (const changed of [{ status: 'unknown' }, { currentVersion: '0.0.1' }, { latestVersion: null }]) {
    const h = harness({ fetcher: path => response(path.endsWith('/version') ? { version: CURRENT } : release(changed)) })
    await h.ui.open()
    assert.equal(h.elements.updateStatus.dataset.state, 'error')
    assert.match(h.elements.updateStatus.textContent, /未能确认/)
    assert.equal(h.elements.updateDownloadButton.disabled, true)
  }
})

test('当前开发版本领先稳定版时明确说明，用户仍可查看稳定发布', async () => {
  const h = harness({ fetcher: path => response(path.endsWith('/version') ? { version: CURRENT } : release({ status: 'ahead', latestVersion: '17.3.0' })) })
  await h.ui.open()
  assert.equal(h.elements.updateStatus.dataset.state, 'ahead')
  assert.match(h.elements.updateStatus.textContent, /高于.*无需更新/)
  assert.equal(h.elements.updateDownloadButton.textContent, '下载稳定版本')
  assert.deepEqual(h.opened, [])
})

test('无响应请求超时后恢复操作能力，不宣称检查成功', async () => {
  const h = harness({ timeoutMs: 10, fetcher: path => path.endsWith('/version') ? response({ version: CURRENT }) : new Promise(() => {}) })
  await h.ui.open()
  assert.equal(h.elements.updateStatus.dataset.state, 'error')
  assert.match(h.elements.updateStatus.textContent, /超时.*未能确认/)
  assert.equal(h.elements.updateCheckButton.disabled, false)
  assert.ok(h.requests[1].options.signal.aborted)
})

test('桌面打开链接期间防重复操作，关闭后迟到错误不污染下一次检查', async () => {
  const opening = deferred()
  let opens = 0
  const h = harness({ invoke: async command => {
    if (command === 'app_version') return CURRENT
    if (command === 'check_for_updates') return release()
    if (command === 'open_update_link') { opens += 1; return opening.promise }
  } })
  await h.ui.open()
  h.elements.updateDownloadButton.click()
  h.elements.updateDownloadButton.click()
  assert.equal(opens, 1)
  assert.equal(h.elements.updateCheckButton.disabled, true)
  h.elements.updateDialog.close()
  await h.ui.open()
  opening.reject(new Error('旧操作失败'))
  await tick()
  assert.equal(h.elements.updateStatus.dataset.state, 'update_available')
  assert.doesNotMatch(h.elements.updateStatus.textContent, /旧操作失败/)
  assert.equal(h.elements.updateCheckButton.disabled, false)
})
