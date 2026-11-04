import { findMediaVersion } from './storyboard.js'
import { storyboardSceneEntries, OTHER_EPISODE } from './storyboard-scope.js'
import { matchShotReferences } from './storyboard-references.js'
import { imageVisualReviewState, visualInputFingerprint, visualBaselineText } from './visual-review.js'

const roles = { character: '人物', scene: '场景', prop: '关键物品', style: '风格', shot: '分镜图' }
const uses = { reference: '设定参考', start: '显式首帧', end: '显式尾帧' }
const states = { bound: '当前状态已关联', manual: '保留手选图片', excluded: '已手动排除', missing: '缺少状态图', stale: '设定图已过期', ready: '尚未关联', ambiguous: '参考有歧义', limit: '参考数量已达上限' }
const filters = [['pending', '待复核'], ['rejected', '不一致'], ['approved', '已通过'], ['all', '全部']]
function el(tag, className = '', text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
function button(text, action, className = 'secondary-button') {
  const node = el('button', className, text); node.type = 'button'
  node.addEventListener('click', action)
  return node
}
const noteKey = (projectId, shot) => JSON.stringify([projectId, shot.id, shot.selectedImageVersionId])
const matchesFilter = (state, filter) => filter === 'all' || (filter === 'pending' ? !['approved', 'rejected'].includes(state.status) : state.status === filter)

// Neighbours come from the episode tree, including a neighbouring scene outside
// the export scope. Never compare an episode's last shot with another episode.
export function visualReviewNeighbours(data) {
  const episodes = new Map(), result = new Map()
  for (const entry of storyboardSceneEntries(data)) {
    const group = entry.episodeId === OTHER_EPISODE ? `unassigned:${entry.sourceId}` : entry.episodeId
    const list = episodes.get(group) || []
    list.push(...entry.shots); episodes.set(group, list)
  }
  for (const list of episodes.values()) list.forEach((shot, index) => result.set(shot.id, { previous: list[index - 1] || null, next: list[index + 1] || null }))
  return result
}

export function createVisualReviewUI({ getContext, getAssets = () => [], getShots, preview, onReview, onOpenBaseline, onSelectShot, notify = () => {} }) {
  let owner = '', filter = 'pending', signature = '', busy = false, focusShotId = '', explicitShotIds = null
  const notes = new Map()
  const dialog = el('dialog', 'app-dialog visual-review-dialog'); dialog.setAttribute('aria-label', '分镜图视觉复核')
  const header = el('header', 'visual-review-header'), heading = el('div')
  heading.append(el('h2', '', '分镜图视觉复核'), el('p', 'media-help', '对照设定图和相邻镜头，人工核对人物、服装、场景布局、物品结构、光线与色调。系统检查输入变更，不会自动认定画面内容一致。'))
  header.append(heading, button('关闭', close))
  const toolbar = el('div', 'visual-review-toolbar'), picker = el('select')
  picker.setAttribute('aria-label', '筛选视觉复核状态')
  for (const [value, label] of filters) { const option = el('option', '', label); option.value = value; picker.append(option) }
  picker.value = filter
  picker.addEventListener('change', () => { filter = picker.value; focusShotId = ''; render(true) })
  const summary = el('p', 'media-help')
  const baseline = el('details', 'visual-review-baseline'); baseline.open = true
  const baselineText = el('p')
  baseline.append(el('summary', '', '全项目视觉基准'), baselineText)
  if (onOpenBaseline) toolbar.append(button('设置统一视觉基准', () => { if (owner !== getContext()?.projectId || busy) return; close(); onOpenBaseline() }))
  toolbar.prepend?.(picker)
  if (!toolbar.contains(picker)) toolbar.append(picker)
  const notice = el('p', 'visual-review-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  const list = el('div', 'visual-review-list')
  dialog.append(header, toolbar, summary, baseline, notice, list)
  document.body.append(dialog)
  const zoom = el('dialog', 'app-dialog visual-review-zoom'); zoom.setAttribute('aria-label', '放大查看参考图片')
  const zoomTitle = el('h2'), zoomBody = el('div', 'visual-review-zoom-body')
  zoom.append(zoomTitle, button('关闭图片', () => zoom.close()), zoomBody); document.body.append(zoom)
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })

  const context = () => getContext() || {}
  const assetsFor = data => (getAssets() || []).filter(asset => asset.projectId === undefined || asset.projectId === data.projectId)
  const scopeShots = data => {
    const ids = new Set(explicitShotIds || (getShots ? getShots(data) : data.storyboard?.shots || []).map(shot => shot.id))
    if (focusShotId) ids.add(focusShotId)
    return storyboardSceneEntries(data).flatMap(entry => entry.shots).filter(shot => ids.has(shot.id))
  }
  function signal(message, failed = false) {
    notice.textContent = message; notice.className = failed ? 'visual-review-notice media-warning' : 'visual-review-notice'
    if (failed) notify(message)
  }
  function close() { dialog.close(); zoom.close() }
  function open(options = {}) {
    if (busy) return false
    const data = context()
    if (!data.projectId) { notify('请先打开项目'); return false }
    owner = data.projectId
    filter = filters.some(([id]) => id === options.filter) ? options.filter : 'pending'
    explicitShotIds = Array.isArray(options.shotIds) ? [...new Set(options.shotIds.filter(id => typeof id === 'string'))] : null
    focusShotId = options.shotId || ''; picker.value = filter
    signal(''); signature = ''
    render(true)
    if (!dialog.open) dialog.showModal()
    if (focusShotId) list.querySelector(`[data-visual-shot="${focusShotId}"]`)?.scrollIntoView?.({ block: 'nearest' })
    return true
  }
  function image(versionId, name, available, className = '') {
    const found = findMediaVersion(available, versionId)
    const wrapper = el('figure', `visual-review-image ${className}`.trim())
    if (!found || found.asset.kind !== 'image') { wrapper.append(el('div', 'visual-review-no-image', '尚无可用图片')); return wrapper }
    const view = () => {
      if (owner !== context().projectId) return close()
      const latest = findMediaVersion(assetsFor(context()), versionId)
      if (!latest || latest.asset.kind !== 'image') return signal('图片已变更或不存在，请刷新后查看。', true)
      zoomTitle.textContent = name
      zoomBody.replaceChildren(preview(latest.version, name)); zoom.showModal()
    }
    const action = button('', view, 'visual-review-image-button'); action.setAttribute('aria-label', `放大查看：${name}`)
    const media = preview(found.version, name)
    media.setAttribute('alt', name); media.setAttribute('loading', 'lazy')
    action.append(media); wrapper.append(action, el('figcaption', '', name))
    return wrapper
  }
  function currentSignature(data, available, shots) {
    return JSON.stringify([data.projectId, filter, focusShotId, data.storyboard?.continuity?.style || '', (data.storyboard?.shots || []).map(shot => [shot.id, shot.selectedImageVersionId, data.documents?.[shot.sourceDocumentId]?.title]), shots.map(shot => [shot.id, shot.title, shot.selectedImageVersionId, visualInputFingerprint(shot, available, data.documents, data.storyboard?.continuity, data), imageVisualReviewState(shot, available, data.documents, data.storyboard?.continuity, data), shot.visualReview])])
  }
  function render(force = false) {
    const data = context()
    if (owner !== data.projectId) { close(); return }
    const available = assetsFor(data), shots = scopeShots(data), nextSignature = currentSignature(data, available, shots)
    if (!force && nextSignature === signature) return
    if (!force && dialog.contains(document.activeElement) && document.activeElement?.tagName?.toLowerCase() === 'textarea') {
      signal('画面或参考有更新，正在输入的核对备注已保留；完成输入后刷新检查。')
      return
    }
    signature = nextSignature
    const top = list.scrollTop, neighbours = visualReviewNeighbours(data)
    const reviewed = shots.map(shot => ({ shot, state: imageVisualReviewState(shot, available, data.documents, data.storyboard?.continuity, data) }))
    summary.textContent = `当前范围 ${shots.length} 镜 · 已通过 ${reviewed.filter(item => item.state.reviewed).length} 镜 · 不一致 ${reviewed.filter(item => item.state.status === 'rejected').length} 镜 · 待复核 ${reviewed.filter(item => !['approved', 'rejected'].includes(item.state.status)).length} 镜`
    baselineText.textContent = visualBaselineText(data.storyboard?.continuity)
    if (!data.storyboard?.continuity?.style?.trim()) baselineText.textContent += '\n尚未填写项目专属视觉基准，建议先约定画风、色彩、材质与成片质感；昼夜、天气和服装变化在各对象状态中分别管理。'
    list.replaceChildren()
    const visible = reviewed.filter(({ shot, state }) => matchesFilter(state, filter) || shot.id === focusShotId)
    for (const { shot, state } of visible) {
      const card = el('article', `visual-review-card is-${state.status}`); card.dataset.visualShot = shot.id
      const title = el('div', 'visual-review-card-heading')
      title.append(el('h3', '', shot.title), el('span', `visual-review-status is-${state.status}`, state.label))
      if (onSelectShot) title.append(button('打开镜头', () => { if (owner !== context().projectId || busy) return; close(); onSelectShot(shot.id) }))
      card.append(title, el('p', 'media-help', data.documents?.[shot.sourceDocumentId]?.title || '来源未归属'))
      if (state.issues?.length) card.append(el('p', 'media-warning', state.issues.join('；')))
      if (state.changedFields?.length) card.append(el('p', 'media-warning', `发生变化：${state.changedFields.join('、')}。图片与历史记录仍保留，请按当前基准重新查看图片。`))
      const comparison = el('div', 'visual-review-comparison'), referenceColumn = el('section', 'visual-review-references')
      referenceColumn.append(el('h4', '', '实际绑定的设定与输入图'))
      const matches = matchShotReferences(shot, available, data.documents, data.storyboard?.continuity, data)
      if (matches.length) referenceColumn.append(el('p', 'media-help', matches.map(match => `${roles[match.role] || '素材'}「${match.name}」${match.stateName ? ` · ${match.stateName}` : ''}：${states[match.status] || match.status}`).join('；')))
      const grid = el('div', 'visual-review-reference-grid'), used = new Set()
      for (const ref of shot.references || []) {
        if (!uses[ref.role] || used.has(ref.versionId)) continue
        const found = findMediaVersion(available, ref.versionId)
        if (!found || found.asset.kind !== 'image') continue
        used.add(ref.versionId)
        grid.append(image(ref.versionId, `${roles[found.asset.role] || '图片'} · ${found.asset.name}（${uses[ref.role]}）`, available))
      }
      if (!used.size) grid.append(el('p', 'media-help', '未绑定图片参考，请先在“参考”中确认人物、场景和物品设定。'))
      referenceColumn.append(grid)
      comparison.append(image(shot.selectedImageVersionId, '当前选用分镜图', available, 'visual-review-selected-image'), referenceColumn)
      card.append(comparison)
      const adjacent = el('details', 'visual-review-neighbours'); adjacent.append(el('summary', '', '对照前后镜头（含相邻分场）'))
      const pair = el('div', 'visual-review-neighbour-grid')
      for (const [key, label] of [['previous', '上一镜'], ['next', '下一镜']]) {
        const neighbour = neighbours.get(shot.id)?.[key]
        if (neighbour) pair.append(image(neighbour.selectedImageVersionId, `${label} · ${neighbour.title}`, available))
        else pair.append(el('p', 'media-help', `本集没有${label}。`))
      }
      adjacent.append(pair); card.append(adjacent)
      const note = el('textarea'); note.maxLength = 2000; note.rows = 2
      note.setAttribute('aria-label', `核对备注：${shot.title}`); note.placeholder = '记录服装、人物细节、场景布局、物品结构或光线的差异（可选）'
      const key = noteKey(owner, shot)
      note.value = notes.has(key) ? notes.get(key) : shot.visualReview?.notes || ''
      note.addEventListener('input', () => notes.set(key, note.value))
      note.addEventListener('blur', () => { if (!busy && dialog.open) render() })
      const expected = { projectId: owner, imageVersionId: shot.selectedImageVersionId, fingerprint: visualInputFingerprint(shot, available, data.documents, data.storyboard?.continuity, data) }
      const actions = el('div', 'visual-review-actions')
      const approve = button('核对一致', () => review(shot.id, 'approved', note, expected), 'primary-button')
      const reject = button('标记不一致', () => review(shot.id, 'rejected', note, expected))
      approve.disabled = busy || state.status === 'missing' || !onReview
      reject.disabled = busy || state.status === 'missing' || !onReview
      approve.dataset.visualMutation = ''; reject.dataset.visualMutation = ''
      note.disabled = busy
      actions.append(approve, reject, el('small', 'media-help', '确认只针对当前图片和当前参考版本；变更后需要重新核对。'))
      card.append(note, actions); list.append(card)
    }
    if (!visible.length) list.append(el('p', 'visual-review-empty', shots.length ? '当前筛选没有需要处理的镜头。' : '当前范围尚无镜头。'))
    list.scrollTop = top
  }
  async function review(shotId, decision, note, expected) {
    if (busy || !onReview) return false
    const data = context(), available = assetsFor(data), shot = data.storyboard?.shots.find(item => item.id === shotId)
    if (owner !== expected.projectId || data.projectId !== expected.projectId) { close(); return false }
    if (!shot || shot.selectedImageVersionId !== expected.imageVersionId || visualInputFingerprint(shot, available, data.documents, data.storyboard?.continuity, data) !== expected.fingerprint) {
      signal('画面或参考已变化，本次未写入核对结果。请查看最新图片后重新核对。', true); render(true); return false
    }
    if (imageVisualReviewState(shot, available, data.documents, data.storyboard?.continuity, data).status === 'missing') return false
    const key = noteKey(owner, shot), text = note.value
    notes.set(key, text)
    try {
      busy = true
      for (const node of dialog.querySelectorAll('[data-visual-mutation]')) node.disabled = true
      note.disabled = true
      const saved = await onReview(shotId, { decision, notes: text }, expected)
      if (saved === false) throw new Error('核对结果未保存，请重试。')
      if (context().projectId !== expected.projectId || owner !== expected.projectId) return false
      notes.delete(key); focusShotId = ''
      signal(decision === 'approved' ? '已记录人工核对一致；后续图片或参考变化会重新提示复核。' : '已标记不一致。修正分镜图后，请重新核对再制作视频。')
      return true
    } catch (error) {
      if (context().projectId === expected.projectId && owner === expected.projectId) signal(`核对未保存：${error.message}`, true)
      return false
    } finally {
      busy = false
      if (dialog.open && owner === context().projectId) render(true)
    }
  }
  function refresh() {
    if (!dialog.open) return
    if (owner !== context().projectId) return close()
    if (!busy) render()
  }
  return { open, refresh, close }
}
