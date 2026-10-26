import { planShotImageResults, imageResultCheckpoint } from '../src/shot-image-results.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createShot, validateStoryboard, storyboardPrompt, parseStoryboardCandidate, findMediaVersion } from '../src/storyboard.js'
import { bindShotReferences, matchShotReferences, referenceBindingWarnings, manualReferencePatch, planReferenceBackfill } from '../src/storyboard-references.js'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'

const asset = (role, name, id) => ({ id: `a-${id}`, role, name, kind: 'image', selectedVersionId: id, versions: [{ id, mimeType: 'image/png' }] })
const assets = [asset('character', '陆骁 · 正脸与三视图', 'lu'), asset('character', '苏遥', 'su'), asset('scene', '木筏 · 日', 'day'), asset('scene', '木筏 · 夜', 'night'), asset('prop', '匕首 · 白底图', 'knife')]
const documents = { scene: { title: 'SC001 木筏 · 日', content: '苏遥出场。' } }
const oldShot = () => createShot({ visual: '陆骁站在木筏上，握紧匕首。', dialogue: '苏遥在哪里？' }, { documentId: 'scene' })

test('旧镜头从画面和分场时段识别三类素材，不把对白或整场剧本中的人物关联进来', () => {
  assert.deepEqual(bindShotReferences(oldShot(), assets, documents).references.map(r => r.versionId), ['lu', 'day', 'knife'])
  for (const visual of ['提起苏遥。', '苏遥（画外）呼喊。', '苏遥未入镜。', '苏遥被提及。']) {
    assert.equal(matchShotReferences(createShot({ visual }), assets).some(m => m.name === '苏遥'), false)
  }
})

test('补图后自动关联且反复刷新幂等，固定旧版本和手动首帧保持不变', () => {
  const shot = oldShot()
  shot.references = [{ versionId: 'old-lu', role: 'start' }, { versionId: 'manual', role: 'reference' }]
  const ready = structuredClone(assets); ready[0].versions.push({ id: 'old-lu', mimeType: 'image/png' })
  const waiting = ready.map(a => ({ ...a, selectedVersionId: '' }))
  const board = { revision: 4, shots: [shot] }
  assert.equal(planReferenceBackfill(board, waiting, documents).changed, 0)
  const plan = planReferenceBackfill(board, ready, documents)
  assert.equal(plan.added, 2)
  assert.deepEqual(plan.storyboard.shots[0].references.map(r => r.versionId), ['old-lu', 'manual', 'day', 'knife'])
  assert.equal(plan.storyboard.revision, 5)
  assert.equal(board.revision, 4)
  assert.equal(planReferenceBackfill(plan.storyboard, ready, documents).changed, 0)
})

test('手动移除持久排除后补版本，手动重新选用或恢复排除后可重新关联', () => {
  let shot = oldShot(); shot.references = bindShotReferences(shot, assets, documents).references
  Object.assign(shot, manualReferencePatch(shot, shot.references.filter(r => r.versionId !== 'knife'), assets))
  shot = JSON.parse(JSON.stringify(shot))
  const updated = [...assets.slice(0, 4), asset('prop', '匕首 · 白底图', 'knife-new')]
  assert.equal(bindShotReferences(shot, updated, documents).added, 0)
  assert.equal(matchShotReferences(shot, updated, documents).find(m => m.role === 'prop').status, 'excluded')
  assert.deepEqual(manualReferencePatch(shot, [...shot.references, { versionId: 'knife-new', role: 'reference' }], updated).referenceExclusions, [])
  shot.referenceExclusions = []
  assert.equal(bindShotReferences(shot, updated, documents).added, 1)
})

