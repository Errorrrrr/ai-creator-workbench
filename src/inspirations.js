import { listInspirations, saveInspiration, archiveInspiration, restoreInspiration, downloadDocument } from './project-store.js'

export function initializeInspirations({ appendToProject }) {
  const form = document.querySelector('#inspirationForm')
  const title = document.querySelector('#inspirationTitle')
  const content = document.querySelector('#inspirationContent')
  const status = document.querySelector('#inspirationStatus')
  const search = document.querySelector('#inspirationSearch')
  const list = document.querySelector('#inspirationList')
  const archivedFilter = document.querySelector('#inspirationArchived')
  const archiveButton = document.querySelector('#archiveInspiration')
  let selectedId = null
  let selectedArchived = false
  let baseline = JSON.stringify(['', ''])
  let busy = false
  let pendingSave = null
  const dirty = () => busy || JSON.stringify([title.value, content.value]) !== baseline
  const report = message => { status.textContent = message }
  function setBusy(value) {
    busy = value
    form.querySelectorAll('button, input, textarea').forEach(element => { element.disabled = value })
    document.querySelector('#newInspiration').disabled = value
    archivedFilter.disabled = value
    title.readOnly = selectedArchived
    content.readOnly = selectedArchived
    form.querySelector('[type="submit"]').disabled = value || selectedArchived
    document.querySelector('#useInspiration').disabled = value || selectedArchived || !selectedId
    archiveButton.disabled = value || !selectedId
    archiveButton.textContent = selectedArchived ? '恢复灵感' : '归档灵感'
  }
  function reset() {
    selectedId = null
    selectedArchived = false
    title.value = ''
    content.value = ''
    baseline = JSON.stringify(['', ''])
    document.querySelector('#inspirationHeading').textContent = '记录一个新灵感'
    report('尚未保存。灵感独立于项目保存。')
    setBusy(false)
    render()
  }
  function select(item) {
    if (busy || (dirty() && !window.confirm('当前灵感尚未保存，放弃这些修改？'))) return
    if (!item) { archivedFilter.checked = false; reset(); title.focus(); return }
    selectedId = item.id
    selectedArchived = Boolean(item.archivedAt)
    title.value = item.title
    content.value = item.content
    baseline = JSON.stringify([title.value, content.value])
    document.querySelector('#inspirationHeading').textContent = selectedArchived ? '归档灵感' : '编辑灵感'
    report(selectedArchived ? '已归档。恢复后可继续编辑或追加到项目。' : '已保存到本机灵感库')
    setBusy(false)
    render()
    title.focus()
  }
  function render() {
    const items = listInspirations({ archived: archivedFilter.checked })
    const query = search.value.trim().toLocaleLowerCase()
    const filtered = items.filter(item => `${item.title}\n${item.content}`.toLocaleLowerCase().includes(query))
    list.replaceChildren()
    if (!filtered.length) {
      const empty = document.createElement('p')
      empty.className = 'inspiration-empty'
      empty.textContent = query ? '没有匹配的灵感，试试其他关键词。' : archivedFilter.checked ? '归档灵感会在这里保留，随时可以恢复。' : '记录一个人物、一段对白，或一个让你停下来的画面。'
      list.append(empty)
    }
    filtered.forEach(item => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'inspiration-item'
      button.setAttribute('aria-pressed', String(item.id === selectedId))
      const heading = document.createElement('strong')
      heading.textContent = item.title
      const preview = document.createElement('span')
      preview.textContent = item.content.slice(0, 100)
      const date = document.createElement('small')
      date.textContent = new Date(item.updatedAt).toLocaleDateString('zh-CN')
      button.append(heading, preview, date)
      button.addEventListener('click', () => select(item))
      list.append(button)
    })
  }
  async function save() {
    if (pendingSave) return pendingSave
    if (busy) return false
    if (!dirty()) return true
    if (selectedArchived || !form.reportValidity()) return false
    setBusy(true)
    report('正在保存…')
    pendingSave = (async () => {
      try {
        const item = await saveInspiration({ id: selectedId, title: title.value, content: content.value })
        selectedId = item.id
        title.value = item.title
        content.value = item.content
        baseline = JSON.stringify([title.value, content.value])
        document.querySelector('#inspirationHeading').textContent = '编辑灵感'
        report('已保存到本机灵感库')
        render()
        return true
      } catch (error) {
        report(`保存失败：${error.message || error}。输入已保留，请重试。`)
        return false
      } finally { pendingSave = null; setBusy(false) }
    })()
    return pendingSave
  }
  form.addEventListener('submit', event => { event.preventDefault(); void save() })
  form.addEventListener('input', () => report(dirty() ? '有未保存修改 · ⌘S 保存' : '已保存到本机灵感库'))
  search.addEventListener('input', render)
  archivedFilter.addEventListener('change', () => {
    if (dirty() && !window.confirm('当前灵感尚未保存，放弃这些修改？')) { archivedFilter.checked = !archivedFilter.checked; return }
    reset()
  })
  document.querySelector('#newInspiration').addEventListener('click', () => select(null))
  document.querySelector('#useInspiration').addEventListener('click', async () => {
    if (dirty() || !selectedId) { report('请先保存当前灵感，再追加到项目。'); return }
    setBusy(true)
    try { await appendToProject({ title: title.value, content: content.value }) }
    catch (error) { report(error.message || String(error)) }
    finally { setBusy(false) }
  })
  archiveButton.addEventListener('click', async () => {
    if (!selectedId || busy) return
    if (dirty() && !await save()) return
    const restoring = selectedArchived
    setBusy(true)
    try {
      if (restoring) await restoreInspiration(selectedId)
      else await archiveInspiration(selectedId)
      reset()
      report(restoring ? '灵感已恢复，可在未归档列表中继续编辑。' : '灵感已归档，可勾选“查看归档灵感”恢复。')
    } catch (error) { report(error.message || String(error)) }
    finally { setBusy(false) }
  })
  document.querySelector('#exportInspirations').addEventListener('click', async () => {
    if (dirty()) { report('请先保存当前修改，再导出。'); return }
    const items = listInspirations({ archived: null })
    if (!items.length) { report('灵感库还是空的，请先保存一条灵感。'); return }
    setBusy(true)
    try {
      const path = await downloadDocument('灵感库.md', items.map(item => `# ${item.title}${item.archivedAt ? '（已归档）' : ''}\n\n${item.content}`).join('\n\n---\n\n'))
      report(`已导出到${path}；恢复用 JSON 请使用“完整备份”。`)
    } catch (error) { report(`导出失败：${error.message || error}`) }
    finally { setBusy(false) }
  })
  reset()
  return { dirty, save, render, reset, isBusy: () => busy }
}
