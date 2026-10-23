import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createShot, parseStoryboardCandidate, validateStoryboard, storyboardPrompt, contentFingerprint, storyboardSourceFingerprint, snapshotStoryboardSource } from '../src/storyboard.js'
import { projectCharacterNames, matchShotCharacters, bindShotCharacters } from '../src/storyboard-characters.js'
import { bindShotReferences } from '../src/storyboard-references.js'
import { replaceSourceShots } from '../src/storyboard-scope.js'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'

const asset = (name, id) => ({ id: `asset-${id}`, name: `${name} · 正脸与三视图`, role: 'character', kind: 'image', selectedVersionId: id, versions: [{ id, mimeType: 'image/png' }] })
const assets = [asset('陆骁', 'lu'), asset('苏遥', 'su'), asset('船长', 'captain')]
const candidate = JSON.stringify({ shots: [{ title: '相遇', visual: '陆骁与苏遥交谈，提起船长。', characterNames: ['陆骁', '苏遥'] }, { title: '空镜', visual: '海面。', characterNames: [] }] })

test('项目角色表合并小传和角色素材，拆镜指令要求逐镜列出多角色并区分提及与出场', () => {
  const names = projectCharacterNames({ characters: { content: '| 角色 | 身份 |\n| --- | --- |\n| 陆骁 | 主角 |\n| 路人 | 配角 |' } }, [...assets, { ...asset('海面', 'sea'), role: 'scene' }])
  assert.deepEqual(names, ['陆骁', '路人', '苏遥', '船长'])
  assert.match(storyboardPrompt('', names), /不包含仅被提到的人物/)
  assert.ok(storyboardPrompt('', names).includes(JSON.stringify(names)))
})

test('多人分镜只绑定实际出场角色，空镜不绑，重复操作不增加引用', () => {
  const [shot, empty] = parseStoryboardCandidate(candidate)
  shot.references = bindShotCharacters(shot, assets).references
  assert.deepEqual(shot.references.map(ref => ref.versionId), ['lu', 'su'])
  assert.deepEqual(bindShotCharacters(shot, assets).references, shot.references)
  assert.deepEqual(bindShotCharacters(empty, assets).references, [])
  assert.deepEqual(matchShotCharacters(shot, assets).map(match => match.status), ['bound', 'bound'])
  assert.equal(validateStoryboard({ revision: 1, shots: [shot, empty] }).shots.length, 2)
})

test('缺图、未选用版本、同名和别名不猜测，旧候选保持兼容', () => {
  const shot = createShot({ characterNames: ['陆骁', '苏遥', '陌生人', '阿骁'] })
  const options = [assets[0], asset('陆骁', 'lu-other'), { ...assets[1], selectedVersionId: 'gone' }]
  const result = bindShotCharacters(shot, options)
  assert.deepEqual(result.references, [])
  assert.deepEqual(result.matches.map(match => match.status), ['ambiguous', 'missing', 'missing', 'missing'])
  const old = parseStoryboardCandidate('{"shots":[{"visual":"陆骁抬头"}]}')[0]
  assert.equal(old.characterNames, undefined)
  assert.deepEqual(bindShotCharacters(old, assets).references, [])
  for (const characterNames of ['陆骁', [7], [''], Array(17).fill('陆骁')]) assert.throws(() => parseStoryboardCandidate(JSON.stringify({ shots: [{ visual: '画面', characterNames }] })), /角色、场景或道具列表/)
})

