import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyContinuity, validateContinuity, normalizeContinuity, createEntity, createEntityState,
  entityStateFingerprint, resolveEntityState, parseEntityExtraction, mergeEntityExtraction,
  entityExtractionPrompt, entityReferencePrompt, planEntityImageResults,
} from '../src/continuity-assets.js'

const documents = { 'scene-1': { title: '第二场', content: '木筏是平板结构。林舟乘木筏漂流。' }, 'scene-2': { title: '第三场', content: '林舟仍在木筏上，筏头被撞坏。' }, 'scene-other': { title: '其他集', content: '火车驶过。' } }
const scope = { documents, sourceDocumentIds: ['scene-1', 'scene-2'] }
const state = (patch = {}) => createEntityState({ id: 'state-1', name: '初始状态', ...patch })
const entity = (patch = {}) => createEntity({ id: 'raft', kind: 'prop', name: '木筏', aliases: ['浮筏'], description: '平板木筏', traits: '灰褐色，四块平板并排', sourceDocumentIds: ['scene-1'], states: [state()], ...patch })
const registry = (item = entity(), style = '') => ({ version: 1, style, entities: [item] })
const raw = (patch = {}) => ({ kind: 'prop', name: '木筏', aliases: [], description: '平板木筏', traits: '灰褐色，四块平板并排', sourceDocumentIds: ['scene-1'], states: [{ name: '初始状态', description: '', sourceDocumentIds: ['scene-1'] }], ...patch })
const parse = (input, options = {}) => parseEntityExtraction(JSON.stringify({ entities: Array.isArray(input) ? input : [input] }), { ...scope, ...options })
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const projectId = 'project-1', first = '1793066400000', second = '1793066460000', third = '1793066520000'
const metadata = (item = entity(), target = item.states[0], style = '') => ({ entityId: item.id, stateId: target.id, kind: item.kind, name: item.name, stateName: target.name, definitionFingerprint: entityStateFingerprint(item, target, style) })
const job = (id = 'job-1', createdAt = first, patch = {}) => ({ id, projectId, capability: 'image', targetId: 'raft-state-1', status: 'completed', assetId: 'asset-1', createdAt, request: { entity: metadata() }, ...patch })
const version = (id = 'image-1', jobId = 'job-1', patch = {}) => ({ id, mimeType: 'image/png', createdAt: first, metadata: { provenance: { jobId, entity: metadata(), artifact: `${id}.png` } }, ...patch })
const asset = (versions = [version()], patch = {}) => ({ id: 'asset-1', projectId, role: 'prop', kind: 'image', selectedVersionId: versions[0]?.id || '', versions, ...patch })

test('创建、规范化及校验支持序列化，安全默认值彼此独立', () => {
  const a = createEntity(), b = createEntity()
  assert.notEqual(a.id, b.id); assert.notEqual(a.defaultStateId, b.defaultStateId)
  const original = registry(); assert.equal(validateContinuity(original), original)
  const normalized = normalizeContinuity(original)
  assert.deepEqual(normalized, JSON.parse(JSON.stringify(original))); assert.notEqual(normalized.entities, original.entities)
  assert.deepEqual(normalizeContinuity(undefined), emptyContinuity())
  const partial = structuredClone(original); delete partial.style; delete partial.entities[0].aliases; delete partial.entities[0].states[0].referenceFingerprint
  assert.equal(normalizeContinuity(partial).entities[0].states[0].referenceFingerprint, '')
  assert.throws(() => normalizeContinuity(null), /必须是对象/)
  assert.throws(() => normalizeContinuity({ version: 1, entities: [{}] }), /ID/)
})

