import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareVersions, parseReleaseTag } from './check-release-version.mjs'
import { verifyReleaseArtifacts } from './release-artifacts.mjs'

const MANAGED_MARKER = '<!-- ai-creator-workbench-actions-release -->'
async function resolveRemoteCommit(github, repo, tag) {
  let object = (await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` })).data.object
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) object = (await github.rest.git.getTag({ ...repo, tag_sha: object.sha })).data.object
  if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('远程 tag 没有指向有效 commit')
  return object.sha
}
export function shouldBecomeLatest(tag, latestTag = null) {
  const release = parseReleaseTag(tag)
  if (release.prerelease.length) return false
  if (!latestTag) return true
  return compareVersions(release.version, parseReleaseTag(latestTag).version) > 0
}

/** Publish only after every local and uploaded asset has passed validation. */
export async function publishRelease({ github, context, directory, tag, commit }) {
  const release = parseReleaseTag(tag)
  const manifest = await verifyReleaseArtifacts(directory, { tag, commit })
  const repo = { owner: context.repo.owner, repo: context.repo.repo }
  if (await resolveRemoteCommit(github, repo, tag) !== commit) throw new Error('远程 tag 在构建后发生变化，已拒绝发布')
  const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 })
  let existing = releases.find(item => item.tag_name === tag)
  if (existing && !existing.draft) throw new Error(`${tag} 已公开发布，不自动覆盖已有发布；请使用新版本号`)
  if (existing && !existing.body?.includes(MANAGED_MARKER)) throw new Error(`${tag} 已有非 Actions 创建的草稿，不自动覆盖`)
  let latestTag = null
  try { latestTag = (await github.rest.repos.getLatestRelease(repo)).data.tag_name }
  catch (error) { if (error.status !== 404) throw error }
  const makeLatest = shouldBecomeLatest(tag, latestTag)
  const generated = await github.rest.repos.generateReleaseNotes({ ...repo, tag_name: tag, target_commitish: commit })
  const body = `${MANAGED_MARKER}\n${generated.data.body || ''}\n\n### macOS Apple Silicon\n\n要求 macOS 12.3 或更新版本，Apple Silicon（M 系列）处理器。下载 DMG 安装；也提供压缩后的 app 与 SHA256SUMS 校验文件。\n\n当前为 ad-hoc 签名，未进行 Apple Developer ID 签名或公证。应用内检查更新只打开发布页或安装包链接，不自动下载替换正在运行的应用。升级前建议导出完整备份。\n\n构建提交：\`${commit}\`。`
  if (!existing) {
    existing = (await github.rest.repos.createRelease({ ...repo, tag_name: tag, target_commitish: commit, name: `AI 创作工作台 ${tag}`, body, draft: true, prerelease: release.prerelease.length > 0, make_latest: 'false' })).data
  } else {
    await github.rest.repos.updateRelease({ ...repo, release_id: existing.id, body, draft: true, target_commitish: commit, prerelease: release.prerelease.length > 0, make_latest: 'false' })
    const oldAssets = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: existing.id, per_page: 100 })
    for (const asset of oldAssets) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id })
  }
  // Failures leave only a private draft; retries replace its incomplete asset set.
  for (const asset of manifest.assets) {
    const data = await readFile(join(directory, asset.name))
    const contentType = asset.name.endsWith('.dmg') ? 'application/x-apple-diskimage' : asset.name.endsWith('.zip') ? 'application/zip' : asset.name.endsWith('.json') ? 'application/json' : 'text/plain'
    await github.rest.repos.uploadReleaseAsset({ ...repo, release_id: existing.id, name: asset.name, data, headers: { 'content-type': contentType, 'content-length': data.length } })
  }
  const uploaded = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: existing.id, per_page: 100 })
  if (uploaded.length !== manifest.assets.length || manifest.assets.some(asset => !uploaded.some(remote => remote.name === asset.name && remote.size === asset.size && remote.state === 'uploaded' && (!remote.digest || remote.digest === `sha256:${asset.sha256}`)))) throw new Error('GitHub 发布附件不完整或校验不匹配，保留草稿等待重试')
  if (await resolveRemoteCommit(github, repo, tag) !== commit) throw new Error('远程 tag 在上传期间发生变化，保留草稿且不发布')
  const published = await github.rest.repos.updateRelease({ ...repo, release_id: existing.id, draft: false, prerelease: release.prerelease.length > 0, make_latest: makeLatest ? 'true' : 'false' })
  return { url: published.data.html_url, tag, latest: makeLatest, assets: uploaded.map(asset => asset.name) }
}
