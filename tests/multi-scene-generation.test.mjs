import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createShot, contentFingerprint, prepareShotInputs, videoParameterState, validateVideoParameters, findMediaVersion, mediaPrompt, resolveConnectionRoute, shotIsStale } from '../src/storyboard.js'
import { mediaAdapterFor } from '../src/media-adapters.js'
import { storyboardSceneEntries, shotsForScenes, UNASSIGNED_SOURCE } from '../src/storyboard-scope.js'

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  assert.ok(match, name)
  const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
  return body.slice(0, end.index + end[0].length)
}
class Node {
  constructor(tag = '', text = '') { this.tag = tag; this.textContent = text; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this.open = false }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(key, value) { this.attributes[key] = value }
  addEventListener(name, action) { this.listeners[name] = action }
  showModal() { this.open = true }
  close() { this.open = false }
  querySelector() { return this.specifiedOption ||= new Node('option') }
}
function harness(counts = [2, 1]) {
  const data = {
    projectId: 'project', project: { name: '跨集项目', type: 'script' },
    structure: { acts: [{ episodeIds: ['ep1', 'ep2'] }], episodes: { ep1: { sceneIds: ['s1', 'empty'] }, ep2: { sceneIds: ['s2'] } } },
    documents: Object.fromEntries(['ep1', 'ep2', 's1', 's2', 'empty'].map(id => [id, { title: id, content: `${id}剧本` }])),
    storyboard: { revision: 1, shots: [] }
  }
  const groups = counts.map((count, index) => Array.from({ length: count }, (_, order) => ({
    ...createShot({ title: `s${index + 1}-${order}`, visual: '宽阔的街道' }),
    sourceDocumentId: `s${index + 1}`, references: [{ versionId: `fixed-${index + 1}`, role: 'reference' }]
  })))
  // Deliberately interleave sources in storage; submission must follow project order.
  data.storyboard.shots = [...groups[1], ...groups[0]]
  const calls = [], notices = [], connection = { id: 'images', name: '图片执行端', kind: 'image-api', adapter: 'openai-images', model: 'test-image' }
  const env = {
    context: () => data, storyboardSceneEntries, shotsForScenes, UNASSIGNED_SOURCE, BATCH_LIMIT: 20,
    selectedSourceId: 's1', selectedShotId: groups[0][0]?.id, batchScopeIds: [], batchSelection: new Set(), batchSceneSelection: new Set(), batchExplicitIds: null, batchOwner: null,
    batchPlan: null, operationBusy: false, loading: false, error: '', jobs: [],
    el: (tag, className, text) => new Node(tag, text), Option: class extends Node { constructor(text, value) { super('option', text); this.value = value } },
    crypto: { randomUUID }, contentFingerprint, prepareShotInputs, videoParameterState, validateVideoParameters, findMediaVersion, mediaPrompt, resolveConnectionRoute, shotIsStale, mediaAdapterFor,
    connectionFor: () => connection, visibleShots: value => value.storyboard.shots.filter(shot => shot.sourceDocumentId === 's1'),
    assets: [1, 2].map(index => ({ id: `asset-${index}`, name: `参考${index}`, selectedVersionId: `new-${index}`, versions: [{ id: `fixed-${index}`, mimeType: 'image/png' }, { id: `new-${index}`, mimeType: 'image/png' }] })),
    terminal: () => true, requireProject() {}, desktop() {}, requireAdapterCatalog: async () => {}, beforeSubmit: null, secret: async () => 'test-only',
    run: callback => callback(), notify: text => notices.push(text), showJobs() {}, refresh: async () => {},
    invoke: async (command, payload) => { calls.push({ command, payload }); return payload.requests.map(request => ({ id: randomUUID(), targetId: request.targetId })) }
  }
  for (const key of ['batchDialog', 'batchCapability', 'batchScope', 'batchScenes', 'batchSceneFieldset', 'batchShots', 'batchConnection', 'batchStatus', 'batchPreview', 'batchConfirm']) env[key] = new Node()
  env.batchCapability.value = 'image'
  vm.createContext(env)
  vm.runInContext(['button', 'field', 'prepareShotRequest', 'updateBatchConfirmation', 'invalidateBatchPlan', 'renderBatchConnection', 'updateBatchScope', 'renderBatchScenes', 'batchScopeShots', 'renderBatchSelection', 'openBatchPlan', 'batchRequests', 'batchSignature', 'previewBatchPlan', 'assertBatchPlan', 'submitBatchPlan'].map(productionFunction).join('\n'), env)
  const sceneInput = id => env.batchScenes.children.flatMap(node => node.children).find(node => node.attributes['aria-label'] === `选择分场：${id}`)
  const chooseScene = (id, checked) => { const input = sceneInput(id); input.checked = checked; input.listeners.change() }
  return { env, data, groups, calls, notices, chooseScene, sceneInput }
}

