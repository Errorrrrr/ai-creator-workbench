import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { scriptLines, prepareScenePlanDraft, parseScenePlanCandidate } from '../src/scene-planning.js'
import { GENERATION_CHARACTER_LIMIT } from '../src/creation-workflow.js'
import { contentFingerprint } from '../src/storyboard.js'
import { candidateDraftsFor, upsertCandidateDraft, validateCandidateDrafts } from '../src/candidate-drafts.js'
import { projectBackup, parseBackup, validateWorkspace } from '../src/project-store.js'

if (!globalThis.crypto) globalThis.crypto = webcrypto

function workspace(content = '前言\r\n第一场：咖啡馆\r\n甲：走吧。\n第二场：街道\r乙：等等。') {
  return {
    schemaVersion: 2, project: { name: '本集分场规划', type: '短剧' }, currentDocId: 'episode-1', activeTab: 'script',
    documents: { 'episode-1': { title: '第一集', content }, 'scene-existing': { title: '已有分场', content: '原有手写正文' }, draft: { title: '未归集正文', content: '独立正文' } },
    structure: { acts: [{ id: 'act-1', title: '第一幕', episodeIds: ['episode-1'] }], episodes: { 'episode-1': { sceneIds: ['scene-existing'] } } },
    tabContents: {}, versions: {}, versionCounters: {}, storyboard: { revision: 0, shots: [] }, candidateDrafts: []
  }
}

function plan(scenes) { return JSON.stringify({ scenes }) }

function scenePlanDraft(data, { sourceDocumentIds = ['scene-existing'] } = {}) {
  const prepared = prepareScenePlanDraft(data, 'episode-1')
  return {
    id: 'candidate-scene-plan', documentId: 'episode-1', tabName: 'script', prompt: '规划本集分场，保留原文',
    text: plan([{ title: '第一场', startLine: 1, endLine: scriptLines(data.documents['episode-1'].content).length }]),
    createdAt: '2026-11-04T03:00:00.000Z', status: 'complete',
    context: {
      projectId: 'project-original', purpose: 'scene-plan', sourceDocumentIds,
      sourceFingerprint: contentFingerprint(data.documents['episode-1'].content), storyboardRevision: null, operationContext: null,
      documentId: 'episode-1', tabName: 'script', title: '第一集', baseContent: data.documents['episode-1'].content,
      selectionStart: 0, selectionEnd: 0, knowledgeChunks: [], messages: prepared.messages
    }
  }
}

test('原文按真实 LF、CRLF、CR 及混合换行编号，不丢弃空行、尾部换行或 Unicode 字符', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    const content = `前言${ending}${ending}## S01 | 咖啡馆${ending}甲：☕ 😀${ending}## S02 | 街道${ending}乙：等等。${ending}`
    const lines = scriptLines(content)
    assert.equal(lines.length, 6)
    assert.equal(lines[1], ending)
    assert.deepEqual(Buffer.from(lines.join('')), Buffer.from(content))
    const scenes = parseScenePlanCandidate(plan([{ title: '咖啡馆', startLine: 1, endLine: 4 }, { title: '街道', startLine: 5, endLine: 6 }]), content)
    assert.equal(scenes[0].content, lines.slice(0, 4).join(''))
    assert.deepEqual(Buffer.from(scenes.map(scene => scene.content).join('')), Buffer.from(content))
  }
  const mixed = '前言\r\n\r\n场一\n甲：走吧。\r场二\r\n乙：等等。'
  assert.deepEqual(scriptLines(mixed), ['前言\r\n', '\r\n', '场一\n', '甲：走吧。\r', '场二\r\n', '乙：等等。'])
  assert.equal(scriptLines(mixed).join(''), mixed)
  assert.deepEqual(scriptLines(''), [])
})

test('分场请求发送完整带行号的原文，预算和摘要真实反映全文，保持输入不变', () => {
  const data = workspace(), before = structuredClone(data)
  const prepared = prepareScenePlanDraft(data, 'episode-1', '按原文转换地点与时间划分')
  const original = data.documents['episode-1'].content
  const numbered = scriptLines(original).map((line, index) => `${index + 1}: ${line}`).join('')
  assert.ok(prepared.messages[1].content.endsWith(numbered))
  assert.match(prepared.messages[0].content, /不改写、不补写、不生成分镜/)
  assert.match(prepared.messages[1].content, /共 5 行/)
  assert.equal(prepared.characters, prepared.messages.reduce((total, message) => total + message.content.length, 0))
  assert.equal(prepared.summary[0].content, original)
  assert.equal(prepared.summary[0].characters, original.length)
  assert.equal(prepared.summary[0].originalCharacters, original.length)
  assert.equal(prepared.summary[0].required, true)
  assert.equal(prepared.summary[0].truncated, false)
  assert.equal(prepared.truncated, false)
  assert.deepEqual(data, before)
})

test('候选只能选择完整连续的原文行段，Markdown JSON 包装不改变正文', () => {
  const content = '必须保留的前言\n\n甲：走吧。\r\n乙：等等。\r最后一句'
  const text = plan([{ title: ' 第一场 · 门口 ', startLine: 1, endLine: 3 }, { title: '第二场 · 屋内', startLine: 4, endLine: 5 }])
  const scenes = parseScenePlanCandidate(`\`\`\`json\n${text}\n\`\`\``, content)
  assert.deepEqual(scenes, [{ title: '第一场 · 门口', content: '必须保留的前言\n\n甲：走吧。\r\n' }, { title: '第二场 · 屋内', content: '乙：等等。\r最后一句' }])
  assert.deepEqual(Buffer.from(scenes.map(scene => scene.content).join('')), Buffer.from(content))
})

