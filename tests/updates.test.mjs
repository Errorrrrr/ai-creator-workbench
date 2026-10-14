import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { checkForUpdates, compareVersions, parseRelease, RELEASES_URL, validateUpdateUrl } from '../src/updates.js'
import { handleRequest } from '../scripts/dev-server.mjs'

const options = { currentVersion: '0.2.3', platform: 'darwin', architecture: 'arm64' }
function release(tag = 'v0.3.0', overrides = {}) {
  return { tag_name: tag, draft: false, prerelease: false, html_url: `${RELEASES_URL}/tag/${tag}`, body: '更新说明\n<script>only text</script>', published_at: '2026-10-05T10:00:00Z', assets: [], ...overrides }
}
function asset(name, tag = 'v0.3.0') {
  return { name, state: 'uploaded', browser_download_url: `${RELEASES_URL}/download/${tag}/${name}` }
}

test('semantic version comparison handles numeric ordering, prereleases, prefixes and build metadata', () => {
  for (const [a, b, result] of [
    ['0.10.0', '0.9.9', 1], ['v1.0.0', '1.0.0', 0], ['1.0.0+local', '1.0.0+release', 0],
    ['1.0.0-alpha.9', '1.0.0-alpha.10', -1], ['1.0.0-beta', '1.0.0', -1],
    ['1.0.0-1', '1.0.0-alpha', -1], ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['0.2.3', '0.3.0', -1]
  ]) assert.equal(compareVersions(a, b), result, `${a} vs ${b}`)
  for (const version of ['latest', '01.0.0', '1.0', '1.0.0-01', '1.0.0\n', '<script>1.0.0</script>']) assert.throws(() => compareVersions(version, '1.0.0'), /版本/)
})

test('release state distinguishes updates, equality and a newer local build', () => {
  assert.equal(parseRelease(release(), options).status, 'update_available')
  assert.equal(parseRelease(release(), { ...options, currentVersion: '0.3.0+local' }).status, 'up_to_date')
  assert.equal(parseRelease(release(), { ...options, currentVersion: '0.4.0' }).status, 'ahead')
  const parsed = parseRelease(release(), options)
  assert.equal(parsed.platform, 'macos-aarch64')
  assert.equal(parsed.notes, '更新说明\n<script>only text</script>', 'notes are returned as inert text for the UI to display using textContent')
  assert.equal(parsed.latestVersion, '0.3.0')
})

test('latest release must be a stable semver release with its matching official page', () => {
  for (const payload of [release('v1.0.0-beta.1'), release('v0.3.0', { draft: true }), release('v0.3.0', { prerelease: true }), release('v0.3.0', { html_url: `${RELEASES_URL}/tag/v0.4.0` }), release('v0.3.0', { html_url: 'https://evil.invalid/release' }), {}]) {
    assert.throws(() => parseRelease(payload, options))
  }
})

test('native architecture DMG is preferred over universal and other architectures', () => {
  const assets = [asset('app_universal.dmg'), asset('app_x64.dmg'), asset('ai-creator-workbench_0.3.0_aarch64.dmg'), asset('app_aarch64.app.zip')]
  const payload = release('v0.3.0', { assets })
  assert.equal(parseRelease(payload, options).assetName, 'ai-creator-workbench_0.3.0_aarch64.dmg')
  assert.equal(parseRelease(payload, { ...options, architecture: 'x64' }).assetName, 'app_x64.dmg')
  assert.equal(parseRelease(payload, { ...options, platform: 'linux' }).downloadUrl, null)
  assets[2].browser_download_url = 'https://evil.invalid/app_aarch64.dmg'
  assert.equal(parseRelease(payload, options).assetName, 'app_universal.dmg')
})

test('missing or invalid native assets retain the official page without offering a wrong DMG', () => {
  const parsed = parseRelease(release('v0.3.0', { assets: [asset('app_x64.dmg'), asset('app_aarch64.dmg', 'v0.4.0'), asset('app.dmg')] }), options)
  assert.equal(parsed.downloadUrl, null)
  assert.equal(parsed.releaseUrl, `${RELEASES_URL}/tag/v0.3.0`)
  assert.equal([...parseRelease(release('v0.3.0', { body: '中'.repeat(13000) }), options).notes].length, 12000)
})

