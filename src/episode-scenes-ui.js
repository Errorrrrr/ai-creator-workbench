import { episodeForDocument, isSceneDocument, splitEpisodeScript } from './episode-scenes.js'
import { parseScenePlanCandidate } from './scene-planning.js'

const node = (tag, text = '', className = '') => { const item = document.createElement(tag); item.textContent = text; item.className = className; return item }
const button = (text, action, primary = false) => { const item = node('button', text, primary ? 'primary-button' : 'secondary-button compact-button'); item.type = 'button'; item.addEventListener('click', action); return item }
const field = (text, control) => { const item = node('label', '', 'form-field'); item.append(node('span', text), control); return item }

export function initializeEpisodeScenesUI({ getContext, commit, requestPlan, openScene, createEpisode, notify }) {
  const dialog = node('dialog', '', 'app-dialog episode-scene-dialog')
  const heading = node('h2'); heading.id = 'episodeScenesTitle'; dialog.setAttribute('aria-labelledby', heading.id)
  const explanation = node('p', '', 'dialog-description'), status = node('p', '', 'media-notice'), body = node('div'), actions = node('div', '', 'scene-workflow-actions')
  status.setAttribute('role', 'status')
  const close = button('关闭', () => dismiss())
  dialog.append(heading, explanation, status, body, actions, close); document.body.append(dialog)
  let snapshot = null, scenes = [], selected = new Set(), target = '', mode = 'scenes', busy = false, dirty = false, opener = null
  function dismiss() {
    if (busy) return
    if (dirty && !window.confirm('放弃尚未保存的分场预览修改？现有剧本与镜头不受影响。')) return
    dirty = false; dialog.close()
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss() })
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() } })
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus({ preventScroll: true }) })
  function check() {
    const data = getContext()
    if (!snapshot || data.projectId !== snapshot.projectId) throw new Error('项目已切换，请重新打开分场整理')
    return data
  }
  async function run(task) {
    if (busy) return
    busy = true; dialog.setAttribute('aria-busy', 'true')
    const controls = [...dialog.querySelectorAll('button, input, textarea, select')].map(control => [control, control.disabled])
    controls.forEach(([control]) => { control.disabled = true })
    try { await task() } catch (error) { status.textContent = error.message || String(error) }
    finally { busy = false; dialog.removeAttribute('aria-busy'); controls.forEach(([control, disabled]) => { control.disabled = disabled }) }
  }
  function renderPlan() {
    const data = check(), episode = data.documents[snapshot.episodeId]
    heading.textContent = `整理分场 · ${episode.title}`
    explanation.textContent = '先确认每场剧本，再进入本场拆镜。这里只追加新分场；原文、已有分场、镜头和图片视频均保留。'
    status.textContent = `本集已有 ${snapshot.expectedSceneIds.length} 场；本次预览 ${scenes.length} 场。${snapshot.candidateId ? 'AI 只建议原文分段，正文按原文提取。' : '按明确场次标题识别；没有场次标题时先作为一场预览，可手动调整。'}`
    body.replaceChildren(); actions.replaceChildren()
    if (snapshot.sourceId !== snapshot.episodeId) {
      const parent = node('select'); parent.setAttribute('aria-label', '分场所属集')
      for (const act of data.structure.acts) for (const id of act.episodeIds) parent.append(new Option(data.documents[id].title, id))
      parent.value = snapshot.episodeId
      parent.addEventListener('change', () => { const current = check(); snapshot.episodeId = parent.value; snapshot.expectedContent = current.documents[parent.value].content; snapshot.expectedSceneIds = [...current.structure.episodes[parent.value].sceneIds]; dirty = true })
      body.append(field('分场所属集', parent))
    }
    const list = node('div', '', 'episode-scene-plan-list')
    scenes.forEach((scene, index) => {
      const item = node('section', '', 'episode-scene-plan-item'), title = node('input'), content = node('textarea')
      title.value = scene.title; title.maxLength = 200; title.setAttribute('aria-label', `第 ${index + 1} 场标题`)
      content.value = scene.content; content.rows = 7; content.setAttribute('aria-label', `第 ${index + 1} 场剧本`)
      title.addEventListener('input', () => { scene.title = title.value; dirty = true })
      content.addEventListener('input', () => { scene.content = content.value; dirty = true })
      item.append(field(`第 ${index + 1} 场标题`, title), field('本场剧本', content), button('移除此预览场次', () => { scenes.splice(index, 1); dirty = true; renderPlan() }))
      list.append(item)
    })
    body.append(list)
    actions.append(button('添加预览场次', () => { if (scenes.length >= 100) return; scenes.push({ title: `第 ${scenes.length + 1} 场`, content: '' }); dirty = true; renderPlan() }))
    const ai = button('AI 规划分场', () => run(async () => {
      check()
      if (dirty && !window.confirm('按原始剧本重新规划？当前未保存的预览修改将被替换。')) return
      if (await requestPlan(snapshot)) { dirty = false; dialog.close(); notify('正在规划分场，完成后进入预览确认') }
    }))
    ai.disabled = !snapshot.expectedContent.trim() || snapshot.sourceId !== snapshot.episodeId
    actions.append(ai, button('确认追加分场', () => run(async () => {
      check()
      const result = await commit({ type: 'scenes', ...snapshot, scenes: structuredClone(scenes) })
      dirty = false; dialog.close(); notify(`已追加 ${result.sceneIds.length} 场，可逐场拆镜；原文与已有素材已保留`)
      if (result.sceneIds[0]) await openScene(result.sceneIds[0])
    }), true))
  }
  function renderAssignment(shotIds) {
    const data = check(), shots = data.storyboard.shots.filter(shot => shotIds.includes(shot.id))
    heading.textContent = '将已有分镜归入分场'
    explanation.textContent = '调整选中镜头的所属分场，并固定原参考图版本；镜头编号、内容和已选图片视频保留。原素材状态与旧候选、历史仍关联原来源；归场后须在参考页核对目标分场的剧情、素材状态和连续性。'
    status.textContent = `${shots.length} 个镜头可整理。归场不会重新生成媒体，也不会自动通过复核。`
    body.replaceChildren(); actions.replaceChildren(); selected = new Set(shots.map(shot => shot.id))
    snapshot.expectedSources = Object.fromEntries(shots.map(shot => [shot.id, shot.sourceDocumentId]))
    const select = node('select'); select.setAttribute('aria-label', '目标分场')
    select.append(new Option('请选择所属分场', ''))
    for (const act of data.structure.acts) for (const episodeId of act.episodeIds) for (const sceneId of data.structure.episodes[episodeId]?.sceneIds || []) {
      if (data.documents[sceneId]) select.append(new Option(`${data.documents[episodeId].title} → ${data.documents[sceneId].title}`, sceneId))
    }
    target = ''; select.addEventListener('change', () => { target = select.value; dirty = true })
    body.append(field('所属集 → 分场', select))
    const list = node('div', '', 'scene-assignment-list')
    shots.forEach(shot => {
      const input = node('input'); input.type = 'checkbox'; input.checked = true
      input.addEventListener('change', () => { if (input.checked) selected.add(shot.id); else selected.delete(shot.id); dirty = true })
      const label = node('label'); label.append(input, node('span', `${shot.title} · 原来源：${data.documents[shot.sourceDocumentId]?.title || '来源缺失'}`)); list.append(label)
    })
    body.append(list)
    if (snapshot.episodeId) actions.append(button('先整理本集分场', () => { mode = 'scenes'; scenes = splitEpisodeScript(snapshot.sourceContent || snapshot.expectedContent); dirty = false; renderPlan() }))
    else actions.append(button('建立分集与分场', () => run(async () => { const id = await createEpisode(); if (!id) return; snapshot.episodeId = id; snapshot.expectedContent = getContext().documents[id].content; snapshot.expectedSceneIds = []; scenes = splitEpisodeScript(snapshot.sourceContent); mode = 'scenes'; dirty = false; renderPlan() })))
    actions.append(button('确认归入分场', () => run(async () => {
      check()
      if (!target || !selected.size) throw new Error('请选择目标分场和至少一个镜头')
      const result = await commit({ type: 'assign', ...snapshot, shotIds: [...selected], targetSceneId: target })
      dirty = false; dialog.close(); notify(`已将 ${result.shotIds.length} 个镜头归入分场，图片视频保持选用；请重新核对连续性`)
      await openScene(target, { storyboard: true })
    }), true))
  }
  async function open({ episodeId, sourceId, shotIds = [] } = {}) {
    if (busy) return
    if (dialog.open && dirty && !window.confirm('放弃当前未保存的分场预览，打开其他内容？')) return
    const data = getContext()
    if (!data.projectId) return notify('请先创建或打开项目')
    episodeId = data.structure.episodes[episodeId] ? episodeId : episodeForDocument(data, sourceId || data.currentDocId)
    episodeId ||= (data.structure.acts || []).flatMap(act => act.episodeIds)[0]
    if (!episodeId && !shotIds.length) { const id = await createEpisode(); if (id && data.projectId === getContext().projectId) return open({ episodeId: id, sourceId }); return }
    sourceId = sourceId && data.documents[sourceId] && !isSceneDocument(data, sourceId) ? sourceId : episodeId
    snapshot = { projectId: data.projectId, episodeId, sourceId, sourceContent: data.documents[sourceId]?.content || '', expectedContent: data.documents[episodeId]?.content || '', expectedSceneIds: [...(data.structure.episodes[episodeId]?.sceneIds || [])], candidateId: null }
    dirty = false; opener = document.activeElement; mode = shotIds.length ? 'assign' : 'scenes'
    if (mode === 'assign') renderAssignment(shotIds)
    else { scenes = splitEpisodeScript(snapshot.sourceContent); renderPlan() }
    if (!dialog.open) dialog.showModal()
  }
  function receiveCandidate(text, context, candidateId) {
    try {
      if (busy) { notify('分场候选已保存在待审稿中，请在当前保存完成后打开'); return }
      const data = getContext()
      if (data.projectId !== context.projectId || !data.structure.episodes[context.documentId]) throw new Error('原项目或分集已变化，分场候选仍保留在待审稿中')
      if (data.documents[context.documentId].content !== context.baseContent) throw new Error('本集原文已变化，请重新规划分场；旧候选仍保留')
      const parsed = parseScenePlanCandidate(text, context.baseContent)
      if (dialog.open && dirty && !window.confirm('打开这份分场候选并放弃当前未保存的预览修改？')) return
      snapshot = { projectId: data.projectId, episodeId: context.documentId, sourceId: context.documentId, sourceContent: context.baseContent, expectedContent: context.baseContent, expectedSceneIds: [...context.sourceDocumentIds], candidateId }
      scenes = parsed; mode = 'scenes'; dirty = false; opener = document.activeElement
      renderPlan(); if (!dialog.open) dialog.showModal()
    } catch (error) { notify(error.message || String(error)) }
  }
  return { open, receiveCandidate, hasPendingWork: () => busy || (dialog.open && dirty) }
}