test('校验拒绝损坏字段、不合法ID、重复身份及跨实体状态ID', () => {
  const invalid = [
    value => { value.version = 2 }, value => { value.style = null }, value => { value.entities[0].id = '../raft' },
    value => { value.entities[0].kind = 'unknown' }, value => { value.entities[0].name = '木\n筏' },
    value => { value.entities[0].aliases = ['浮筏', '浮筏'] }, value => { value.entities[0].traits = 3 },
    value => { value.entities[0].sourceDocumentIds = ['scene-1', 'scene-1'] },
    value => { value.entities[0].defaultStateId = 'missing' }, value => { value.entities[0].states[0].basedOnStateId = 'missing' },
    value => { value.entities[0].states[0].sourceDocumentIds = ['other'] },
    value => { value.entities[0].states[0].imageResultCheckpoint = { jobId: 'job-1', createdAt: 5 } },
    value => { value.entities[0].states[0].imageResultCheckpoint = { jobId: '../job', createdAt: first } },
    value => { value.entities[0].states[0].referenceVersionId = '../../../image' },
    value => { value.entities.push(entity({ id: 'other', states: [state({ id: 'other-state' })], name: '浮筏' })) },
    value => { value.entities.push(entity({ id: 'other', kind: 'scene' })) },
  ]
  for (const corrupt of invalid) { const value = registry(); corrupt(value); assert.throws(() => validateContinuity(value)) }
  const differentKind = registry(); differentKind.entities.push(entity({ id: 'other', kind: 'scene', states: [state({ id: 'other-state' })] }))
  assert.doesNotThrow(() => validateContinuity(differentKind))
})

test('名称、状态ID和指纹限制与生成端一致，不把后端失败延迟到点击生成', () => {
  assert.doesNotThrow(() => createEntity({ name: '木'.repeat(80), states: [state({ id: 'a'.repeat(89) })] }))
  assert.throws(() => createEntity({ name: '木'.repeat(81) }), /名称无效/)
  assert.throws(() => createEntity({ aliases: ['木'.repeat(81)] }), /别名无效/)
  assert.throws(() => createEntityState({ name: '木'.repeat(81) }), /名称无效/)
  assert.throws(() => createEntityState({ id: 'a'.repeat(90) }), /89/)
  assert.throws(() => createEntityState({ referenceFingerprint: 'a'.repeat(129) }), /指纹/)
  for (const id of ['id.with.dot', 'id:colon', 'id/slash']) assert.throws(() => createEntity({ id }))
})

test('分场优先选择显式状态，默认状态可覆盖其余分场；非默认状态重叠和循环拒绝', () => {
  const item = entity({ sourceDocumentIds: ['scene-1', 'scene-2'], states: [state({ sourceDocumentIds: ['scene-1', 'scene-2'] }), state({ id: 'damaged', name: '筏头破损', basedOnStateId: 'state-1', sourceDocumentIds: ['scene-2'] })] })
  assert.equal(resolveEntityState(item, 'scene-1').id, 'state-1'); assert.equal(resolveEntityState(item, 'scene-2').id, 'damaged')
  assert.equal(resolveEntityState(item, 'unassigned').id, 'state-1')
  const overlap = structuredClone(item); overlap.states.push(state({ id: 'repaired', name: '已修复', sourceDocumentIds: ['scene-2'] }))
  assert.throws(() => validateContinuity(registry(overlap)), /两个非默认状态/)
  const cycle = structuredClone(item); cycle.states[0].basedOnStateId = 'damaged'
  assert.throws(() => validateContinuity(registry(cycle)), /循环/)
})

test('视觉指纹忽略分场、参考图和任务记录，但捕捉固定特征、状态及风格变更', () => {
  const item = entity(), initial = entityStateFingerprint(item, item.states[0])
  const assigned = structuredClone(item); assigned.sourceDocumentIds.push('scene-2'); assigned.states[0].referenceVersionId = 'image-1'; assigned.states[0].referenceFingerprint = 'prior'; assigned.states[0].imageResultCheckpoint = { jobId: 'job-1', createdAt: first }
  assert.equal(entityStateFingerprint(assigned, assigned.states[0]), initial)
  for (const change of [e => { e.traits = '圆木' }, e => { e.description = '帆船' }, e => { e.states[0].description = '破损' }]) {
    const edited = structuredClone(item); change(edited); assert.notEqual(entityStateFingerprint(edited, edited.states[0]), initial)
  }
  assert.notEqual(entityStateFingerprint(item, item.states[0], '水墨'), initial)
})