test('场景时段冲突、时段不明和重名不猜测；显式空数组覆盖旧镜头自动识别', () => {
  assert.equal(matchShotReferences(createShot({ visual: '木筏漂浮' }), assets).find(m => m.role === 'scene').status, 'ambiguous')
  assert.equal(matchShotReferences(createShot({ visual: '木筏漂浮，夜幕降临' }), [assets[2]]).find(m => m.role === 'scene').status, 'ambiguous')
  assert.equal(matchShotReferences(oldShot(), [...assets, asset('character', '陆骁', 'duplicate')], documents)[0].status, 'ambiguous')
  assert.deepEqual(bindShotReferences({ ...oldShot(), characterNames: [], sceneNames: [], propNames: [] }, assets, documents).references, [])
  const shot = oldShot(); shot.references = Array.from({ length: 16 }, (_, i) => ({ versionId: `manual-${i}`, role: 'reference' }))
  assert.ok(bindShotReferences(shot, assets, documents).matches.every(m => m.status === 'limit'))
})

test('新拆镜三类名称保存并导出 Flow 和 Muse 对应图片，非法字段拒绝', () => {
  const shot = parseStoryboardCandidate(JSON.stringify({ shots: [{ visual: '持刀', characterNames: ['陆骁'], sceneNames: ['木筏 · 夜'], propNames: ['匕首'] }] }))[0]
  shot.references = bindShotReferences(shot, assets).references
  const storyboard = { revision: 1, shots: [shot] }
  assert.deepEqual(validateStoryboard(JSON.parse(JSON.stringify(storyboard))), storyboard)
  for (const build of [buildFlowExport, buildMuseExport]) assert.deepEqual(build({ project: { name: '测试' }, storyboard }, assets).images.map(i => i.versionId), ['lu', 'night', 'knife'])
  for (const field of ['sceneNames', 'propNames']) assert.throws(() => createShot({ [field]: '错误类型' }))
  assert.match(storyboardPrompt('', [], { scene: ['木筏'], prop: ['匕首'] }), /sceneNames/)
  assert.match(storyboardPrompt('', [], { scene: ['木筏'], prop: ['匕首'] }), /匕首/)
})

test('自动补齐入口在刷新后保存，拆镜中暂缓，失败不改原镜头', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('  async function synchronizeReferences()'), source.indexOf('  function reserveStoryboardTask('))
  for (const mode of ['ready', 'task', 'generating', 'transition', 'foreign', 'failure']) {
    const data = { projectId: 'p', documents, storyboard: { revision: 2, shots: [oldShot()] }, textGenerating: mode === 'generating', mutationBusy: mode === 'transition' }
    const calls = [], notices = [], scheduled = []
    const env = { context: () => data, referenceSyncBusy: false, loading: false, error: '', operationBusy: false, storyboardTasks: { active: () => mode === 'task' }, invoke: true, projectId: mode === 'foreign' ? 'another' : 'p', assets, jobs: [], planReferenceBackfill, planShotImageResults, scheduleReferenceSync: () => scheduled.push(true), commit: async (patch, options) => { calls.push(options); if (mode === 'failure') throw new Error('磁盘不可写'); data.storyboard = patch.storyboard }, renderShots() {}, refreshReferenceDetails() {}, notify: message => notices.push(message) }
    vm.createContext(env); vm.runInContext(`${handler}\nthis.sync = synchronizeReferences`, env)
    await env.sync()
    assert.equal(calls.length, ['ready', 'failure'].includes(mode) ? 1 : 0)
    assert.equal(scheduled.length, ['transition', 'task', 'generating'].includes(mode) ? 1 : 0)
    assert.equal(data.storyboard.shots[0].references.length, mode === 'ready' ? 3 : 0)
    assert.equal(env.referenceSyncBusy, false)
    if (mode === 'ready') { assert.equal(calls[0].atomic, true); assert.equal(calls[0].revision, 2); await env.sync(); assert.equal(calls.length, 1) }
    if (mode === 'failure') assert.match(notices[0], /未保存.*磁盘不可写/)
  }
})

