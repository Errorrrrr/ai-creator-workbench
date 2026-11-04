import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createShot, validateStoryboard } from '../src/storyboard.js'
import { createEntity, entityStateFingerprint } from '../src/continuity-assets.js'
import { makeVisualReview, visualInputFingerprint, imageVisualReviewState } from '../src/visual-review.js'

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const match = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  assert.ok(match, `missing production function ${name}`)
  const body = source.slice(match.index), end = new RegExp(`^${match[1]}\\}`, 'm').exec(body)
  assert.ok(end)
  return body.slice(0, end.index + end[0].length)
}

function harness() {
  const entity = createEntity({ id: 'raft', kind: 'prop', name: '木筏', traits: '三块木板与两个蓝色浮桶', sourceDocumentIds: ['scene'], states: [{ id: 'raft-base', name: '基础状态', referenceVersionId: 'ref-v1' }] })
  entity.states[0].referenceFingerprint = entityStateFingerprint(entity, entity.states[0], '写实电影')
  const shot = createShot({ title: '木筏近景', visual: '木筏漂浮', propNames: ['木筏'] }, { documentId: 'scene' })
  shot.id = 'shot-1'; shot.selectedImageVersionId = 'shot-image-v1'
  shot.references = [{ versionId: 'ref-v1', role: 'reference', scope: 'continuity', origin: 'auto', entityId: entity.id, stateId: entity.states[0].id }]
  let data = { projectId: 'p', documents: { scene: { title: '第一场', content: '木筏漂浮在海面。' } }, storyboard: { revision: 3, shots: [shot], continuity: { version: 1, style: '写实电影', entities: [entity] } } }
  const assets = [{ id: 'reference', projectId: 'p', name: '木筏', role: 'prop', kind: 'image', selectedVersionId: 'ref-v1', versions: [{ id: 'ref-v1', mimeType: 'image/png' }, { id: 'ref-v2', mimeType: 'image/png' }] }, { id: 'shot-image', projectId: 'p', name: '分镜图', kind: 'image', role: 'shot', versions: [{ id: 'shot-image-v1', mimeType: 'image/png' }, { id: 'shot-image-v2', mimeType: 'image/png' }] }]
  const controls = { fail: false, gate: null }, calls = { commits: [], renders: 0, details: 0, progress: 0, generated: 0 }
  let saved = null
  const env = {
    context: () => data, assets, structuredClone, loading: false, error: '', projectId: 'p', visualInputFingerprint, makeVisualReview,
    commit: async (patch, metadata) => {
      calls.commits.push({ patch: structuredClone(patch), metadata: structuredClone(metadata) })
      if (controls.gate) await controls.gate
      if (controls.fail) throw new Error('测试磁盘写入失败')
      if (metadata.projectId !== data.projectId || metadata.revision !== data.storyboard.revision) throw new Error('项目或分镜版本已变化')
      validateStoryboard(patch.storyboard)
      saved = JSON.stringify({ ...data, ...patch })
      data = JSON.parse(saved)
    },
    renderShots: () => { calls.renders++ }, refreshReferenceDetails: () => { calls.details++ }, productionOverview: { refresh: () => { calls.progress++ } },
    invoke: () => { calls.generated++; throw new Error('复核不能触发生图') }
  }
  vm.createContext(env)
  vm.runInContext([productionFunction('changeStoryboard'), productionFunction('saveVisualReview')].join('\n'), env)
  const expected = () => ({ projectId: data.projectId, imageVersionId: data.storyboard.shots[0].selectedImageVersionId, fingerprint: visualInputFingerprint(data.storyboard.shots[0], assets, data.documents, data.storyboard.continuity) })
  const review = (decision = { decision: 'approved', notes: '人物、结构和光线一致' }, input = expected()) => env.saveVisualReview('shot-1', decision, input)
  return { env, assets, controls, calls, expected, review, get data() { return data }, get saved() { return saved }, reload: () => { data = JSON.parse(saved) } }
}

