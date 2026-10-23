import { findMediaVersion, shotIsStale } from './storyboard.js'
import { matchShotReferences } from './storyboard-references.js'
import { shotReadiness } from './shot-workflow.js'
import { storyboardGroups, OTHER_EPISODE, UNASSIGNED_SOURCE } from './storyboard-scope.js'

export function productionRows(data, assets = [], jobs = []) {
  const shots = data.storyboard?.shots || [], documents = data.documents || {}
  const summarize = (group, documentId, sourceShots, episodeOnly = false) => {
    const document = documents[documentId]
    const ready = shot => shotReadiness(shot, assets, jobs, documents)
    const missingReferences = sourceShots.filter(shot => shot.references.some(ref => !findMediaVersion(assets, ref.versionId)) || matchShotReferences(shot, assets, documents).some(match => !['bound', 'excluded'].includes(match.status)))
    const missingImages = sourceShots.filter(shot => findMediaVersion(assets, shot.selectedImageVersionId)?.asset.kind !== 'image')
    const missingVideos = sourceShots.filter(shot => findMediaVersion(assets, shot.selectedVideoVersionId)?.asset.kind !== 'video')
    const review = sourceShots.filter(shot => findMediaVersion(assets, shot.selectedVideoVersionId)?.asset.kind === 'video' && (ready(shot).tone !== 'complete' || shotIsStale(shot, documents)))
    const stale = sourceShots.filter(shot => shotIsStale(shot, documents))
    const complete = sourceShots.filter(shot => ready(shot).tone === 'complete' && !shotIsStale(shot, documents))
    return { episodeId: group.id, episodeTitle: group.title, documentId, title: document?.title || '未归属镜头', episodeOnly, needsScenes: episodeOnly && !group.sceneIds.length,
      written: Boolean(document?.content?.trim() && !document.content.startsWith('【待创作】')), total: sourceShots.length,
      images: sourceShots.length - missingImages.length, videos: sourceShots.length - missingVideos.length, complete: complete.length,
      referenceIds: missingReferences.map(shot => shot.id), imageIds: missingImages.map(shot => shot.id), videoIds: missingVideos.map(shot => shot.id), reviewIds: review.map(shot => shot.id), staleIds: stale.map(shot => shot.id) }
  }
  return storyboardGroups(data).flatMap(group => {
    const rows = group.sceneIds.filter(id => group.id !== OTHER_EPISODE || shots.some(shot => shot.sourceDocumentId === id)).map(id => summarize(group, id, shots.filter(shot => shot.sourceDocumentId === id)))
    const episodeShots = shots.filter(shot => shot.sourceDocumentId === group.id)
    if (group.id !== OTHER_EPISODE && (!group.sceneIds.length || episodeShots.length)) rows.push(summarize(group, group.id, episodeShots, true))
    if (group.id === OTHER_EPISODE) {
      const orphaned = shots.filter(shot => !documents[shot.sourceDocumentId])
      if (orphaned.length) rows.push(summarize(group, UNASSIGNED_SOURCE, orphaned))
    }
    return rows
  })
}

export function productionRowMatches(row, filter) {
  if (filter === 'script') return !row.written || row.needsScenes
  if (filter === 'storyboard') return !row.total || row.staleIds.length > 0
  if (filter === 'references') return row.referenceIds.length > 0
  if (filter === 'images') return row.imageIds.length > 0
  if (filter === 'videos') return row.videoIds.length > 0
  if (filter === 'review') return row.reviewIds.length > 0
  return true
}

