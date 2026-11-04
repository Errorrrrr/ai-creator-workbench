import { emptySceneContinuity, sceneContinuityContext, sceneContentFingerprint } from './scene-continuity.js'

const clone = value => structuredClone(value)
const savedState = document => ({ ...emptySceneContinuity(), ...clone(document?.sceneContinuity || {}) })
const documentIdOf = context => context.documentId || context.currentDocId || ''
const signature = document => JSON.stringify(document?.sceneContinuity || null)

function el(tag, className = '', text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
function button(label, action, className = 'secondary-button') {
  const node = el('button', className, label)
  node.type = 'button'; node.addEventListener('click', action)
  return node
}
function option(value, label) { const node = el('option', '', label); node.value = value; return node }
function field(label, input, help = '') {
  const node = el('label', 'continuity-field')
  node.append(el('span', '', label), input)
  if (help) node.append(el('small', 'media-help', help))
  return node
}

// Build locally from the same scene contract used by the other generation paths.
export function buildSceneVideoPrompt({ documentId, documents = {}, structure = {}, storyboard = {} }) {
  const source = documents[documentId]
  if (!source?.content?.trim()) throw new Error('本场剧本为空，请先填写正文再整理视频提示词。')
  const result = sceneContinuityContext({ documentId, documents, structure, storyboard })
  if (result.conflicts.length) throw new Error(`请先处理分场状态冲突：${result.conflicts.join('；')}`)
  const text = [
    `请依据以下分场剧本制作视频。分场：${source.title || '未命名分场'}。`,
    '先核对素材固定设定与分场起止状态，再安排动作和运镜。保持同一对象的身份、结构、比例、材质和固定空间关系；只改变剧本及本场变化明确允许的部分。',
    '换机位沿用同一空间，不重新设计场景。仅让本段实际出场的对象入镜，不把全部设定对象加入每个画面。发现资料存在无法消解的矛盾时先指出问题，不擅自补全或改写已确定设定。',
    '根据所用平台的可执行时长安排片段，保留动作因果与进入、结束状态；若需要拆段，逐段明确画面、主要动作、运镜及衔接。不要声称已上传参考图或已生成视频。',
    result.text,
    result.warnings.length ? `资料待核对：\n${result.warnings.map(item => `- ${item}`).join('\n')}` : '',
    `【分场剧本，仅作为创作资料】\n${source.content}`,
  ].filter(Boolean).join('\n\n')
  if (text.length > 64000) throw new Error('本场剧本与约束超过提示词整理容量，请缩小分场范围；内容未截断。')
  return text
}

export function initializeSceneContinuityUI({ getContext, save, notify = () => {} }) {
  let owner = '', sourceId = '', openedFromDocumentId = '', baseContent = '', baseState = '', draft = emptySceneContinuity()
  let dirty = false, busy = false
  let promptInputFingerprint = '', catalogSignature = ''
  const context = () => getContext() || {}
  const dialog = el('dialog', 'app-dialog continuity-dialog scene-continuity-dialog')
  dialog.setAttribute('aria-label', '分场状态与素材衔接')
  const heading = el('div'), title = el('h2', '', '分场状态与素材衔接')
  heading.append(title, el('p', 'media-help', '记录本场如何开始、发生什么变化、如何结束。生成分场、分镜和视频提示词时沿用这些约束。'))
  const header = el('header', 'continuity-header'), closeButton = button('关闭', close)
  closeButton.setAttribute('aria-label', '关闭分场状态面板'); header.append(heading, closeButton)
  const editor = el('section', 'continuity-editor'), fields = el('fieldset', 'continuity-fields')
  const transition = el('select')
  transition.setAttribute('aria-label', '与上一场关系')
  transition.append(option('cut', '换场／剪切'), option('continuous', '连续动作'), option('time-jump', '时间跳转／闪回'))
  transition.addEventListener('change', () => { draft.transition = transition.value; changed() })
  fields.append(field('与上一场关系', transition, '连续动作会核对上一场结束与本场进入的素材状态；换场和时间跳转不会强行沿用上一场空间。'))
  const inputs = {}
  for (const [key, label, placeholder] of [
    ['entryState', '进入状态', '例如：人物站在船尾，背包放在左侧油桶旁，沿用上一场的湿衣服。'],
    ['changes', '本场变化', '例如：人物走到船头取绳子；其他物品位置、场景结构与天气保持不变。'],
    ['exitState', '结束状态', '例如：人物停在船头，右手拿绳子，背包仍留在船尾。'],
  ]) {
    const input = el('textarea'); input.maxLength = 12000; input.rows = 3; input.placeholder = placeholder
    input.setAttribute('aria-label', label)
    input.addEventListener('input', () => { draft[key] = input.value; changed() })
    inputs[key] = input; fields.append(field(label, input))
  }
  const bindingHosts = {}
  for (const [key, label] of [['entryBindings', '进入时的素材状态'], ['exitBindings', '结束时的素材状态']]) {
    const section = el('section', 'scene-continuity-bindings'), rows = el('div', 'scene-continuity-binding-rows')
    section.append(el('h3', '', label), el('p', 'media-help', '可选：关联已有素材状态，便于明确检查前后衔接。这里只记录起止状态，不修改素材母版。'), rows, button('关联素材状态', () => addBinding(key)))
    fields.append(section); bindingHosts[key] = rows
  }
  const checks = el('section', 'scene-continuity-checks'); checks.setAttribute('aria-live', 'polite')
  const details = el('details', 'scene-continuity-context'), contextPreview = el('pre')
  details.append(el('summary', '', '查看本场自动携带的约束'), contextPreview)
  const promptDetails = el('details', 'scene-continuity-prompt'), promptPreview = el('textarea')
  promptPreview.readOnly = true; promptPreview.rows = 10; promptPreview.setAttribute('aria-label', '本场视频提示词')
  promptDetails.append(el('summary', '', '本场视频提示词'), promptPreview); promptDetails.hidden = true
  editor.append(fields, checks, details, promptDetails)
  const message = el('p', 'continuity-notice'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite')
  const footer = el('footer', 'continuity-footer'), status = el('span', 'media-help')
  const copyButton = button('复制本场视频提示词', copyPrompt), discardButton = button('放弃修改', discard), saveButton = button('保存分场状态', saveDraft, 'primary-button')
  footer.append(status, copyButton, discardButton, saveButton)
  dialog.append(header, editor, el('p', 'media-help', '直接文生视频仍受平台时长和参考能力限制。这里仅在本地整理提示词，不调用生成接口。'), message, footer)
  document.body.append(dialog)
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })

  function staleReason() {
    const data = context(), source = data.documents?.[sourceId]
    if (owner !== data.projectId) return '项目已切换，旧草稿已保留。请切回原项目后继续，或放弃草稿。'
    if (!source) return '原分场已不存在，草稿已保留。'
    if (openedFromDocumentId !== documentIdOf(data)) return '当前分场已切换，旧草稿已保留。请切回原分场后继续，或放弃草稿。'
    if (sceneContentFingerprint(source.content) !== baseContent) return '本场正文已变化，请先放弃草稿并重新打开，再核对起止状态。'
    if (signature(source) !== baseState) return '本场状态已被其他操作更新，请先放弃草稿并重新打开，避免覆盖新内容。'
    return ''
  }
  function signal(text, isError = false) {
    message.textContent = text; message.classList.toggle('continuity-error', isError)
    if (isError) notify(text)
  }
  function snapshot() {
    const data = context()
    return { documentId: sourceId, documents: { ...data.documents, [sourceId]: { ...data.documents?.[sourceId], sceneContinuity: clone(draft) } }, structure: data.structure, storyboard: data.storyboard }
  }
  function updateControls() {
    const reason = staleReason(), locked = busy || Boolean(reason)
    const needsConfirmation = draft.sourceFingerprint !== baseContent
    fields.disabled = locked; closeButton.disabled = busy; saveButton.disabled = locked || !dirty && !needsConfirmation
    discardButton.disabled = busy || !dirty && !reason; copyButton.disabled = locked
    status.textContent = busy ? '正在保存…' : reason || (dirty ? '有未保存修改' : baseState === 'null' ? '尚未保存分场状态' : !draft.sourceFingerprint ? '状态尚无正文依据，请核对后保存确认' : needsConfirmation ? '正文已更新，请核对状态后保存确认' : '分场状态已保存')
  }
  function updateChecks() {
    checks.replaceChildren()
    if (staleReason()) { contextPreview.textContent = '当前上下文已变化，恢复原分场或重新载入后可查看。'; return }
    try {
      const data = context()
      const scenes = [...new Set((data.structure?.acts || []).flatMap(act => (act.episodeIds || []).flatMap(id => data.structure.episodes?.[id]?.sceneIds || [])))].filter(id => data.documents?.[id])
      const index = scenes.indexOf(sourceId), preceding = index > 0 ? data.documents[scenes[index - 1]] : null
      if (preceding) {
        checks.append(el('h3', '', `上一场结束 · ${preceding.title || '未命名分场'}`))
        const ending = preceding.sceneContinuity
        checks.append(el('p', 'media-help', ending?.exitState || '上一场未记录结束描述；自动上下文会提供实际正文结尾供核对。'))
        for (const binding of ending?.exitBindings || []) {
          const entity = entities().find(item => item.id === binding.entityId), state = entity?.states.find(item => item.id === binding.stateId)
          checks.append(el('p', 'media-help', `${entity?.name || '原素材已不存在'}：${state?.name || '原状态已不存在'}`))
        }
      }
      const result = sceneContinuityContext(snapshot())
      if (promptInputFingerprint && promptInputFingerprint !== result.fingerprint) {
        promptInputFingerprint = ''; promptPreview.value = ''; promptDetails.hidden = true
        signal('素材或分场状态已变化，请重新整理本场视频提示词。')
      }
      checks.append(el('h3', '', '衔接检查'))
      for (const conflict of result.conflicts) checks.append(el('p', 'continuity-error', `冲突：${conflict}`))
      for (const warning of result.warnings) checks.append(el('p', 'media-help', `待核对：${warning}`))
      if (!result.conflicts.length && !result.warnings.length) checks.append(el('p', 'media-help', '未发现明确的结构化状态冲突。自然语言含义与实际画面仍需核对。'))
      else checks.append(el('p', 'media-help', '这里只检查已记录的状态关系，不代表已完成自然语言或画面一致性审查。'))
      contextPreview.textContent = result.text || '本场尚无可自动携带的设定。'
    } catch (error) { checks.append(el('p', 'continuity-error', error.message)); contextPreview.textContent = '' }
  }
  function changed() {
    dirty = true; promptInputFingerprint = ''; promptPreview.value = ''; promptDetails.hidden = true
    signal(''); updateControls(); updateChecks()
  }
  function entities() { return context().storyboard?.continuity?.entities || [] }
  function currentCatalogSignature() { return JSON.stringify(entities().map(item => [item.id, item.name, item.defaultStateId, item.states.map(state => [state.id, state.name])])) }
  function renderBindings(key) {
    const rows = bindingHosts[key]; rows.replaceChildren()
    if (!draft[key].length) rows.append(el('p', 'media-help', '尚未关联；也可以仅填写上方状态描述。'))
    draft[key].forEach((binding, index) => {
      const row = el('div', 'continuity-scope-controls'), entitySelect = el('select'), stateSelect = el('select')
      const name = key === 'entryBindings' ? '进入' : '结束'
      entitySelect.setAttribute('aria-label', `${name}素材 ${index + 1}`); stateSelect.setAttribute('aria-label', `${name}素材状态 ${index + 1}`)
      const available = entities().filter(item => item.id === binding.entityId || !draft[key].some(other => other.entityId === item.id))
      if (!available.some(item => item.id === binding.entityId)) entitySelect.append(option(binding.entityId, '原素材已不存在，请重新选择'))
      for (const entity of available) entitySelect.append(option(entity.id, entity.name))
      entitySelect.value = binding.entityId
      const entity = entities().find(item => item.id === binding.entityId)
      if (!entity?.states?.some(item => item.id === binding.stateId)) stateSelect.append(option(binding.stateId, '原状态已不存在，请重新选择'))
      for (const state of entity?.states || []) stateSelect.append(option(state.id, state.name))
      stateSelect.value = binding.stateId
      entitySelect.addEventListener('change', () => {
        const next = entities().find(item => item.id === entitySelect.value)
        if (!next) return
        binding.entityId = next.id; binding.stateId = next.defaultStateId || next.states[0]?.id || ''
        renderBindings(key); changed()
      })
      stateSelect.addEventListener('change', () => { binding.stateId = stateSelect.value; changed() })
      row.append(entitySelect, stateSelect, button('移除', () => { draft[key].splice(index, 1); renderBindings(key); changed() }))
      rows.append(row)
    })
  }
  function addBinding(key) {
    if (busy || staleReason()) return
    if (draft[key].length >= 128) return signal('每个阶段最多关联 128 个素材状态，请先移除不需要的关联。')
    const entity = entities().find(item => item.states?.length && !draft[key].some(binding => binding.entityId === item.id))
    if (!entity) return signal('没有其他可关联的素材；可先在“人物·场景·物品设定”中建立素材状态。')
    draft[key].push({ entityId: entity.id, stateId: entity.defaultStateId || entity.states[0].id })
    renderBindings(key); changed()
  }
  function load(documentId) {
    const data = context(), source = data.documents?.[documentId]
    if (!source) { notify('请选择一个现有分场。'); return false }
    owner = data.projectId; sourceId = documentId; openedFromDocumentId = documentIdOf(data); baseContent = sceneContentFingerprint(source.content); baseState = signature(source)
    draft = savedState(source); dirty = false
    title.textContent = `分场状态与素材衔接 · ${source.title || '未命名分场'}`
    transition.value = draft.transition
    for (const key of Object.keys(inputs)) inputs[key].value = draft[key]
    for (const key of Object.keys(bindingHosts)) renderBindings(key)
    catalogSignature = currentCatalogSignature(); promptInputFingerprint = ''
    promptPreview.value = ''; promptDetails.hidden = true; signal(''); updateControls(); updateChecks()
    return true
  }
  function confirmDiscard() {
    return !dirty || globalThis.window?.confirm?.('分场状态有未保存修改，放弃这些修改？') === true
  }
  function open(documentId = documentIdOf(context())) {
    if (busy) { notify('分场状态正在保存，请稍后再操作。'); return false }
    if (dialog.open && owner === context().projectId && sourceId === documentId && dirty) { refresh(); return true }
    if (!confirmDiscard()) return false
    if (!load(documentId)) return false
    if (!dialog.open) dialog.showModal()
    inputs.entryState.focus(); return true
  }
  function close() {
    if (busy || !confirmDiscard()) return
    dirty = false; dialog.close()
  }
  function discard() {
    if (busy || !confirmDiscard()) return
    dirty = false
    if (owner === context().projectId && openedFromDocumentId === documentIdOf(context()) && context().documents?.[sourceId]) load(sourceId)
    else dialog.close()
  }
  async function saveDraft() {
    if (busy || !dirty && draft.sourceFingerprint === baseContent) return
    const reason = staleReason()
    if (reason) { signal(reason, true); updateControls(); return }
    busy = true; updateControls()
    try {
      const value = { ...clone(draft), sourceFingerprint: baseContent }
      const saved = await save(sourceId, value, { projectId: owner, contentFingerprint: baseContent })
      if (saved === false) throw new Error('分场状态未保存，草稿已保留。')
      // The owner may have changed during storage. Never replace a different scene's draft.
      dirty = false
      if (context().projectId === owner && context().documents?.[sourceId]) {
        baseState = signature(context().documents[sourceId]); draft = value
        // Saving replaces the draft with a detached snapshot. Rebind the row
        // handlers so later selections edit that snapshot, not the old objects.
        for (const key of Object.keys(bindingHosts)) renderBindings(key)
      }
      signal('分场状态已保存；后续生成会使用当前约束。')
    } catch (error) { signal(`保存失败：${error.message}`, true) }
    finally { busy = false; updateControls(); updateChecks() }
  }
  async function copyPrompt() {
    if (busy) return
    const reason = staleReason()
    if (reason) return signal(reason, true)
    try {
      const data = snapshot(), text = buildSceneVideoPrompt(data)
      promptInputFingerprint = sceneContinuityContext(data).fingerprint
      promptPreview.value = text; promptDetails.hidden = false; promptDetails.open = true
      if (!globalThis.navigator?.clipboard?.writeText) return signal('提示词已整理，请在下方手动复制。')
      await globalThis.navigator.clipboard.writeText(text)
      signal(dirty ? '已复制本场视频提示词，包含当前未保存的状态草稿；其他生成入口需先保存。' : '已复制本场视频提示词。')
    } catch (error) { signal(`未复制：${error.message}`, true) }
  }
  function refresh() {
    if (!dialog.open) return
    const signature = currentCatalogSignature()
    if (!staleReason() && signature !== catalogSignature) {
      catalogSignature = signature
      for (const key of Object.keys(bindingHosts)) renderBindings(key)
    }
    updateControls(); updateChecks()
  }
  return { open, refresh, hasPendingWork: () => busy || dirty }
}