test('切换角色、场景时段与道具后只移除失效自动项，手动引用及旧引用保留', () => {
  const ready = [...assets, asset('prop', '绳索', 'rope')]
  const shot = createShot({ visual: '陆骁持刀', characterNames: ['陆骁'], sceneNames: ['木筏 · 日'], propNames: ['匕首'] })
  shot.references = bindShotReferences(shot, ready).references
  assert.ok(shot.references.every(ref => ref.origin === 'auto' && ref.scope === 'continuity'))
  shot.references.push({ versionId: 'old-manual', role: 'start', origin: 'manual' }, { versionId: 'legacy', role: 'reference' })
  Object.assign(shot, { characterNames: ['苏遥'], sceneNames: ['木筏 · 夜'], propNames: ['绳索'] })
  const result = bindShotReferences(shot, ready)
  assert.equal(result.removed, 3); assert.equal(result.added, 3)
  assert.deepEqual(result.references.map(ref => ref.versionId), ['old-manual', 'legacy', 'su', 'night', 'rope'])
  const board = { revision: 1, shots: [shot] }, plan = planReferenceBackfill(board, ready)
  assert.equal(plan.removed, 3); assert.equal(plan.changed, 1); assert.equal(plan.storyboard.revision, 2)
  assert.equal(planReferenceBackfill(plan.storyboard, ready).changed, 0)
  assert.deepEqual(shot.references.slice(0, 3).map(ref => ref.versionId), ['lu', 'day', 'knife'])
})

test('自动清理支持仅移除、不添加；场景时段改变但没有新图时不继续使用旧时段图', () => {
  const shot = createShot({ visual: '木筏漂浮', sceneNames: ['木筏 · 日'], characterNames: [], propNames: [] })
  shot.references = bindShotReferences(shot, assets).references
  shot.sceneNames = ['木筏 · 夜']
  const result = bindShotReferences(shot, assets.filter(asset => asset.selectedVersionId !== 'night'))
  assert.equal(result.added, 0); assert.equal(result.removed, 1)
  assert.equal(result.matches[0].status, 'ambiguous'); assert.deepEqual(result.references, [])
  shot.sceneNames = []
  const plan = planReferenceBackfill({ revision: 3, shots: [shot] }, assets)
  assert.equal(plan.changed, 1); assert.equal(plan.removed, 1); assert.equal(plan.storyboard.revision, 4)
})

test('手动接管自动引用与用途修改不被之后同步移除；未改的自动项仍有来源', () => {
  const shot = oldShot(); shot.references = bindShotReferences(shot, assets, documents).references
  const next = shot.references.map(ref => ref.versionId === 'lu' ? { ...ref, origin: 'manual' } : ref.versionId === 'knife' ? { ...ref, scope: 'video' } : ref)
  Object.assign(shot, manualReferencePatch(shot, next, assets))
  assert.deepEqual(shot.references.map(ref => ref.origin), ['manual', 'auto', 'manual'])
  Object.assign(shot, { characterNames: [], sceneNames: [], propNames: [] })
  assert.deepEqual(bindShotReferences(shot, assets, documents).references.map(ref => ref.versionId), ['lu', 'knife'])
  const manual = manualReferencePatch(shot, [...shot.references, { versionId: 'su', role: 'reference' }], assets)
  assert.equal(manual.references.at(-1).origin, 'manual')
})

