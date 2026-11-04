import { emptyContinuity, normalizeContinuity, validateContinuity, createEntity, createEntityState, entityStateFingerprint, parseEntityExtraction, mergeEntityExtraction } from './continuity-assets.js'
import { planLegacyContinuityReferences } from './continuity-linking.js'
import { contentFingerprint } from './storyboard.js'

const LABELS = { character: '人物', scene: '场景', prop: '关键物品' }
const ACTIVE = new Set(['queued', 'submitting', 'running', 'downloading'])
const STATUS = { queued: '排队中', submitting: '提交中', running: '生成中', downloading: '下载中', completed: '已完成', failed: '失败', cancelled: '已停止', submission_unknown: '提交结果待确认' }
const copy = value => JSON.parse(JSON.stringify(value))
const revision = context => context.storyboard?.revision || 0
const timestamp = value => /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value)
const dateLabel = value => Number.isFinite(timestamp(value)) ? new Date(timestamp(value)).toLocaleString('zh-CN') : '时间未知'

// Follow the document tree, rather than sorting IDs or scanning unrelated notes.
export function continuityScopes({ documents = {}, structure = {}, currentDocId = '' }) {
  const episodes = [], seen = new Set()
  for (const act of structure.acts || []) for (const id of act.episodeIds || []) {
    if (seen.has(id)) continue
    seen.add(id)
    const scenes = (structure.episodes?.[id]?.sceneIds || []).filter(sceneId => documents[sceneId])
    if (!documents[id] && !scenes.length) continue
    episodes.push({ id, title: documents[id]?.title || '未命名分集', scenes: scenes.map(sceneId => ({ id: sceneId, title: documents[sceneId].title || '未命名分场' })), sourceDocumentIds: scenes.length ? scenes : documents[id] ? [id] : [] })
  }
  const current = episodes.find(item => item.id === currentDocId || item.sourceDocumentIds.includes(currentDocId)) || episodes[0]
  return { episodes, currentEpisodeId: current?.id || '' }
}

export function continuityImageCheckpoint(jobs, projectId, entityId, stateId) {
  const matches = (jobs || []).filter(job => job.projectId === projectId && job.capability === 'image' && !job.restored && job.id && Number.isFinite(timestamp(job.createdAt)) && job.request?.entity?.entityId === entityId && job.request.entity.stateId === stateId)
  matches.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || b.id.localeCompare(a.id))
  return matches[0] ? { jobId: matches[0].id, createdAt: matches[0].createdAt } : null
}

export function continuityReferenceOptions(assets, projectId, kind) {
  return (assets || []).filter(asset => asset.projectId === projectId && asset.kind === 'image' && asset.role === kind).flatMap(asset => (asset.versions || []).filter(version => version.id && version.mimeType?.startsWith('image/')).map(version => ({ asset, version })))
}

export function cloneContinuityState(state, name = '新状态') {
  return createEntityState({ name, description: state?.description || '', sourceDocumentIds: [], basedOnStateId: state?.id || '' })
}

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
function option(value, text) { const node = el('option', '', text); node.value = value; return node }
function field(label, input, help = '') {
  const wrapper = el('label', 'continuity-field'); wrapper.append(el('span', '', label), input)
  if (help) wrapper.append(el('small', 'media-help', help))
  return wrapper
}

