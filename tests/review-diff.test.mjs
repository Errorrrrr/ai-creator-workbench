import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { diffText, createReviewDiff } from '../src/review-diff.js'
import { initializeProjectPlanUI } from '../src/project-plan-ui.js'
import { captureOperationContext } from '../src/project-operations.js'
import { removeCandidateDraft } from '../src/candidate-drafts.js'

const original = diff => diff.runs.filter(run => run.type !== 'add').flatMap(run => run.lines).join('')
const revised = diff => diff.runs.filter(run => run.type !== 'remove').flatMap(run => run.lines).join('')
const descendants = element => [element, ...element.children.flatMap(descendants)]
const byClass = (element, name) => descendants(element).filter(node => node.className.split(' ').includes(name))
const byTag = (element, name) => descendants(element).filter(node => node.tagName === name)

class Element extends EventTarget {
  constructor(tagName) { super(); this.tagName = tagName; this.children = []; this.attributes = new Map(); this.className = ''; this.disabled = false; this.open = false; this.value = ''; this.ownText = '' }
  set textContent(value) { this.ownText = String(value); this.children = [] }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  set innerHTML(_) { throw new Error('AI text must not be interpreted as HTML') }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.ownText = ''; this.children = children }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  removeAttribute(name) { this.attributes.delete(name) }
  focus() { this.focused = true }
  scrollIntoView() { this.scrolled = true }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')) }
  close() { this.open = false; this.dispatchEvent(new Event('close')) }
}
const documentRef = { createElement: name => new Element(name) }

test('中文增删、多个改动与保留段落的统计和位置可核对', () => {
  const before = '第一行\n旧对白\n保留一\n保留二\n保留三\n旧结尾\n'
  const after = '第一行\n新对白\n补充动作\n保留一\n保留二\n保留三\n新结尾\n'
  const diff = diffText(before, after)
  assert.equal(original(diff), before); assert.equal(revised(diff), after)
  assert.equal(diff.added, 3); assert.equal(diff.removed, 2); assert.equal(diff.hunks.length, 2)
  assert.equal(diff.limited, false)
  assert.deepEqual(diff.hunks.map(hunk => [hunk.beforeStart, hunk.afterStart]), [[1, 1], [4, 5]])
  assert.equal(diff.hunks[1].runs.find(run => run.type === 'remove').lines.join(''), '旧结尾\n')
})

test('空文档、纯删除、完整替换、空白、CRLF 和文末换行不会被归一化或漏掉', () => {
  const cases = [
    ['', ''], ['', '新增😀'], ['删除😀', ''], ['甲\n乙', '丙\n丁'],
    ['\n \t\n', '\n\t \n'], ['你好\r\n世界\r\n', '你好\n世界\n'],
    ['你好', '你好\n'], ['你好\n', '你好'], ['一 \n二\n', '一\n二\n'],
  ]
  for (const [before, after] of cases) {
    const diff = diffText(before, after)
    assert.equal(original(diff), before); assert.equal(revised(diff), after)
    assert.equal(diff.hunks.length === 0, before === after)
  }
  assert.deepEqual(diffText('相同\n', '相同\n').runs, [{ type: 'equal', lines: ['相同\n'] }])
})

test('重复行和多种编辑序列仍能无损还原两侧，且摘要与改动行一致', () => {
  let seed = 421
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const tokens = ['甲\n', '乙\n', ' \n', '\t\n', '😀\n', '<script>\n']
  for (let i = 0; i < 180; i++) {
    const before = Array.from({ length: next() % 25 }, () => tokens[next() % tokens.length]).join('')
    const after = Array.from({ length: next() % 25 }, () => tokens[next() % tokens.length]).join('')
    for (const maxCells of [0, 250000]) {
      const diff = diffText(before, after, { maxCells })
      assert.equal(original(diff), before); assert.equal(revised(diff), after)
      assert.equal(diff.added, diff.runs.filter(run => run.type === 'add').reduce((sum, run) => sum + run.lines.length, 0))
      assert.equal(diff.removed, diff.runs.filter(run => run.type === 'remove').reduce((sum, run) => sum + run.lines.length, 0))
      assert.equal(diff.hunks.length === 0, before === after)
    }
  }
})

