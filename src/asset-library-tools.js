import { ASSET_ROLES } from './storyboard.js'

export function assetUsage(asset, data) {
  const versions = new Set((asset.versions || []).map(version => version.id))
  const collect = (shot, historical = false) => {
    const purposes = []
    if ((shot.references || []).some(ref => versions.has(ref.versionId))) purposes.push('参考图')
    if (versions.has(shot.selectedImageVersionId)) purposes.push('选用分镜图')
    if (versions.has(shot.selectedVideoVersionId)) purposes.push('选用视频')
    if (!purposes.length) return null
    return { shotId: shot.id, documentId: shot.sourceDocumentId, title: shot.title, sourceTitle: data.documents?.[shot.sourceDocumentId]?.title || '未归属镜头', purposes, historical }
  }
  const current = (data.storyboard?.shots || []).map(shot => collect(shot)).filter(Boolean)
  const history = (data.storyboard?.sourceVersions || []).flatMap(version => (version.shots || []).map(shot => collect(shot, true)).filter(Boolean))
  return { current, historicalCount: new Set(history.map(item => `${item.documentId}:${item.shotId}`)).size }
}

export function filterLibraryAssets(assets, data, { query = '', usage = 'all', kind = '', sort = 'recent' } = {}) {
  const normalized = query.trim().toLocaleLowerCase()
  const result = assets.filter(asset => {
    if (kind && asset.kind !== kind) return false
    if (normalized && ![asset.name, ASSET_ROLES[asset.role], ...(asset.versions || []).map(version => version.name || '')].join(' ').toLocaleLowerCase().includes(normalized)) return false
    if (usage === 'all') return true
    const used = assetUsage(asset, data), count = used.current.length + used.historicalCount
    return usage === 'unused' ? count === 0 : usage === 'history' ? !used.current.length && used.historicalCount > 0 : used.current.length > 0
  })
  return sort === 'name' ? [...result].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) : result
}

export function createAssetLibraryTools({ getAssets, getContext, onFilterChange, onReset, onSelectShot, preview }) {
  const node = (tag, text = '', className = '') => { const result = document.createElement(tag); result.textContent = text; result.className = className; return result }
  const element = node('div', '', 'asset-library-tools')
  const search = node('input'); search.type = 'search'; search.placeholder = '搜索素材名称或版本'; search.setAttribute('aria-label', '搜索素材名称或版本')
  const makeSelect = (label, options) => { const select = node('select'); select.setAttribute('aria-label', label); for (const [value, text] of options) select.append(new Option(text, value)); return select }
  const usage = makeSelect('筛选素材使用情况', [['all', '全部使用状态'], ['used', '当前镜头使用中'], ['unused', '未使用素材'], ['history', '仅历史分镜使用']])
  const kind = makeSelect('筛选媒体类型', [['', '图片和视频'], ['image', '图片'], ['video', '视频']])
  const sort = makeSelect('素材排序', [['recent', '原有顺序'], ['name', '按名称排序']])
  const reset = node('button', '清除筛选', 'text-button compact-button'); reset.type = 'button'
  element.append(search, usage, kind, sort, reset)
  search.addEventListener('input', onFilterChange)
  for (const select of [usage, kind, sort]) select.addEventListener('change', onFilterChange)
  reset.addEventListener('click', () => { search.value = ''; usage.value = 'all'; kind.value = ''; sort.value = 'recent'; onReset?.(); onFilterChange(); search.focus() })
  function openCompare(asset) {
    const owner = getContext().projectId, opener = document.activeElement
    const dialog = node('dialog', '', 'app-dialog asset-compare-dialog'), header = node('div', '', 'production-dialog-heading'), title = node('h2', `${asset.name} · 版本对比`)
    title.id = 'assetCompareTitle'; dialog.setAttribute('aria-labelledby', title.id)
    const close = node('button', '关闭', 'secondary-button compact-button'); close.type = 'button'; close.addEventListener('click', () => dialog.close()); header.append(title, close)
    dialog.append(header, node('p', '并排查看现有版本。对比不会改变选用版本，视频分别播放。', 'dialog-description'))
    const columns = node('div', '', 'asset-compare-columns')
    for (let index = 0; index < 2; index += 1) {
      const column = node('section'), select = makeSelect(index ? '右侧对比版本' : '左侧对比版本', asset.versions.map((version, i) => [version.id, `版本 ${i + 1} · ${version.id.slice(-8)}`]))
      select.value = index ? asset.versions.find(version => version.id !== asset.selectedVersionId)?.id || asset.versions[1]?.id || asset.versions[0]?.id : asset.selectedVersionId || asset.versions[0]?.id
      const frame = node('div'), info = node('p', '', 'media-help')
      const render = () => {
        if (owner !== getContext().projectId) { dialog.close(); return }
        const latest = getAssets().find(item => item.id === asset.id), version = latest?.versions?.find(item => item.id === select.value)
        frame.querySelectorAll('video').forEach(video => video.pause())
        frame.replaceChildren(preview(version, asset.name))
        info.textContent = version ? `${version.mimeType} · ${Math.ceil((version.bytes || 0) / 1024)} KiB${version.id === latest.selectedVersionId ? ' · 当前默认参考' : ''}` : '此版本已不可用'
      }
      select.addEventListener('change', render); column.append(select, frame, info); columns.append(column); render()
    }
    dialog.append(columns); document.body.append(dialog)
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close() } })
    dialog.addEventListener('close', () => { dialog.querySelectorAll('video').forEach(video => video.pause()); dialog.remove(); if (opener?.isConnected) opener.focus({ preventScroll: true }) }, { once: true })
    dialog.showModal()
  }
  return { element, filter(assets) { return filterLibraryAssets(assets, getContext(), { query: search.value, usage: usage.value, kind: kind.value, sort: sort.value }) },
    detail(asset) {
      const section = node('section', '', 'asset-usage'), used = assetUsage(asset, getContext())
      section.append(node('h3', '使用位置'))
      if (!used.current.length) section.append(node('p', used.historicalCount ? '当前镜头未使用，历史分镜仍保留引用。' : '当前镜头和历史分镜均未使用此素材。', 'media-help'))
      for (const item of used.current) {
        const go = node('button', `${item.sourceTitle} · ${item.title} · ${item.purposes.join('、')}`, 'text-button asset-usage-link'); go.type = 'button'
        go.addEventListener('click', () => onSelectShot(item.shotId)); section.append(go)
      }
      if (used.historicalCount) section.append(node('p', `${used.historicalCount} 个历史镜头仍使用此素材。`, 'media-help'))
      const compare = node('button', '并排对比版本', 'secondary-button compact-button'); compare.type = 'button'; compare.disabled = (asset.versions?.length || 0) < 2; compare.addEventListener('click', () => openCompare(asset)); section.append(compare)
      if (compare.disabled) section.append(node('p', '有两个或更多版本后，可并排对比。', 'media-help'))
      return section
    } }
}
