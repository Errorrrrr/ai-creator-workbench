import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createShot, validateStoryboard, snapshotStoryboardSource, SHOT_LIMIT } from '../src/storyboard.js'
import { storyboardGroups, replaceSourceShots } from '../src/storyboard-scope.js'
import { planShotImageResults, imageResultCheckpoint } from '../src/shot-image-results.js'

const projectId = 'project-1'
const first = '1793066400000', second = '1793066460000', third = '1793066520000'
const shot = (id = 'shot-1', selectedImageVersionId = '') => ({
  ...createShot({ title: id, visual: '人物走向窗边' }, { documentId: 'scene-1' }), id, selectedImageVersionId,
})
const job = (id, targetId = 'shot-1', createdAt = first, patch = {}) => ({
  id, projectId, targetId, capability: 'image', status: 'completed', createdAt,
  updatedAt: createdAt, assetId: `asset-${targetId}`, request: { projectId, targetId, capability: 'image' }, ...patch,
})
const version = (id, jobId, artifact = 'output-1.png', patch = {}) => ({
  id, fileId: `file-${id}`, mimeType: 'image/png', createdAt: first,
  metadata: { provenance: { jobId, artifact } }, ...patch,
})
const asset = (versions, targetId = 'shot-1', patch = {}) => ({
  id: `asset-${targetId}`, projectId, kind: 'image', role: 'shot', versions,
  selectedVersionId: versions[0]?.id || '', ...patch,
})
const board = (...shots) => ({ revision: 7, shots })
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  assert.ok(match, name)
  const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
  return body.slice(0, end.index + end[0].length)
}
function historyHarness(current, saved, jobs) {
  const buttons = [], commits = []
  const data = {
    projectId, documents: { 'scene-1': { title: '第一场' } },
    storyboard: { ...board(current), sourceVersions: [{ id: 'history-1', createdAt: new Date(Number(first)).toISOString(), sourceDocumentId: 'scene-1', label: '旧版本', shots: [saved] }] },
  }
  const node = () => ({ append() {}, addEventListener() {}, showModal() {}, close() {}, remove() {} })
  const env = {
    context: () => data, selectedSourceId: 'scene-1', selectedEpisodeId: '', selectedShotId: '', jobs,
    structuredClone, storyboardGroups, snapshotStoryboardSource, replaceSourceShots, imageResultCheckpoint, SHOT_LIMIT,
    el: node, disclosure: node, mediaTimeLabel: value => value,
    button: (text, action) => { buttons.push({ text, action }); return node() },
    document: { body: node() }, window: { confirm: () => true }, run: action => action(),
    showSource() {}, renderSources() {}, renderShots() {}, notify() {},
    commit: async (patch, options) => { validateStoryboard(patch.storyboard); commits.push(options); Object.assign(data, patch) },
  }
  vm.createContext(env)
  vm.runInContext(['changeStoryboard', 'showStoryboardVersions'].map(productionFunction).join('\n'), env)
  env.showStoryboardVersions()
  return { data, commits, restore: () => buttons.find(button => button.text === '恢复此分场版本').action() }
}

test('历史恢复真实入口保留旧选图，并阻止已完成或运行中任务随后覆盖；再次生成仍自动关联', async () => {
  for (const status of ['completed', 'running']) {
    const saved = shot('shot-1', 'old-image')
    saved.imageResultCheckpoint = { jobId: 'old', createdAt: first }
    const current = shot('shot-1', 'new-image'), latest = job('new', 'shot-1', second, { status })
    const jobs = [job('old'), latest]
    const { data, commits, restore } = historyHarness(current, saved, jobs)
    const savedBefore = structuredClone(saved)
    await restore()
    assert.equal(commits.length, 1)
    assert.equal(commits[0].immediate, true)
    assert.equal(data.storyboard.shots[0].selectedImageVersionId, 'old-image', status)
    assert.deepEqual({ ...data.storyboard.shots[0].imageResultCheckpoint }, { jobId: 'new', createdAt: second }, status)
    assert.deepEqual(saved, savedBefore)
    assert.equal(data.storyboard.sourceVersions[0].shots[0].selectedImageVersionId, 'new-image')
    const assets = [asset([version('old-image', 'old'), version('new-image', 'new'), version('next-image', 'next')])]
    const completed = planShotImageResults(data.storyboard, assets, jobs.map(item => ({ ...item, status: 'completed' })), projectId)
    assert.equal(completed.changed, 0, status)
    assert.equal(completed.storyboard.shots[0].selectedImageVersionId, 'old-image', status)
    const regenerated = planShotImageResults(completed.storyboard, assets, [...jobs, job('next', 'shot-1', third)], projectId)
    assert.equal(regenerated.storyboard.shots[0].selectedImageVersionId, 'next-image', status)
  }
})

