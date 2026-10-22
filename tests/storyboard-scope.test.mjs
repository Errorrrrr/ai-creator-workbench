import test from 'node:test'
import assert from 'node:assert/strict'
import { storyboardGroups, scopeForDocument, scopedShots, moveSourceShot, replaceSourceShots, OTHER_EPISODE, UNASSIGNED_SOURCE } from '../src/storyboard-scope.js'

const shot = (id, sourceDocumentId) => ({ id, sourceDocumentId, references: [{ versionId: `${id}-ref`, role: 'reference' }] })
const data = {
  documents: Object.fromEntries(['ep1', 's1', 's2', 'ep2', 's3', 'draft'].map(id => [id, { title: `标题 ${id}` }])),
  structure: { acts: [{ episodeIds: ['ep1', 'ep2'] }], episodes: { ep1: { sceneIds: ['s1', 's2'] }, ep2: { sceneIds: ['s3'] } } },
  storyboard: { shots: [shot('second', 's2'), shot('first-a', 's1'), shot('other-episode', 's3'), shot('first-b', 's1'), shot('missing', 'deleted'), shot('manual', ''), shot('episode', 'ep1')] }
}

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

test('分场选择器跟随左侧当前文档，刷新保留全集范围，空集可回到分集正文', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const logic = source.slice(source.indexOf('  function visibleShots('), source.indexOf('  function renderShots('))
  const control = () => ({ value: '', options: [], replaceChildren(...options) { this.options = options }, append(option) { this.options.push(option) }, setAttribute() {} })
  const current = structuredClone(data); current.currentDocId = 's2'; current.projectId = 'p'
  const env = { context: () => current, storyboardGroups, scopeForDocument, scopedShots, OTHER_EPISODE, UNASSIGNED_SOURCE,
    selectedEpisodeId: '', selectedSourceId: '', lastContextDocId: null, storyboardTasks: { active: () => null }, renderStoryboardTaskProgress() {},
    episodeSelect: control(), sourceSelect: control(), wholeEpisodeButton: control(), generateButton: control(), addShotButton: control(),
    Option: function (text, value) { return { text, value } }, renderShots() {}, renderCandidate() {} }
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
  assert.ok(env.sourceSelect.options.some(option => option.value === 'ep2'))
})