test('旧引用不猜测来源并提示未匹配项；同一实体的已固定版本不随素材选用版本漂移', () => {
  const shot = createShot({ visual: '苏遥', characterNames: ['苏遥'], sceneNames: [], propNames: [] })
  shot.references = [{ versionId: 'lu', role: 'reference' }, { versionId: 'knife', role: 'reference', origin: 'manual' }]
  const result = bindShotReferences(shot, assets)
  assert.equal(result.removed, 0); assert.equal(result.added, 1)
  const warnings = referenceBindingWarnings(shot, assets)
  assert.equal(warnings.legacy.length, 1)
  assert.deepEqual(warnings.unmatched.map(item => item.ref.versionId), ['lu', 'knife'])
  const original = oldShot(); original.references = bindShotReferences(original, assets, documents).references
  const updated = structuredClone(assets); updated[0].versions.push({ id: 'new-lu', mimeType: 'image/png' }); updated[0].selectedVersionId = 'new-lu'
  assert.deepEqual(bindShotReferences(original, updated, documents).references, original.references)
  validateStoryboard({ revision: 0, shots: [original] })
  const corrupt = structuredClone(original); corrupt.references[0].origin = 'guess'
  assert.throws(() => validateStoryboard({ revision: 0, shots: [corrupt] }), /来源/)
})

async function imageSyncHarness({ fail = false, blocked = false, candidateFocused = false, videoPlaying = false } = {}) {
  const { readFileSync } = await import('node:fs'), vm = await import('node:vm')
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('  async function synchronizeReferences()'), source.indexOf('  function reserveStoryboardTask('))
  const refreshCandidates = source.slice(source.indexOf('  function refreshShotCandidates()'), source.indexOf('  function renderShotReferenceInputs('))
  const current = oldShot(), data = { projectId: 'p', documents, storyboard: { revision: 8, shots: [current] } }
  const generated = { id: 'generated-asset', projectId: 'p', kind: 'image', role: 'shot', name: '新分镜图', selectedVersionId: 'new-image', versions: [{ id: 'new-image', mimeType: 'image/png', metadata: { provenance: { jobId: 'image-job', artifact: 'output-1.png' } } }] }
  const jobs = [{ id: 'image-job', targetId: current.id, projectId: 'p', capability: 'image', status: 'completed', createdAt: '1793066400000', assetId: generated.id, request: {} }]
  const calls = { commits: [], notices: [], renders: [], previews: [], candidateRenders: [], jobs: 0, overview: 0 }
  let release
  const gate = blocked ? new Promise(resolve => { release = resolve }) : Promise.resolve()
  const candidates = {
    dataset: {},
    contains: () => candidateFocused,
    querySelectorAll: () => videoPlaying ? [{ paused: false }] : [],
    replaceWith: content => calls.candidateRenders.push(content),
  }
  const host = { replaceChildren: (...children) => calls.previews.push(children) }
  const env = {
    context: () => data, referenceSyncBusy: false, loading: false, error: '', operationBusy: false,
    storyboardTasks: { active: () => false }, invoke: true, projectId: 'p', assets: [...assets, generated], jobs,
    planReferenceBackfill, planShotImageResults, findMediaVersion, scheduleReferenceSync() {},
    fail, commit: async (patch, options) => {
      calls.commits.push({ patch, options }); await gate
      if (env.fail) throw new Error('模拟磁盘写入失败')
      data.storyboard = patch.storyboard
    },
    renderShots: options => calls.renders.push({ options, selected: data.storyboard.shots[0].selectedImageVersionId }),
    refreshReferenceDetails() {}, notify: message => calls.notices.push(message), selectedShot: () => data.storyboard.shots[0],
    shotDetail: { querySelector: selector => selector.startsWith('.shot-selected-media') ? host : selector === '.shot-candidates' ? candidates : null },
    document: { activeElement: {} }, el: (tag, className, text) => ({ tag, className, text }),
    preview: (version, title) => ({ versionId: version?.id, title }), button: (text, action) => ({ text, action }),
    renderShotDetail() {}, selectDetailPanel() {}, rememberShotDisclosures() {}, restoreShotDisclosures() {},
    renderShotCandidates: item => ({ selected: item.selectedImageVersionId }),
    renderJobs: () => { calls.jobs++ }, productionOverview: { refresh: () => { calls.overview++ } },
  }
  vm.createContext(env); vm.runInContext(`${refreshCandidates}\n${handler}\nthis.sync = synchronizeReferences`, env)
  return { env, data, calls, release, original: structuredClone(data.storyboard) }
}

