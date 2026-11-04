import test from 'node:test'
import assert from 'node:assert/strict'
import { episodeForDocument, isSceneDocument, splitEpisodeScript, prepareEpisodeScenes, prepareAssignShots } from '../src/episode-scenes.js'
import { createShot, contentFingerprint, shotInputFingerprint, videoReviewState } from '../src/storyboard.js'
import { validateWorkspace } from '../src/project-store.js'
import { createEntity, createEntityState, entityStateFingerprint } from '../src/continuity-assets.js'
import { bindShotReferences, planReferenceBackfill } from '../src/storyboard-references.js'

function fixture() {
  const shot = createShot({ title: '旧集镜头', visual: '人物站在桥上', sceneNames: ['桥'] }, { documentId: 'episode-a', fingerprint: contentFingerprint('整集正文') })
  Object.assign(shot, { id: 'shot-a', selectedImageVersionId: 'image-v1', selectedVideoVersionId: 'video-v1', reviewedVideoVersionId: 'video-v1', references: [{ versionId: 'reference-v1', role: 'reference', scope: 'continuity', origin: 'manual', entityId: 'entity-a', stateId: 'state-a' }] })
  const workspace = {
    project: { name: '分场结构' }, currentDocId: 'episode-a', activeTab: 'script',
    documents: { 'episode-a': { title: '第一集', content: '整集正文', meta: ['1 场'] }, 'episode-b': { title: '第二集', content: '另一集', meta: ['0 场'] }, 'scene-old': { title: '桥上', content: '已有分场', kicker: '1-1 · 外景', breadcrumb: '第 1 集 · 场 1' } },
    structure: { acts: [{ id: 'act', title: '第一幕', episodeIds: ['episode-a', 'episode-b'] }], episodes: { 'episode-a': { sceneIds: ['scene-old'] }, 'episode-b': { sceneIds: [] } } },
    tabContents: { 'scene-old': { outline: '原大纲', references: '原笔记', history: '原历史' } }, versions: { 'scene-old': [] }, versionCounters: { 'scene-old': 0 },
    storyboard: { revision: 9, shots: [shot, createShot({ visual: '另一镜' }, { documentId: 'scene-old', fingerprint: 'old' })], sourceVersions: [{ id: 'history-a', createdAt: '2026-11-04', sourceDocumentId: 'episode-a', label: '归场前', shots: [structuredClone(shot)] }] },
    mediaStoreMarker: { selected: ['image-v1', 'video-v1'] }, candidateDrafts: []
  }
  shot.reviewedInputFingerprint = shotInputFingerprint(shot, workspace.documents, workspace)
  return workspace
}

test('结构判断区分集、分场、场景资产和未知文档，标题重名不影响归属', () => {
  const data = fixture()
  data.documents['scene-two'] = { title: '桥上', content: '别集同名分场' }
  data.structure.episodes['episode-b'].sceneIds.push('scene-two')
  assert.equal(episodeForDocument(data, 'episode-a'), 'episode-a')
  assert.equal(episodeForDocument(data, 'scene-old'), 'episode-a')
  assert.equal(episodeForDocument(data, 'scene-two'), 'episode-b')
  assert.equal(isSceneDocument(data, 'scene-old'), true)
  assert.equal(isSceneDocument(data, 'episode-a'), false)
  assert.equal(isSceneDocument(data, 'asset-bridge'), false)
  assert.equal(episodeForDocument(data, 'unknown'), null)
})

test('明确场次拆分保留前言、标题、混合换行及所有原始字符', () => {
  const content = '第一集\r\n创作说明：保持原文。\r\n\r\n## 第一场：桥上 夜 外\r\n甲：走吧。\n\n### 第二场：仓库 夜 内\n乙：等等。\r结尾\n'
  const scenes = splitEpisodeScript(content)
  assert.deepEqual(scenes.map(scene => scene.title), ['第一场：桥上 夜 外', '第二场：仓库 夜 内'])
  assert.equal(scenes.map(scene => scene.content).join(''), content)
  assert.ok(scenes[0].content.startsWith('第一集\r\n创作说明'))
  assert.ok(scenes[1].content.startsWith('### 第二场'))
})