test('基础状态定义被编辑时派生状态指纹失效，避免晚返回图片恢复旧外形', () => {
  const item = entity({ states: [state({ description: '蓝色船头' }), state({ id: 'damaged', name: '破损', basedOnStateId: 'state-1' })] })
  const original = entityStateFingerprint(item, item.states[1])
  item.states[0].description = '红色船头'
  assert.notEqual(entityStateFingerprint(item, item.states[1]), original)
})

test('解析严格限制到真实选定分场，禁止AI捏造图片、任务及身份ID', () => {
  const result = parse(raw()); assert.equal(result[0].name, '木筏'); assert.match(result[0].id, /^[a-f0-9-]{36}$/)
  assert.throws(() => parse(raw(), { sourceDocumentIds: ['missing'] }), /不存在/)
  for (const change of [
    r => { r.sourceDocumentIds = ['scene-other'] }, r => { r.states[0].sourceDocumentIds = ['scene-2'] },
    r => { r.referenceVersionId = 'image' }, r => { r.id = 'made-up' }, r => { r.states[0].id = 'made-up' },
    r => { r.states[0].referenceVersionId = 'image' }, r => { r.states[0].referenceFingerprint = 'fingerprint' },
    r => { r.states[0].imageResultCheckpoint = { jobId: 'job', createdAt: first } }, r => { r.states[0].basedOnStateId = 'made-up' },
  ]) { const input = raw(); change(input); assert.throws(() => parse(input)) }
  const fenced = parseEntityExtraction('```json\n' + JSON.stringify({ entities: [raw()] }) + '\n```', scope)
  assert.equal(fenced[0].kind, 'prop')
  assert.throws(() => parseEntityExtraction('not json', scope), /有效 JSON/)
})

test('既有实体按规范名称、括号名称或别名复用，保留手工固定特征及参考图', () => {
  const current = registry(entity({ states: [state({ referenceVersionId: 'manual-image', referenceFingerprint: 'approved', imageResultCheckpoint: { jobId: 'manual-job', createdAt: first } })] }))
  freeze(current)
  for (const name of ['木筏', '木筏（主要交通工具）', '浮筏']) {
    const extracted = parse(raw({ name, description: 'AI新描述', traits: 'AI重设圆木', sourceDocumentIds: ['scene-2'], states: [{ name: '初始状态', description: '', sourceDocumentIds: ['scene-2'] }] }), { existing: current })
    assert.equal(extracted[0].id, 'raft'); assert.equal(extracted[0].states[0].id, 'state-1')
    const result = mergeEntityExtraction(current, extracted)
    assert.equal(result.entities.length, 1); assert.equal(result.entities[0].description, '平板木筏'); assert.equal(result.entities[0].traits, current.entities[0].traits)
    assert.equal(result.entities[0].states[0].referenceVersionId, 'manual-image')
    assert.deepEqual(result.entities[0].states[0].imageResultCheckpoint, { jobId: 'manual-job', createdAt: first })
    assert.deepEqual(result.entities[0].sourceDocumentIds, ['scene-1', 'scene-2'])
    assert.deepEqual(mergeEntityExtraction(result, extracted), result)
  }
})

test('按名称合并再次独立提取的ID，新增状态保留来源并复用已有默认状态', () => {
  const current = registry()
  const independentlyExtracted = parse(raw()); assert.notEqual(independentlyExtracted[0].id, 'raft')
  assert.equal(mergeEntityExtraction(current, independentlyExtracted).entities[0].id, 'raft')
  const changed = parse(raw({ sourceDocumentIds: ['scene-2'], states: [{ name: '筏头破损', description: '前缘缺口，主体仍是四块平板', sourceDocumentIds: ['scene-2'], basedOnStateId: 'state-1' }] }), { existing: current })
  const merged = mergeEntityExtraction(current, changed), item = merged.entities[0]
  assert.equal(item.states.length, 2); assert.equal(item.defaultStateId, 'state-1')
  assert.equal(resolveEntityState(item, 'scene-2').name, '筏头破损')
  assert.equal(resolveEntityState(item, 'scene-2').basedOnStateId, 'state-1')
})

