import { readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
export function parseVersion(version) {
  if (typeof version !== 'string') throw new Error('版本必须是字符串')
  const match = semver.exec(version)
  if (!match || match[0] !== version) throw new Error(`不是严格 SemVer：${JSON.stringify(version)}`)
  const prerelease = match[4]?.split('.') || []
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) throw new Error('预发布版本数字不能有前导零')
  return { version, major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]), prerelease }
}
export function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) throw new Error('发布 tag 必须使用 v 开头，例如 v0.3.0')
  return { tag, ...parseVersion(tag.slice(1)) }
}
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right)
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i]
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y)
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1
    if (numericX !== numericY) return numericX ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function tomlValue(section, key) {
  const matches = [...section.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\r\\n]*)"\\s*(?:#.*)?$`, 'gm'))]
  if (matches.length !== 1) throw new Error(`TOML ${key} 必须只有一个明确的字符串值`)
  return matches[0][1]
}
export function validateReleaseVersions(files, tag) {
  const release = parseReleaseTag(tag)
  const packageJson = JSON.parse(files['package.json'])
  const packageLock = JSON.parse(files['package-lock.json'])
  const tauri = JSON.parse(files['src-tauri/tauri.conf.json'])
  const packageSection = files['src-tauri/Cargo.toml'].split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0]
  if (!packageSection) throw new Error('Cargo.toml 缺少 [package]')
  const cargoName = tomlValue(packageSection, 'name')
  if (cargoName !== packageJson.name || packageLock.name !== packageJson.name || packageLock.packages?.['']?.name !== packageJson.name) throw new Error('npm 与 Cargo 项目名称不一致')
  const cargoPackages = files['src-tauri/Cargo.lock'].split(/^\[\[package\]\]\s*$/m).slice(1)
  const ownPackages = cargoPackages.filter(section => tomlValue(section, 'name') === cargoName)
  if (ownPackages.length !== 1) throw new Error('Cargo.lock 中应用包缺失或重复')
  const versions = {
    'package.json': packageJson.version,
    'package-lock.json': packageLock.version,
    'package-lock.json packages[""]': packageLock.packages?.['']?.version,
    'tauri.conf.json': tauri.version,
    'Cargo.toml': tomlValue(packageSection, 'version'),
    'Cargo.lock application package': tomlValue(ownPackages[0], 'version'),
  }
  for (const [file, version] of Object.entries(versions)) if (version !== release.version) throw new Error(`${file} 的版本 ${JSON.stringify(version)} 与 ${tag} 不一致`)
  return { tag, version: release.version, prerelease: release.prerelease.length > 0, name: packageJson.name, productName: tauri.productName, identifier: tauri.identifier }
}

export const VERSION_FILES = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']
function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
export function resolveReleaseRef(tag, root = process.cwd()) {
  parseReleaseTag(tag)
  const ref = `refs/tags/${tag}`
  try { git(root, 'show-ref', '--verify', ref) } catch { throw new Error(`发布 tag 不存在：${tag}；请先推送这个 tag` ) }
  const commit = git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('tag 未指向有效的 Git commit')
  return commit
}
export function checkRelease(tag, { root = process.cwd(), fromTag = false } = {}) {
  const commit = resolveReleaseRef(tag, root)
  if (!fromTag && git(root, 'rev-parse', 'HEAD') !== commit) throw new Error('当前 HEAD 必须与发布 tag 指向同一个 commit')
  const files = Object.fromEntries(VERSION_FILES.map(file => [file, fromTag ? git(root, 'show', `${commit}:${file}`) : readFileSync(resolve(root, file), 'utf8')]))
  return { ...validateReleaseVersions(files, tag), commit }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    let tag, output, fromTag = false
    while (args.length) {
      const arg = args.shift()
      if (arg === '--tag') tag = args.shift()
      else if (arg === '--github-output') output = args.shift()
      else if (arg === '--from-tag') fromTag = true
      else throw new Error(`未知参数：${arg}`)
    }
    const result = checkRelease(tag, { fromTag })
    if (output) appendFileSync(output, `tag=${result.tag}\nversion=${result.version}\ncommit=${result.commit}\nprerelease=${result.prerelease}\n`)
    console.log(JSON.stringify(result))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
