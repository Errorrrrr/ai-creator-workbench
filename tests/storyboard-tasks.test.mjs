import test from 'node:test'
import assert from 'node:assert/strict'
import { createStoryboardTasks } from '../src/storyboard-tasks.js'
import { createShot, storyboardSourceFingerprint } from '../src/storyboard.js'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('准备阶段即占用任务，同项目和跨项目重复请求都被拒绝', () => {
  const tasks = createStoryboardTasks()
  const task = tasks.reserve({ id: 'a', projectId: 'p', documentId: 's1' })
  assert.equal(tasks.active(), task)
  for (const projectId of ['p', 'other']) assert.throws(() => tasks.reserve({ id: 'b', projectId, documentId: 's2' }), /等待任务结束/)
  tasks.bind('a')
  assert.throws(() => tasks.bind('a'), /重复提交/)
  tasks.update('a', { phase: 'saving' })
  assert.throws(() => tasks.reserve({ id: 'b' }), /等待任务结束/)
  tasks.update('a', { phase: 'completed' })
  assert.ok(tasks.active(), 'successful save still awaits provider cleanup')
  tasks.release('a')
  assert.equal(tasks.active(), null)
  assert.equal(tasks.list('p')[0].phase, 'completed')
  assert.ok(task.finishedAt)
})

test('停止只标记取消，迟到的结果不能复活任务，退出后才解锁', () => {
  const tasks = createStoryboardTasks()
  const task = tasks.reserve({ id: 'a', projectId: 'p', documentId: 's1' })
  tasks.bind('a'); tasks.update('a', { phase: 'receiving', characters: 20 })
  tasks.update('a', { phase: 'cancelling' })
  tasks.update('a', { phase: 'completed', characters: 200 })
  assert.equal(task.phase, 'cancelling')
  assert.equal(task.characters, 20)
  assert.throws(() => tasks.reserve({ id: 'b' }))
  tasks.release('a')
  assert.equal(task.phase, 'cancelled')
  tasks.update('a', { phase: 'running' })
  assert.equal(task.phase, 'cancelled')
  tasks.reserve({ id: 'b', projectId: 'p', documentId: 's2' })
  tasks.release('a')
  assert.equal(tasks.active().id, 'b')
})

test('失败与待处理结果保留原因且释放执行锁', () => {
  const tasks = createStoryboardTasks()
  for (const phase of ['failed', 'review']) {
    tasks.reserve({ id: phase, projectId: 'p', documentId: 's1' })
    tasks.update(phase, { phase, message: '可检查的原因' }); tasks.release(phase)
    assert.equal(tasks.get(phase).phase, phase)
    assert.equal(tasks.get(phase).message, '可检查的原因')
    assert.equal(tasks.active(), null)
  }
  assert.equal(tasks.list('p').length, 2)
  assert.deepEqual(tasks.list('other'), [])
})

test('分场快照忽略其他场和全局版本，检测本场字段、参考和排序变化', () => {
  const first = createShot({ visual: '原画面' }, { documentId: 's1' })
  const next = createShot({}, { documentId: 's1' })
  const board = { revision: 1, shots: [first, createShot({}, { documentId: 's2' }), next] }
  const before = storyboardSourceFingerprint(board, 's1')
  board.revision++; board.shots[1].visual = '其他场'
  assert.equal(storyboardSourceFingerprint(board, 's1'), before)
  for (const change of [b => { b.shots[0].visual = '本场变更' }, b => { b.shots[0].references.push({ versionId: 'r', role: 'reference' }) }, b => b.shots.reverse()]) {
    const changed = structuredClone(board); change(changed)
    assert.notEqual(storyboardSourceFingerprint(changed, 's1'), before)
  }
})

test('进度计时只更新标签，保持操作按钮和键盘焦点所在节点', () => {
  const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
  const logic = source.slice(source.indexOf('  function storyboardTaskLabel('), source.indexOf('  function renderStoryboardTaskProgress('))
  const status = { dataset: { storyboardTaskId: 'a' }, textContent: '' }
  const focusedButton = { label: '停止拆镜' }
  const task = { id: 'a', startedAt: Date.now() - 2000, characters: 12, phase: 'running' }
  const env = { STORYBOARD_TASK_PHASES: { running: '等待 AI 返回' }, storyboardTasks: { get: () => task }, document: { activeElement: focusedButton, querySelectorAll: () => [status] } }
  vm.createContext(env); vm.runInContext(logic, env)
  env.updateStoryboardTaskLabels()
  assert.match(status.textContent, /已收到 12 字符/)
  task.characters = 25; env.updateStoryboardTaskLabels()
  assert.match(status.textContent, /已收到 25 字符/)
  assert.equal(env.document.activeElement, focusedButton)
})
