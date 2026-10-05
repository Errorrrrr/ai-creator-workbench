import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parseReleaseTag, compareVersions, validateReleaseVersions, resolveReleaseRef, checkRelease } from '../scripts/check-release-version.mjs'
import { createReleaseManifest, verifyReleaseArtifacts, releaseAssetNames } from '../scripts/release-artifacts.mjs'
import { publishRelease, shouldBecomeLatest } from '../scripts/publish-release.mjs'

const commit = 'a'.repeat(40)
function versionFiles(version = '0.3.0') {
  return {
    'package.json': JSON.stringify({ name: 'ai-creator-workbench', version }),
    'package-lock.json': JSON.stringify({ name: 'ai-creator-workbench', version, packages: { '': { name: 'ai-creator-workbench', version } } }),
    'src-tauri/tauri.conf.json': JSON.stringify({ productName: 'AI Creator Workbench', version, identifier: 'com.aicreator.workbench' }),
    'src-tauri/Cargo.toml': `[package]\nname = "ai-creator-workbench"\nversion = "${version}"\n[dependencies]\nother = "99.0.0"\n`,
    'src-tauri/Cargo.lock': `version = 4\n[[package]]\nname = "other"\nversion = "99.0.0"\n[[package]]\nname = "ai-creator-workbench"\nversion = "${version}"\ndependencies = ["other"]\n`,
  }
}

test('release tags accept strict SemVer and reject shell/ref/control-character injection', () => {
  for (const tag of ['v0.3.0', 'v1.2.3-rc.1', 'v1.2.3+build.01']) assert.equal(parseReleaseTag(tag).tag, tag)
  for (const tag of ['0.3.0', 'v01.3.0', 'v1.2', 'v1.2.3-01', 'v1.2.3\n', 'v1.2.3;echo secret', 'v1.2.3$(id)', 'v1.2.3`id`', 'v1.2.3^{commit}', '--help', 'refs/tags/v0.3.0', 'v1.2.3/foo', 'v1.2.3 rc1']) assert.throws(() => parseReleaseTag(tag), undefined, tag)
})

test('tag must match package, npm lock root, Tauri, Cargo and application Cargo.lock versions', () => {
  assert.equal(validateReleaseVersions(versionFiles(), 'v0.3.0').version, '0.3.0')
  for (const path of Object.keys(versionFiles())) {
    const files = versionFiles()
    files[path] = files[path].replaceAll('0.3.0', '0.3.1')
    assert.throws(() => validateReleaseVersions(files, 'v0.3.0'), /不一致/, path)
  }
  const files = versionFiles()
  const lock = JSON.parse(files['package-lock.json'])
  lock.packages[''].version = '0.3.1'
  files['package-lock.json'] = JSON.stringify(lock)
  assert.throws(() => validateReleaseVersions(files, 'v0.3.0'), /packages/)
})

test('manual release must resolve an existing tag and validates files at that immutable tag', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-release-git-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', ...args], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--quiet', '--initial-branch=main')
  await mkdir(join(directory, 'src-tauri'))
  for (const [path, value] of Object.entries(versionFiles())) await writeFile(join(directory, path), value)
  git('add', '.')
  git('commit', '--quiet', '-m', 'release fixture')
  git('tag', 'v0.3.0')
  const sha = git('rev-parse', 'HEAD')
  assert.equal(resolveReleaseRef('v0.3.0', directory), sha)
  assert.equal(checkRelease('v0.3.0', { root: directory }).commit, sha)
  assert.throws(() => resolveReleaseRef('v9.9.9', directory), /不存在/)
  await writeFile(join(directory, 'package.json'), versionFiles('0.4.0')['package.json'])
  assert.throws(() => checkRelease('v0.3.0', { root: directory }), /不一致/)
  assert.equal(checkRelease('v0.3.0', { root: directory, fromTag: true }).version, '0.3.0')
  git('add', '.')
  git('commit', '--quiet', '-m', 'later fixture')
  assert.throws(() => checkRelease('v0.3.0', { root: directory }), /HEAD/)
})

test('only a newer stable release can become Latest', () => {
  assert.equal(shouldBecomeLatest('v0.3.0', 'v0.2.3'), true)
  assert.equal(shouldBecomeLatest('v0.2.3', 'v0.3.0'), false)
  assert.equal(shouldBecomeLatest('v0.3.0', 'v0.3.0'), false)
  assert.equal(shouldBecomeLatest('v0.4.0-rc.1', 'v0.3.0'), false)
  assert.equal(shouldBecomeLatest('v0.3.0'), true)
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.10'), 1)
  assert.equal(compareVersions('1.0.0+abc', '1.0.0+def'), 0)
})