test('跨集勾选分场后按项目顺序固定所有镜头及参考版本，一次提交并归回原镜头', async () => {
  const { env, groups, calls, chooseScene, sceneInput } = harness()
  assert.equal(env.openBatchPlan({ capability: 'image', scope: 'scenes' }), true)
  assert.equal(sceneInput('empty').disabled, true)
  assert.equal(env.batchSelection.size, 2)
  chooseScene('s2', true)
  assert.equal(env.batchSelection.size, 3)
  env.previewBatchPlan()
  assert.equal(calls.length, 0)
  assert.equal(env.batchConfirm.disabled, false)
  assert.deepEqual(Array.from(env.batchPlan.requests, request => request.targetId), [...groups[0], ...groups[1]].map(shot => shot.id))
  assert.deepEqual(Array.from(env.batchPlan.requests, request => request.references[0].versionId), ['fixed-1', 'fixed-1', 'fixed-2'])
  await env.submitBatchPlan()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'media_submit_batch')
  assert.ok(calls[0].payload.requests.every(request => request.projectId === 'project' && request.capability === 'image'))
  assert.deepEqual(Array.from(env.jobs, job => job.targetId), [...groups[0], ...groups[1]].map(shot => shot.id))
  await assert.rejects(env.submitBatchPlan(), /不会自动重复执行/)
  assert.equal(calls.length, 1)
})

test('撤选分场移除其镜头且预览失效；超过20镜不静默截取整场', () => {
  const { env, chooseScene } = harness([12, 12])
  env.openBatchPlan({ capability: 'image', scope: 'scenes' })
  env.previewBatchPlan()
  assert.ok(env.batchPlan)
  chooseScene('s2', true)
  assert.equal(env.batchScopeIds.length, 24)
  assert.equal(env.batchSelection.size, 12)
  assert.equal(env.batchPlan, null)
  assert.equal(env.batchConfirm.disabled, true)
  assert.match(env.batchStatus.textContent, /超过每批 20.*保留原有选择/)
  const shotInputs = env.batchShots.children.filter(node => node.tag === 'label').map(node => node.children[0])
  for (const input of shotInputs.slice(12, 21)) { input.checked = true; input.listeners.change() }
  assert.equal(env.batchSelection.size, 20)
  assert.equal(shotInputs[20].checked, false)
  chooseScene('s1', false)
  assert.equal(env.batchScopeIds.length, 12)
  assert.equal(env.batchSelection.size, 8)
})

test('固定预览后剧本变化或切换项目，提交前阻止整批调用', async () => {
  for (const mutate of [data => { data.documents.s2.content = '剧本已修改' }, data => { data.projectId = 'another-project' }]) {
    const { env, data, calls, chooseScene } = harness()
    env.openBatchPlan({ capability: 'image', scope: 'scenes' }); chooseScene('s2', true); env.previewBatchPlan()
    env.beforeSubmit = async () => mutate(data)
    await assert.rejects(env.submitBatchPlan(), /已变化.*未提交生成/)
    assert.equal(calls.length, 0)
  }
})

test('指定镜头入口与当前范围入口继续独立工作，重新打开不会残留跨场选择', () => {
  const { env, groups, chooseScene } = harness()
  env.openBatchPlan({ capability: 'image', scope: 'scenes' }); chooseScene('s2', true)
  env.openBatchPlan({ capability: 'image', shotIds: [groups[1][0].id], projectId: 'project' })
  assert.equal(env.batchScope.value, 'specified')
  assert.deepEqual(Array.from(env.batchRequests('image'), request => request.targetId), [groups[1][0].id])
  env.openBatchPlan()
  assert.equal(env.batchScope.value, 'current')
  assert.deepEqual(Array.from(env.batchScopeIds), groups[0].map(shot => shot.id))
  assert.equal(env.batchScope.querySelector().hidden, true)
  assert.equal(env.batchScope.querySelector().disabled, true)
})
