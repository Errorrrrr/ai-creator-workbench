import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createEntity, createEntityState, entityStateFingerprint } from '../src/continuity-assets.js'
import { buildContinuityExport } from '../src/continuity-export.js'

function fixture() {
  const people = createEntity({ kind: 'character', name: '陆骁', aliases: ['小陆'] })
  const scene = createEntity({ kind: 'scene', name: '河道' })
  const prop = createEntity({ kind: 'prop', name: '木筏', traits: '平整木板，不得变成圆木', sourceDocumentIds: ['s1', 's2'] })
  const base = prop.states[0], damaged = createEntityState({ name: '破损', description: '左舷一块板开裂', basedOnStateId: base.id, sourceDocumentIds: ['s2'] })
  prop.states.push(damaged)
  const data = { projectId: 'p', project: { name: '狂澜' }, documents: { s1: { title: '第一场' }, s2: { title: '第二场' } }, storyboard: { revision: 4, shots: [], continuity: { version: 1, style: '写实', entities: [people, scene, prop] } }, connections: [{ apiKey: 'SECRET-DO-NOT-EXPORT' }] }
  const assets = []
  function image(entity, state, id) {
    state.referenceVersionId = id; state.referenceFingerprint = entityStateFingerprint(entity, state, '写实')
    const asset = { id: `a-${id}`, projectId: 'p', kind: 'image', role: entity.kind, name: entity.name, selectedVersionId: 'newer-not-chosen', versions: [{ id, mimeType: 'image/png' }, { id: `newer-${id}`, mimeType: 'image/jpeg' }] }
    assets.push(asset); return asset
  }
  image(prop, base, 'base'); image(prop, damaged, 'damaged')
  assets.push({ id: 'old-character', projectId: 'p', kind: 'image', role: 'character', name: '小陆 · 正脸与三视图', versions: [{ id: 'old-image', mimeType: 'image/jpeg' }] })
  return { data, assets, people, scene, prop, base, damaged, image }
}
const manifest = bundle => JSON.parse(bundle.texts.find(file => file.path === 'manifest.json').content)
test('独立包按三类与全部状态导出固定版本、来源和基础图，旧角色自动纳入且不修改输入', () => {
  const f = fixture(), snapshot = structuredClone(f.data), before = structuredClone(f.assets)
  const bundle = buildContinuityExport(f.data, f.assets, { generatedAt: '2026-10-28T00:00:00Z' }), doc = manifest(bundle)
  assert.deepEqual(doc.entities.map(entity => entity.kind), ['character', 'scene', 'prop'])
  assert.deepEqual(bundle.images.map(image => image.versionId), ['old-image', 'base', 'damaged'])
  const changed = doc.entities[2].states[1]
  assert.equal(changed.baseState.reference.versionId, 'base'); assert.equal(changed.reference.versionId, 'damaged'); assert.deepEqual(changed.sources, [{ id: 's2', title: '第二场' }])
  assert.match(bundle.texts.find(file => file.path === changed.promptPath).content, /平整木板|圆木/)
  assert.ok(bundle.texts.find(file => file.path === changed.promptPath).content.includes(changed.baseState.reference.path))
  assert.deepEqual(f.data, snapshot); assert.deepEqual(f.assets, before); assert.ok(!JSON.stringify(bundle).includes('SECRET-DO-NOT-EXPORT'))
})
test('分类导出、无图与过期图有明确状态，缺失基础图不谎称已附带', () => {
  const f = fixture(); f.base.referenceFingerprint = 'old-definition'; f.damaged.referenceVersionId = 'missing'
  const bundle = buildContinuityExport(f.data, f.assets, { kind: 'prop' }), doc = manifest(bundle)
  assert.equal(doc.entities.length, 1); assert.equal(doc.entities[0].states[0].status, 'stale'); assert.equal(doc.entities[0].states[1].status, 'missing')
  assert.deepEqual(bundle.images.map(image => image.versionId), ['base'])
  const prompt = bundle.texts.find(file => file.path === doc.entities[0].states[1].promptPath).content
  assert.doesNotMatch(prompt, /以附带的基础状态参考图/); assert.match(prompt, /基础状态缺图或图片待确认/)
  assert.match(bundle.texts.find(file => file.path === '使用说明.md').content, /对应旧定义/)
})
test('图片版本跨项目、类型错配或重复时拒绝；空分类不产生空包', () => {
  for (const modify of [f => { f.assets[0].projectId = 'q' }, f => { f.assets[0].role = 'scene' }, f => { f.assets.push(structuredClone(f.assets[0])) }]) {
    const f = fixture(); modify(f); assert.throws(() => buildContinuityExport(f.data, f.assets), /当前项目|标识重复/)
  }
  const f = fixture(); f.data.storyboard.continuity.entities = [f.prop]
  assert.throws(() => buildContinuityExport(f.data, f.assets, { kind: 'character' }), /尚无设定/)
  assert.throws(() => buildContinuityExport(f.data, f.assets, { kind: 'bad' }), /分类无效/)
})
test('不安全或超长名称仅影响可读名，生成的路径稳定有界且无穿越', () => {
  const f = fixture(); f.prop.name = '../CON:木筏\\..'; f.base.name = '海'.repeat(80); f.damaged.name = 'NUL..'
  const bundle = buildContinuityExport(f.data, f.assets, { kind: 'prop' })
  for (const file of [...bundle.texts, ...bundle.images].filter(file => file.path.includes('/'))) {
    const parts = file.path.split('/'); assert.equal(parts.length, 4)
    for (const part of parts.slice(1, 3)) { assert.ok(Buffer.byteLength(part) <= 120); assert.doesNotMatch(part, /^[.\s]|[.\s]$|[<>:"/\\|?*\x00-\x1f]/) }
  }
})
test('面板导出使用新媒体快照、传递分类，并阻止读取媒体期间跨项目导出', async () => {
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('  async function exportContinuity('), source.indexOf('  async function exportPackage('))
  for (const switched of [false, true]) {
    const f = fixture(), calls = [], errors = []
    const env = { structuredClone, buildContinuityExport, context: () => f.data, requireProject() {}, desktop() {}, notify() {}, run: async action => { try { return await action() } catch (error) { errors.push(error.message) } }, invoke: async (command, payload) => { calls.push([command, payload]); if (command === 'media_list') { if (switched) f.data.projectId = 'q'; return { assets: f.assets } } return '/export/package' } }
    vm.runInNewContext(`${handler}\nthis.submit = exportContinuity`, env)
    const path = await env.submit({ projectId: 'p', kind: 'prop' })
    assert.deepEqual(calls.map(call => call[0]), switched ? ['media_list'] : ['media_list', 'media_export_continuity'])
    if (switched) assert.match(errors[0], /项目已切换/)
    else { assert.equal(path, '/export/package'); assert.equal(manifest(calls[1][1].bundle).entities.length, 1) }
  }
})
