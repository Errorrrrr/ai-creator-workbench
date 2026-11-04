import test from 'node:test'
import assert from 'node:assert/strict'
import { storyboardGroups, scopeForDocument, scopedShots, moveSourceShot, replaceSourceShots, OTHER_EPISODE, UNASSIGNED_SOURCE, storyboardExportScope, storyboardSceneEntries, shotsForScenes, singleSceneExport } from '../src/storyboard-scope.js'
import { isSceneDocument } from '../src/episode-scenes.js'

const shot = (id, sourceDocumentId) => ({ id, sourceDocumentId, references: [{ versionId: `${id}-ref`, role: 'reference' }] })
const data = {
  documents: Object.fromEntries(['ep1', 's1', 's2', 'ep2', 's3', 'draft'].map(id => [id, { title: `标题 ${id}` }])),
  structure: { acts: [{ episodeIds: ['ep1', 'ep2'] }], episodes: { ep1: { sceneIds: ['s1', 's2'] }, ep2: { sceneIds: ['s3'] } } },
  storyboard: { shots: [shot('second', 's2'), shot('first-a', 's1'), shot('other-episode', 's3'), shot('first-b', 's1'), shot('missing', 'deleted'), shot('manual', ''), shot('episode', 'ep1')] }
}

test('导出范围名称区分分场、全集与未归属镜头', () => {
  assert.equal(storyboardExportScope(data, 'ep1', 's1'), '标题 ep1_标题 s1')
  assert.equal(storyboardExportScope(data, 'ep1', ''), '标题 ep1_全集')
  assert.equal(storyboardExportScope(data, OTHER_EPISODE, UNASSIGNED_SOURCE), '未归属镜头')
  const renamed = structuredClone(data)
  renamed.documents.ep1.title = 'EP01 深海垂钓者'
  renamed.documents.s1.title = 'EP01-SC001 烈日暴晒'
  assert.equal(storyboardExportScope(renamed, 'ep1', 's1'), 'EP01 深海垂钓者_EP01-SC001 烈日暴晒')
})

test('跨分场列表和镜头顺序遵循分集分场结构，未归属镜头单列且不重复', () => {
  const entries = storyboardSceneEntries(data)
  assert.deepEqual(entries.map(entry => entry.sourceId), ['s1', 's2', 'ep1', 's3', UNASSIGNED_SOURCE])
  assert.deepEqual(entries.at(-1).shots.map(shot => shot.id), ['missing', 'manual'])
  assert.deepEqual(shotsForScenes(data, new Set(['s3', 's1'])).map(shot => shot.id), ['first-a', 'first-b', 'other-episode'])
  assert.deepEqual(shotsForScenes(data, ['s1', 's1', 'deleted-scene']).map(shot => shot.id), ['first-a', 'first-b'])
})

test('单场导出保留固定引用和镜头ID，独立于当前全集状态，拒绝空分场或已删除分场', () => {
  const before = structuredClone(data), result = singleSceneExport(data, 's2')
  assert.deepEqual(result.storyboard.shots.map(shot => shot.id), ['second'])
  assert.equal(result.storyboard.shots[0].references[0].versionId, 'second-ref')
  assert.equal(result.exportScope, '标题 ep1_标题 s2')
  result.storyboard.shots[0].title = '导出副本'
  assert.deepEqual(data, before)
  assert.throws(() => singleSceneExport(data, 'removed'), /已不存在/)
  const empty = structuredClone(data); empty.storyboard.shots = []
  assert.throws(() => singleSceneExport(empty, 's2'), /尚无分镜/)
  assert.deepEqual(singleSceneExport(data, UNASSIGNED_SOURCE).storyboard.shots.map(shot => shot.id), ['missing', 'manual'])
})

test('分场过滤、全集按场次顺序显示，不混入其他集或未归属镜头', () => {
  assert.deepEqual(scopedShots(data, 'ep1', 's1').map(s => s.id), ['first-a', 'first-b'])
  assert.deepEqual(scopedShots(data, 'ep1', '').map(s => s.id), ['first-a', 'first-b', 'second', 'episode'])
  assert.deepEqual(scopedShots(data, 'ep2', '').map(s => s.id), ['other-episode'])
  assert.deepEqual(scopedShots(data, 'ep1', 's3'), [])
  assert.deepEqual(scopedShots(data, OTHER_EPISODE, UNASSIGNED_SOURCE).map(s => s.id), ['missing', 'manual'])
  assert.deepEqual(scopeForDocument(data, 's2'), { episodeId: 'ep1', sourceId: 's2' })
  assert.deepEqual(scopeForDocument(data, 'ep1'), { episodeId: 'ep1', sourceId: '' })
})