test('支持中文场景号、集场编号和英文显式场次，不凭叙述地点或普通标题猜分场', () => {
  for (const headings of [['场景一：庭院', '场景二：屋内'], ['1-1 外景 日', '1-2 内景 夜'], ['SCENE 1: bridge', 'SCENE 2: room'], ['**第 1 场：门口**', '**第 2 场：屋内**']]) {
    const content = headings.map(title => `${title}\n正文\n`).join('')
    const scenes = splitEpisodeScript(content)
    assert.equal(scenes.length, 2)
    assert.equal(scenes.map(scene => scene.content).join(''), content)
  }
  const content = '# 第一集\n## 核心冲突\n甲：第一场演出结束了。\n他走进客厅。\n## 结尾钩子\n保留全部原文。'
  assert.deepEqual(splitEpisodeScript(content), [{ title: '第 1 场 · 待确认', content }])
  assert.deepEqual(splitEpisodeScript(' \n'), [])
  assert.throws(() => splitEpisodeScript(Array.from({ length: 101 }, (_, i) => `第${i + 1}场：屋内\n正文\n`).join('')), /100/)
})

test('支持规范 S01 场次标题并保留 Markdown、前言和原文，不将普通 S 开头单词识别为场次', () => {
  const content = '# 第一集\r\n创作说明。\r\n## S01 | 内景 · 咖啡馆 | 黄昏\r\n甲：走吧。\n## S02｜外景 · 街道｜夜\n乙：等等。\n'
  const scenes = splitEpisodeScript(content)
  assert.deepEqual(scenes.map(scene => scene.title), ['S01 | 内景 · 咖啡馆 | 黄昏', 'S02｜外景 · 街道｜夜'])
  assert.equal(scenes.map(scene => scene.content).join(''), content)
  const ordinary = '## S01版本说明\n正文\n## Story\n说明'
  assert.equal(splitEpisodeScript(ordinary).length, 1)
  assert.equal(splitEpisodeScript(ordinary)[0].title, '第 1 场 · 待确认')
})

test('创建分场只追加独立 ID，保留原集、已有分场、媒体、历史和候选', () => {
  const data = fixture(), before = structuredClone(data)
  let sequence = 0
  const scenes = [{ title: '桥上', content: '同名但新正文\r\n' }, { title: '桥上', content: '另一场同名正文\n' }]
  const result = prepareEpisodeScenes(data, { episodeId: 'episode-a', scenes, expectedContent: '整集正文', expectedSceneIds: ['scene-old'], idFactory: () => `scene-new-${++sequence}` })
  assert.deepEqual(data, before)
  assert.deepEqual(result.sceneIds, ['scene-new-1', 'scene-new-2'])
  assert.deepEqual(result.workspace.structure.episodes['episode-a'].sceneIds, ['scene-old', ...result.sceneIds])
  assert.equal(result.workspace.documents['episode-a'].content, before.documents['episode-a'].content)
  assert.equal(result.workspace.documents['episode-a'].meta[0], '3 场')
  assert.deepEqual(result.workspace.documents['scene-old'], before.documents['scene-old'])
  assert.deepEqual(result.workspace.storyboard, before.storyboard)
  assert.deepEqual(result.workspace.mediaStoreMarker, before.mediaStoreMarker)
  assert.deepEqual(result.workspace.candidateDrafts, before.candidateDrafts)
  for (const [index, id] of result.sceneIds.entries()) {
    assert.equal(result.workspace.documents[id].content, scenes[index].content)
    assert.deepEqual(result.workspace.tabContents[id], { outline: '', references: '', history: '' })
    assert.deepEqual(result.workspace.versions[id], [])
    assert.equal(result.workspace.versionCounters[id], 0)
  }
  validateWorkspace(result.workspace)
})

test('未知集、过期正文或分场结构、空白内容、超限及重复 ID 均不覆盖原数据', () => {
  const data = fixture(), before = structuredClone(data)
  const input = { episodeId: 'episode-a', scenes: [{ title: '新场', content: '内容' }], expectedContent: '整集正文', expectedSceneIds: ['scene-old'], idFactory: () => 'scene-new' }
  for (const patch of [
    { episodeId: 'scene-old' }, { episodeId: 'missing' }, { expectedContent: '旧集正文' }, { expectedSceneIds: [] },
    { scenes: [] }, { scenes: [{ title: ' ', content: '内容' }] }, { scenes: [{ title: '场', content: ' \n' }] },
    { scenes: [{ title: '场'.repeat(201), content: '内容' }] },
    { scenes: Array.from({ length: 100 }, () => ({ title: '场', content: '内容' })) },
    { idFactory: () => 'scene-old' }, { idFactory: () => '__proto__' }
  ]) assert.throws(() => prepareEpisodeScenes(data, { ...input, ...patch }))
  assert.throws(() => prepareEpisodeScenes(data, { ...input, scenes: [{ title: '甲', content: '甲' }, { title: '乙', content: '乙' }] }), /标识/)
  assert.deepEqual(data, before)
  const created = prepareEpisodeScenes(data, input).workspace
  assert.throws(() => prepareEpisodeScenes(created, input), /分场已变化/)
  assert.throws(() => prepareEpisodeScenes(created, { ...input, expectedSceneIds: undefined }), /缺少快照/)
  assert.throws(() => prepareEpisodeScenes(created, { ...input, expectedSceneIds: ['scene-old', 'scene-new'] }), /重复提交/)
})

