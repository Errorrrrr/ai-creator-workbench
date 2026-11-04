import test from 'node:test'
import assert from 'node:assert/strict'
import { createEntity, createEntityState, entityStateFingerprint } from '../src/continuity-assets.js'
import { prepareEntityRequest } from '../src/continuity-request.js'
import { useMediaAdapterCatalog } from '../src/media-adapters.js'

const imageAdapter = { id: 'openai-images', transport: 'api', capability: 'image', driverId: null, modes: ['generate', 'edit'], referenceRoles: ['reference'], maxReferences: 16 }
const cliAdapter = { ...imageAdapter, id: 'codex-native-image', transport: 'cli', driverId: 'codex' }
const catalog = (adapter = imageAdapter) => useMediaAdapterCatalog({ schemaVersion: 1, adapters: [structuredClone(adapter), structuredClone(cliAdapter)] })
const fixture = (kind = 'prop') => {
  catalog()
  const initial = createEntityState({ id: 'initial', name: '完整', description: '平整完整' })
  const item = createEntity({ id: 'raft', kind, name: '木筏', traits: '木板并排的平整筏面', states: [initial] })
  return { projectId: 'project-1', storyboard: { continuity: { version: 1, style: '', entities: [item] } }, workflow: {}, connections: [{ id: 'image-1', kind: 'image-api', adapter: 'openai-images', model: 'image-model', baseUrl: 'https://example.com/v1', defaultFor: ['image'] }] }
}
const entity = data => data.storyboard.continuity.entities[0]
const state = data => entity(data).states[0]
const generate = (data, assets = [], stateId = 'initial') => prepareEntityRequest(data, assets, 'raft', stateId)
const image = (patch = {}) => ({ id: 'asset-1', projectId: 'project-1', kind: 'image', role: 'prop', versions: [{ id: 'image-1', fileId: 'file-1', mimeType: 'image/png', bytes: 1024, metadata: {} }], ...patch })
const choose = (data, selected = state(data), versionId = 'image-1') => { selected.referenceVersionId = versionId; selected.referenceFingerprint = entityStateFingerprint(entity(data), selected, data.storyboard.continuity.style) }
const derived = data => { const item = createEntityState({ id: 'damaged', name: '破损', description: '右前角断裂', basedOnStateId: 'initial' }); entity(data).states.push(item); return item }

test('三类设定生成请求使用后端严格字段、状态目标和定义指纹，不修改源数据', () => {
  for (const kind of ['character', 'scene', 'prop']) {
    const data = fixture(kind), before = structuredClone(data), request = generate(data)
    assert.deepEqual(Object.keys(request).sort(), ['projectId', 'targetId', 'capability', 'entity', 'prompt', 'references', 'connection', 'parameters', 'allowUserProfile'].sort())
    assert.deepEqual(request.entity, { entityId: 'raft', stateId: 'initial', kind, name: '木筏', stateName: '完整', definitionFingerprint: entityStateFingerprint(entity(data), state(data)) })
    assert.equal(request.projectId, 'project-1'); assert.equal(request.targetId, 'entity-initial'); assert.equal(request.capability, 'image')
    assert.deepEqual(request.parameters, { mode: 'generate', aspectRatio: '16:9', duration: 5, size: '1536x1024', quality: 'high' })
    assert.deepEqual(request.references, []); assert.equal(request.allowUserProfile, false)
    assert.equal(request.connection.kind, 'api'); assert.equal(request.connection.adapter, 'openai-images')
    assert.deepEqual(data, before)
  }
})

test('派生状态必须先有有效且未过期的基础图，不能退回无参考生成', () => {
  const data = fixture(); derived(data)
  assert.throws(() => generate(data, [], 'damaged'), /先生成或选择基础状态/)
  choose(data)
  assert.throws(() => generate(data, [], 'damaged'), /实际图片版本/)
  const request = generate(data, [image()], 'damaged')
  assert.equal(request.parameters.mode, 'edit')
  assert.deepEqual(request.references, [{ versionId: 'image-1', role: 'reference' }])
  assert.match(request.prompt, /保持同一对象/)
  state(data).description = '改成圆木结构'
  assert.throws(() => generate(data, [image()], 'damaged'), /基础状态.*过期/)
  choose(data); data.storyboard.continuity.style = '改变视觉风格'
  assert.throws(() => generate(data, [image()], 'damaged'), /基础状态.*过期/)
})

test('已有自身图片优先作为编辑输入，旧指纹可用于重新生成当前定义', () => {
  const data = fixture(), changed = derived(data)
  choose(data, changed, 'own-image')
  changed.description += '，新增断裂痕迹'
  const request = generate(data, [image({ versions: [{ ...image().versions[0], id: 'own-image' }] })], 'damaged')
  assert.equal(request.parameters.mode, 'edit')
  assert.equal(request.references[0].versionId, 'own-image')
  assert.equal(request.entity.definitionFingerprint, entityStateFingerprint(entity(data), changed))
  assert.match(request.prompt, /新增断裂痕迹/)
})