test('拒绝遗漏前言或末尾、范围缺口、重叠、倒序、越界和非整数行号', () => {
  const content = '前言\n场一\n场二\n尾声\n'
  const invalid = [
    [{ title: '场', startLine: 2, endLine: 4 }],
    [{ title: '场', startLine: 1, endLine: 3 }],
    [{ title: '场一', startLine: 1, endLine: 1 }, { title: '场二', startLine: 3, endLine: 4 }],
    [{ title: '场一', startLine: 1, endLine: 2 }, { title: '场二', startLine: 2, endLine: 4 }],
    [{ title: '场', startLine: 1, endLine: 0 }],
    [{ title: '场', startLine: 1, endLine: 5 }],
    [{ title: '场', startLine: 0, endLine: 4 }],
    [{ title: '场', startLine: 1.5, endLine: 4 }],
    [{ title: '场', startLine: 1, endLine: 3.5 }],
    [{ title: '场', startLine: '1', endLine: 4 }]
  ]
  for (const scenes of invalid) assert.throws(() => parseScenePlanCandidate(plan(scenes), content), /原文|范围|连续|遗漏/)
})

test('拒绝模型改写正文、伪造字段、原型字段、不完整 JSON 和超量场次', () => {
  const content = '甲\n乙\n'
  const scene = { title: '第一场', startLine: 1, endLine: 2 }
  for (const candidate of [
    JSON.stringify({ scenes: [scene], content: '已改写的全剧' }),
    JSON.stringify({ scenes: [{ ...scene, content: '已改写场次' }] }),
    JSON.stringify({ scenes: [{ ...scene, id: 'scene-injected' }] }),
    JSON.stringify({ scenes: [{ ...scene, selectedImageVersionId: 'injected-image' }] }),
    '{"__proto__":{"polluted":true},"scenes":[{"title":"场","startLine":1,"endLine":2}]}',
    '{"scenes":[{"title":"场","startLine":1,"endLine":2,"constructor":{}}]}',
    '{"scenes":[',
    JSON.stringify({ scenes: [] }),
    JSON.stringify({ scenes: Array.from({ length: 101 }, () => scene) }),
    JSON.stringify({ scenes: [null] }),
    JSON.stringify({ scenes: [{ ...scene, title: ' ' }] }),
    JSON.stringify({ scenes: [{ ...scene, title: '场'.repeat(201) }] })
  ]) assert.throws(() => parseScenePlanCandidate(candidate, content))
  assert.throws(() => parseScenePlanCandidate('文'.repeat(100001), content), /格式/)
  assert.equal({}.polluted, undefined)
})

test('只有空行的场次必须合并，不能生成空白剧本分场', () => {
  assert.throws(() => parseScenePlanCandidate(plan([{ title: '场一', startLine: 1, endLine: 1 }, { title: '空场', startLine: 2, endLine: 2 }, { title: '场三', startLine: 3, endLine: 3 }]), '甲\n\r\n乙\r'), /只有空行/)
  assert.throws(() => parseScenePlanCandidate(plan([{ title: '空场', startLine: 1, endLine: 1 }]), ' \r\n'), /只有空行/)
  assert.throws(() => parseScenePlanCandidate(plan([{ title: '空场', startLine: 1, endLine: 1 }]), ''))
})

test('全文连同行号超出发送预算时拒绝，不截断原文或构造部分请求', () => {
  for (const content of ['文'.repeat(GENERATION_CHARACTER_LIMIT - 1), '甲\n'.repeat(4000)]) {
    const data = workspace(content), before = structuredClone(data)
    assert.throws(() => prepareScenePlanDraft(data, 'episode-1'), /超过.*预算.*未截断原文、未提交生成/)
    assert.deepEqual(data, before)
    assert.equal(data.documents['episode-1'].content, content)
  }
})

test('只允许真实分集规划分场，未知文档、分场、普通正文和空集均拒绝', () => {
  const data = workspace()
  for (const id of ['missing', 'scene-existing', 'draft']) assert.throws(() => prepareScenePlanDraft(data, id), /先选择一集/)
  for (const content of ['', ' \n\r\n']) assert.throws(() => prepareScenePlanDraft(workspace(content), 'episode-1'), /正文为空/)
})

test('scene-plan 候选通过真实候选存储和项目备份来回序列化，完整保留原文与场次快照', () => {
  for (const sourceDocumentIds of [[], ['scene-existing']]) {
    const data = workspace(), original = structuredClone(data), candidate = scenePlanDraft(data, { sourceDocumentIds })
    data.candidateDrafts = upsertCandidateDraft(data.candidateDrafts, candidate)
    assert.deepEqual(original.candidateDrafts, [])
    validateWorkspace(data)
    const restored = parseBackup(projectBackup(data, null)).workspace
    const [saved] = candidateDraftsFor(restored.candidateDrafts, 'episode-1', 'script')
    assert.deepEqual(saved, candidate)
    assert.equal(saved.context.purpose, 'scene-plan')
    assert.deepEqual(saved.context.sourceDocumentIds, sourceDocumentIds)
    assert.deepEqual(Buffer.from(saved.context.baseContent), Buffer.from(data.documents['episode-1'].content))
    assert.deepEqual(restored.documents, data.documents)
    const scenes = parseScenePlanCandidate(saved.text, saved.context.baseContent)
    assert.equal(scenes.map(scene => scene.content).join(''), candidate.context.baseContent)
  }
})

test('scene-plan 候选缺少场次或原文快照时拒绝，不能丢弃并发校验信息', () => {
  const candidate = scenePlanDraft(workspace())
  for (const key of ['sourceDocumentIds', 'baseContent']) {
    const invalid = structuredClone(candidate)
    delete invalid.context[key]
    assert.throws(() => validateCandidateDrafts([invalid]), /分场候选缺少/)
  }
})
