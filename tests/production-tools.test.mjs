import test from 'node:test'
import assert from 'node:assert/strict'
import { productionRows, productionRowMatches } from '../src/production-overview.js'
import { assetUsage, filterLibraryAssets } from '../src/asset-library-tools.js'
import { createShot, contentFingerprint, shotInputFingerprint } from '../src/storyboard.js'

function fixture() {
  const documents = { ep1: { title: '第一集', content: '大纲' }, s1: { title: '第一场', content: '剧本' }, s2: { title: '第二场', content: '' }, ep2: { title: '第二集', content: '大纲' } }
  const shot = createShot({ title: '第一镜', visual: '人物近景', characterNames: [], sceneNames: [], propNames: [] }, { documentId: 's1', fingerprint: contentFingerprint('剧本') })
  const data = { documents, projectId: 'p', structure: { acts: [{ episodeIds: ['ep1', 'ep2'] }], episodes: { ep1: { sceneIds: ['s1', 's2'] }, ep2: { sceneIds: [] } } }, storyboard: { revision: 1, shots: [shot] } }
  const assets = [{ id: 'image', name: '苏遥正面', kind: 'image', role: 'character', selectedVersionId: 'i1', versions: [{ id: 'i1', name: '正面.png', mimeType: 'image/png' }] }, { id: 'video', name: '第一镜视频', kind: 'video', role: 'shot', selectedVersionId: 'v1', versions: [{ id: 'v1', name: '镜头.mp4', mimeType: 'video/mp4' }] }]
  return { data, assets, shot }
}

test('制作看板包含空场和未建分场的分集，按创作结构顺序显示', () => {
  const { data, assets } = fixture(), rows = productionRows(data, assets)
  assert.deepEqual(rows.map(row => row.documentId), ['s1', 's2', 'ep2'])
  assert.equal(rows[0].written, true); assert.equal(rows[1].written, false); assert.equal(rows[2].episodeOnly, true)
  assert.deepEqual(rows.filter(row => productionRowMatches(row, 'script')).map(row => row.documentId), ['s2', 'ep2'])
  assert.deepEqual(rows.filter(row => productionRowMatches(row, 'storyboard')).map(row => row.documentId), ['s2', 'ep2'])
})

test('缺图缺视频可定位具体镜头，失效版本不能计入完成数量', () => {
  const { data, assets, shot } = fixture()
  shot.selectedImageVersionId = 'missing-image'; shot.selectedVideoVersionId = 'missing-video'; shot.references = [{ versionId: 'missing-reference', role: 'reference' }]
  const row = productionRows(data, assets)[0]
  assert.equal(row.images, 0); assert.equal(row.videos, 0); assert.equal(row.complete, 0)
  for (const key of ['imageIds', 'videoIds', 'referenceIds']) assert.deepEqual(row[key], [shot.id])
  for (const filter of ['references', 'images', 'videos']) assert.equal(productionRowMatches(row, filter), true)
})

test('未审核视频归入待复核，源剧本修改不会被看板计为完成', () => {
  const { data, assets, shot } = fixture()
  shot.selectedVideoVersionId = 'v1'; shot.selectedImageVersionId = 'i1'
  let row = productionRows(data, assets)[0]
  assert.equal(row.images, 1); assert.equal(row.videos, 1); assert.deepEqual(row.reviewIds, [shot.id])
  shot.reviewedVideoVersionId = 'v1'; shot.reviewedInputFingerprint = shotInputFingerprint(shot, data.documents)
  assert.equal(productionRows(data, assets)[0].complete, 1)
  data.documents.s1.content = '改写后的剧本'
  row = productionRows(data, assets)[0]
  assert.equal(row.complete, 0); assert.deepEqual(row.staleIds, [shot.id]); assert.equal(productionRowMatches(row, 'storyboard'), true)
})

test('已删除来源镜头独立显示，前期设定不会充当未写分场', () => {
  const { data, assets, shot } = fixture()
  data.documents.world = { title: '世界观', content: '规则' }
  shot.sourceDocumentId = 'deleted'
  const rows = productionRows(data, assets)
  assert.equal(rows.some(row => row.documentId === 'world'), false)
  assert.equal(rows.at(-1).documentId, '__unassigned_shots__'); assert.equal(rows.at(-1).total, 1)
})

test('素材使用位置合并同镜头多种用途，保留历史引用不误报未使用', () => {
  const { data, assets, shot } = fixture()
  shot.references = [{ versionId: 'i1', role: 'reference' }]; shot.selectedImageVersionId = 'i1'
  let usage = assetUsage(assets[0], data)
  assert.equal(usage.current.length, 1); assert.deepEqual(usage.current[0].purposes, ['参考图', '选用分镜图'])
  data.storyboard.sourceVersions = [{ shots: [structuredClone(shot)] }]; data.storyboard.shots = []
  usage = assetUsage(assets[0], data)
  assert.equal(usage.current.length, 0); assert.equal(usage.historicalCount, 1)
  assert.deepEqual(filterLibraryAssets(assets, data, { usage: 'unused' }).map(asset => asset.id), ['video'])
  assert.deepEqual(filterLibraryAssets(assets, data, { usage: 'history' }).map(asset => asset.id), ['image'])
})

test('素材搜索、类型和使用过滤组合生效，排序不修改原数组', () => {
  const { data, assets, shot } = fixture()
  shot.selectedVideoVersionId = 'v1'
  const before = structuredClone(assets)
  assert.deepEqual(filterLibraryAssets(assets, data, { query: '正面.PNG', kind: 'image', usage: 'unused' }).map(asset => asset.id), ['image'])
  assert.deepEqual(filterLibraryAssets(assets, data, { query: '镜头', kind: 'video', usage: 'used' }).map(asset => asset.id), ['video'])
  assert.deepEqual(filterLibraryAssets(assets, data, { query: '不存在' }), [])
  filterLibraryAssets(assets, data, { sort: 'name' }); assert.deepEqual(assets, before)
})