test('镜头归场保留 IDs、选用媒体和审核记录，仅调整所选归属、固定参考与修订号', () => {
  const data = fixture(), before = structuredClone(data)
  assert.equal(videoReviewState(data.storyboard.shots[0], data.documents, data).reviewed, true)
  const result = prepareAssignShots(data, { shotIds: ['shot-a'], targetSceneId: 'scene-old', expectedSources: { 'shot-a': 'episode-a' } })
  assert.deepEqual(data, before)
  assert.deepEqual(result.shotIds, ['shot-a'])
  assert.equal(result.workspace.storyboard.revision, 10)
  const expectedShot = { ...before.storyboard.shots[0], sourceDocumentId: 'scene-old' }
  assert.deepEqual(result.workspace.storyboard.shots[0], expectedShot)
  assert.deepEqual(result.workspace.storyboard.shots[1], before.storyboard.shots[1])
  assert.deepEqual(result.workspace.storyboard.sourceVersions, before.storyboard.sourceVersions)
  assert.deepEqual(result.workspace.documents, before.documents)
  assert.deepEqual(result.workspace.mediaStoreMarker, before.mediaStoreMarker)
  assert.deepEqual(result.workspace.candidateDrafts, before.candidateDrafts)
  assert.equal(videoReviewState(result.workspace.storyboard.shots[0], result.workspace.documents, result.workspace).reviewed, false)
  assert.equal(videoReviewState(result.workspace.storyboard.shots[0], result.workspace.documents, result.workspace).outdated, true)
  assert.match(result.warnings.join('\n'), /旧素材状态范围.*不自动迁移/)
  assert.match(result.warnings.join('\n'), /旧拆镜候选/)
  validateWorkspace(result.workspace)
})

test('镜头归场拒绝未知或集级目标、缺失/过期来源、重复选择和重复提交', () => {
  const data = fixture(), before = structuredClone(data)
  const input = { shotIds: ['shot-a'], targetSceneId: 'scene-old', expectedSources: { 'shot-a': 'episode-a' } }
  for (const patch of [
    { targetSceneId: 'episode-a' }, { targetSceneId: 'missing' }, { shotIds: ['missing'] }, { shotIds: [] },
    { shotIds: ['shot-a', 'shot-a'] }, { expectedSources: {} }, { expectedSources: { 'shot-a': 'other' } }
  ]) assert.throws(() => prepareAssignShots(data, { ...input, ...patch }))
  assert.deepEqual(data, before)
  const moved = prepareAssignShots(data, input).workspace
  assert.throws(() => prepareAssignShots(moved, input), /归属已变化/)
  assert.throws(() => prepareAssignShots(moved, { ...input, expectedSources: { 'shot-a': 'scene-old' } }), /无需重复/)
})

test('新旧来源正文完全相同仍使视频复核过期，不以相同文字伪造新来源通过', () => {
  const data = fixture()
  data.documents['scene-old'].content = data.documents['episode-a'].content
  const shot = data.storyboard.shots[0]
  shot.reviewedInputFingerprint = shotInputFingerprint(shot, data.documents, data)
  assert.equal(videoReviewState(shot, data.documents, data).reviewed, true)
  const moved = prepareAssignShots(data, { shotIds: [shot.id], targetSceneId: 'scene-old', expectedSources: { [shot.id]: 'episode-a' } }).workspace
  assert.equal(moved.storyboard.shots[0].sourceFingerprint, shot.sourceFingerprint)
  assert.equal(moved.storyboard.shots[0].reviewedInputFingerprint, shot.reviewedInputFingerprint)
  assert.equal(videoReviewState(moved.storyboard.shots[0], moved.documents, moved).outdated, true)
})