export function initializeContinuityUI({ getContext, getAssets = () => [], getJobs = () => [], save, requestExtraction, generateReference, stopExtraction, preview, exportBundle, notify = () => {} }) {
  let owner = '', baseRevision = 0, draft = emptyContinuity(), dirty = false, busy = false, selectedEntityId = '', selectedStateId = '', filter = 'all', scopeEpisodeId = '', scopeSceneId = '', message = '', extraction = null, runtimeSignature = '', baselineExpanded = false
  const candidates = new Map()
  const dialog = el('dialog', 'app-dialog continuity-dialog'); dialog.setAttribute('aria-label', '人物·场景·物品设定')
  const header = el('header', 'continuity-header'), heading = el('div')
  heading.append(el('h2', '', '人物·场景·物品设定'), el('p', 'media-help', '先固定外形，再为服装、昼夜或损坏等变化建立状态。分镜按分场自动关联对应设定图。'))
  const closeButton = button('关闭', close); closeButton.setAttribute('aria-label', '关闭设定面板')
  header.append(heading, closeButton)
  const scopeHost = el('section', 'continuity-scope'), candidateHost = el('section', 'continuity-candidate-host')
  const scopeStatus = el('p', 'media-help')
  const layout = el('div', 'continuity-layout'), sidebar = el('aside', 'continuity-sidebar'), editor = el('section', 'continuity-editor')
  layout.append(sidebar, editor)
  const notice = el('p', 'continuity-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  const footer = el('footer', 'continuity-footer'), draftLabel = el('span', 'media-help')
  const discardButton = button('放弃修改', discard), saveButton = button('保存设定', () => saveDraft(), 'primary-button')
  const exportButton = button('导出全部设定素材包', exportSettings)
  footer.append(draftLabel, exportButton, discardButton, saveButton)
  dialog.append(header, scopeHost, candidateHost, layout, notice, footer)
  document.body.append(dialog)
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })

  const context = () => getContext() || {}
  const entity = () => draft.entities.find(item => item.id === selectedEntityId)
  const state = () => entity()?.states.find(item => item.id === selectedStateId)
  const mismatch = () => owner !== context().projectId
  const blocked = () => busy || mismatch() || !!context().mutationBusy
  const conflict = () => !mismatch() && baseRevision !== revision(context())
  const activeCandidate = () => candidates.get(owner)
  const jobsForState = () => (getJobs() || []).filter(job => job.projectId === owner && job.capability === 'image' && job.request?.entity?.entityId === selectedEntityId && job.request.entity.stateId === selectedStateId).sort((a, b) => (timestamp(b.createdAt) || 0) - (timestamp(a.createdAt) || 0) || b.id.localeCompare(a.id))

  function signal(text, isError = false) {
    message = text; notice.textContent = text; notice.classList.toggle('continuity-error', isError)
    if (isError) notify(text)
  }
  function markDirty() { dirty = true; updateControls() }
  function updateControls() {
    const locked = blocked(), stale = mismatch() || conflict()
    saveButton.disabled = locked || !dirty || stale
    discardButton.disabled = busy || (!dirty && !stale)
    closeButton.disabled = busy
    exportButton.textContent = `导出${filter === 'all' ? '全部设定' : LABELS[filter]}素材包`
    exportButton.disabled = locked || stale || dirty || !exportBundle || !draft.entities.some(item => filter === 'all' || item.kind === filter)
    draftLabel.textContent = mismatch() ? '项目已切换，请放弃旧草稿后载入当前项目' : conflict() && dirty ? '分镜已更新，请放弃草稿后重新编辑，避免覆盖新内容' : dirty ? '有未保存修改' : '设定已保存'
    for (const fieldset of dialog.querySelectorAll('fieldset')) fieldset.disabled = locked || stale
    for (const action of dialog.querySelectorAll('[data-mutation]')) action.disabled = locked || stale || action.dataset.unavailable === 'true'
    const start = scopeHost.querySelector('[data-extract]')
    if (start) start.disabled = locked || !!extraction || !!context().textGenerating || dirty || !scopeIds().length
    const stop = scopeHost.querySelector('[data-stop-extract]')
    if (stop) stop.disabled = busy || !(extraction || context().textGenerating)
    const adopt = candidateHost.querySelector('[data-adopt]')
    if (adopt) adopt.disabled = locked || stale || dirty || !!activeCandidate()?.error
  }
  function loadCurrent() {
    const current = context()
    owner = current.projectId || ''; baseRevision = revision(current)
    draft = normalizeContinuity(current.storyboard?.continuity || emptyContinuity()); dirty = false
    if (!draft.entities.some(item => item.id === selectedEntityId)) selectedEntityId = draft.entities[0]?.id || ''
    if (!entity()?.states.some(item => item.id === selectedStateId)) selectedStateId = entity()?.defaultStateId || entity()?.states[0]?.id || ''
    const scopes = continuityScopes(current)
    if (!scopes.episodes.some(item => item.id === scopeEpisodeId)) scopeEpisodeId = scopes.currentEpisodeId
    if (!scopes.episodes.find(item => item.id === scopeEpisodeId)?.scenes.some(item => item.id === scopeSceneId)) scopeSceneId = ''
  }
  function open(options = {}) {
    if (!dirty && !busy) {
      if (owner !== context().projectId || !dialog.open) { scopeEpisodeId = continuityScopes(context()).currentEpisodeId; scopeSceneId = '' }
      loadCurrent()
    }
    if (options.entityId && draft.entities.some(item => item.id === options.entityId)) selectedEntityId = options.entityId
    if (options.stateId && entity()?.states.some(item => item.id === options.stateId)) selectedStateId = options.stateId
    if (options.baseline) baselineExpanded = true
    if (!entity()?.states.some(item => item.id === selectedStateId)) selectedStateId = entity()?.defaultStateId || entity()?.states[0]?.id || ''
    render()
    if (!dialog.open) dialog.showModal()
    if (options.baseline) scopeHost.querySelector('textarea')?.focus?.()
  }
  function close() {
    if (busy) return
    if (dirty && !window.confirm('设定有未保存修改，放弃这些修改并关闭？')) return
    if (dirty) { dirty = false; loadCurrent() }
    dialog.close()
  }
  function discard() {
    if (busy) return
    if (dirty && !window.confirm('放弃未保存的设定修改？')) return
    loadCurrent(); signal('已载入最新保存的设定。'); render()
  }
  function assertWritable() {
    if (mismatch()) throw new Error('项目已切换，未写入旧项目。请重新打开设定。')
    if (context().mutationBusy) throw new Error('工作台正在保存或切换项目，请稍后重试。')
    if (conflict()) throw new Error('分镜或设定已更新，草稿保留。请放弃草稿后重新编辑。')
  }
  async function saveDraft(requestedOwner = owner) {
    if (busy) return false
    if (!dirty) return true
    try {
      if (requestedOwner !== owner) throw new Error('草稿属于其他项目，请返回对应项目保存。')
      assertWritable(); validateContinuity(draft)
      const projectId = owner, expectedRevision = baseRevision, next = copy(draft)
      const visualChanged = JSON.stringify(context().storyboard?.continuity || emptyContinuity()) !== JSON.stringify(next)
      const existingImages = context().storyboard?.shots.some(shot => shot.selectedImageVersionId)
      busy = true; updateControls()
      await save(next, { projectId, revision: expectedRevision })
      if (context().projectId !== projectId) throw new Error('保存时项目已切换，草稿保留，请重新打开对应项目核对。')
      loadCurrent(); signal(visualChanged && existingImages ? '设定已保存。已有分镜图不会自动重绘；使用本次变更基准或参考的镜头需要重新核对视觉一致性。请到分镜页打开“视觉复核”。' : '设定已保存，分镜会使用对应状态的参考图。'); render()
      return true
    } catch (error) { signal(`设定未保存：${error.message}`, true); return false }
    finally { busy = false; updateControls() }
  }
  async function exportSettings() {
    if (blocked() || conflict() || dirty || !exportBundle) return
    const projectId = owner, kind = filter
    try {
      busy = true; updateControls(); signal('正在整理设定、状态和图片…')
      const path = await exportBundle({ projectId, kind })
      if (context().projectId !== projectId) return
      signal(path ? `已导出：${path}` : '导出未完成，请查看工作台提示后重试。', !path)
    } catch (error) { signal(`导出失败：${error.message}`, true) }
    finally { busy = false; updateControls() }
  }
  function scopeIds() {
    const episode = continuityScopes(context()).episodes.find(item => item.id === scopeEpisodeId)
    const ids = scopeSceneId ? episode?.scenes.some(item => item.id === scopeSceneId) ? [scopeSceneId] : [] : episode?.sourceDocumentIds || []
    return ids.filter(id => context().documents?.[id]?.content?.trim())
  }
  function updateExtractionStatus() {
    if (extraction) {
      const elapsed = Math.max(0, Math.floor((Date.now() - timestamp(extraction.createdAt)) / 1000))
      const duration = `${Math.floor(elapsed / 60)} 分 ${String(elapsed % 60).padStart(2, '0')} 秒`
      scopeStatus.textContent = `正在提取 ${extraction.sourceDocumentIds.length} 份分场内容 · 已用时 ${duration} · CLI 最长等待 10 分钟，可随时停止。完成后先预览再采纳。`
    } else scopeStatus.textContent = continuityScopes(context()).episodes.length ? `将提取 ${scopeIds().length} 份已填写的分场内容。使用工作台文字执行端；设定图使用工作台图片执行端。` : '请先在剧本中建立分集或分场并填写内容，再提取设定。也可以先手动新增。'
  }
  function renderScope() {
    const scopes = continuityScopes(context()), row = el('div', 'continuity-scope-controls')
    const episodeSelect = el('select'); episodeSelect.setAttribute('aria-label', '提取分集')
    for (const item of scopes.episodes) episodeSelect.append(option(item.id, item.title))
    episodeSelect.value = scopeEpisodeId
    episodeSelect.addEventListener('change', () => { scopeEpisodeId = episodeSelect.value; scopeSceneId = ''; renderScope(); updateControls() })
    const sceneSelect = el('select'); sceneSelect.setAttribute('aria-label', '提取分场'); sceneSelect.append(option('', '本集全部分场'))
    for (const item of scopes.episodes.find(item => item.id === scopeEpisodeId)?.scenes || []) sceneSelect.append(option(item.id, item.title))
    sceneSelect.value = scopeSceneId
    sceneSelect.addEventListener('change', () => { scopeSceneId = sceneSelect.value; renderScope(); updateControls() })
    const start = button('AI 提取人物、场景和物品', extract, 'primary-button'); start.dataset.extract = ''
    row.append(field('分集', episodeSelect), field('范围', sceneSelect), start)
    if (extraction) { const stopButton = button('停止提取', stop); stopButton.dataset.stopExtract = ''; row.append(stopButton) }
    const style = el('details', 'continuity-project-style'), fields = el('fieldset', 'continuity-fields')
    style.open = baselineExpanded || !draft.style.trim()
    style.addEventListener('toggle', () => { baselineExpanded = style.open })
    style.append(el('summary', '', `全项目视觉基准${draft.style.trim() ? ' · 已填写' : ' · 待填写'}`))
    const baselineField = inputField('全项目视觉基准', draft.style, 4000, value => { draft.style = value }, true, '固定全项目的画风、色彩、材质和成片质感，例如：写实电影，低饱和冷色，真实皮肤与旧化金属，禁止擅自加入建筑。人物服装、场景昼夜和天气差异请在各对象状态中管理，不把所有分场强制设成同一种光线。修改基准会使旧设定图需要确认，已通过的分镜图也需重新视觉复核。')
    baselineField.querySelector('textarea').placeholder = '填写所有镜头共同遵守的视觉规则；具体人物外形、场景布局和物品结构以已选状态设定图为准。'
    fields.append(baselineField); style.append(fields)
    updateExtractionStatus()
    scopeHost.replaceChildren(row, scopeStatus, style)
  }
  async function extract() {
    if (busy || extraction || context().textGenerating || dirty || blocked()) return
    const sourceDocumentIds = scopeIds()
    if (!sourceDocumentIds.length) return signal('选定范围还没有可提取的剧本内容。', true)
    const projectId = owner
    extraction = { projectId, sourceDocumentIds, sources: sourceDocumentIds.map(id => [id, context().documents[id].content]), createdAt: new Date().toISOString() }
    const submittedExtraction = extraction
    renderScope(); updateControls()
    try {
      const started = await requestExtraction({ sourceDocumentIds })
      if (started === false) throw new Error('文字任务未启动，请检查工作台执行端。')
      if (extraction === submittedExtraction) {
        extraction.started = true
        signal('提取任务已启动，结果会保留供你检查。')
      }
    }
    catch (error) {
      if (extraction !== submittedExtraction) return
      extraction = null; signal(`提取未启动：${error.message}`, true); renderScope(); updateControls()
    }
  }
  async function stop() {
    if (busy) return
    try { busy = true; updateControls(); await stopExtraction(); extraction = null; signal('已停止提取。已生成的候选会保留。') }
    catch (error) { signal(`停止失败：${error.message}`, true) }
    finally { busy = false; renderScope(); updateControls() }
  }
  function receiveCandidate(text, metadata = {}, draftId = '') {
    const candidateOwner = metadata.projectId || extraction?.projectId || owner || context().projectId
    const sourceDocumentIds = metadata.sourceDocumentIds || extraction?.sourceDocumentIds || []
    const candidate = { text, metadata, draftId, sourceDocumentIds, projectId: candidateOwner, createdAt: metadata.createdAt || new Date().toISOString(), sources: extraction?.projectId === candidateOwner ? extraction.sources : null }
    if (extraction?.projectId === candidateOwner) extraction = null
    if (candidateOwner !== context().projectId) return false
    if (!String(text || '').trim()) {
      if (owner === candidateOwner) {
        const hasPrevious = !!String(candidates.get(candidateOwner)?.text || '').trim()
        const result = hasPrevious ? '已有候选保留，可重新提取。' : '本次未生成可用候选，可重新提取。'
        signal(metadata.error ? `提取失败：${String(metadata.error).replace(/[。\s]+$/, '')}。${result}` : result, !!metadata.error)
        renderScope(); updateControls()
      }
      return true
    }
    try { candidate.entities = parseEntityExtraction(text, { documents: context().documents, sourceDocumentIds, existing: context().storyboard?.continuity || emptyContinuity() }) }
    catch (error) { candidate.error = error.message }
    candidates.set(candidateOwner, candidate)
    if (owner === candidateOwner) { renderScope(); renderCandidate(); updateControls() }
    return true
  }
  function renderCandidate() {
    const candidate = activeCandidate()
    if (!candidate) { candidateHost.replaceChildren(); return }
    const card = el('div', 'continuity-candidate'), title = el('div', 'continuity-candidate-heading')
    title.append(el('strong', '', '提取候选'), el('span', 'media-help', `生成于 ${dateLabel(candidate.createdAt)}`))
    card.append(title)
    if (candidate.metadata.error) card.append(el('p', 'continuity-error', `提取未完成：${candidate.metadata.error}。下面保留了已返回的部分内容，请检查后再采纳。`))
    if (candidate.error) card.append(el('p', 'continuity-error', `候选格式暂时无法采纳：${candidate.error}。候选已保留，可重新提取。`))
    else {
      const summary = el('div', 'continuity-extraction-preview')
      for (const item of candidate.entities) {
        const row = el('div', 'continuity-extracted-entity')
        row.append(el('strong', '', `${LABELS[item.kind]} · ${item.name}`), el('p', 'media-help', item.traits || item.description || '暂无外形说明'), el('small', 'media-help', `状态：${item.states.map(version => version.name).join('、')}`)); summary.append(row)
      }
      card.append(el('p', 'media-help', `识别到 ${candidate.entities.length} 项。采纳会合并同名设定，保留已有描述、状态图和手动选择。`), summary)
      const adopt = button('采纳并保存设定', adoptCandidate, 'primary-button'); adopt.dataset.adopt = ''; card.append(adopt)
    }
    candidateHost.replaceChildren(card)
  }
  async function adoptCandidate() {
    const candidate = activeCandidate()
    if (!candidate || candidate.error || dirty || busy) return
    try {
      assertWritable()
      if (candidate.sources?.some(([id, content]) => context().documents?.[id]?.content !== content)) throw new Error('提取后分场内容有修改，请重新提取。原候选已保留。')
      if (candidate.metadata.sourceFingerprints && candidate.sourceDocumentIds.some(id => !context().documents?.[id] || candidate.metadata.sourceFingerprints[id] !== contentFingerprint(context().documents[id].content))) throw new Error('提取后分场内容有修改，请重新提取。原候选已保留。')
      const extracted = parseEntityExtraction(candidate.text, { documents: context().documents, sourceDocumentIds: candidate.sourceDocumentIds, existing: draft })
      const next = mergeEntityExtraction(draft, extracted); validateContinuity(next)
      const projectId = owner, expectedRevision = baseRevision
      busy = true; updateControls()
      await save(next, { projectId, revision: expectedRevision, resolvedCandidateId: candidate.draftId || undefined })
      candidates.delete(projectId)
      if (context().projectId !== projectId) { signal('候选已保存到原项目。'); return }
      loadCurrent(); signal('候选已采纳，接下来可逐项生成设定图。'); render()
    } catch (error) { signal(`未采纳：${error.message}`, true) }
    finally { busy = false; updateControls() }
  }
  function renderSidebar() {
    const kindFilter = el('select'); kindFilter.setAttribute('aria-label', '设定分类')
    kindFilter.append(option('all', `全部设定（${draft.entities.length}）`))
    for (const [kind, label] of Object.entries(LABELS)) kindFilter.append(option(kind, `${label}（${draft.entities.filter(item => item.kind === kind).length}）`))
    kindFilter.value = filter; kindFilter.addEventListener('change', () => { filter = kindFilter.value; renderSidebar(); updateControls() })
    const list = el('div', 'continuity-entity-list')
    for (const item of draft.entities.filter(item => filter === 'all' || item.kind === filter)) {
      const select = button('', () => { selectedEntityId = item.id; selectedStateId = item.defaultStateId || item.states[0]?.id || ''; renderSidebar(); renderEditor(); updateControls() }, 'continuity-entity')
      select.setAttribute('aria-pressed', String(item.id === selectedEntityId))
      select.append(el('strong', '', item.name || '未命名'), el('span', 'media-help', `${LABELS[item.kind]} · ${item.states.length} 个状态`)); list.append(select)
    }
    if (!list.children.length) list.append(el('p', 'media-help', '暂无设定，先提取或手动新增。'))
    const add = el('div', 'continuity-add')
    for (const [kind, label] of Object.entries(LABELS)) { const create = button(`＋${label}`, () => addEntity(kind)); create.dataset.mutation = ''; add.append(create) }
    sidebar.replaceChildren(kindFilter, list, add)
  }
  function addEntity(kind) {
    if (blocked() || conflict()) return
    const prefix = `新${LABELS[kind]}`; let name = prefix, number = 2
    while (draft.entities.some(item => item.kind === kind && [item.name, ...item.aliases].includes(name))) name = `${prefix} ${number++}`
    const next = createEntity({ kind, name, sourceDocumentIds: scopeIds() })
    draft.entities.push(next); selectedEntityId = next.id; selectedStateId = next.defaultStateId || next.states[0]?.id || ''; filter = 'all'; dirty = true; renderSidebar(); renderEditor(); updateControls()
  }
  function inputField(label, value, maxLength, change, multiline = false, help = '') {
    const input = el(multiline ? 'textarea' : 'input'); input.value = value || ''; input.maxLength = maxLength
    if (multiline) input.rows = 3
    input.addEventListener('input', () => { change(input.value); markDirty() })
    input.addEventListener('change', () => { renderSidebar(); renderRuntime(); updateControls() })
    return field(label, input, help)
  }
  function renderEditor() {
    const item = entity(), currentState = state()
    if (!item) { editor.replaceChildren(el('div', 'continuity-empty', '提取剧本中的人物、场景和关键物品，再固定每个状态的外形与参考图。')); return }
    const settings = el('fieldset', 'continuity-fields'); settings.append(el('legend', '', `${LABELS[item.kind]}设定`))
    settings.append(inputField('名称', item.name, 80, value => { item.name = value }), inputField('别名', item.aliases.join('、'), 4049, value => { item.aliases = value.split(/[、,，\n]/).map(part => part.trim()).filter(Boolean) }, false, '多个别名用顿号或逗号分隔，用于识别分镜中的同一对象。'), inputField('固定外形特征', item.traits, 12000, value => { item.traits = value }, true, '写清材质、结构、形状、颜色和比例。例如：平整木板筏面，禁止改成裸露圆木。'), inputField('设定说明', item.description, 12000, value => { item.description = value }, true))
    const stateRow = el('div', 'continuity-state-toolbar'), select = el('select'); select.setAttribute('aria-label', '状态版本')
    for (const version of item.states) select.append(option(version.id, `${version.name}${version.id === item.defaultStateId ? '（默认）' : ''}`))
    select.value = selectedStateId; select.addEventListener('change', () => { selectedStateId = select.value; renderEditor(); updateControls() })
    const add = button('新增状态', () => {
      if (blocked() || conflict()) return
      let name = '新状态', number = 2
      while (item.states.some(version => version.name === name)) name = `新状态 ${number++}`
      const next = cloneContinuityState(state(), name); item.states.push(next); selectedStateId = next.id; markDirty(); renderSidebar(); renderEditor(); updateControls()
    }); add.dataset.mutation = ''; stateRow.append(field('状态版本', select), add)
    settings.append(stateRow)
    if (currentState) {
      settings.append(inputField('状态名称', currentState.name, 80, value => { currentState.name = value }), inputField('状态差异', currentState.description, 12000, value => { currentState.description = value }, true, '只描述相对固定外形的变化，如破损程度、服装、天气。新状态不会沿用旧状态的参考图。'))
      if (currentState.basedOnStateId) settings.append(el('p', 'media-help', `延续自：${item.states.find(version => version.id === currentState.basedOnStateId)?.name || '原状态'}。生成时保持主体结构与材质一致。`))
      const defaultInput = el('input'); defaultInput.type = 'checkbox'; defaultInput.checked = item.defaultStateId === currentState.id
      defaultInput.addEventListener('change', () => { if (defaultInput.checked) item.defaultStateId = currentState.id; else defaultInput.checked = true; markDirty(); renderEditor(); updateControls() })
      const defaultLabel = el('label', 'continuity-check'); defaultLabel.append(defaultInput, el('span', '', '作为默认状态（没有指定其他状态的分场使用此状态）')); settings.append(defaultLabel)
      const scopes = continuityScopes(context()), appearance = el('details', 'continuity-appearances'); appearance.open = currentState.sourceDocumentIds.length > 0
      appearance.append(el('summary', '', `适用分场 · 已选 ${currentState.sourceDocumentIds.length} 场`), el('p', 'media-help', '同一分场只能指定一个非默认状态。默认状态仍适用于其他分场。'))
      for (const episode of scopes.episodes) {
        const group = el('div', 'continuity-scene-group'); group.append(el('strong', '', episode.title))
        const choices = episode.scenes.length ? episode.scenes : [{ id: episode.id, title: episode.title }]
        for (const scene of choices) {
          const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = currentState.sourceDocumentIds.includes(scene.id)
          const occupied = item.states.find(version => version.id !== currentState.id && version.id !== item.defaultStateId && version.sourceDocumentIds.includes(scene.id))
          checkbox.disabled = !!occupied && currentState.id !== item.defaultStateId && !checkbox.checked
          checkbox.addEventListener('change', () => {
            currentState.sourceDocumentIds = checkbox.checked ? [...new Set([...currentState.sourceDocumentIds, scene.id])] : currentState.sourceDocumentIds.filter(id => id !== scene.id)
            if (checkbox.checked && !item.sourceDocumentIds.includes(scene.id)) item.sourceDocumentIds.push(scene.id)
            markDirty()
          })
          const label = el('label', 'continuity-check'); label.append(checkbox, el('span', '', `${scene.title}${occupied && currentState.id !== item.defaultStateId ? `（已用：${occupied.name}）` : ''}`)); group.append(label)
        }
        appearance.append(group)
      }
      settings.append(appearance)
    }
    const runtime = el('section', 'continuity-runtime'); runtime.dataset.runtime = ''
    editor.replaceChildren(settings, runtime); runtimeSignature = ''; renderRuntime()
  }
  function renderRuntime() {
    const host = editor.querySelector('[data-runtime]'), item = entity(), currentState = state()
    if (!host || !item || !currentState) return
    const choices = continuityReferenceOptions(getAssets(), owner, item.kind), jobs = jobsForState(), fingerprint = entityStateFingerprint(item, currentState, draft.style)
    const signature = JSON.stringify([item.id, currentState.id, currentState.referenceVersionId, currentState.referenceFingerprint, fingerprint, choices.map(({ version }) => version.id), jobs.map(job => [job.id, job.status, job.progress, job.error])])
    if (signature === runtimeSignature) return
    runtimeSignature = signature
    const nodes = [el('h3', '', '状态参考图')], current = choices.find(({ version }) => version.id === currentState.referenceVersionId)
    if (currentState.referenceVersionId && !current) nodes.push(el('p', 'continuity-error', '当前参考图已缺失或类型不匹配，请重新选择或生成。'))
    else if (!currentState.referenceVersionId) nodes.push(el('p', 'media-help', '还没有参考图。生成或选择后会自动关联到使用此状态的分镜。'))
    else if (currentState.referenceFingerprint !== fingerprint) nodes.push(el('p', 'continuity-error', '设定已修改，当前图片对应旧定义。请重新生成，或确认仍适用后重新选用。'))
    if (current && preview) { const image = preview(current.version.id); if (image) { const figure = el('div', 'continuity-reference-preview'); figure.append(image); nodes.push(figure) } }
    for (const issue of planLegacyContinuityReferences(draft, getAssets(), owner).issues.filter(issue => issue.entityId === item.id && issue.stateId === currentState.id)) nodes.push(el('p', 'continuity-error', issue.message))
    const select = el('select'); select.setAttribute('aria-label', '状态参考图片版本'); select.append(option('', '选择已有同类图片…'))
    for (const { asset, version } of choices) select.append(option(version.id, `${asset.name || LABELS[item.kind]} · ${version.name || '版本'} · ${dateLabel(version.createdAt)}`))
    select.value = currentState.referenceVersionId
    const choose = button('选用此图', () => {
      if (blocked() || conflict() || !select.value) return
      delete currentState.legacyReferenceOptOut
      currentState.referenceVersionId = select.value; currentState.referenceFingerprint = entityStateFingerprint(item, currentState, draft.style)
      const checkpoint = continuityImageCheckpoint(getJobs(), owner, item.id, currentState.id)
      if (checkpoint) currentState.imageResultCheckpoint = checkpoint
      markDirty(); renderRuntime(); updateControls()
    }); choose.dataset.mutation = ''; choose.dataset.unavailable = String(!choices.length)
    const clear = button('清除选图', () => {
      if (blocked() || conflict()) return
      currentState.referenceVersionId = ''; currentState.referenceFingerprint = ''; currentState.legacyReferenceOptOut = true
      const checkpoint = continuityImageCheckpoint(getJobs(), owner, item.id, currentState.id)
      if (checkpoint) currentState.imageResultCheckpoint = checkpoint
      markDirty(); renderRuntime(); updateControls()
    }); clear.dataset.mutation = ''; clear.dataset.unavailable = String(!currentState.referenceVersionId)
    const row = el('div', 'continuity-reference-picker'); row.append(field('已有图片版本', select), choose, clear); nodes.push(row)
    const generate = button('生成此状态设定图', generateImage, 'primary-button'); generate.dataset.mutation = ''; generate.dataset.unavailable = String(jobs.some(job => ACTIVE.has(job.status)))
    nodes.push(generate, el('p', 'media-help', '生成前会保存当前设定。新图完成后自动关联；旧图会保留，可随时重新选用。'))
    for (const job of jobs.slice(0, 4)) {
      const status = el('div', 'continuity-job'); status.setAttribute('role', 'status')
      const progress = typeof job.progress === 'number' && job.progress >= 0 && job.progress <= 100 ? ` · ${Math.round(job.progress)}%` : ''
      status.append(el('strong', '', `${STATUS[job.status] || job.status}${progress}`), el('span', 'media-help', dateLabel(job.createdAt)))
      if (job.status === 'failed' && job.error) status.append(el('p', 'continuity-error', typeof job.error === 'string' ? job.error : '生成失败，请查看任务中心。'))
      nodes.push(status)
    }
    host.replaceChildren(...nodes)
  }
  async function generateImage() {
    if (blocked() || jobsForState().some(job => ACTIVE.has(job.status))) return
    const entityId = selectedEntityId, stateId = selectedStateId, projectId = owner
    if (dirty && !await saveDraft()) return
    try {
      assertWritable()
      if (owner !== projectId || context().projectId !== projectId) throw new Error('项目已切换，请重新选择设定。')
      busy = true; updateControls()
      await generateReference(entityId, stateId)
      signal('设定图任务已提交，完成后自动关联此状态与分镜。'); renderRuntime()
    } catch (error) { signal(`未生成设定图：${error.message}`, true) }
    finally { busy = false; updateControls() }
  }
  function render() {
    renderScope(); renderCandidate(); renderSidebar(); renderEditor(); updateControls()
    notice.textContent = message
  }
  function refresh() {
    // Task cleanup must also run while the panel is closed.
    if (extraction && context().textGenerating === false && extraction.started) extraction = null
    if (extraction && context().textGenerating) extraction.started = true
    if (!dialog.open) return
    if (!dirty && !busy && !mismatch()) {
      const current = normalizeContinuity(context().storyboard?.continuity || emptyContinuity())
      if (JSON.stringify(current) !== JSON.stringify(draft)) { loadCurrent(); renderSidebar(); renderEditor() }
      else baseRevision = revision(context())
    }
    // Avoid replacing a focused style field or scope control during polling.
    if (!scopeHost.contains(document.activeElement)) renderScope()
    else updateExtractionStatus()
    renderRuntime(); updateControls()
  }
  function clearCandidate(id) {
    for (const [projectId, candidate] of candidates) if (!id || candidate.draftId === id) candidates.delete(projectId)
    renderCandidate(); updateControls()
  }
  function discardDraft(requestedOwner = owner) {
    if (busy || requestedOwner !== owner) return false
    loadCurrent(); render(); return true
  }
  return { open, refresh, receiveCandidate, clearCandidate, hasPendingWork: () => busy || !!extraction, hasDrafts: () => dirty, pendingDraft: requestedOwner => dirty && (!requestedOwner || requestedOwner === owner) ? { projectId: owner, entityId: selectedEntityId, stateId: selectedStateId, kind: 'continuity' } : null, discardDraft, saveDraft, showDraft: () => { open(); return true } }
}