test('真实同步入口将生成图和参考一次原子保存，保存成功前不更新选用状态和UI', async () => {
  const h = await imageSyncHarness({ blocked: true })
  const syncing = h.env.sync()
  assert.equal(h.calls.commits.length, 1)
  assert.equal(h.calls.commits[0].options.atomic, true)
  assert.equal(h.calls.commits[0].options.projectId, 'p')
  assert.equal(h.calls.commits[0].options.revision, 8)
  assert.equal(h.calls.commits[0].patch.storyboard.revision, 9, '图片与参考合并只增加一次修订')
  assert.deepEqual(h.data.storyboard, h.original)
  assert.equal(h.calls.renders.length, 0); assert.equal(h.calls.previews.length, 0)
  assert.equal(h.env.referenceSyncBusy, true)
  h.release(); await syncing
  const saved = h.data.storyboard.shots[0]
  assert.equal(saved.selectedImageVersionId, 'new-image')
  assert.deepEqual(saved.imageResultCheckpoint, { jobId: 'image-job', createdAt: '1793066400000' })
  assert.deepEqual(saved.references.map(ref => ref.versionId), ['lu', 'day', 'knife'])
  assert.equal(h.calls.renders[0].selected, 'new-image')
  assert.equal(h.calls.previews[0][1].versionId, 'new-image')
  assert.equal(h.calls.candidateRenders[0].selected, 'new-image')
  assert.equal(h.calls.jobs, 1); assert.equal(h.calls.overview, 1)
  assert.equal(h.env.referenceSyncBusy, false)
  assert.ok(h.calls.notices.some(message => /1 张新生成图片关联并选用/.test(message)))
  await h.env.sync(); assert.equal(h.calls.commits.length, 1, '重复同步不再保存同一结果')
})

test('真实同步入口写入失败保留镜头和水位，之后重试仍能关联同一结果', async () => {
  const h = await imageSyncHarness({ fail: true })
  await h.env.sync()
  assert.deepEqual(h.data.storyboard, h.original)
  assert.equal(h.data.storyboard.shots[0].imageResultCheckpoint, undefined)
  assert.equal(h.calls.renders.length, 0); assert.equal(h.calls.previews.length, 0)
  assert.equal(h.calls.jobs, 0); assert.equal(h.env.referenceSyncBusy, false)
  assert.match(h.calls.notices[0], /未保存.*模拟磁盘写入失败/)
  h.env.fail = false
  await h.env.sync()
  assert.equal(h.calls.commits.length, 2)
  assert.equal(h.calls.commits[1].options.revision, 8)
  assert.equal(h.data.storyboard.shots[0].selectedImageVersionId, 'new-image')
  assert.equal(h.data.storyboard.shots[0].imageResultCheckpoint.jobId, 'image-job')
  assert.equal(h.calls.jobs, 1)
  await h.env.sync(); assert.equal(h.calls.commits.length, 2)
})

test('图片同步保存仍执行，候选区有焦点或视频正在播放时保持原节点', async () => {
  for (const options of [{ candidateFocused: true }, { videoPlaying: true }]) {
    const h = await imageSyncHarness(options)
    await h.env.sync()
    assert.equal(h.data.storyboard.shots[0].selectedImageVersionId, 'new-image')
    assert.equal(h.calls.previews[0][1].versionId, 'new-image')
    assert.equal(h.calls.candidateRenders.length, 0)
    assert.equal(h.calls.jobs, 1)
  }
})