test('历史恢复真实入口在任务列表缺失时不降低当前或历史已处理水位', async () => {
  for (const [currentCheckpoint, savedCheckpoint, expected] of [
    [{ jobId: 'new', createdAt: second }, { jobId: 'old', createdAt: first }, { jobId: 'new', createdAt: second }],
    [undefined, { jobId: 'old', createdAt: first }, { jobId: 'old', createdAt: first }],
    [{ jobId: 'job-a', createdAt: second }, { jobId: 'job-z', createdAt: new Date(Number(second)).toISOString() }, { jobId: 'job-z', createdAt: new Date(Number(second)).toISOString() }],
  ]) {
    const current = shot('shot-1', 'new-image'), saved = shot('shot-1', 'old-image')
    if (currentCheckpoint) current.imageResultCheckpoint = currentCheckpoint
    if (savedCheckpoint) saved.imageResultCheckpoint = savedCheckpoint
    const { data, restore } = historyHarness(current, saved, [])
    await restore()
    assert.equal(data.storyboard.shots[0].selectedImageVersionId, 'old-image')
    assert.deepEqual({ ...data.storyboard.shots[0].imageResultCheckpoint }, expected)
  }
})

test('已完成图片按任务来源关联原镜头，不使用素材仍指向旧图的默认版本', () => {
  const jobs = [job('old'), job('new', 'shot-1', second)]
  const assets = [asset([version('old-image', 'old'), version('new-image', 'new')])]
  const result = planShotImageResults(board(shot()), assets, jobs, projectId)
  assert.equal(result.changed, 1)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'new-image')
  assert.deepEqual(result.storyboard.shots[0].imageResultCheckpoint, { jobId: 'new', createdAt: second })
  assert.deepEqual(result.linked, [{ shotId: 'shot-1', jobId: 'new', versionId: 'new-image' }])
})

test('批量图片分别关联任务所属镜头，不受任务和素材返回顺序影响', () => {
  const jobs = [job('job-b', 'shot-b', second), job('job-a', 'shot-a')]
  const assets = [asset([version('image-a', 'job-a')], 'shot-a'), asset([version('image-b', 'job-b')], 'shot-b')]
  const result = planShotImageResults(board(shot('shot-a'), shot('shot-b')), assets, jobs, projectId)
  assert.equal(result.changed, 2)
  assert.deepEqual(result.storyboard.shots.map(item => item.selectedImageVersionId), ['image-a', 'image-b'])
  assert.deepEqual(result.linked.map(item => item.shotId).sort(), ['shot-a', 'shot-b'])
})

test('任务按发起时间确定新旧，旧任务晚收录不能覆盖新结果', () => {
  const jobs = [job('old', 'shot-1', first, { updatedAt: third }), job('new', 'shot-1', second)]
  const assets = [asset([version('late-old-image', 'old'), version('new-image', 'new')])]
  const result = planShotImageResults(board(shot()), assets, jobs, projectId)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'new-image')
})

test('最新任务未成功时保留当前图片，不回落选用更早完成的任务', () => {
  for (const status of ['queued', 'submitting', 'running', 'downloading', 'failed', 'cancelled', 'submission_unknown']) {
    const original = board(shot())
    const jobs = [job('new', 'shot-1', second, { status }), job('old')]
    const result = planShotImageResults(original, [asset([version('old-image', 'old')])], jobs, projectId)
    assert.equal(result.changed, 0, status)
    assert.deepEqual(result.storyboard, original, status)
    assert.deepEqual(result.linked, [], status)
  }
})

test('重启及重复刷新遵守持久水位，不反复选用同一结果', () => {
  const jobs = [job('new', 'shot-1', second)], assets = [asset([version('new-image', 'new')])]
  const firstRun = planShotImageResults(board(shot()), assets, jobs, projectId)
  const restart = planShotImageResults(JSON.parse(JSON.stringify(firstRun.storyboard)), assets, jobs, projectId)
  assert.equal(restart.changed, 0)
  assert.deepEqual(restart.linked, [])
  assert.deepEqual(restart.storyboard, firstRun.storyboard)
})

test('持久水位阻止更早结果回填，即使当前选用图已被手动清空', () => {
  const current = shot(); current.imageResultCheckpoint = { jobId: 'new', createdAt: second }
  const original = board(current)
  const result = planShotImageResults(original, [asset([version('old-image', 'old')])], [job('old')], projectId)
  assert.equal(result.changed, 0); assert.deepEqual(result.storyboard, original)
})

test('未记录水位时，同镜头的旧生成图可自动换为新任务结果', () => {
  const current = shot('shot-1', 'old-image')
  const jobs = [job('old'), job('new', 'shot-1', second)]
  const result = planShotImageResults(board(current), [asset([version('old-image', 'old'), version('new-image', 'new')])], jobs, projectId)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'new-image')
  assert.equal(result.linked.length, 1)
})