test('新提取的派生状态自动继承默认态，已有状态和手工创建基准不被改写', () => {
  const changedStates = [{ name: '初始状态', sourceDocumentIds: ['scene-1'] }, { name: '扩建', sourceDocumentIds: ['scene-2'] }]
  const fresh = parse(raw({ sourceDocumentIds: ['scene-1', 'scene-2'], states: changedStates }))[0]
  assert.equal(fresh.states[0].basedOnStateId, '')
  assert.equal(fresh.states[1].basedOnStateId, fresh.defaultStateId)
  const current = registry()
  const appended = parse(raw({ sourceDocumentIds: ['scene-2'], states: [changedStates[1]] }), { existing: current })[0]
  assert.equal(appended.states.find(item => item.name === '扩建').basedOnStateId, 'state-1')
  const standalone = entity({ states: [state(), state({ id: 'expanded', name: '扩建' })] })
  const retained = parse(raw({ sourceDocumentIds: ['scene-1', 'scene-2'], states: changedStates }), { existing: registry(standalone) })[0]
  assert.equal(retained.states.find(item => item.id === 'expanded').basedOnStateId, '')
  assert.equal(createEntityState({ name: '手工独立状态' }).basedOnStateId, '')
})

test('别名横跨两个实体、ID冒用以及非默认状态冲突均拒绝整次采纳', () => {
  const current = registry(); current.entities.push(entity({ id: 'boat', name: '小船', aliases: [], states: [state({ id: 'boat-state' })] }))
  assert.throws(() => parse(raw({ aliases: ['小船'] }), { existing: current }), /歧义/)
  assert.throws(() => parse(raw({ id: 'boat' }), { existing: current }), /冒用/)
  const withState = registry(entity({ sourceDocumentIds: ['scene-1', 'scene-2'], states: [state(), state({ id: 'wet', name: '浸湿', sourceDocumentIds: ['scene-2'] })] }))
  assert.throws(() => parse(raw({ sourceDocumentIds: ['scene-2'], states: [{ name: '破损', sourceDocumentIds: ['scene-2'] }] }), { existing: withState }), /两个非默认状态/)
  assert.equal(withState.entities[0].states.length, 2)
})

test('提取提示含现有身份状态、选定正文和反复关键物品规则，不泄漏图片版本和未选集', () => {
  const current = registry(entity({ states: [state({ referenceVersionId: 'private-image', imageResultCheckpoint: { jobId: 'private-job', createdAt: first } })] }))
  const prompt = entityExtractionPrompt({ ...scope, continuity: current })
  for (const pattern of ['木筏', '平板/圆木', '不要机械截断', 'state-1', 'sourceDocumentIds', '林舟']) assert.ok(prompt.includes(pattern), pattern)
  assert.ok(prompt.includes('prop 作为唯一外形定义'))
  for (const excluded of ['private-image', 'private-job', '火车驶过']) assert.ok(!prompt.includes(excluded), excluded)
})

