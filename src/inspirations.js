import { listInspirations, saveInspiration, downloadDocument } from './project-store.js'

export function initializeInspirations({ appendToProject }) {
  const form = document.querySelector('#inspirationForm')
  const title = document.querySelector('#inspirationTitle')
  const content = document.querySelector('#inspirationContent')
  const status = document.querySelector('#inspirationStatus')
  const search = document.querySelector('#inspirationSearch')
  const list = document.querySelector('#inspirationList')
  let selectedId = null
  let baseline = JSON.stringify(['', ''])
  let busy = false
  const dirty = () => busy || JSON.stringify([title.value, content.value]) !== baseline
  const report = message => { status.textContent = message }
  const setBusy = value => {
    busy = value
    form.querySelectorAll('button, input, textarea').forEach(element => { element.disabled = value })
    document.querySelector('#newInspiration').disabled = value
  }
  function select(item) {
    if (busy || (dirty() && !window.confirm('当前灵感尚未保存，放弃这些修改？'))) return
    selectedId = item?.id || null
    title.value = item?.title || ''
    content.value = item?.content || ''
    baseline = JSON.stringify([title.value, content.value])
    document.querySelector('#inspirationHeading').textContent = item ? '编辑灵感' : '记录一个新灵感'
    report(item ? '已保存到本机灵感库' : '尚未保存。灵感独立于项目保存。')
    render()
    title.focus()
  }
  function render() {
    const items = listInspirations()
    const query = search.value.trim().toLocaleLowerCase()
    const filtered = items.filter(item => `${item.title}\n${item.content}`.toLocaleLowerCase().includes(query))
    list.replaceChildren()
    if (!filtered.length) {
      const empty = document.createElement('p')
      empty.className = 'inspiration-empty'
      empty.textContent = items.length ? '没有匹配的灵感，试试其他关键词。' : '还没有灵感。点击“新增灵感”，或直接在右侧记录第一个火花。'
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
      button.append(heading, preview)
      button.addEventListener('click', () => select(item))
      list.append(button)
    })
  }
  async function save() {
    if (busy || !form.reportValidity()) return
    setBusy(true)
    report('正在保存…')
    try {
      const item = await saveInspiration({ id: selectedId, title: title.value, content: content.value })
      selectedId = item.id
      title.value = item.title
      content.value = item.content
      baseline = JSON.stringify([title.value, content.value])
      document.querySelector('#inspirationHeading').textContent = '编辑灵感'
      report('已保存到本机灵感库')
      render()
    } catch (error) { report(`保存失败：${error.message || error}。输入已保留，请重试。`) }
    finally { setBusy(false) }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void save() })
  form.addEventListener('input', () => report(dirty() ? '有未保存修改 · ⌘S 保存' : '已保存到本机灵感库'))
  search.addEventListener('input', render)
  document.querySelector('#newInspiration').addEventListener('click', () => select(null))
  document.querySelector('#useInspiration').addEventListener('click', async () => {
    if (dirty() || !selectedId) { report('请先保存当前灵感，再追加到项目。'); return }
    setBusy(true)
    try { await appendToProject({ title: title.value, content: content.value }) }
    catch (error) { report(error.message || String(error)) }
    finally { setBusy(false) }
  })
  document.querySelector('#exportInspirations').addEventListener('click', async () => {
    if (dirty()) { report('请先保存当前修改，再导出。'); return }
    const items = listInspirations()
    if (!items.length) { report('灵感库还是空的，请先保存一条灵感。'); return }
    setBusy(true)
    try {
      const path = await downloadDocument('灵感库.md', items.map(item => `# ${item.title}\n\n${item.content}`).join('\n\n---\n\n'))
      report(`已导出到${path}`)
    } catch (error) { report(`导出失败：${error.message || error}`) }
    finally { setBusy(false) }
  })
  render()
  return { dirty, save, render }
}