test('改名不影响归属，场次调序后全集随结构顺序显示，空集可访问', () => {
  const next = structuredClone(data)
  next.documents.s1.title = '新标题'
  next.structure.episodes.ep1.sceneIds.reverse()
  next.structure.episodes.ep2.sceneIds = []
  assert.equal(storyboardGroups(next)[0].sceneIds[0], 's2')
  assert.deepEqual(scopedShots(next, 'ep1', '').map(s => s.id), ['second', 'first-a', 'first-b', 'episode'])
  assert.deepEqual(scopedShots(next, 'ep2', ''), [])
  assert.deepEqual(scopedShots(next, OTHER_EPISODE, 's3').map(s => s.id), ['other-episode'])
})

test('分场内移动镜头保留其他场的顺序和引用，禁止跨场拖动', () => {
  const shots = structuredClone(data.storyboard.shots)
  const other = structuredClone(shots[2])
  moveSourceShot(shots, 'first-b', 'first-a')
  assert.deepEqual(shots.map(s => s.id), ['second', 'first-b', 'other-episode', 'first-a', 'missing', 'manual', 'episode'])
  assert.deepEqual(shots[2], other)
  assert.throws(() => moveSourceShot(shots, 'first-a', 'second'), /同一分场/)
})

test('替换只影响候选所属来源，保留其他场的镜头及素材引用', () => {
  const shots = structuredClone(data.storyboard.shots)
  const unaffected = shots.filter(s => s.sourceDocumentId !== 's1')
  replaceSourceShots(shots, 's1', [shot('replacement', 's1')])
  assert.deepEqual(shots.filter(s => s.sourceDocumentId !== 's1'), unaffected)
  assert.deepEqual(shots.map(s => s.id), ['second', 'replacement', 'other-episode', 'missing', 'manual', 'episode'])
})

