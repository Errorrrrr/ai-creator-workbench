import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createShot, findMediaVersion, prepareShotInputs, videoParameterState, validateVideoParameters, validateStoryboard, mediaPrompt, resolveConnectionRoute } from '../src/storyboard.js'
import { mediaAdapterFor } from '../src/media-adapters.js'

const connection = { id: 'veo-resource', kind: 'video-api', adapter: 'veo', name: '视频资源', model: 'veo-3.1-generate-preview' }
const image = id => ({ id: `asset-${id}`, name: id, kind: 'image', role: 'shot', versions: [{ id, mimeType: 'image/png', bytes: 1024 }] })
const assets = [image('start'), image('end'), image('subject'), { id: 'asset-video', name: 'clip', kind: 'video', versions: [{ id: 'clip', mimeType: 'video/mp4', bytes: 1024, metadata: { provenance: { model: connection.model, connectionId: connection.id } } }] }]
const shot = (patch = {}) => ({ ...createShot({ title: '分镜一', visual: '人物走过街道' }), selectedImageVersionId: 'start', ...patch })
const validate = (value, sourceAssets = assets, resource = connection) => validateVideoParameters(value, sourceAssets, resource, prepareShotInputs(value, sourceAssets, 'video'))

test('默认 5 秒在预览前说明不兼容，明确选择执行时长后不改剧情时长', () => {
  const value = shot()
  assert.equal(value.duration, 5)
  assert.match(videoParameterState(value, connection).issues.join('；'), /生成时长 5 秒不兼容.*4／6／8.*剧情时长 5 秒保持不变/)
  assert.throws(() => validate(value), /生成设置中明确选择/)
  for (const seconds of [4, 6, 8]) {
    value.videoDuration = seconds
    const state = validate(value)
    assert.equal(state.duration, seconds); assert.equal(value.duration, 5)
    validateStoryboard(JSON.parse(JSON.stringify({ revision: 0, shots: [value] })))
  }
  value.videoDuration = 0
  assert.throws(() => validateStoryboard({ revision: 0, shots: [value] }), /视频生成时长/)
  delete value.videoDuration; value.duration = 6
  assert.equal(validate(value).duration, 6)
})

test('Veo 画幅、模型和各模式数量均前置校验，主体参考与续接要求 8 秒', () => {
  const value = shot({ videoDuration: 4, aspectRatio: '1:1' })
  assert.throws(() => validate(value), /不支持 1:1.*16:9 或 9:16/)
  value.aspectRatio = '9:16'
  assert.equal(validate(value).aspectRatio, '9:16')
  assert.throws(() => validate(value, assets, { ...connection, model: 'unknown' }), /模型/)
  value.videoMode = 'first-last'
  assert.throws(() => validate(value), /各 1 张/)
  value.references = [{ versionId: 'end', role: 'end', scope: 'video' }]
  assert.equal(validate(value).duration, 4)
  value.videoMode = 'reference-to-video'; value.references = [{ versionId: 'subject', role: 'reference' }]
  assert.throws(() => validate(value), /主体参考模式支持 8 秒/)
  value.videoDuration = 8
  assert.equal(validate(value).duration, 8)
  value.references = []
  assert.throws(() => validate(value), /1–3 张/)
  value.references = Array.from({ length: 4 }, () => ({ versionId: 'subject', role: 'reference' }))
  assert.throws(() => validate(value), /1–3 张/)
  value.videoMode = 'image-to-video'; value.references = [{ versionId: 'subject', role: 'reference', scope: 'video' }]
  assert.throws(() => validate(value), /显式视频输入用途冲突/)
})