test('首次迁移保留已手选的导入图片，但记录最新结果水位避免反复覆盖', () => {
  const current = shot('shot-1', 'imported-image'), jobs = [job('new', 'shot-1', second)]
  const imported = asset([{ id: 'imported-image', mimeType: 'image/png', metadata: { provenance: { source: 'import' } } }], 'imported')
  const result = planShotImageResults(board(current), [imported, asset([version('new-image', 'new')])], jobs, projectId)
  assert.equal(result.changed, 1)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'imported-image')
  assert.deepEqual(result.storyboard.shots[0].imageResultCheckpoint, { jobId: 'new', createdAt: second })
  assert.deepEqual(result.linked, [])
})

test('首次迁移保留复用其他镜头的图片，不能只凭provenance是生成图片就替换', () => {
  const jobs = [job('other-job', 'shot-other'), job('new', 'shot-1', second)]
  const assets = [asset([version('other-image', 'other-job')], 'shot-other'), asset([version('new-image', 'new')])]
  const result = planShotImageResults(board(shot('shot-1', 'other-image')), assets, jobs, projectId)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'other-image')
  assert.deepEqual(result.storyboard.shots[0].imageResultCheckpoint, { jobId: 'new', createdAt: second })
  assert.deepEqual(result.linked, [])
})

test('手选时记录运行中任务水位，该任务完成后保留手选，再次生成仍可自动选用', () => {
  const running = job('new', 'shot-1', second, { status: 'running' })
  const current = shot('shot-1', 'manual-image')
  current.imageResultCheckpoint = imageResultCheckpoint(current.id, [running], projectId)
  assert.deepEqual(current.imageResultCheckpoint, { jobId: 'new', createdAt: second })
  const assets = [asset([version('new-image', 'new'), version('next-image', 'next')])]
  const completed = planShotImageResults(board(current), assets, [{ ...running, status: 'completed' }], projectId)
  assert.equal(completed.changed, 0); assert.equal(completed.storyboard.shots[0].selectedImageVersionId, 'manual-image')
  const regenerated = planShotImageResults(completed.storyboard, assets, [job('next', 'shot-1', third), { ...running, status: 'completed' }], projectId)
  assert.equal(regenerated.storyboard.shots[0].selectedImageVersionId, 'next-image')
  assert.deepEqual(regenerated.linked, [{ shotId: 'shot-1', jobId: 'next', versionId: 'next-image' }])
})

test('已选用同一任务的其他产物时只补水位，保留用户选择', () => {
  const jobs = [job('new', 'shot-1', second)]
  const assets = [asset([version('first-image', 'new', 'image-1.png'), version('chosen-image', 'new', 'image-2.png')])]
  const result = planShotImageResults(board(shot('shot-1', 'chosen-image')), assets, jobs, projectId)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'chosen-image')
  assert.deepEqual(result.storyboard.shots[0].imageResultCheckpoint, { jobId: 'new', createdAt: second })
  assert.deepEqual(result.linked, [])
})

test('跨项目任务、角色图片、视频及恢复历史不参与图片选用或水位计算', () => {
  const jobs = [
    job('cross-project', 'shot-1', third, { projectId: 'project-2' }),
    job('character', 'shot-1', third, { request: { character: { name: '角色' } } }),
    job('video', 'shot-1', third, { capability: 'video' }),
    job('restored', 'shot-1', third, { restored: true }),
    job('other-shot', 'shot-2', third),
  ]
  const original = board(shot()), result = planShotImageResults(original, [asset(jobs.map(item => version(`${item.id}-image`, item.id)))], jobs, projectId)
  assert.equal(result.changed, 0); assert.deepEqual(result.storyboard, original)
  assert.equal(imageResultCheckpoint('shot-1', jobs, projectId), null)
})

test('缺失或不属于本项目的素材及版本不会关联，也不推进水位', () => {
  const jobs = [job('new')]
  const cases = [
    [],
    [asset([version('new-image', 'new')], 'shot-1', { projectId: 'project-2' })],
    [asset([version('new-image', 'new')], 'shot-1', { kind: 'video' })],
    [asset([version('unrelated-image', 'other-job')])],
    [asset([version('not-image', 'new', 'video.mp4', { mimeType: 'video/mp4' })])],
  ]
  for (const assets of cases) {
    const original = board(shot()), result = planShotImageResults(original, assets, jobs, projectId)
    assert.equal(result.changed, 0); assert.deepEqual(result.storyboard, original)
    assert.deepEqual(result.linked, [])
  }
})