test('归场将所选镜头自动参考固定为手动，逐字段保留全部版本和用途，其他镜头不动', () => {
  const data = fixture(), current = data.storyboard.shots[0], untouched = data.storyboard.shots[1]
  current.references = [
    { versionId: 'auto-reference', role: 'reference', scope: 'continuity', origin: 'auto', entityId: 'entity-a', stateId: 'state-a' },
    { versionId: 'auto-start', role: 'start', scope: 'video', origin: 'auto' },
    { versionId: 'manual-end', role: 'end', scope: 'video', origin: 'manual' },
    { versionId: 'legacy', role: 'extend' }
  ]
  untouched.references = [{ versionId: 'untouched-auto', role: 'reference', origin: 'auto' }]
  const before = structuredClone(data)
  const moved = prepareAssignShots(data, { shotIds: [current.id, untouched.id], targetSceneId: 'scene-old', expectedSources: { [current.id]: 'episode-a', [untouched.id]: 'scene-old' } }).workspace
  assert.deepEqual(data, before)
  assert.deepEqual(moved.storyboard.shots[0], { ...before.storyboard.shots[0], sourceDocumentId: 'scene-old', references: before.storyboard.shots[0].references.map(ref => ref.origin === 'auto' ? { ...ref, origin: 'manual' } : ref) })
  assert.deepEqual(moved.storyboard.shots[1], before.storyboard.shots[1])
  assert.deepEqual(moved.storyboard.sourceVersions, before.storyboard.sourceVersions)
  validateWorkspace(moved)
})

test('目标分场绑定不同素材状态时，归场固定旧版本并经真实引用同步仍保留原图与选用图片视频', () => {
  const data = fixture(), shot = data.storyboard.shots[0]
  const entity = createEntity({
    id: 'raft', kind: 'prop', name: '木筏', traits: '平整木板筏面', sourceDocumentIds: ['episode-a', 'scene-old'],
    states: [
      createEntityState({ id: 'raft-initial', name: '完整', referenceVersionId: 'raft-old-image' }),
      createEntityState({ id: 'raft-broken', name: '破损', description: '前缘缺一块木板', sourceDocumentIds: ['scene-old'], basedOnStateId: 'raft-initial', referenceVersionId: 'raft-target-image' })
    ]
  })
  for (const state of entity.states) state.referenceFingerprint = entityStateFingerprint(entity, state)
  const assets = [{
    id: 'raft-asset', projectId: 'project-1', name: '木筏', role: 'prop', kind: 'image', selectedVersionId: 'raft-target-image',
    versions: entity.states.map(state => ({ id: state.referenceVersionId, mimeType: 'image/png', metadata: { provenance: { entity: { entityId: entity.id, stateId: state.id, kind: entity.kind, name: entity.name, stateName: state.name, definitionFingerprint: state.referenceFingerprint } } } }))
  }]
  data.storyboard.continuity = { version: 1, style: '', entities: [entity] }
  Object.assign(shot, { visual: '木筏在河面漂浮', propNames: ['木筏'], sceneNames: [], characterNames: [], references: [] })
  shot.references = bindShotReferences(shot, assets, data.documents, data.storyboard.continuity).references
  assert.deepEqual(shot.references.map(ref => [ref.versionId, ref.origin]), [['raft-old-image', 'auto']])
  const unprotected = bindShotReferences({ ...shot, sourceDocumentId: 'scene-old' }, assets, data.documents, data.storyboard.continuity)
  assert.deepEqual(unprotected.references.map(ref => ref.versionId), ['raft-target-image'])
  const before = structuredClone(data)
  const moved = prepareAssignShots(data, { shotIds: [shot.id], targetSceneId: 'scene-old', expectedSources: { [shot.id]: 'episode-a' } }).workspace
  const result = bindShotReferences(moved.storyboard.shots[0], assets, moved.documents, moved.storyboard.continuity)
  assert.equal(result.removed, 0)
  assert.equal(result.added, 0)
  assert.deepEqual(result.references, [{ ...before.storyboard.shots[0].references[0], origin: 'manual' }])
  const plan = planReferenceBackfill(moved.storyboard, assets, moved.documents, 'project-1')
  const synced = plan.storyboard.shots[0]
  assert.deepEqual(synced.references, result.references)
  assert.equal(synced.selectedImageVersionId, before.storyboard.shots[0].selectedImageVersionId)
  assert.equal(synced.selectedVideoVersionId, before.storyboard.shots[0].selectedVideoVersionId)
  assert.equal(synced.sourceFingerprint, before.storyboard.shots[0].sourceFingerprint)
  assert.deepEqual(data, before)
  validateWorkspace({ ...moved, storyboard: plan.storyboard })
})