async function artifacts(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-release-assets-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const release = { tag: 'v0.3.0', version: '0.3.0', commit }
  const names = releaseAssetNames(release.version)
  await writeFile(join(directory, names[0]), 'synthetic DMG bytes')
  await writeFile(join(directory, names[1]), 'synthetic app ZIP bytes')
  const manifest = await createReleaseManifest(directory, release)
  return { directory, release, manifest, names }
}

test('release artifacts are complete, regular non-empty files and match their SHA256 manifest', async t => {
  const { directory, release, names } = await artifacts(t)
  assert.equal((await verifyReleaseArtifacts(directory, release)).assets.length, 3)
  await writeFile(join(directory, names[0]), 'tampered')
  await assert.rejects(verifyReleaseArtifacts(directory, release), /校验失败/)
})

test('missing, unexpected or renamed artifacts cannot pass publication validation', async t => {
  const { directory, release, names } = await artifacts(t)
  await writeFile(join(directory, 'unexpected.key'), 'synthetic extra file')
  await assert.rejects(verifyReleaseArtifacts(directory, release), /意外或缺失/)
  await rm(join(directory, 'unexpected.key'))
  await rm(join(directory, names[0]))
  await assert.rejects(verifyReleaseArtifacts(directory, release), /意外或缺失/)
})

function fakeGithub({ failUpload = 0, latest = 'v0.2.3', remoteCommit = commit, existing = null } = {}) {
  const events = [], assets = []
  let uploadCount = 0
  const repos = {
    listReleases: async () => ({ data: existing ? [existing] : [] }),
    listReleaseAssets: async () => ({ data: assets }),
    getLatestRelease: async () => ({ data: { tag_name: latest } }),
    generateReleaseNotes: async () => ({ data: { body: 'Notes containing `$(not-a-shell-command)` are plain data.' } }),
    createRelease: async args => { events.push({ type: 'create', args }); return { data: { id: 1, draft: true } } },
    uploadReleaseAsset: async args => {
      uploadCount++
      if (uploadCount === failUpload) throw new Error('synthetic upload failure')
      assets.push({ name: args.name, size: args.data.length, state: 'uploaded', digest: `sha256:${createHash('sha256').update(args.data).digest('hex')}` })
      events.push({ type: 'upload', name: args.name })
    },
    deleteReleaseAsset: async () => {},
    updateRelease: async args => { events.push({ type: 'update', args }); return { data: { html_url: 'https://github.com/Errorrrrr/ai-creator-workbench/releases/tag/v0.3.0' } } },
  }
  return { events, assets, github: { rest: { repos, git: { getRef: async () => ({ data: { object: { type: 'commit', sha: remoteCommit } } }) } }, paginate: async (method, args) => (await method(args)).data } }
}
const context = { repo: { owner: 'Errorrrrr', repo: 'ai-creator-workbench' } }

test('publication uploads and verifies all assets privately before making one final public release', async t => {
  const { directory, release } = await artifacts(t)
  const fake = fakeGithub()
  const result = await publishRelease({ github: fake.github, context, directory, ...release })
  assert.equal(fake.events[0].type, 'create')
  assert.equal(fake.events[0].args.draft, true)
  assert.equal(fake.events[0].args.make_latest, 'false')
  assert.equal(fake.events.filter(event => event.type === 'upload').length, 3)
  assert.equal(fake.events.at(-1).args.draft, false)
  assert.equal(fake.events.at(-1).args.make_latest, 'true')
  assert.equal(result.assets.length, 3)
})

test('failed uploads stay private and cannot replace Latest with a partial release', async t => {
  const { directory, release } = await artifacts(t)
  const fake = fakeGithub({ failUpload: 2 })
  await assert.rejects(publishRelease({ github: fake.github, context, directory, ...release }), /upload failure/)
  assert.ok(fake.events.every(event => event.args?.draft !== false))
  assert.equal(fake.events[0].args.make_latest, 'false')
})

test('moved tags and already-published releases are rejected before any GitHub mutation', async t => {
  const { directory, release } = await artifacts(t)
  for (const settings of [{ remoteCommit: 'b'.repeat(40) }, { existing: { tag_name: 'v0.3.0', draft: false } }]) {
    const fake = fakeGithub(settings)
    await assert.rejects(publishRelease({ github: fake.github, context, directory, ...release }))
    assert.deepEqual(fake.events, [])
  }
})

test('release workflow only grants publish write permission and gates it on the build', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.equal((workflow.match(/contents: write/g) || []).length, 1)
  assert.match(workflow, /needs: build/)
  for (const command of ['npm ci', 'npm run check', 'npm test', 'npm run build:web', 'cargo test --locked', 'release-artifacts.mjs']) assert.ok(workflow.includes(command))
  assert.ok(workflow.indexOf('cargo test --locked') < workflow.indexOf('Build the app and DMG'))
  assert.match(workflow, /workbench-release-publication/)
  assert.ok(!workflow.includes('${{ inputs.tag }}'), 'tag is passed as environment data, not directly interpolated into shell code')
})