test('续接拒绝导入、其他执行端、非原生视频；不支持的媒体格式和上传大小在提交前说明', () => {
  const value = shot({ videoDuration: 8, videoMode: 'extend', references: [{ versionId: 'clip', role: 'extend' }] })
  assert.equal(validate(value).duration, 8)
  value.videoDuration = 6
  assert.throws(() => validate(value), /原生视频续接支持 8 秒/)
  value.videoDuration = 8
  for (const provenance of [{}, { model: connection.model, connectionId: 'other' }, { model: 'other-model', connectionId: connection.id }]) {
    const imported = structuredClone(assets); imported.at(-1).versions[0].metadata.provenance = provenance
    assert.throws(() => validate(value, imported), /同一执行端生成的原生/)
  }
  value.references = [{ versionId: 'start', role: 'extend' }]
  assert.throws(() => validate(value), /续接输入必须是视频/)
  value.videoMode = 'image-to-video'; value.references = [{ versionId: 'clip', role: 'start' }]
  assert.throws(() => validate(value), /PNG、JPEG 或 WebP/)
  value.references = []
  const huge = structuredClone(assets); huge[0].versions[0].bytes = 51 * 1024 * 1024
  assert.throws(() => validate(value, huge), /50 MiB/)
  const gif = structuredClone(assets); gif[0].versions[0].mimeType = 'image/gif'
  assert.throws(() => validate(value, gif), /PNG、JPEG 或 WebP/)
})

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  assert.ok(match, name)
  const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
  return body.slice(0, end.index + end[0].length)
}
function harness(shots) {
  const data = { projectId: 'project', project: { name: '测试', type: 'script' }, storyboard: { revision: 1, shots }, documents: {} }
  const calls = { secret: 0, invoke: 0 }, notices = []
  const env = {
    context: () => data, connectionFor: capability => capability === 'video' ? connection : { id: 'images', kind: 'image-api', adapter: 'openai-images' },
    prepareShotInputs, videoParameterState, validateVideoParameters, mediaAdapterFor, findMediaVersion, mediaPrompt, resolveConnectionRoute,
    assets, loading: false, error: '', jobs: [], terminal: () => true, BATCH_LIMIT: 20, batchSelection: new Set(shots.map(value => value.id)),
    invoke: async () => { calls.invoke++; return {} }, secret: async () => { calls.secret++; return 'test-only' }, requireProject() {}, desktop() {}, requireAdapterCatalog: async () => {},
    run: callback => callback(), batchSignature: requests => JSON.stringify(requests), beforeSubmit: null,
    changeStoryboard: async edit => { const next = structuredClone(data.storyboard.shots); edit(next); data.storyboard.shots = next; data.storyboard.revision++ },
    renderShots() {}, refreshReferenceDetails() {}, renderGenerationReadiness() {}, renderBatchSelection() {}, invalidateBatchPlan: text => notices.push(text)
  }
  vm.createContext(env)
  vm.runInContext(['prepareShotRequest', 'batchRequests', 'setBatchVideoDuration', 'submitShot'].map(productionFunction).join('\n'), env)
  return { env, data, calls, notices }
}

test('实际提交入口在凭据和原生调用前拦截不兼容参数，图片请求不受视频时长影响', async () => {
  const value = shot(), { env, calls } = harness([value])
  await assert.rejects(env.submitShot(value.id, 'video'), /生成时长 5 秒不兼容/)
  assert.deepEqual(calls, { secret: 0, invoke: 0 })
  value.videoDuration = 6
  assert.equal(env.prepareShotRequest(value.id, 'video').parameters.duration, 6)
  assert.equal(env.prepareShotRequest(value.id, 'image').parameters.duration, 5)
})

test('批量预览汇总每个不兼容镜头，显式统一生成时长仅修改已选镜头', async () => {
  const first = shot(), second = shot({ title: '分镜二', duration: 7 }), third = shot({ title: '分镜三', duration: 3 })
  const { env, data, notices } = harness([first, second, third])
  env.batchSelection = new Set([first.id, second.id])
  assert.throws(() => env.batchRequests('video'), /有 2 个镜头[\s\S]*分镜一[\s\S]*分镜二/)
  await assert.rejects(env.setBatchVideoDuration(0), /明确选择/)
  await env.setBatchVideoDuration(6)
  assert.deepEqual(data.storyboard.shots.map(value => value.duration), [5, 7, 3])
  assert.deepEqual(data.storyboard.shots.map(value => value.videoDuration), [6, 6, undefined])
  assert.deepEqual(Array.from(env.batchRequests('video'), request => request.parameters.duration), [6, 6])
  assert.match(notices[0], /剧情时长保持不变/)
})