test('大文稿使用锚点保留中间上下文，无共同内容时降级为显式整段替换', { timeout: 5000 }, () => {
  const lines = Array.from({ length: 14000 }, (_, index) => `原段落 ${index}\n`)
  const changed = [...lines]; changed[1] = '第一次修改\n'; changed[13998] = '第二次修改\n'
  const before = lines.join(''), after = changed.join('')
  const diff = diffText(before, after)
  assert.equal(diff.added, 2); assert.equal(diff.removed, 2); assert.equal(diff.hunks.length, 2)
  assert.equal(diff.limited, false); assert.equal(original(diff), before); assert.equal(revised(diff), after)
  const replacement = diffText('原文\n'.repeat(18000), '新稿\n'.repeat(18000))
  assert.equal(replacement.limited, true); assert.equal(replacement.hunks.length, 1)
  assert.equal(replacement.added, 18000); assert.equal(replacement.removed, 18000)
  assert.equal(original(replacement), '原文\n'.repeat(18000)); assert.equal(revised(replacement), '新稿\n'.repeat(18000))
})

test('差异组件以纯文本展示模型内容，保留全文且提供可聚焦的逐处导航', () => {
  const before = '开头\n旧行\n中间一\n中间二\n中间三\n旧尾'
  const after = '开头\n<img src=x onerror=alert(1)>\n中间一\n中间二\n中间三\n<script>新尾</script>'
  const root = createReviewDiff({ before, after, documentRef, title: '待审稿', beforeLabel: '原稿', afterLabel: '候选稿' })
  assert.equal(root.attributes.get('aria-label'), '待审稿')
  const [previous, next] = byTag(root, 'button')
  assert.equal(previous.disabled, true); assert.equal(next.disabled, false)
  assert.match(root.textContent, /2 处变更 · 新增 2 行 · 删除 2 行/)
  assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/)
  assert.equal(byTag(root, 'img').length, 0); assert.equal(byTag(root, 'script').length, 0)
  const region = byClass(root, 'review-diff-hunk')[0]
  const position = byClass(root, 'review-diff-position')[0]
  assert.equal(region.tabIndex, -1); assert.equal(position.attributes.get('aria-live'), 'polite')
  next.click()
  assert.equal(position.textContent, '第 2 / 2 处'); assert.equal(region.focused, true); assert.equal(region.scrolled, true)
  assert.equal(previous.disabled, false); assert.equal(next.disabled, true)
  assert.match(region.textContent, /<script>新尾<\/script>/)
  previous.click(); assert.equal(position.textContent, '第 1 / 2 处')
  const details = byTag(root, 'details')[0]
  assert.equal(byTag(root, 'pre').length, 0, '全文在展开时才挂载')
  details.open = true; details.dispatchEvent(new Event('toggle'))
  assert.deepEqual(byTag(root, 'pre').map(node => node.textContent), [before, after])
  details.dispatchEvent(new Event('toggle')); assert.equal(byTag(root, 'pre').length, 2)
  assert.equal(byTag(root, 'button').length, 2, '只提供导航，组件没有部分采纳入口')
})

test('超长差异的 DOM 和字符预览有上限，全文仍可完整查看且明确显示缩略说明', () => {
  const before = '原文'.repeat(20000) + '\n' + '重复原文\n'.repeat(1600)
  const after = '新文'.repeat(20000) + '\n' + '重复新文\n'.repeat(1600)
  const root = createReviewDiff({ before, after, documentRef })
  assert.ok(byClass(root, 'review-diff-line').length <= 160)
  assert.ok(byClass(root, 'review-diff-text').reduce((length, node) => length + node.textContent.length, 0) < 18000)
  assert.match(root.textContent, /部分区域按整段替换显示/)
  assert.match(root.textContent, /还有 \d+ 行未在预览中展示/)
  assert.match(root.textContent, /长行已缩略/)
  const details = byTag(root, 'details')[0]; details.open = true; details.dispatchEvent(new Event('toggle'))
  assert.deepEqual(byTag(root, 'pre').map(node => node.textContent), [before, after])
})

test('无变化与空白行、文末换行在组件中有明确文字说明', () => {
  const same = createReviewDiff({ before: '', after: '', documentRef })
  assert.match(same.textContent, /文字一致，没有改动/); assert.equal(byTag(same, 'button').length, 0)
  const whitespace = createReviewDiff({ before: ' \t\r\n', after: '', documentRef })
  assert.match(whitespace.textContent, /空白行（2 个空白字符）/); assert.match(whitespace.textContent, /↵ CRLF/)
  const ending = createReviewDiff({ before: '结尾', after: '结尾\n', documentRef })
  assert.deepEqual(byClass(ending, 'review-diff-ending').map(node => node.textContent), ['∎', '↵'])
})