test('已有固定旧版和其他用途不覆盖，超过参考上限明确保留为待处理', () => {
  const shot = createShot({ characterNames: ['陆骁', '苏遥'] })
  shot.references = [{ versionId: 'lu-old', role: 'reference' }, { versionId: 'start', role: 'start' }]
  const updated = [{ ...assets[0], versions: [...assets[0].versions, { id: 'lu-old', mimeType: 'image/png' }] }, assets[1]]
  const result = bindShotCharacters(shot, updated)
  assert.deepEqual(result.references.map(ref => ref.versionId), ['lu-old', 'start', 'su'])
  assert.equal(shot.references.length, 2, 'matching must not mutate stored data')
  shot.references = Array.from({ length: 16 }, (_, i) => ({ role: 'reference', versionId: `existing-${i}` }))
  const full = bindShotCharacters(shot, assets)
  assert.equal(full.references.length, 16)
  assert.deepEqual(full.matches.map(match => match.status), ['limit', 'limit'])
})

test('Flow 和 Muse 都导出自动绑定的多角色图片，并提示部分缺图', () => {
  const shot = parseStoryboardCandidate(candidate)[0]
  shot.characterNames.push('陌生人')
  shot.references = bindShotCharacters(shot, assets).references
  for (const build of [buildFlowExport, buildMuseExport]) {
    const result = build({ project: { name: '测试', type: '短剧' }, storyboard: { revision: 1, shots: [shot] } }, assets)
    assert.deepEqual(result.images.map(image => image.versionId), ['lu', 'su'])
    assert.match(result.texts.find(file => file.path.endsWith('prompt.txt')).content, /出场角色：陆骁、苏遥、陌生人/)
    assert.match(result.texts.find(file => file.path === 'shot-001/说明.md').content, /陌生人.*尚未绑定/)
  }
})

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
const apply = source.slice(source.indexOf('  async function applyCandidate('), source.indexOf('\n  function prepareShotRequest(', source.indexOf('  async function applyCandidate(')))

test('实际采纳入口把多角色引用和候选一起保存，剧本变化时不写入', async () => {
  const data = { projectId: 'project', documents: { scene: { content: '剧本' } }, storyboard: { revision: 0, shots: [] } }
  const saved = [], notices = []
  const environment = { context: () => data, assets, candidate: { projectId: 'project', documentId: 'scene', fingerprint: contentFingerprint('剧本'), revision: 0, text: candidate }, contentFingerprint, storyboardSourceFingerprint, parseStoryboardCandidate, bindShotCharacters, bindShotReferences, SHOT_LIMIT: 120, run: async fn => fn(), candidateHost: { querySelector: () => null }, changeStoryboard: async fn => { fn(data.storyboard.shots); saved.push(structuredClone(data.storyboard)) }, onCandidateResolved: null, selectedShotId: null, showSource() {}, renderSources() {}, renderCandidate() {}, renderShots() {}, notify: message => notices.push(message) }
  vm.createContext(environment)
  environment.invoke = null
  vm.runInContext(`${apply}\nthis.apply = applyCandidate`, environment)
  await environment.apply()
  assert.deepEqual(saved[0].shots[0].references.map(ref => ref.versionId), ['lu', 'su'])
  assert.deepEqual(saved[0].shots[1].references, [])
  environment.candidate = { projectId: 'project', documentId: 'scene', fingerprint: contentFingerprint('旧剧本'), revision: 0, text: candidate }
  await assert.rejects(environment.apply(), /剧本在生成后已修改/)
  assert.equal(saved.length, 1)
})

const receive = source.slice(source.indexOf('  async function receiveCandidate('), source.indexOf('\n  function clearCandidate(', source.indexOf('  async function receiveCandidate(')))
const snapshot = source.slice(source.indexOf('  function candidateSnapshot('), source.indexOf('\n  async function receiveCandidate(', source.indexOf('  function candidateSnapshot(')))