test('分场选择器跟随左侧当前文档，刷新保留总览，集正文与待归场镜头不能直接拆镜', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  // Exercise scope navigation without pulling in the unrelated next-action UI.
  const extract = name => {
    const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
    assert.ok(match, `missing production function ${name}`)
    const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
    return body.slice(0, end.index + end[0].length)
  }
  const logic = ['visibleShots', 'selectDocument', 'showSource', 'focusShot', 'renderSources'].map(extract).join('\n')
  const control = () => ({ value: '', options: [], replaceChildren(...options) { this.options = options }, append(option) { this.options.push(option) }, setAttribute() {} })
  const current = structuredClone(data); current.currentDocId = 's2'; current.projectId = 'p'
  const env = { context: () => current, storyboardGroups, scopeForDocument, scopedShots, isSceneDocument, OTHER_EPISODE, UNASSIGNED_SOURCE,
    selectedEpisodeId: '', selectedSourceId: '', lastContextDocId: null, shotDetailOpen: false, detailPanel: 'picture',
    storyboardTasks: { active: () => null }, renderStoryboardTaskProgress() {}, renderNextAction() {}, selectDetailPanel() {},
    episodeSelect: control(), sourceSelect: control(), wholeEpisodeButton: control(), generateButton: control(), addShotButton: control(),
    organizeScenes() {}, organizeScenesButton: control(), assignShotsButton: control(), openScriptButton: control(), hierarchyBreadcrumb: control(),
    Option: function (text, value) { return { text, value } }, renderShots() {}, renderCandidate() {}, navigate() {}, shotList: { querySelectorAll: () => [] } }
  vm.createContext(env); vm.runInContext(logic, env)
  env.renderSources()
  assert.equal(env.selectedSourceId, 's2')
  assert.equal(env.selectedEpisodeId, 'ep1')
  env.selectedSourceId = ''; env.renderSources()
  assert.equal(env.selectedSourceId, '', 'background refresh preserves whole episode view')
  assert.equal(env.generateButton.disabled, true)
  env.selectDocument('s2')
  assert.equal(env.selectedSourceId, 's2', 'clicking the same sidebar scene exits whole episode view')
  env.storyboardTasks.active = () => ({ id: 'running' })
  env.selectDocument('s1'); env.renderSources()
  assert.equal(env.selectedSourceId, 's1', 'view-only navigation survives background refresh')
  assert.equal(current.currentDocId, 's2', 'generation context remains on its original scene')
  assert.equal(env.generateButton.disabled, true, 'other scenes cannot start a second task')
  current.currentDocId = 's1'; env.renderSources()
  assert.equal(env.selectedSourceId, 's1')
  current.currentDocId = 'ep2'; env.renderSources()
  assert.equal(env.selectedSourceId, '')
  assert.equal(env.selectedEpisodeId, 'ep2')
  assert.ok(!env.sourceSelect.options.some(option => option.value === 'ep2'), 'empty episode is an overview rather than a scene choice')
  assert.equal(env.generateButton.disabled, true)
  assert.equal(env.organizeScenesButton.hidden, false)
  current.currentDocId = 'ep1'; env.renderSources()
  assert.ok(env.sourceSelect.options.some(option => option.value === 'ep1' && /待归场/.test(option.text)), 'legacy episode shots remain accessible')
  env.selectedSourceId = 'ep1'; env.renderSources()
  assert.equal(env.generateButton.disabled, true)
  assert.equal(env.addShotButton.disabled, true)
  assert.equal(env.assignShotsButton.hidden, false)
  assert.match(env.hierarchyBreadcrumb.textContent, /待归场/)
  env.selectedEpisodeId = OTHER_EPISODE; env.selectedSourceId = UNASSIGNED_SOURCE; env.renderSources()
  assert.equal(env.generateButton.disabled, true)
  assert.equal(env.assignShotsButton.hidden, false)
  const before = structuredClone(current.storyboard.shots)
  assert.equal(env.focusShot('episode'), true)
  assert.equal(env.selectedSourceId, 'ep1', 'legacy episode shots can be located without pretending they are a scene')
  assert.equal(env.selectedShotId, 'episode')
  assert.equal(env.focusShot('missing'), true)
  assert.equal(env.selectedSourceId, UNASSIGNED_SOURCE)
  assert.equal(env.selectedEpisodeId, OTHER_EPISODE)
  assert.equal(env.focusShot('first-b'), true)
  assert.equal(env.selectedSourceId, 's1')
  assert.equal(env.selectedShotId, 'first-b')
  assert.equal(env.shotDetailOpen, true, 'locating a shot opens its detail instead of only highlighting the grid')
  assert.equal(env.detailPanel, 'picture')
  assert.equal(env.focusShot('gone'), false)
  env.selectDocument('s2')
  assert.equal(env.shotDetailOpen, false, 'choosing a different scene returns to its overview')
  assert.deepEqual(current.storyboard.shots, before, 'navigation never changes shot or media ownership')
})

test('旧来源镜头在分场列表明确待归场，查看与单场导出保持原ID和引用', () => {
  const entries = storyboardSceneEntries(data)
  const scene = entries.find(entry => entry.sourceId === 's1')
  const legacy = entries.find(entry => entry.sourceId === 'ep1')
  assert.equal(scene.pendingAssignment, false)
  assert.equal(legacy.pendingAssignment, true)
  assert.match(legacy.title, /^待归场/)
  const exported = singleSceneExport(data, 'ep1')
  assert.deepEqual(exported.storyboard.shots, data.storyboard.shots.filter(shot => shot.sourceDocumentId === 'ep1'))
})

test('绕过禁用按钮也不能对整集、其他文档或缺失来源直接拆镜或新建镜头', async () => {
  const { readFileSync } = await import('node:fs'), vm = await import('node:vm')
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const extract = name => {
    const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
    const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
    return body.slice(0, end.index + end[0].length)
  }
  for (const sourceId of ['ep1', 'draft', 'deleted', '']) {
    const current = structuredClone(data), before = structuredClone(current.storyboard.shots), notices = []
    const env = { context: () => current, requireProject() {}, isSceneDocument, selectedSourceId: sourceId, sourceSelect: { value: sourceId }, SHOT_LIMIT: 120,
      storyboardChoiceOpen: false, run: callback => callback(), notify: message => notices.push(message) }
    vm.createContext(env); vm.runInContext([extract('generateStoryboard'), extract('addShot')].join('\n'), env)
    await env.generateStoryboard()
    assert.match(notices[0], /先整理本集分场/)
    await assert.rejects(env.addShot(), /选择具体分场/)
    assert.deepEqual(current.storyboard.shots, before)
  }
})