test('三类设定图遵守人物四视图、无人空景和纯白单品构图，并固定外形', () => {
  for (const kind of ['character', 'scene', 'prop']) {
    const item = entity({ kind }), prompt = entityReferencePrompt(item, item.states[0], '水彩')
    assert.ok(prompt.startsWith('视觉风格：水彩')); assert.equal(prompt.match(/视觉风格/g).length, 1)
    assert.ok(prompt.includes('四块平板')); assert.ok(prompt.includes('结构'))
    if (kind === 'character') for (const text of ['正脸特写', '90 度侧面', '背面', '中性 A 字站姿', '头顶与脚底对齐']) assert.ok(prompt.includes(text))
    if (kind === 'scene') { assert.ok(prompt.endsWith('画面中没有任何人物，空场景')); assert.ok(prompt.includes('固定相对位置')); assert.ok(prompt.includes('不在场景图中重新设计其外形')) }
    if (kind === 'prop') { assert.ok(prompt.includes('纯白背景')); assert.ok(prompt.includes('边缘完整')); assert.ok(!prompt.includes('电影质感')) }
  }
})

test('新图按任务和设定来源关联，不取素材默认旧图；计划不修改输入', () => {
  const current = registry(), jobs = [job('old'), job('new', second)], assets = [asset([version('old-image', 'old'), version('new-image', 'new')])]
  freeze(current); freeze(jobs); freeze(assets)
  const result = planEntityImageResults(current, assets, jobs, projectId)
  assert.equal(result.continuity.entities[0].states[0].referenceVersionId, 'new-image')
  assert.equal(result.changed, 1); assert.deepEqual(result.linked, [{ entityId: 'raft', stateId: 'state-1', jobId: 'new', versionId: 'new-image' }])
  assert.equal(current.entities[0].states[0].referenceVersionId, '')
  assert.equal(result.continuity.entities[0].states[0].referenceFingerprint, metadata().definitionFingerprint)
  const restart = planEntityImageResults(JSON.parse(JSON.stringify(result.continuity)), assets, jobs, projectId)
  assert.equal(restart.changed, 0); assert.deepEqual(restart.linked, [])
})

test('未建立素材库的旧项目不会因自动图片同步崩溃', () => {
  assert.deepEqual(planEntityImageResults(undefined, [], [], projectId), { continuity: undefined, changed: 0, linked: [] })
})

test('旧任务晚返回不覆盖新结果，新任务未完成不退回旧任务', () => {
  const current = registry(), assets = [asset([version('old-image', 'old'), version('new-image', 'new')])]
  for (const status of ['queued', 'running', 'failed', 'cancelled']) {
    const result = planEntityImageResults(current, assets, [job('old', first, { updatedAt: third }), job('new', second, { status })], projectId)
    assert.equal(result.continuity, current); assert.equal(result.changed, 0)
  }
  const applied = planEntityImageResults(current, assets, [job('old', first, { updatedAt: third }), job('new', second)], projectId)
  assert.equal(applied.continuity.entities[0].states[0].referenceVersionId, 'new-image')
})

test('手动选图水位阻止进行中任务覆盖，之后的新任务仍自动采用', () => {
  const current = registry(entity({ states: [state({ referenceVersionId: 'manual', imageResultCheckpoint: { jobId: 'pending', createdAt: second } })] }))
  const assets = [asset([version('pending-image', 'pending'), version('next-image', 'next')])]
  assert.equal(planEntityImageResults(current, assets, [job('pending', second)], projectId).changed, 0)
  const next = planEntityImageResults(current, assets, [job('pending', second), job('next', third)], projectId)
  assert.equal(next.continuity.entities[0].states[0].referenceVersionId, 'next-image')
  const cleared = structuredClone(current); cleared.entities[0].states[0].referenceVersionId = ''
  assert.equal(planEntityImageResults(cleared, assets, [job('pending', second)], projectId).changed, 0)
})

test('首次记录保留手工导入参考与同次其他输出，后续生成可替换自身旧图', () => {
  const imported = version('manual', 'imported', { metadata: { provenance: { source: 'import' } } })
  const assets = [asset([imported, version(), version('image-2')])]
  for (const id of ['manual', 'image-2']) {
    const current = registry(entity({ states: [state({ referenceVersionId: id })] }))
    const result = planEntityImageResults(current, assets, [job()], projectId)
    assert.equal(result.continuity.entities[0].states[0].referenceVersionId, id); assert.equal(result.changed, 1)
  }
  const current = registry(entity({ states: [state({ referenceVersionId: 'image-1' })] }))
  const result = planEntityImageResults(current, [asset([version(), version('next', 'next')])], [job(), job('next', second)], projectId)
  assert.equal(result.continuity.entities[0].states[0].referenceVersionId, 'next')
})