test('任务完成但产物暂未读到时可稍后重试，不提前标记已处理', () => {
  const jobs = [job('new')], original = board(shot())
  const missing = planShotImageResults(original, [], jobs, projectId)
  assert.equal(missing.storyboard.shots[0].imageResultCheckpoint, undefined)
  const recovered = planShotImageResults(missing.storyboard, [asset([version('new-image', 'new')])], jobs, projectId)
  assert.equal(recovered.storyboard.shots[0].selectedImageVersionId, 'new-image')
  assert.equal(recovered.linked.length, 1)
})

test('多产物按文件序号稳定选择首张，忽略版本数组与默认选用顺序', () => {
  const versions = [version('image-10', 'new', 'output-10.png'), version('image-2', 'new', 'output-2.png'), version('image-1', 'new', 'output-1.png')]
  const result = planShotImageResults(board(shot()), [asset(versions)], [job('new')], projectId)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'image-1')
  const withoutOne = planShotImageResults(board(shot()), [asset(versions.slice(0, 2))], [job('new')], projectId)
  assert.equal(withoutOne.storyboard.shots[0].selectedImageVersionId, 'image-2')
})

test('时间相同按任务ID稳定排序，毫秒字符串与ISO时间均可比较', () => {
  const iso = new Date(Number(second)).toISOString()
  const jobs = [job('job-a', 'shot-1', iso), job('job-z', 'shot-1', second), job('job-old', 'shot-1', first)]
  assert.deepEqual(imageResultCheckpoint('shot-1', jobs, projectId), { jobId: 'job-z', createdAt: second })
  const result = planShotImageResults(board(shot()), [asset(jobs.map(item => version(`${item.id}-image`, item.id)))], jobs, projectId)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'job-z-image')
})

test('无效发起时间不参与排序或阻挡有效任务', () => {
  const invalid = ['', 'not-a-date', 'NaN', null, undefined].map((createdAt, index) => job(`invalid-${index}`, 'shot-1', createdAt, { createdAt }))
  assert.equal(imageResultCheckpoint('shot-1', invalid, projectId), null)
  const jobs = [...invalid, job('valid')]
  assert.deepEqual(imageResultCheckpoint('shot-1', jobs, projectId), { jobId: 'valid', createdAt: first })
  const result = planShotImageResults(board(shot()), [asset([version('valid-image', 'valid')])], jobs, projectId)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'valid-image')
})

test('纯计划不修改输入、固定参考、选用视频或分镜历史，已删除镜头不被重新创建', () => {
  const current = shot(); current.references = [{ versionId: 'reference-1', role: 'reference', origin: 'manual' }]
  current.selectedVideoVersionId = 'video-1'; current.reviewedVideoVersionId = 'video-1'; current.reviewedInputFingerprint = 'v1:old-input'
  const original = board(current)
  original.sourceVersions = [{ id: 'history-1', sourceDocumentId: 'scene-1', shots: [structuredClone(current)] }]
  const jobs = [job('new'), job('deleted-job', 'deleted-shot')]
  const assets = [asset([version('new-image', 'new')]), asset([version('deleted-image', 'deleted-job')], 'deleted-shot')]
  const expected = structuredClone({ original, jobs, assets })
  freeze(original); freeze(jobs); freeze(assets)
  const result = planShotImageResults(original, assets, jobs, projectId)
  assert.deepEqual({ original, jobs, assets }, expected)
  assert.equal(result.storyboard.shots.length, 1)
  for (const key of ['references', 'selectedVideoVersionId', 'reviewedVideoVersionId', 'reviewedInputFingerprint']) assert.deepEqual(result.storyboard.shots[0][key], original.shots[0][key])
  assert.deepEqual(result.storyboard.sourceVersions, original.sourceVersions)
  assert.equal(result.storyboard.shots[0].selectedImageVersionId, 'new-image')
})

test('图片关联水位可随分镜序列化并校验，损坏记录被拒绝', () => {
  for (const createdAt of [first, new Date(Number(first)).toISOString()]) {
    const current = shot(); current.imageResultCheckpoint = { jobId: 'job-1', createdAt }
    const persisted = JSON.parse(JSON.stringify(board(current)))
    assert.deepEqual(validateStoryboard(persisted).shots[0].imageResultCheckpoint, current.imageResultCheckpoint)
  }
  const corrupt = [null, 'job-1', {}, { jobId: '', createdAt: first }, { jobId: '../job', createdAt: first }, { jobId: 'a'.repeat(97), createdAt: first }, { jobId: 'job-1', createdAt: 'invalid-date' }, { jobId: 'job-1', createdAt: Number(first) }]
  for (const checkpoint of corrupt) {
    const current = shot(); current.imageResultCheckpoint = checkpoint
    assert.throws(() => validateStoryboard(board(current)), /图片关联记录无效/)
  }
})