function planHarness() {
  const ids = ['projectPlanDialog', 'projectPlanInput', 'projectPlanTargets', 'projectPlanPreview', 'projectPlanStatus', 'projectPlanApply', 'projectPlanPreviewButton']
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]))
  const context = { projectId: 'p1', workspace: { currentDocId: 'draft', documents: { draft: { title: '正文', content: '旧正文\n保留\n' } }, tabContents: { draft: { outline: '旧大纲', references: '' } }, storyboard: { shots: [{ id: 'shot-1', title: '第一镜' }], revision: 1 } }, media: null }
  const base = captureOperationContext(context, [{ key: 'current', characters: 1 }, { key: 'object:shot:shot-1', characters: 1 }])
  const commits = [], queries = []
  const fakeDocument = { ...documentRef, querySelector: selector => elements[selector.slice(1)] }
  const previousDocument = globalThis.document; globalThis.document = fakeDocument
  const ui = initializeProjectPlanUI({
    getContext: () => context, captureContext: () => structuredClone(base),
    commit: async (plan, captured, source) => { commits.push({ plan, captured, source }); return {} },
    queryTasks: async query => { queries.push(query); return { jobs: [{ id: 'job-1', status: 'running' }], hasMore: false } },
    notify() {}, openDialog: dialog => { dialog.open = true },
  })
  return { ui, elements, context, commits, queries, dispose: () => { globalThis.document = previousDocument } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const textOperation = (tabName, content) => ({ tool: 'write_document', documentId: 'draft', tabName, mode: 'replace', content })

test('项目计划差异只读，保持整份计划一次采纳且再次检查原文冲突', async () => {
  const h = planHarness()
  try {
    const operations = [textOperation('script', '新正文\n保留\n'), textOperation('outline', '新大纲')]
    h.ui.open(JSON.stringify({ version: 1, summary: '修改两处', operations }))
    h.elements.projectPlanPreviewButton.click(); await tick()
    assert.equal(byClass(h.elements.projectPlanPreview, 'review-diff').length, 2)
    assert.equal(h.commits.length, 0); assert.equal(h.elements.projectPlanApply.disabled, false)
    h.elements.projectPlanApply.click(); await tick()
    assert.equal(h.commits.length, 1); assert.equal(h.commits[0].plan.operations.length, 2)
    h.ui.open(JSON.stringify({ version: 1, summary: '冲突保护', operations }))
    h.elements.projectPlanPreviewButton.click(); await tick()
    h.context.workspace.documents.draft.content = '用户新增的正文'
    h.elements.projectPlanApply.click(); await tick()
    assert.equal(h.commits.length, 1)
    assert.match(h.elements.projectPlanStatus.textContent, /已有新修改/)
  } finally { h.dispose() }
})

test('本地任务快照保留只读专门展示，不渲染文字差异或允许采纳', async () => {
  const h = planHarness()
  try {
    h.ui.open(JSON.stringify({ version: 1, summary: '查看本地任务', operations: [{ tool: 'query_media_tasks', shotIds: ['shot-1'] }] }))
    h.elements.projectPlanPreviewButton.click(); await tick()
    assert.equal(h.queries.length, 1); assert.equal(h.commits.length, 0)
    assert.equal(byClass(h.elements.projectPlanPreview, 'review-diff').length, 0)
    assert.equal(h.elements.projectPlanApply.disabled, true)
    const details = byTag(h.elements.projectPlanPreview, 'details')
    assert.equal(details.length, 2); assert.equal(details[1].open, true)
    assert.match(details[1].textContent, /本地任务快照/); assert.match(details[1].textContent, /job-1/)
  } finally { h.dispose() }
})

test('AI 计划来源随审阅传递，关闭后手工计划不会继承上一候选的来源', async () => {
  const h = planHarness()
  const plan = JSON.stringify({ version: 1, summary: '修改正文', operations: [textOperation('script', '新正文')] })
  try {
    h.ui.open(plan, null, { candidateId: 'candidate-a' })
    h.elements.projectPlanPreviewButton.click(); await tick()
    h.elements.projectPlanApply.click(); await tick()
    assert.deepEqual(h.commits[0].source, { candidateId: 'candidate-a' })
    h.ui.open(plan)
    h.elements.projectPlanPreviewButton.click(); await tick()
    h.elements.projectPlanApply.click(); await tick()
    assert.deepEqual(h.commits[1].source, { candidateId: null })
  } finally { h.dispose() }
})

const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
function appPlanCommitHarness({ failSave = false } = {}) {
  const start = appSource.indexOf('  commit: async (plan, base,', appSource.indexOf('projectPlanUI = initializeProjectPlanUI('))
  const end = appSource.indexOf('  renderMedia:', start)
  assert.ok(start >= 0 && end > start, 'execute the actual app plan commit boundary')
  const draft = id => ({
    id, documentId: 'draft', tabName: 'script', prompt: '修改正文', text: '计划内容', status: 'complete', createdAt: '2026-10-15T09:00:00.000Z',
    context: { projectId: 'p1', purpose: 'project-plan', documentId: 'draft', tabName: 'script', title: '正文', baseContent: '原正文', knowledgeChunks: [{ id, name: id, path: `${id}.md`, content: `${id}引用` }] }
  })
  const state = { candidateApplying: false, isGenerating: false, activeCandidateId: 'candidate-b', candidateDrafts: [draft('candidate-a'), draft('candidate-b')], editHistories: new Map(), selectedVersionByDocument: {}, tabContents: { draft: {} }, versionCounters: { draft: 1 }, knowledge: { index: null } }
  state.generationContext = state.candidateDrafts[1].context
  const calls = { persisted: [], discarded: 0, materialized: [] }
  const context = vm.createContext({
    state, projectTransition: false, activeProjectId: 'p1', editRevision: 0, unsavedEdits: false, isDesktopRuntime: false,
    setProjectTransition() {}, saveImmediately: async () => true,
    materializeOperationPlan(_plan, _base, _context, options) {
      calls.materialized.push(options)
      return { hasWorkspaceChanges: true, changes: [{ documentId: 'draft' }], workspace: { documents: {}, tabContents: { draft: {} }, versions: {}, versionCounters: { draft: 1 }, storyboard: {}, candidateDrafts: structuredClone(state.candidateDrafts) } }
    },
    projectOperationContext: () => ({}), removeCandidateDraft, validateWorkspace() {},
    saveProject: async (_id, workspace) => { if (failSave) throw new Error('磁盘写入失败'); calls.persisted.push(structuredClone(workspace)) },
    formatVersionHistory: () => '', setSaveStatus() {}, renderCandidateDrafts() {}, renderProjectTree() {}, updateDocumentView() {}, mediaWorkbench: { refresh() {} },
    discardCandidate() { calls.discarded++; state.candidateDrafts = removeCandidateDraft(state.candidateDrafts, state.activeCandidateId); state.activeCandidateId = null }, scheduleSave() {},
  })
  const commit = vm.runInContext(`({${appSource.slice(start, end)}}).commit`, context)
  return { commit: source => commit({ operations: [] }, { projectId: 'p1' }, source), state, calls }
}

test('采纳手工项目计划保留当前 AI 待审稿，也不误用其引用来源', async () => {
  const h = appPlanCommitHarness()
  await h.commit({ candidateId: null })
  assert.deepEqual(h.state.candidateDrafts.map(draft => draft.id), ['candidate-a', 'candidate-b'])
  assert.deepEqual(h.calls.persisted[0].candidateDrafts.map(draft => draft.id), ['candidate-a', 'candidate-b'])
  assert.equal(h.state.activeCandidateId, 'candidate-b'); assert.equal(h.calls.discarded, 0)
  assert.equal(h.calls.materialized[0].knowledgeChunks.length, 0)
})

test('采纳 AI 项目计划只删除明确来源稿，当前展示的另一稿和引用归属保持正确', async () => {
  const h = appPlanCommitHarness()
  await h.commit({ candidateId: 'candidate-a' })
  assert.deepEqual(h.state.candidateDrafts.map(draft => draft.id), ['candidate-b'])
  assert.deepEqual(h.calls.persisted[0].candidateDrafts.map(draft => draft.id), ['candidate-b'])
  assert.equal(h.state.activeCandidateId, 'candidate-b'); assert.equal(h.calls.discarded, 0)
  assert.equal(h.calls.materialized[0].knowledgeChunks[0].id, 'candidate-a')
})

test('来源稿失效或保存失败都保留待审稿，成功采纳当前来源后才清空展示', async () => {
  const stale = appPlanCommitHarness()
  await assert.rejects(stale.commit({ candidateId: 'missing-candidate' }), /来源候选已失效/)
  assert.equal(stale.calls.persisted.length, 0); assert.equal(stale.state.candidateDrafts.length, 2)
  const failure = appPlanCommitHarness({ failSave: true })
  await assert.rejects(failure.commit({ candidateId: 'candidate-b' }), /磁盘写入失败/)
  assert.equal(failure.state.activeCandidateId, 'candidate-b'); assert.equal(failure.state.candidateDrafts.length, 2)
  assert.equal(failure.calls.discarded, 0)
  const success = appPlanCommitHarness()
  await success.commit({ candidateId: 'candidate-b' })
  assert.deepEqual(success.state.candidateDrafts.map(draft => draft.id), ['candidate-a'])
  assert.equal(success.state.activeCandidateId, null); assert.equal(success.calls.discarded, 1)
})
