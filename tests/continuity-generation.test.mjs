import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEntityExtractionDraft } from '../src/continuity-generation.js'
import { createEntity, emptyContinuity } from '../src/continuity-assets.js'
import { validateCandidateDrafts } from '../src/candidate-drafts.js'
import { createShot, mediaPrompt, shotInputFingerprint, validateStoryboard } from '../src/storyboard.js'
import { buildFlowExport, buildMuseExport } from '../src/video-export.js'

test('整集提取超过普通12k创作要求仍完整发送，不混入编辑器选区或截断正文', () => {
  const prompt = '木筏是平板结构。'.repeat(1800) + '最后一场仍为平板结构'
  const prepared = prepareEntityExtractionDraft(prompt, { name: '测试项目', type: '漫剧' })
  assert.ok(prompt.length > 12000)
  assert.ok(prepared.messages[1].content.endsWith(prompt))
  assert.equal(prepared.truncated, false)
  assert.equal(prepared.summary[0].content, prompt)
  assert.throws(() => prepareEntityExtractionDraft('汉'.repeat(33000)), /分场分批提取/)
  assert.throws(() => prepareEntityExtractionDraft(''), /为空/)
})

test('提取候选保存全范围原文指纹，缺少快照和泄漏执行端配置被拒绝', () => {
  const draft = { id: 'draft', documentId: 'scene', tabName: 'script', prompt: '本场'.repeat(7000), text: '{"entities":[]}', createdAt: new Date().toISOString(), status: 'complete', context: { projectId: 'project', documentId: 'scene', tabName: 'script', purpose: 'asset-extraction', title: '分场', baseContent: '正文', sourceDocumentIds: ['scene'], sourceFingerprints: { scene: '2:abcd' } } }
  assert.equal(validateCandidateDrafts([draft])[0], draft)
  assert.throws(() => validateCandidateDrafts([{ ...draft, context: { ...draft.context, sourceFingerprints: {} } }]), /缺少分场快照/)
  assert.throws(() => validateCandidateDrafts([{ ...draft, context: { ...draft.context, connection: { apiKey: 'test' } } }]), /未知字段/)
})

test('连续性约束进入图片提示、Flow和Muse包，设定变化使已审视频失效', () => {
  const shot = createShot({ visual: '木筏在海面漂浮' }); shot.continuityNotes = '关键物品木筏：平板甲板，禁止替换成圆木外形'
  const entity = createEntity({ name: '木筏', traits: '平板甲板，禁止替换成圆木外形' })
  const data = { projectId: 'project', project: { name: '海上', type: '漫剧' }, documents: {}, storyboard: { revision: 1, shots: [shot], continuity: { ...emptyContinuity(), entities: [entity] } } }
  validateStoryboard(data.storyboard)
  assert.match(mediaPrompt(shot, data.project), /平板甲板/)
  for (const build of [buildFlowExport, buildMuseExport]) assert.ok(build(data, []).texts.some(text => text.path.endsWith('prompt.txt') && text.content.includes('平板甲板')))
  assert.notEqual(shotInputFingerprint(shot), shotInputFingerprint({ ...shot, continuityNotes: '木筏已经扩建，保留平板甲板' }))
  assert.throws(() => validateStoryboard({ ...data.storyboard, continuity: { ...data.storyboard.continuity, entities: [entity, entity] } }), /重复/)
})
