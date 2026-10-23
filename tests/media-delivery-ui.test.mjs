import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createShot, findMediaVersion, videoReviewState, snapshotStoryboardSource, SHOT_LIMIT } from '../src/storyboard.js'
import { shotReadiness } from '../src/shot-workflow.js'
import { replaceSourceShots } from '../src/storyboard-scope.js'

const source = readFileSync(new URL('../src/media-workbench.js', import.meta.url), 'utf8')
function productionFunction(name) {
  const start = new RegExp(`^( *)((?:async )?function ${name}\\()`, 'm').exec(source)
  const body = source.slice(start.index), end = new RegExp(`^${start[1]}\\}`, 'm').exec(body)
  return body.slice(0, end.index + end[0].length)
}
function harness() {
  class Node {
    constructor(tag = 'div', className = '', textContent = '') { Object.assign(this, { tag, className, textContent, dataset: {}, children: [], listeners: new Map(), paused: true, playCount: 0 }) }
    append(...children) { this.children.push(...children) }
    setAttribute() {}
    removeAttribute(key) { delete this[key] }
    addEventListener(type, callback) { this.listeners.set(type, callback) }
    showModal() { this.open = true }
    close() { this.open = false; this.listeners.get('close')?.() }
    remove() { this.removed = true }
    pause() { this.paused = true }
    async play() { this.paused = false; this.playCount++ }
  }
  const el = (...args) => new Node(...args), body = el('body')
  const shots = ['甲镜', '缺片', '乙镜'].map(title => createShot({ title, visual: '画面', dialogue: '对白' }, { documentId: 'scene' }))
  shots[0].selectedVideoVersionId = 'v1'; shots[2].selectedVideoVersionId = 'v2'
  const data = { projectId: 'p1', project: { name: '项目' }, documents: {}, storyboard: { revision: 1, shots } }
  const assets = ['v1', 'v2'].map(id => ({ id, kind: 'video', versions: [{ id, fileId: `file-${id}`, mimeType: 'video/mp4' }] }))
  const calls = { invoke: [], messages: [], confirmations: [], saved: false }
  const env = { el, document: { body }, Option: class extends Node { constructor(text, value) { super('option', '', text); this.value = value } },
    context: () => data, assets, findMediaVersion, videoReviewState, shotReadiness, error: '', visibleShots: value => (value || data).storyboard.shots,
    run: async callback => callback(), requireProject() {}, desktop() {}, refresh: async () => {}, fileUrl: version => `local:${version.fileId}`,
    beforeSubmit: async () => { calls.saved = true }, invoke: async (command, args) => { assert.equal(calls.saved, true); calls.invoke.push({ command, args }); return '/tmp/package' },
    window: { confirm: message => { calls.confirmations.push(message); return true } }, notify: message => calls.messages.push(message) }
  vm.createContext(env)
  vm.runInContext(['button', 'selectedVideoEntries', 'exportSelectedVideos', 'playSelectedVideos'].map(productionFunction).join('\n'), env)
  return { env, data, calls, body }
}

test('选用视频包先保存，按当前范围顺序传真实版本，缺片先提示且未归属标题为空', async () => {
  const h = harness(); await h.env.exportSelectedVideos()
  assert.match(h.calls.confirmations[0], /1 镜缺少/)
  assert.equal(h.calls.invoke[0].command, 'media_export_selected_videos')
  assert.deepEqual(Array.from(h.calls.invoke[0].args.shots, shot => shot.videoVersionId), ['v1', 'v2'])
  assert.ok(h.calls.invoke[0].args.shots.every(shot => shot.sourceTitle === ''))
})

test('视频包准备中项目变化或缺片确认取消时不导出', async () => {
  const h = harness(); h.env.beforeSubmit = async () => { h.data.projectId = 'p2' }
  await assert.rejects(h.env.exportSelectedVideos(), /项目已切换/); assert.equal(h.calls.invoke.length, 0)
  const cancelled = harness(); cancelled.env.window.confirm = () => false
  await cancelled.env.exportSelectedVideos(); assert.equal(cancelled.calls.invoke.length, 0)
})

test('连播仅播放选用视频，按顺序推进，结束不循环且关闭停止播放', async () => {
  const h = harness(); h.env.playSelectedVideos()
  const dialog = h.body.children[0], player = dialog.children.find(node => node.tag === 'video'), status = dialog.children.find(node => node.className === 'media-notice')
  assert.equal(player.src, 'local:file-v1'); assert.equal(player.playCount, 0, 'opening preview does not autoplay')
  assert.match(status.textContent, /1 镜缺少视频/)
  player.listeners.get('ended')(); await Promise.resolve()
  assert.equal(player.src, 'local:file-v2'); assert.equal(player.playCount, 1)
  player.listeners.get('ended')(); assert.match(status.textContent, /已播放至末镜/)
  dialog.close(); assert.equal(player.paused, true); assert.equal(player.src, undefined); assert.equal(dialog.removed, true)
  assert.equal(h.calls.invoke.length, 0, 'playback never generates or exports')
})

test('恢复历史先保留当前版本，保存失败不修改原镜头与历史，恢复不影响其他分场', async () => {
  const h = harness(), { env, data } = h
  data.documents.scene = { title: '第一场' }
  snapshotStoryboardSource(data.storyboard, 'scene')
  const old = structuredClone(data.storyboard.sourceVersions[0].shots)
  data.storyboard.shots[0].visual = '当前新内容'
  const other = createShot({ visual: '另一场' }, { documentId: 'other' }); data.storyboard.shots.push(other)
  const before = structuredClone(data.storyboard)
  Object.assign(env, { structuredClone, snapshotStoryboardSource, replaceSourceShots, SHOT_LIMIT, selectedSourceId: 'scene', selectedEpisodeId: 'ep1', selectedShotId: null,
    storyboardGroups: () => [], mediaTimeLabel: value => value, showSource() {}, renderSources() {}, renderShots() {}, commit: async () => { throw new Error('保存失败') } })
  vm.runInContext(['disclosure', 'changeStoryboard', 'showStoryboardVersions'].map(productionFunction).join('\n'), env)
  env.showStoryboardVersions()
  const dialog = h.body.children[0], flatten = node => [node, ...node.children.flatMap(flatten)]
  const restore = flatten(dialog).find(node => node.textContent === '恢复此分场版本')
  await assert.rejects(restore.listeners.get('click')(), /保存失败/)
  assert.deepEqual(data.storyboard, before); assert.equal(dialog.open, true)
  env.commit = async patch => { data.storyboard = patch.storyboard }
  await restore.listeners.get('click')()
  assert.deepEqual(Array.from(data.storyboard.shots.filter(shot => shot.sourceDocumentId === 'scene')), old)
  assert.deepEqual(data.storyboard.shots.find(shot => shot.id === other.id), other)
  assert.equal(data.storyboard.sourceVersions[0].shots[0].visual, '当前新内容')
  assert.equal(data.storyboard.sourceVersions[0].label, '恢复前的分镜'); assert.equal(dialog.removed, true)
})