function autoHarness() {
  const data = { projectId: 'project', documents: { scene: { content: '剧本' } }, storyboard: { revision: 0, shots: [createShot({ title: '原有镜头', visual: '已有编辑' })] } }
  const saves = [], notices = []
  const environment = {
    context: () => data, assets, candidate: null, candidateRestoredProjectId: null, invoke: true, projectId: 'project', loading: false, error: '',
    contentFingerprint, storyboardSourceFingerprint, parseStoryboardCandidate, bindShotCharacters, bindShotReferences, snapshotStoryboardSource, SHOT_LIMIT: 120,
    run: async fn => { try { return await fn() } catch (error) { notices.push(error.message) } },
    candidateHost: { querySelector: () => null },
    changeStoryboard: async (fn, options) => { const next = structuredClone(data.storyboard); fn(next.shots, next); next.revision++; data.storyboard = next; saves.push(options) },
    onCandidateResolved: null, selectedShotId: null, showSource() {}, renderSources() {}, renderCandidate() {}, renderShots() {}, notify: message => notices.push(message),
    refresh: async () => {}, navigate() {}
  }
  vm.createContext(environment)
  vm.runInContext(`${snapshot}\n${apply}\n${receive}\nthis.receive = receiveCandidate`, environment)
  const generation = { projectId: 'project', documentId: 'scene', sourceFingerprint: contentFingerprint('剧本'), storyboardRevision: 0, storyboardSourceFingerprint: storyboardSourceFingerprint(data.storyboard, 'scene') }
  return { data, saves, notices, environment, receive: (text = candidate, autoApply = true) => environment.receive(text, generation, 'draft-1', { autoApply }) }
}

test('拆镜完成自动追加并保存所有字段及多角色参考，保留原有镜头并一次性清除候选', async () => {
  const h = autoHarness()
  let refreshed = false
  h.environment.refresh = async () => { refreshed = true; h.environment.assets = [asset('陆骁', 'lu-new'), assets[1]] }
  h.environment.onCandidateResolved = async (id, options) => { assert.equal(id, 'draft-1'); assert.equal(options.committed, true) }
  await h.receive(JSON.stringify({ shots: [{ visual: '两人交谈', characterNames: ['陆骁', '苏遥'], dialogue: '你好', camera: '推近', action: '举手', duration: 8, entryState: '站立', exitState: '转身', transition: 'continuous' }] }))
  assert.equal(refreshed, true)
  assert.equal(h.data.storyboard.shots[0].title, '原有镜头')
  const shot = h.data.storyboard.shots[1]
  assert.deepEqual(shot.references.map(ref => ref.versionId), ['lu-new', 'su'])
  assert.equal(shot.duration, 8)
  assert.equal(shot.camera, '推近')
  assert.equal(shot.transition, 'continuous')
  assert.equal(shot.sourceDocumentId, 'scene')
  assert.equal(h.saves[0].resolvedCandidateId, 'draft-1')
  assert.equal(h.environment.candidate, null)
  assert.match(h.notices.at(-1), /已自动保存 1 个镜头，关联 2 项/)
})

test('停止或恢复的待审稿只展示，不自动写入', async () => {
  const h = autoHarness()
  await h.receive(candidate, false)
  assert.equal(h.saves.length, 0)
  assert.ok(h.environment.candidate)
})

test('自动配置遇到失效输入、资产读取失败或磁盘失败时保留候选和原有镜头', async () => {
  for (const failure of ['json', 'document', 'revision', 'assets', 'save', 'project']) {
    const h = autoHarness()
    h.environment.refresh = async () => {
      if (failure === 'document') h.data.documents.scene.content += '修改'
      if (failure === 'revision') { h.data.storyboard.revision++; h.data.storyboard.shots[0].sourceDocumentId = 'scene' }
      if (failure === 'assets') h.environment.error = '读取失败'
      if (failure === 'project') h.data.projectId = 'other'
    }
    if (failure === 'save') h.environment.changeStoryboard = async () => { throw new Error('磁盘写入失败') }
    await h.receive(failure === 'json' ? '未完成 JSON' : candidate)
    assert.equal(h.saves.length, 0, failure)
    assert.equal(h.data.storyboard.shots.length, 1, failure)
    assert.ok(h.environment.candidate, failure)
    assert.ok(h.notices.length, failure)
  }
})