test('候选区等焦点离开或视频暂停结束后局部刷新，避免最终任务完成后留下旧状态', async () => {
  const { readFileSync } = await import('node:fs'), vm = await import('node:vm')
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('  function renderShotCandidates('), source.indexOf('  function renderShotReferenceInputs('))
  for (const event of ['focusout', 'pause', 'ended']) {
    let focused = event === 'focusout', playing = !focused, current, replacements = 0
    const node = () => ({
      dataset: {}, children: [], listeners: new Map(), isConnected: true,
      append(...children) { this.children.push(...children) }, setAttribute() {},
      addEventListener(name, action, capture) { this.listeners.set(name, { action, capture }) },
      contains: () => focused, querySelectorAll: () => playing ? [{ paused: false }] : [],
      replaceWith(next) { this.isConnected = false; current = next; replacements++ },
    })
    const env = {
      assets: [], jobs: [], el: node, disclosure: node, field: node, button: node,
      Option: function (text, value) { this.text = text; this.value = value },
      selectedShot: oldShot, shotDetail: { querySelector: () => current },
      document: { activeElement: {} }, queueMicrotask, rememberShotDisclosures() {}, restoreShotDisclosures() {},
    }
    vm.createContext(env); vm.runInContext(`${handler}\nthis.render = renderShotCandidates; this.refresh = refreshShotCandidates`, env)
    current = env.render(oldShot())
    env.refresh()
    const previous = current
    assert.equal(previous.dataset.needsRefresh, 'true'); assert.equal(replacements, 0)
    if (event !== 'focusout') assert.equal(previous.listeners.get(event).capture, true)
    focused = false; playing = false
    previous.listeners.get(event).action()
    assert.equal(replacements, 0, '等待事件后微任务再读取最新焦点和播放状态')
    await Promise.resolve()
    assert.equal(replacements, 1); assert.notEqual(current, previous)
    previous.listeners.get(event).action(); await Promise.resolve()
    assert.equal(replacements, 1, '已脱离页面的旧节点不重复刷新')
  }
})

test('真实手选入口记录尚在运行的生成任务水位，之后完成不覆盖手选图', async () => {
  const { readFileSync } = await import('node:fs'), vm = await import('node:vm')
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('  function editShot('), source.indexOf('  function rememberShotDisclosures('))
  const selected = oldShot(), data = { projectId: 'p', documents, storyboard: { revision: 2, shots: [selected] } }
  const job = { id: 'running-image', projectId: 'p', targetId: selected.id, capability: 'image', status: 'running', createdAt: '1793066400000', assetId: 'generated', request: {} }
  const generated = { id: 'generated', projectId: 'p', kind: 'image', versions: [{ id: 'result', mimeType: 'image/png', metadata: { provenance: { jobId: job.id } } }] }
  const env = {
    context: () => data, jobs: [job], assets: [generated], projectId: 'p', loading: false, error: '',
    imageResultCheckpoint, manualReferencePatch, bindShotReferences, REFERENCE_ENTITY_FIELDS: {},
    changeStoryboard: async action => { const next = structuredClone(data.storyboard); action(next.shots); next.revision++; data.storyboard = next },
    renderShots() {}, refreshReferenceDetails() {}, renderGenerationReadiness() {}, notify(message) { throw new Error(message) },
  }
  vm.createContext(env); vm.runInContext(`${handler}\nthis.edit = editShot`, env)
  await env.edit(selected.id, { selectedImageVersionId: 'manually-imported' })
  assert.equal(data.storyboard.shots[0].selectedImageVersionId, 'manually-imported')
  assert.deepEqual(data.storyboard.shots[0].imageResultCheckpoint, { jobId: job.id, createdAt: job.createdAt })
  job.status = 'completed'
  const plan = planShotImageResults(data.storyboard, [generated], [job], 'p')
  assert.equal(plan.changed, 0)
  assert.equal(plan.storyboard.shots[0].selectedImageVersionId, 'manually-imported')
  await env.edit(selected.id, { visual: '改写画面' })
  assert.deepEqual(data.storyboard.shots[0].imageResultCheckpoint, { jobId: job.id, createdAt: job.createdAt })
})