test('引用必须属于当前项目和同类资产，并有支持的实际图片文件', () => {
  const data = fixture(); choose(data)
  for (const mutate of [
    asset => { asset.projectId = 'project-other' }, asset => { asset.kind = 'video' }, asset => { asset.role = 'scene' },
    asset => { asset.versions[0].mimeType = 'image/gif' }, asset => { asset.versions[0].mimeType = 'video/mp4' },
    asset => { delete asset.versions[0].fileId }, asset => { asset.versions[0].fileId = '../image.png' }, asset => { asset.versions[0].fileId = 123 },
    asset => { asset.versions[0].bytes = 0 }, asset => { asset.versions[0].bytes = 512 * 1024 * 1024 + 1 }, asset => { asset.versions[0].bytes = 1.5 },
  ]) {
    const asset = image(); mutate(asset)
    assert.throws(() => generate(data, [asset]), /实际图片版本/)
  }
  assert.throws(() => generate(data, [image(), image({ id: 'duplicate' })]), /实际图片版本/)
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) assert.equal(generate(data, [image({ versions: [{ ...image().versions[0], mimeType }] })]).parameters.mode, 'edit')
})

test('请求在发送前验证实体状态归属、名称和标识边界', () => {
  for (const mutate of [
    data => { data.projectId = '../project' }, data => { data.projectId = 123 },
    data => { entity(data).name = '木\u0085筏' }, data => { state(data).name = '完\u009f整' },
    data => { state(data).id = 'x'.repeat(90); entity(data).defaultStateId = state(data).id },
    data => { entity(data).unexpected = true }, data => { entity(data).kind = 'shot' },
  ]) { const data = fixture(); mutate(data); assert.throws(() => generate(data)) }
  assert.throws(() => generate(fixture(), [], 'missing'), /状态已不存在/)
  assert.throws(() => prepareEntityRequest(fixture(), [], 'other-entity', 'initial'), /状态已不存在/)
  const data = fixture(); state(data).id = 'x'.repeat(89); entity(data).defaultStateId = state(data).id
  assert.equal(generate(data, [], state(data).id).targetId.length, 96)
})

test('提示词按 UTF-8 字节上限校验，不误用中文字符数', () => {
  const data = fixture(), item = entity(data)
  item.traits = '木'.repeat(12000); item.description = '板'.repeat(12000); state(data).description = '破'.repeat(8000)
  data.storyboard.continuity.style = 'x'
  const first = generate(data), bytes = new TextEncoder().encode(first.prompt).byteLength
  const remaining = 100000 - bytes
  assert.ok(remaining > 0 && remaining < 3999)
  data.storyboard.continuity.style += 'x'.repeat(remaining)
  const boundary = generate(data)
  assert.equal(new TextEncoder().encode(boundary.prompt).byteLength, 100000)
  assert.ok(boundary.prompt.length < 100000)
  data.storyboard.continuity.style += 'x'
  assert.throws(() => generate(data), /超过 100000 字节/)
})

test('执行端模式与参考能力不匹配时拒绝，不自动切换资源', () => {
  const data = fixture(); choose(data)
  for (const adapter of [{ ...imageAdapter, modes: ['generate'] }, { ...imageAdapter, referenceRoles: [] }, { ...imageAdapter, maxReferences: 0 }]) {
    catalog(adapter); assert.throws(() => generate(data, [image()]), /不支持/)
  }
  const fresh = fixture(); catalog({ ...imageAdapter, modes: ['edit'] }); assert.throws(() => generate(fresh), /生成模式/)
  catalog(); data.connections[0].adapter = 'unknown'; assert.throws(() => generate(data, [image()]), /不支持/)
  data.workflow.imageConnectionId = 'missing'; assert.throws(() => generate(data), /不存在/)
})

test('API 和 CLI 配置保持各自协议，模型长度与 Rust 字节校验一致', () => {
  const data = fixture()
  data.connections[0].model = '木'.repeat(53) + 'x'
  assert.equal(generate(data).connection.model, data.connections[0].model)
  data.connections[0].model += 'x'; assert.throws(() => generate(data), /模型名称/)
  data.connections = [{ id: 'codex-1', kind: 'cli', driverId: 'codex', planningModel: 'planning-model', model: 'unused-image-model', defaultFor: ['image'] }]
  const request = generate(data)
  assert.equal(request.connection.kind, 'cli'); assert.equal(request.connection.adapter, 'codex-native-image')
  assert.equal(request.connection.model, 'planning-model'); assert.equal(request.connection.driverId, 'codex'); assert.equal(request.allowUserProfile, true)
})