test('缺图仍保存可用分镜并提示，慢速读取不误用切换后的候选', async () => {
  const h = autoHarness()
  await h.receive(JSON.stringify({ shots: [{ visual: '陌生人走来', characterNames: ['陌生人'] }] }))
  assert.equal(h.data.storyboard.shots.length, 2)
  assert.match(h.notices.at(-1), /待补充或确认：陌生人/)
  const switched = autoHarness()
  switched.environment.refresh = async () => { switched.environment.candidate = { text: candidate } }
  await switched.receive()
  assert.equal(switched.saves.length, 0)
})


test('其他分场修改不阻断候选自动保存，同分场变更仍保护原镜头', async () => {
  const h = autoHarness()
  h.environment.refresh = async () => { h.data.storyboard.revision++; h.data.storyboard.shots[0].visual = '另一个分场的新内容' }
  assert.equal(await h.receive(), 2)
  assert.equal(h.data.storyboard.shots[0].visual, '另一个分场的新内容')
  assert.equal(h.data.storyboard.shots.length, 3)
})


test('追加与替换成功后清空候选，界面回调失败也不能重复采纳', async () => {
  for (const replace of [false, true]) {
    const h = autoHarness()
    h.data.storyboard.shots[0].sourceDocumentId = 'scene'
    const other = createShot({ title: '其他分场' }, { documentId: 'other' })
    h.data.storyboard.shots.push(other)
    await h.receive(candidate, false)
    h.environment.candidate.storyboardSourceFingerprint = storyboardSourceFingerprint(h.data.storyboard, 'scene')
    h.environment.replaceSourceShots = replaceSourceShots
    h.environment.window = { confirm: () => true }
    h.environment.onCandidateResolved = async () => { throw new Error('显示刷新失败') }
    assert.equal(await h.environment.applyCandidate(replace), 2)
    assert.equal(h.environment.candidate, null)
    assert.equal(h.data.storyboard.shots.length, replace ? 3 : 4)
    assert.deepEqual(h.data.storyboard.shots.find(s => s.id === other.id), other)
    await h.environment.applyCandidate(replace)
    assert.equal(h.saves.length, 1, 'double action cannot append or replace the resolved candidate again')
  }
})

test('已有分场明确选择重做才自动替换，并完整保留旧镜头及固定素材历史', async () => {
  const h = autoHarness(), original = h.data.storyboard.shots[0]
  original.sourceDocumentId = 'scene'; original.selectedImageVersionId = 'pinned-image'; original.references = [{ versionId: 'lu', role: 'reference', origin: 'manual' }]
  const before = structuredClone(original)
  h.environment.replaceSourceShots = replaceSourceShots
  await h.environment.receive(candidate, { projectId: 'project', documentId: 'scene', sourceFingerprint: contentFingerprint('剧本'), storyboardSourceFingerprint: storyboardSourceFingerprint(h.data.storyboard, 'scene'), storyboardApplyMode: 'replace' }, 'new-draft', { autoApply: true })
  assert.equal(h.data.storyboard.shots.length, 2, 'redo must not append duplicate shots')
  assert.deepEqual(h.data.storyboard.sourceVersions[0].shots[0], before)
  assert.equal(h.saves[0].resolvedCandidateId, 'new-draft')
})

test('已有分场选择对比或旧请求无明确方式时不自动写入', async () => {
  for (const storyboardApplyMode of ['compare', undefined]) {
    const h = autoHarness(); h.data.storyboard.shots[0].sourceDocumentId = 'scene'
    await h.environment.receive(candidate, { projectId: 'project', documentId: 'scene', sourceFingerprint: contentFingerprint('剧本'), storyboardApplyMode }, 'new-draft', { autoApply: true })
    assert.equal(h.saves.length, 0); assert.equal(h.data.storyboard.shots.length, 1); assert.ok(h.environment.candidate)
  }
})
