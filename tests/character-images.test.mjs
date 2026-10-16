import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { biographyCharacters, characterImagePrompt, characterTargetId, prepareCharacterRequest } from '../src/character-images.js'
import { contentFingerprint } from '../src/storyboard.js'

const biography = '| 角色 | 身份 | 装备 |\n| :--- | :--- | :--- |\n| **陆骁** | 工程兵 | 飞钩 |\n| **苏遥**<br>*(EP03登场)* | 机械师 | 护目镜 |'
const connection = { id: 'image-1', kind: 'image-api', adapter: 'openai-images', baseUrl: 'https://example.com/v1', model: 'image-model', defaultFor: ['image'] }
const data = () => ({ projectId: 'project-1', project: { name: '测试', type: '漫剧' }, documents: { characters: { content: biography } }, connections: [structuredClone(connection)], workflow: {} })
const input = () => ({ name: '陆骁', biography: '陆骁，工程兵，黑色短发。', appearance: '灰色工装', style: '漫画', targetId: 'character-1', referenceVersionId: '' })

test('人物表格按角色拆出独立资料，换行后的出场信息不进入名称', () => {
  const characters = biographyCharacters(biography)
  assert.deepEqual(characters.map(item => item.name), ['陆骁', '苏遥'])
  assert.match(characters[0].biography, /身份：工程兵/)
  assert.ok(!characters[0].biography.includes('苏遥'))
  assert.match(characters[1].biography, /EP03登场/)
})

test('人物标题支持分节与未格式化小传，不把总标题当角色', () => {
  const source = '# 人物小传\n## 1. 陆骁\n工程兵\n### 外观\n短发\n## 2. 苏遥\n机械师'
  assert.deepEqual(biographyCharacters(source).map(item => item.name), ['陆骁', '苏遥'])
  assert.match(biographyCharacters(source)[0].biography, /短发/)
  assert.deepEqual(biographyCharacters('陆骁，工程兵'), [])
})

test('固定构图、风格与角色资料进入提示词，不混入镜头叙事参数', () => {
  const prompt = characterImagePrompt(input())
  assert.ok(prompt.startsWith('视觉风格：漫画'))
  for (const part of ['左侧为正脸特写', '正面、90 度侧面、背面', '头顶与脚底对齐', '完全一致', '纯白背景', '禁止文字', '灰色工装', '黑色短发']) assert.ok(prompt.includes(part), part)
  assert.ok(!prompt.includes('镜头：'))
  assert.throws(() => characterImagePrompt({ ...input(), name: '' }), /角色名称/)
  assert.throws(() => characterImagePrompt({ ...input(), name: '陆\n骁' }), /控制字符/)
  assert.throws(() => characterImagePrompt({ ...input(), biography: '字'.repeat(12001) }), /12000/)
})

test('角色目标稳定且无名称截断碰撞，项目隔离由 projectId 保持', async () => {
  assert.equal(await characterTargetId(' 陆骁 '), await characterTargetId('陆骁'))
  assert.notEqual(await characterTargetId('陆骁'), await characterTargetId('苏遥'))
  assert.match(await characterTargetId('陆骁'), /^character-[a-f0-9]{64}$/)
})