test('手选基图尚无历史水位时，明确基于此图生成的新结果仍自动采用；提交后手选有水位则保留', () => {
  const manual = version('manual', 'imported', { metadata: { provenance: { source: 'import' } } })
  const current = registry(entity({ states: [state({ referenceVersionId: 'manual' })] }))
  const jobs = [job('new', second, { request: { entity: metadata(), references: [{ versionId: 'manual', role: 'reference' }] } })]
  const assets = [asset([manual, version('new-image', 'new')])]
  const result = planEntityImageResults(current, assets, jobs, projectId)
  assert.equal(result.continuity.entities[0].states[0].referenceVersionId, 'new-image')
  assert.deepEqual(result.linked, [{ entityId: 'raft', stateId: 'state-1', jobId: 'new', versionId: 'new-image' }])
  current.entities[0].states[0].imageResultCheckpoint = { jobId: 'new', createdAt: second }
  const laterChoice = planEntityImageResults(current, assets, jobs, projectId)
  assert.equal(laterChoice.changed, 0); assert.equal(laterChoice.continuity.entities[0].states[0].referenceVersionId, 'manual')
})

test('缺失产物、来源不符、跨项目和非图片都不绑定、不推进水位，产物回来后可重试', () => {
  const badProvenance = { ...metadata(), stateId: 'other' }
  const cases = [
    [], [asset([version()], { projectId: 'other' })], [asset([version()], { role: 'scene' })],
    [asset([version()], { kind: 'video' })], [asset([version('image', 'other')])],
    [asset([version('image', 'job-1', { mimeType: 'video/mp4' })])],
    [asset([version('image', 'job-1', { metadata: { provenance: { jobId: 'job-1', entity: badProvenance } } })])],
    [asset([version('image', 'job-1', { metadata: { provenance: { jobId: 'job-1' } } })])],
  ]
  const current = registry()
  for (const assets of cases) { const result = planEntityImageResults(current, assets, [job()], projectId); assert.equal(result.continuity, current); assert.equal(result.changed, 0) }
  assert.equal(planEntityImageResults(current, [asset()], [job()], projectId).changed, 1)
  for (const patch of [{ projectId: 'other' }, { restored: true }, { capability: 'video' }, { createdAt: 'invalid' }, { request: {} }, { request: { entity: { ...metadata(), kind: 'scene' } } }]) assert.equal(planEntityImageResults(current, [asset()], [job('job-1', first, patch)], projectId).changed, 0)
})

test('生成中编辑定义或风格，旧定义结果仅保留素材，不覆盖当前设定图', () => {
  const current = registry(), assets = [asset()], jobs = [job()]
  for (const change of [c => { c.entities[0].traits = '新增绳索' }, c => { c.entities[0].states[0].description = '破损' }, c => { c.style = '水墨' }]) {
    const edited = structuredClone(current); change(edited)
    assert.equal(planEntityImageResults(edited, assets, jobs, projectId).changed, 0)
    assert.equal(edited.entities[0].states[0].imageResultCheckpoint, undefined)
  }
})

test('多输出使用自然文件序号，同发起时间按任务ID排序且兼容ISO时间', () => {
  const versions = [version('image-10', 'job-z'), version('image-2', 'job-z'), version('image-1', 'job-a')]
  const jobs = [job('job-z', first), job('job-a', new Date(Number(first)).toISOString())]
  const result = planEntityImageResults(registry(), [asset(versions)], jobs, projectId)
  assert.equal(result.continuity.entities[0].states[0].referenceVersionId, 'image-2')
  assert.equal(result.continuity.entities[0].states[0].imageResultCheckpoint.jobId, 'job-z')
})