test('official URL allowlist rejects credentials, alternate hosts, query strings and encoded traversal', () => {
  for (const url of [RELEASES_URL, `${RELEASES_URL}/latest`, `${RELEASES_URL}/tag/v0.3.0`, `${RELEASES_URL}/download/v0.3.0/app_aarch64.dmg`]) assert.equal(validateUpdateUrl(url), url)
  for (const url of [
    'javascript:alert(1)', 'https://github.com.evil.invalid/Errorrrrr/ai-creator-workbench/releases',
    'http://github.com/Errorrrrr/ai-creator-workbench/releases', 'https://github.com/another/repository/releases',
    'https://user@github.com/Errorrrrr/ai-creator-workbench/releases', 'https://github.com:444/Errorrrrr/ai-creator-workbench/releases',
    `${RELEASES_URL}?`, `${RELEASES_URL}#`, `${RELEASES_URL}/download/v0.3.0/app%2Fsecret.dmg`,
    `${RELEASES_URL}/download/v0.3.0/app%5Csecret.dmg`, `${RELEASES_URL}/download/v0.3.0/app%0asecret.dmg`,
    'https://github.com/Errorrrrr/ai-creator-workbench/issues'
  ]) assert.throws(() => validateUpdateUrl(url), /链接/)
})

test('update check uses the static release attachment with manually validated redirects and no API credentials', async () => {
  let request
  const result = await checkForUpdates({ ...options, fetchImpl: async (url, init) => {
    request = { url, init }
    return new Response(JSON.stringify(release()))
  } })
  assert.equal(result.status, 'update_available')
  assert.equal(request.url, 'https://github.com/Errorrrrr/ai-creator-workbench/releases/latest/download/latest.json')
  assert.equal(request.init.method, 'GET')
  assert.equal(request.init.redirect, 'manual')
  assert.equal(request.init.headers.Authorization, undefined)
  assert.equal(request.init.headers['X-GitHub-Api-Version'], undefined)
})

test('404 means no accessible release, never that the installed version is current', async () => {
  const result = await checkForUpdates({ ...options, fetchImpl: async () => new Response('', { status: 404 }) })
  assert.equal(result.status, 'no_release')
  assert.equal(result.latestVersion, null)
  assert.match(result.notes, /尚未发布.*仓库当前不可访问/)
})

test('rate limits, authorization errors, server errors and invalid JSON are explicit failures', async () => {
  for (const [response, error] of [
    [new Response('', { status: 429 }), /暂时限制请求/],
    [new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), /拒绝访问/],
    [new Response('', { status: 403 }), /拒绝访问/],
    [new Response('', { status: 500 }), /HTTP 500/],
    [new Response('not json'), /无法解析/]
  ]) await assert.rejects(checkForUpdates({ ...options, fetchImpl: async () => response }), error)
})

test('header/body stalls time out, cancelling the request and pending body reader', async () => {
  let signal
  await assert.rejects(checkForUpdates({ ...options, timeoutMs: 15, fetchImpl: (_url, init) => { signal = init.signal; return new Promise(() => {}) } }), { statusCode: 504 })
  assert.equal(signal.aborted, true)
  let cancelled = false
  await assert.rejects(checkForUpdates({ ...options, timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true } })) }), { statusCode: 504 })
  assert.equal(cancelled, true)
})

test('release response size is bounded for declared and streamed bodies', async () => {
  for (const response of [new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } }), new Response('x'.repeat(1024 * 1024 + 1))]) {
    await assert.rejects(checkForUpdates({ ...options, fetchImpl: async () => response }), /1 MiB/)
  }
})

function responseMock() {
  const response = new EventEmitter()
  response.writeHead = code => { response.statusCode = code }
  response.end = body => { response.body = JSON.parse(body) }
  return response
}

test('local version API reads package version and updates API propagates accessible-release state', async t => {
  const response = responseMock()
  await handleRequest({ method: 'GET', url: '/api/app/version', headers: { host: 'localhost:4173' } }, response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version)
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
  const updates = responseMock()
  await handleRequest({ method: 'GET', url: '/api/app/updates', headers: { host: 'localhost:4173' } }, updates)
  assert.equal(updates.statusCode, 200)
  assert.equal(updates.body.status, 'no_release')
})