test('生成请求固定角色归属、小传版本与图片执行端，已有图使用编辑模式', () => {
  const request = prepareCharacterRequest(data(), input())
  assert.deepEqual(request.character, { name: '陆骁', sourceDocumentId: 'characters', sourceFingerprint: contentFingerprint(biography) })
  assert.equal(request.capability, 'image')
  assert.equal(request.parameters.mode, 'generate')
  assert.equal(request.parameters.aspectRatio, '16:9')
  assert.equal(request.parameters.size, '1536x1024')
  assert.equal(request.connection.model, 'image-model')
  const edit = prepareCharacterRequest(data(), { ...input(), referenceVersionId: 'version-1' })
  assert.equal(edit.parameters.mode, 'edit')
  assert.deepEqual(edit.references, [{ versionId: 'version-1', role: 'reference' }])
  const missing = data(); missing.workflow.imageConnectionId = 'deleted'
  assert.throws(() => prepareCharacterRequest(missing, input()), /不存在/)
  missing.workflow.imageConnectionId = ''; missing.connections = [{ id: 'text', kind: 'cli', driverId: 'antigravity', defaultFor: ['text'] }]
  assert.throws(() => prepareCharacterRequest(missing, input()), /未配置图片/)
})

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
const start = source.indexOf('  async function submitCharacterImages() {')
const end = source.indexOf('\n  function context()', start)
const productionSubmit = source.slice(start, end)
function harness({ save, secret, invoke } = {}) {
  const state = data(), fields = input(), calls = [], notices = []
  const dialog = { open: true, close() { this.open = false } }
  const environment = {
    context: () => state, characterInput: () => ({ ...fields }), characterOwner: state.projectId,
    characterSourceFingerprint: contentFingerprint(biography), characterDialog: dialog, characterStatus: {},
    jobs: [], assets: [], loading: false, error: '', roleFilter: {},
    contentFingerprint, prepareCharacterRequest, characterTargetId, terminal: status => status === 'completed',
    findMediaVersion: () => true, connectionFor: () => state.connections[0],
    run: async action => { try { await action() } catch (error) { notices.push(error.message) } },
    desktop() {}, requireAdapterCatalog: async () => {}, beforeSubmit: async () => save?.(state, fields, dialog),
    secret: async () => secret ? secret(state, fields) : 'local-fixture-key',
    invoke: async (command, payload) => { calls.push({ command, payload }); if (invoke) return invoke(); return { id: 'job-1', ...payload.request, request: payload.request, status: 'queued' } },
    navigate: view => calls.push({ view }), refresh: async () => {}, notify: text => notices.push(text), renderCharacterPreview() {}
  }
  vm.createContext(environment)
  vm.runInContext(`${productionSubmit}\nthis.submit = submitCharacterImages`, environment)
  return { state, fields, calls, notices, environment, dialog, submit: environment.submit }
}

test('提交角色生成后打开角色素材，排队任务仍属于原项目', async () => {
  const h = harness(); await h.submit()
  const call = h.calls.find(item => item.command === 'media_submit')
  assert.equal(call.payload.request.character.name, '陆骁')
  assert.equal(call.payload.request.projectId, 'project-1')
  assert.equal(h.environment.roleFilter.value, 'character')
  assert.equal(h.dialog.open, false)
  assert.match(h.notices.at(-1), /自动保存到原项目/)
})

test('异步保存或读密钥期间项目、小传、执行端和输入变化均阻止提交', async () => {
  for (const change of [state => { state.projectId = 'project-2' }, state => { state.documents.characters.content += '变化' }, state => { state.connections[0].baseUrl = 'https://changed.example/v1' }, (_state, fields) => { fields.name = '苏遥' }, (_state, _fields, dialog) => { dialog.open = false }]) {
    const h = harness({ save: change }); await h.submit()
    assert.equal(h.calls.length, 0)
    assert.match(h.notices.at(-1), /已变化/)
  }
  const h = harness({ secret: state => { state.projectId = 'project-2'; return 'key' } }); await h.submit()
  assert.equal(h.calls.length, 0)
})

test('保存失败、缺少密钥、生成拒绝与重复任务不会创建或切换素材', async () => {
  for (const options of [{ save() { throw new Error('保存失败') } }, { secret: () => null }, { invoke() { throw new Error('接口失败') } }]) {
    const h = harness(options); await h.submit()
    assert.equal(h.dialog.open, true)
    assert.ok(!h.calls.some(item => item.view))
  }
  const h = harness(); h.environment.jobs = [{ id: 'running', targetId: 'character-existing', capability: 'image', status: 'running', request: { character: { name: '陆骁' } } }]
  await h.submit(); assert.equal(h.calls.length, 0); assert.match(h.notices.at(-1), /正在生成/)
})
