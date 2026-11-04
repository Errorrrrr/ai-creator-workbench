import test from 'node:test'
import assert from 'node:assert/strict'
import { captureOperationContext, materializeOperationPlan, operationTargetManifest, parseOperationPlan, prepareOperationRequest } from '../src/project-operations.js'
import { contentFingerprint, createShot } from '../src/storyboard.js'

function context(documentId = 'scene-1') {
  const oldShot = createShot({ title: '既有镜头', visual: '她走入门内。' }, { documentId: 'episode-1', fingerprint: 'original-source' })
  oldShot.references = [{ versionId: 'reference-v1', role: 'reference' }]
  oldShot.selectedImageVersionId = 'image-v1'
  oldShot.selectedVideoVersionId = 'video-v1'
  oldShot.reviewedVideoVersionId = 'video-v1'
  return {
    projectId: 'project-1',
    workspace: {
      currentDocId: documentId,
      documents: {
        'episode-1': { title: '第一集', content: '整集原剧本。' },
        'scene-1': { title: '第一场', content: '她走入门内。' },
        draft: { title: '未归场剧本', content: '原始全文。' }
      },
      structure: { acts: [{ id: 'act-1', episodeIds: ['episode-1'] }], episodes: { 'episode-1': { sceneIds: ['scene-1'] } } },
      tabContents: Object.fromEntries(['episode-1', 'scene-1', 'draft'].map(id => [id, { outline: '', references: '' }])),
      storyboard: { revision: 3, shots: [oldShot] }, versions: {}, versionCounters: {}
    },
    media: { projectId: 'project-1', versions: [{ id: 'replacement-v1', kind: 'image', assetId: 'replacement', name: '新候选图' }] }
  }
}
const capture = data => captureOperationContext(data, [{ key: 'current', characters: 6 }, { key: `object:shot:${data.workspace.storyboard.shots[0].id}`, characters: 6 }, { key: 'object:asset:replacement-v1', characters: 6 }])
const planText = operations => JSON.stringify({ version: 1, summary: '本场制作计划', operations })
const append = sourceDocumentId => ({ tool: 'append_shots', sourceDocumentId, shots: [{ title: '新镜头', visual: '她停下脚步。', duration: 5 }] })

test('操作清单区分分场与整集，新镜头只追加到确认的分场并保留旧媒体', () => {
  const data = context(), before = structuredClone(data), base = capture(data)
  assert.equal(base.documents['scene-1'].isScene, true)
  assert.equal(operationTargetManifest(base).documents[0].isScene, true)
  const draft = { messages: [{ role: 'system', content: '规划本场。' }, { role: 'user', content: '增加镜头。' }], summary: [] }
  assert.match(prepareOperationRequest(draft, base).messages[0].content, /isScene 为 true/)
  const prepared = materializeOperationPlan(parseOperationPlan(planText([append('scene-1')]), base), base, data)
  assert.equal(prepared.workspace.storyboard.shots.length, 2)
  assert.equal(prepared.workspace.storyboard.shots[1].sourceDocumentId, 'scene-1')
  assert.equal(prepared.workspace.storyboard.shots[1].sourceFingerprint, contentFingerprint(data.workspace.documents['scene-1'].content))
  assert.deepEqual(prepared.workspace.storyboard.shots[0], before.workspace.storyboard.shots[0])
  assert.deepEqual(prepared.workspace.documents, before.workspace.documents)
  assert.deepEqual(data, before, '预览不能修改原项目或媒体')
})

test('整集正文和其他文档不能通过项目操作计划绕过分场追加镜头', () => {
  for (const documentId of ['episode-1', 'draft']) {
    const data = context(documentId), base = capture(data), before = structuredClone(data)
    assert.equal(operationTargetManifest(base).documents[0].isScene, false)
    assert.throws(() => parseOperationPlan(planText([append(documentId)]), base), /具体分场/)
    assert.deepEqual(data, before)
  }
})

test('旧计划缺少分场分类时仍可读，但实际采纳必须核验当前分场结构', () => {
  for (const documentId of ['episode-1', 'draft']) {
    const data = context(documentId), base = capture(data)
    delete base.documents[documentId].isScene
    const plan = parseOperationPlan(planText([append(documentId)]), base)
    assert.throws(() => materializeOperationPlan(plan, base, data), /具体分场/)
    assert.equal(data.workspace.storyboard.shots.length, 1)
  }
  const data = context(), base = capture(data)
  delete base.documents['scene-1'].isScene
  assert.equal(materializeOperationPlan(parseOperationPlan(planText([append('scene-1')]), base), base, data).workspace.storyboard.shots.length, 2)
})

test('分场在计划生成后被移除，即使正文仍在也不能继续拆镜', () => {
  const data = context(), base = capture(data)
  const plan = parseOperationPlan(planText([append('scene-1')]), base)
  data.workspace.structure.episodes['episode-1'].sceneIds = []
  assert.throws(() => materializeOperationPlan(plan, base, data), /已有新修改|具体分场/)
  assert.equal(data.workspace.storyboard.shots.length, 1)
})

test('旧计划仍可修改非分场正文、旧镜头与选用媒体', () => {
  const data = context('episode-1'), base = capture(data), shotId = data.workspace.storyboard.shots[0].id
  delete base.documents['episode-1'].isScene
  const operations = [
    { tool: 'write_document', documentId: 'episode-1', tabName: 'script', mode: 'append', content: '补充集目标。' },
    { tool: 'update_shot', shotId, patch: { title: '已校对的旧镜头' } },
    { tool: 'select_shot_media', shotId, kind: 'image', versionId: 'replacement-v1' }
  ]
  const prepared = materializeOperationPlan(parseOperationPlan(planText(operations), base), base, data)
  assert.match(prepared.workspace.documents['episode-1'].content, /整集原剧本。\n\n补充集目标。/)
  const shot = prepared.workspace.storyboard.shots[0]
  assert.equal(shot.id, shotId)
  assert.equal(shot.sourceDocumentId, 'episode-1')
  assert.equal(shot.title, '已校对的旧镜头')
  assert.equal(shot.selectedImageVersionId, 'replacement-v1')
  assert.equal(shot.selectedVideoVersionId, 'video-v1')
  assert.deepEqual(shot.references, data.workspace.storyboard.shots[0].references)
})