export function createProductionOverview({ getContext, getAssets, getJobs, onSelectScene }) {
  const node = (tag, text = '', className = '') => { const result = document.createElement(tag); result.textContent = text; result.className = className; return result }
  const dialog = node('dialog', '', 'app-dialog production-dialog'), title = node('h2', '制作进度')
  title.id = 'productionOverviewTitle'; dialog.setAttribute('aria-labelledby', title.id)
  const close = node('button', '关闭', 'secondary-button compact-button'); close.type = 'button'; close.addEventListener('click', () => dialog.close())
  const header = node('div', '', 'production-dialog-heading'); header.append(title, close)
  const status = node('p', '', 'media-notice'); status.setAttribute('role', 'status')
  const filter = node('select'); filter.setAttribute('aria-label', '筛选制作待办')
  for (const [id, text] of [['all', '全部分场'], ['script', '待写剧本／待建分场'], ['storyboard', '待拆镜／剧本已变'], ['references', '待补参考图'], ['images', '待选分镜图'], ['videos', '待选视频'], ['review', '视频待复核']]) filter.append(new Option(text, id))
  const scroll = node('div', '', 'production-table-scroll'), table = node('table', '', 'production-table'), body = node('tbody')
  const tableHead = node('thead'), heading = node('tr')
  for (const text of ['分集／分场', '剧本', '分镜', '参考', '分镜图', '视频', '审核']) { const th = node('th', text); th.scope = 'col'; heading.append(th) }
  tableHead.append(heading); table.append(tableHead, body); scroll.append(table)
  const empty = node('p', '', 'media-help')
  dialog.append(header, node('p', '按场查看缺项，点击数量可直接进入对应镜头。审核完成不代表已经导出。', 'dialog-description'), status, filter, scroll, empty)
  document.body.append(dialog)
  let owner = null, signature = '', opener = null
  const closeLocally = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close() } }
  dialog.addEventListener('keydown', closeLocally)
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus({ preventScroll: true }) })
  function refresh(force = false) {
    if (!dialog.open) return
    const data = getContext()
    if (owner !== data.projectId) { dialog.close(); return }
    const rows = productionRows(data, getAssets(), getJobs()), filtered = rows.filter(row => productionRowMatches(row, filter.value))
    const key = JSON.stringify([filter.value, rows]); if (!force && key === signature) return; signature = key
    const focus = dialog.contains(document.activeElement) ? document.activeElement.dataset.productionFocus : null
    const top = scroll.scrollTop
    const total = rows.reduce((sum, row) => sum + row.total, 0), completed = rows.reduce((sum, row) => sum + row.complete, 0)
    status.textContent = `${rows.filter(row => !row.episodeOnly && row.documentId !== UNASSIGNED_SOURCE).length} 个分场 · ${total} 个镜头 · ${completed} 个镜头已审核完成`
    body.replaceChildren()
    for (const row of filtered) {
      const tr = node('tr'), source = node('td'); source.append(node('small', row.episodeTitle), node('strong', row.title)); tr.append(source)
      const addCell = (text, stage, shotId = '') => {
        const cell = node('td'), button = node('button', text, 'text-button compact-button'); button.type = 'button'
        button.dataset.productionFocus = `${row.documentId}:${stage}`
        button.addEventListener('click', () => { if (owner !== getContext().projectId) return dialog.close(); dialog.close(); onSelectScene(row.documentId, { stage, shotId, episodeId: row.episodeId }) })
        cell.append(button); tr.append(cell)
      }
      addCell(row.documentId === UNASSIGNED_SOURCE ? '来源缺失' : row.needsScenes ? '待建分场' : row.written ? '已写' : '待写', 'script')
      addCell(row.total ? `${row.total} 镜${row.staleIds.length ? ' · 来源已变' : ''}` : '待拆镜', 'content', row.staleIds[0])
      addCell(row.referenceIds.length ? `缺 ${row.referenceIds.length} 镜` : row.total ? '已齐' : '—', 'references', row.referenceIds[0])
      addCell(`${row.images}/${row.total}`, 'images', row.imageIds[0])
      addCell(`${row.videos}/${row.total}`, 'videos', row.videoIds[0])
      addCell(row.reviewIds.length ? `待复核 ${row.reviewIds.length}` : `${row.complete}/${row.total}`, 'export', row.reviewIds[0])
      body.append(tr)
    }
    empty.textContent = !rows.length ? '先建立分集、分场或镜头，即可查看制作进度。' : !filtered.length ? '当前筛选没有待处理分场。' : ''
    if (focus) [...body.querySelectorAll('[data-production-focus]')].find(item => item.dataset.productionFocus === focus)?.focus({ preventScroll: true })
    scroll.scrollTop = top
  }
  filter.addEventListener('change', () => refresh(true))
  return { open() { owner = getContext().projectId; opener = document.activeElement; filter.value = 'all'; signature = ''; if (!dialog.open) dialog.showModal(); refresh(true) }, refresh }
}