test('工作台真实保存函数原子提交复核记录，失败不留内存通过标记，可重试并重载', async () => {
  const h = harness(), before = structuredClone(h.data.storyboard)
  h.controls.fail = true
  await assert.rejects(h.review(), /磁盘写入失败/)
  assert.deepEqual(h.data.storyboard, before)
  assert.equal(h.saved, null)
  assert.equal(h.data.storyboard.shots[0].visualReview, undefined)
  assert.equal(h.calls.renders, 0)
  assert.equal(h.calls.commits[0].metadata.atomic, true, 'failed reviews must also use the atomic persistence path')
  h.controls.fail = false; await h.review()
  const record = h.data.storyboard.shots[0].visualReview
  assert.equal(record.decision, 'approved'); assert.equal(record.notes, '人物、结构和光线一致')
  assert.equal(h.data.storyboard.revision, before.revision + 1)
  assert.equal(h.calls.commits[1].metadata.projectId, 'p'); assert.equal(h.calls.commits[1].metadata.revision, 3)
  assert.equal(h.calls.commits[1].metadata.atomic, true, 'visual approval must not use an optimistic/deferred commit')
  h.reload(); validateStoryboard(h.data.storyboard)
  assert.equal(imageVisualReviewState(h.data.storyboard.shots[0], h.assets, h.data.documents, h.data.storyboard.continuity).reviewed, true)
  assert.equal(h.calls.renders, 1); assert.equal(h.calls.details, 1); assert.equal(h.calls.progress, 1)
  assert.equal(h.calls.generated, 0)
})

test('工作台拒绝项目、选用图片或参考指纹已经变化的旧复核结论', async () => {
  for (const mutation of [
    h => { h.data.projectId = 'other'; h.env.projectId = 'other' },
    h => { h.data.storyboard.shots[0].selectedImageVersionId = 'shot-image-v2' },
    h => { h.data.storyboard.shots[0].references[0].versionId = 'ref-v2' },
    h => { h.data.storyboard.continuity.style = '改为水彩' },
    h => { h.data.documents.scene.content += '新增雨天' }
  ]) {
    const h = harness(), expected = h.expected()
    mutation(h)
    const changed = structuredClone(h.data.storyboard)
    await assert.rejects(h.review(undefined, expected), /项目已切换|图片或参考基准已变化/)
    assert.equal(h.calls.commits.length, 0)
    assert.deepEqual(h.data.storyboard, changed)
    assert.equal(h.calls.generated, 0)
  }
})

test('素材未就绪不写复核；图片在提交前消失不能被审核为通过', async () => {
  for (const field of ['loading', 'error', 'projectId']) {
    const h = harness(); h.env[field] = field === 'loading' ? true : field === 'error' ? '读取失败' : 'other'
    await assert.rejects(h.review(), /素材尚未读取完成/)
    assert.equal(h.calls.commits.length, 0)
  }
  const h = harness(), expected = h.expected()
  h.assets[1].versions = []
  await assert.rejects(h.review(undefined, expected), /分镜图|图片|缺少/)
  assert.equal(h.calls.commits.length, 0)
  assert.equal(h.data.storyboard.shots[0].visualReview, undefined)
})

test('提交期间切换项目或出现新修订，失败不会把克隆上的复核写回当前数据', async () => {
  for (const change of [h => { h.data.projectId = 'other' }, h => { h.data.storyboard.revision++; h.data.storyboard.shots[0].selectedImageVersionId = 'shot-image-v2' }]) {
    const h = harness(); let release
    h.controls.gate = new Promise(resolve => { release = resolve })
    const pending = h.review()
    assert.equal(h.calls.commits.length, 1)
    assert.equal(h.data.storyboard.shots[0].visualReview, undefined, '保存结束前只修改克隆')
    change(h); release()
    await assert.rejects(pending, /项目或分镜版本已变化/)
    assert.equal(h.data.storyboard.shots[0].visualReview, undefined)
    assert.equal(h.saved, null); assert.equal(h.calls.renders, 0)
  }
})

test('持久化通过后改视觉基准或选图需要重新复核，已有图与旧结论仍保留可追溯', async () => {
  const h = harness(); await h.review(); h.reload()
  const shot = h.data.storyboard.shots[0], originalRecord = structuredClone(shot.visualReview)
  h.data.storyboard.continuity.style = '水彩，明亮暖色'
  let state = imageVisualReviewState(shot, h.assets, h.data.documents, h.data.storyboard.continuity)
  assert.equal(state.status, 'changed'); assert.equal(state.reviewed, false)
  assert.equal(shot.selectedImageVersionId, 'shot-image-v1'); assert.deepEqual(shot.visualReview, originalRecord)
  h.data.storyboard.continuity.style = '写实电影'; shot.selectedImageVersionId = 'shot-image-v2'
  state = imageVisualReviewState(shot, h.assets, h.data.documents, h.data.storyboard.continuity)
  assert.equal(state.reviewed, false); assert.equal(state.status, 'changed')
  assert.equal(h.calls.generated, 0)
})
