import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkRelease, parseReleaseTag } from './check-release-version.mjs'

export const RELEASE_TARGET = 'aarch64-apple-darwin'
export function releaseAssetNames(version) {
  parseReleaseTag(`v${version}`)
  return [`ai-creator-workbench_${version}_aarch64.dmg`, `ai-creator-workbench_${version}_aarch64.app.zip`, 'SHA256SUMS']
}
export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function fileRecord(directory, name) {
  const path = join(directory, name)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`发布文件不存在、为空或不是普通文件：${name}`)
  return { name, size: info.size, sha256: await sha256(path) }
}
export async function createReleaseManifest(directory, release) {
  const names = releaseAssetNames(release.version)
  const assets = []
  for (const name of names.slice(0, 2)) assets.push(await fileRecord(directory, name))
  await writeFile(join(directory, 'SHA256SUMS'), assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''))
  assets.push(await fileRecord(directory, 'SHA256SUMS'))
  const manifest = { format: 'ai-creator-workbench-release', version: 1, tag: release.tag, releaseVersion: release.version, commit: release.commit, target: RELEASE_TARGET, assets }
  await writeFile(join(directory, 'release-metadata.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
export async function verifyReleaseArtifacts(directory, { tag, commit }) {
  const release = parseReleaseTag(tag)
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('发布 commit 无效')
  const manifest = JSON.parse(await readFile(join(directory, 'release-metadata.json'), 'utf8'))
  if (manifest.format !== 'ai-creator-workbench-release' || manifest.version !== 1 || manifest.tag !== tag || manifest.releaseVersion !== release.version || manifest.commit !== commit || manifest.target !== RELEASE_TARGET) throw new Error('发布产物元数据与选定 tag 不一致')
  const expected = releaseAssetNames(release.version)
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== expected.length || manifest.assets.some((asset, i) => asset.name !== expected[i])) throw new Error('发布文件列表不完整或包含意外文件')
  const entries = (await readdir(directory)).sort()
  if (JSON.stringify(entries) !== JSON.stringify([...expected, 'release-metadata.json'].sort())) throw new Error('发布目录含有意外或缺失文件')
  for (const asset of manifest.assets) {
    const actual = await fileRecord(directory, asset.name)
    if (actual.size !== asset.size || actual.sha256 !== asset.sha256) throw new Error(`发布文件校验失败：${asset.name}`)
  }
  const expectedChecksums = manifest.assets.slice(0, 2).map(asset => `${asset.sha256}  ${asset.name}\n`).join('')
  if (await readFile(join(directory, 'SHA256SUMS'), 'utf8') !== expectedChecksums) throw new Error('SHA256SUMS 内容与发布文件不一致')
  return manifest
}

export async function prepareReleaseArtifacts(tag, { root = process.cwd() } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS 发布产物必须在 macOS 上构建和验证')
  const release = checkRelease(tag, { root })
  const bundle = join(root, 'src-tauri', 'target', RELEASE_TARGET, 'release', 'bundle')
  const app = join(bundle, 'macos', `${release.productName}.app`)
  if (!(await lstat(app)).isDirectory()) throw new Error('未找到构建后的 .app')
  const plist = join(app, 'Contents', 'Info.plist')
  const plistValue = key => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()
  if (plistValue('CFBundleShortVersionString') !== release.version || plistValue('CFBundleIdentifier') !== release.identifier) throw new Error('.app 的版本或应用标识不匹配')
  const binary = join(app, 'Contents', 'MacOS', plistValue('CFBundleExecutable'))
  if (execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' }).trim() !== 'arm64') throw new Error('应用必须为 Apple Silicon arm64 构建')
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  const dmgDirectory = join(bundle, 'dmg')
  const dmgFiles = (await readdir(dmgDirectory)).filter(file => file.endsWith('.dmg'))
  if (dmgFiles.length !== 1) throw new Error('必须恰好生成一个 DMG 文件')
  const dmg = join(dmgDirectory, dmgFiles[0])
  execFileSync('/usr/bin/hdiutil', ['verify', dmg], { stdio: 'inherit' })
  const output = join(root, 'release-artifacts')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('发布产物目录必须为空，避免混入旧版本文件')
  const names = releaseAssetNames(release.version)
  await copyFile(dmg, join(output, names[0]))
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(output, names[1])], { stdio: 'inherit' })
  await createReleaseManifest(output, release)
  await verifyReleaseArtifacts(output, release)
  return { directory: basename(output), ...release }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--tag') { console.error('用法：node scripts/release-artifacts.mjs --tag v0.3.0'); process.exitCode = 1 }
  else prepareReleaseArtifacts(process.argv[3]).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
