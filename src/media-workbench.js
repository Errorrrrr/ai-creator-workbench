import { ASSET_ROLES, JOB_STATUSES, SHOT_LIMIT, contentFingerprint, createShot, findMediaVersion, mediaPrompt, parseStoryboardCandidate, resolveConnectionRoute, shotIsStale, storyboardPrompt, supportsCapability } from './storyboard.js'
import { mediaAdapterFor, useMediaAdapterCatalog } from './media-adapters.js'

const $ = selector => document.querySelector(selector)
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  node.className = className
  if (text) node.textContent = text
  return node
}
function button(text, action, className = 'secondary-button compact-button') {
  const node = el('button', className, text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}
function field(label, input) {
  const node = el('label', 'media-field')
  node.append(el('span', '', label), input)
  return node
}
const terminal = status => ['completed', 'failed', 'cancelled', 'submission_unknown'].includes(status)
const BATCH_LIMIT = 20

export function initializeMediaWorkbench({ getContext, commit, invoke, secret, requestText, notify, navigate, importPackage, portableProject, beforeSubmit, getSavedCandidate, onCandidateChange, onCandidateResolved }) {
  let assets = [], jobs = [], recoveryIssues = [], projectId = null, selectedShotId = null, selectedAssetId = null
  let loading = false, error = '', requestSequence = 0, candidate = null, selectedSourceId = ''
  let operationBusy = false
  let shotResourceStatus = null
  let draggingShotId = null
  let batchPlan = null, batchSelection = new Set()
  let adapterCatalogReady = false
  const adapterCatalogPromise = loadAdapterCatalog()
  const batchDialog = $('#mediaBatchDialog'), batchCapability = $('#mediaBatchCapability'), batchShots = $('#mediaBatchShots')
  const batchConnection = $('#mediaBatchConnection'), batchStatus = $('#mediaBatchStatus'), batchPreview = $('#mediaBatchPreview'), batchConfirm = $('#mediaBatchConfirm')
  batchDialog.querySelectorAll('[data-media-batch-close]').forEach(node => node.addEventListener('click', () => batchDialog.close()))
  batchCapability.addEventListener('change', () => { invalidateBatchPlan(); renderBatchConnection() })
  batchDialog.querySelector('[data-media-batch-preview]').addEventListener('click', previewBatchPlan)
  batchConfirm.addEventListener('click', submitBatchPlan)
  batchDialog.querySelector('[data-media-batch-select]').addEventListener('click', () => { batchSelection = new Set(context().storyboard.shots.slice(0, BATCH_LIMIT).map(shot => shot.id)); renderBatchSelection(); invalidateBatchPlan() })
  batchDialog.querySelector('[data-media-batch-clear]').addEventListener('click', () => { batchSelection.clear(); renderBatchSelection(); invalidateBatchPlan() })
  const storyboardView = $('#storyboardView'), assetsView = $('#assetsView'), jobsDialog = $('#mediaJobsDialog')
  const sourceSelect = el('select'), presetSelect = el('select')
  sourceSelect.setAttribute('aria-label', '拆镜来源文档')
  sourceSelect.addEventListener('change', () => { selectedSourceId = sourceSelect.value })
  for (const [value, text] of [['text', '文字创作'], ['script', '剧本创作'], ['storyboard', '分镜制作']]) presetSelect.append(new Option(text, value))
  presetSelect.addEventListener('change', () => updateWorkflow({ preset: presetSelect.value }))
  const endpointSelectors = new Map()
  const workflow = $('#projectWorkflow')
  workflow.append(field('创作路径', presetSelect))
  for (const [step, label] of [['text', '文字'], ['storyboard', '拆镜'], ['image', '图片'], ['video', '视频']]) {
    const select = el('select')
    select.setAttribute('aria-label', `${label}执行端`)
    select.addEventListener('change', () => updateWorkflow({ [`${step}ConnectionId`]: select.value }))
    endpointSelectors.set(step, select)
    workflow.append(field(`${label}执行端`, select))
  }
  workflow.append(el('p', 'media-help', '步骤可以跳过或回退；切换执行端不会清空内容或发起生成。图片、视频使用所选资源的真实能力。'))

  const shotActions = el('div', 'media-toolbar')
  shotActions.append(field('拆镜来源', sourceSelect), button('AI 拆镜', generateStoryboard, 'primary-button'), button('新建镜头', addShot), button('批量生成计划', () => openBatchPlan()), button('任务中心', showJobs))
  storyboardView.querySelector('.media-view-content').append(shotActions)
  const shotStatus = el('p', 'media-notice'), candidateHost = el('section', 'storyboard-candidate'), shotBody = el('div', 'storyboard-body')
  shotStatus.setAttribute('role', 'status')
  candidateHost.hidden = true
  const shotList = el('div', 'shot-list'), shotDetail = el('section', 'shot-detail')
  shotDetail.setAttribute('aria-label', '镜头详情')
  shotBody.append(shotList, shotDetail)
  storyboardView.querySelector('.media-view-content').append(shotStatus, candidateHost, shotBody)

  const assetToolbar = el('div', 'media-toolbar')
  const roleFilter = el('select')
  roleFilter.setAttribute('aria-label', '筛选素材用途')
  roleFilter.append(new Option('全部素材', ''))
  Object.entries(ASSET_ROLES).forEach(([value, text]) => roleFilter.append(new Option(text, value)))
  roleFilter.addEventListener('change', renderAssets)
  assetToolbar.append(field('素材用途', roleFilter), button('导入图片／视频', chooseImport, 'primary-button'), button('导出完整项目包', exportPackage), button('导入项目包', restorePackage), button('恢复待完成导入', showPendingImports), button('任务中心', showJobs))
  const pendingHost = el('section', 'media-pending-imports'); pendingHost.hidden = true
  const assetNotice = el('p', 'media-notice'), assetGrid = el('div', 'asset-grid'), assetDetail = el('section', 'asset-detail')
  assetNotice.setAttribute('role', 'status')
  assetsView.querySelector('.media-view-content').append(assetToolbar, pendingHost, assetNotice, assetGrid, assetDetail)
  const jobsList = jobsDialog.querySelector('.media-jobs-list')
  jobsDialog.querySelector('[data-media-refresh]').addEventListener('click', () => refresh())
  jobsDialog.querySelector('[data-media-close]').addEventListener('click', () => jobsDialog.close())

  function context() { return getContext() }
  async function loadAdapterCatalog() {
    const status = $('#mediaAdapterStatus'), list = $('#mediaAdapterList')
    if (!invoke) { status.textContent = '浏览器仅展示配置；实际协议目录与生成需在桌面版使用。'; return }
    try {
      const descriptors = useMediaAdapterCatalog(await invoke('media_adapter_catalog'))
      adapterCatalogReady = true
      status.textContent = `${descriptors.length} 个已实现适配器 · 不代表账号、额度或真实生成已验证；取消仅停止本地等待。`
      list.replaceChildren(...descriptors.map(adapter => {
        const item = el('div', 'media-notice')
        item.append(el('strong', '', `${adapter.name} · ${adapter.transport.toUpperCase()} · ${adapter.capability === 'image' ? '图片' : '视频'}`), el('p', 'media-help', `模式：${adapter.modes.join(' / ')}；远端查询：${adapter.remoteQuery ? '支持既有任务' : '不支持'}；远端取消：${adapter.remoteCancel ? '支持' : '不支持'}。${adapter.parameterNotes}`))
        return item
      }))
      renderEndpoints()
    } catch (problem) { status.textContent = `协议目录读取失败：${String(problem?.message || problem)}；媒体提交已停用。` }
  }
  function selectedShot() { return context().storyboard.shots.find(shot => shot.id === selectedShotId) }
  function connectionFor(step) {
    return resolveConnectionRoute(context(), step).connection
  }
  function fileUrl(version) {
    return window.__TAURI__?.core?.convertFileSrc?.(version.fileId, 'workbench-media') || ''
  }
  function preview(version, name) {
    if (!version) return el('div', 'media-placeholder', '尚未选择素材')
    const url = fileUrl(version)
    if (!url) return el('div', 'media-placeholder', '请在桌面版预览本地媒体')
    const video = version.mimeType?.startsWith('video/')
    const node = el(video ? 'video' : 'img', 'media-preview')
    node.src = url
    if (video) { node.controls = true; node.preload = 'metadata'; node.setAttribute('aria-label', name) }
    else { node.alt = name; node.loading = 'lazy' }
    node.addEventListener('error', () => { node.replaceWith(el('div', 'media-placeholder', '媒体无法读取，请检查本地文件或恢复完整项目包')) }, { once: true })
    return node
  }
  async function run(action) {
    if (operationBusy) return notify('上一操作尚未完成，请稍候')
    operationBusy = true
    const controls = [...document.querySelectorAll('#storyboardView button, #assetsView button, #mediaJobsDialog button, #mediaBatchDialog button')].filter(node => !node.disabled && !node.hasAttribute('data-media-close') && !node.hasAttribute('data-media-batch-close'))
    controls.forEach(node => { node.disabled = true })
    storyboardView.setAttribute('aria-busy', 'true'); assetsView.setAttribute('aria-busy', 'true')
    try { return await action() }
    catch (problem) { notify(String(problem?.message || problem)) }
    finally { operationBusy = false; controls.forEach(node => { if (node.isConnected) node.disabled = false }); updateBatchConfirmation(); storyboardView.removeAttribute('aria-busy'); assetsView.removeAttribute('aria-busy') }
  }
  function desktop() { if (!invoke) throw new Error('媒体文件、CLI 生成与项目包请在桌面版使用；分镜和文字仍可编辑') }
  async function requireAdapterCatalog() {
    await adapterCatalogPromise
    if (!adapterCatalogReady) throw new Error('媒体协议目录尚未就绪；未提交生成，请重新打开桌面应用')
  }
  function requireProject() { if (!context().projectId) throw new Error('请先创建或打开项目') }
  async function changeStoryboard(transform, { immediate = true, resolvedCandidateId = null } = {}) {
    const data = context(), next = structuredClone(data.storyboard)
    transform(next.shots)
    next.revision += 1
    await commit({ storyboard: next }, { projectId: data.projectId, revision: data.storyboard.revision, immediate, ...(resolvedCandidateId ? { resolvedCandidateId } : {}) })
  }
  async function updateWorkflow(patch) {
    try {
      const data = context()
      await commit({ workflow: { ...data.workflow, ...patch } }, { projectId: data.projectId })
      renderEndpoints()
    } catch (problem) { notify(String(problem?.message || problem)) }
  }
  function renderEndpoints() {
    const data = context()
    presetSelect.value = data.workflow.preset
    workflow.querySelectorAll('select').forEach(select => { select.disabled = !data.projectId })
    for (const [step, select] of endpointSelectors) {
      const selected = data.workflow[`${step}ConnectionId`]
      const inherited = resolveConnectionRoute({ ...data, workflow: { ...data.workflow, [`${step}ConnectionId`]: '' } }, step)
      const inheritLabel = step === 'storyboard' ? '沿用项目文字／全局默认' : `沿用全局${{ text: '文字', image: '图片', video: '视频' }[step]}默认`
      select.replaceChildren(new Option(`${inheritLabel} · ${inherited.connection?.name || inherited.error}`, ''))
      for (const connection of data.connections.filter(item => supportsCapability(item, step))) {
        const suffix = connection.kind === 'cli' ? ' · CLI' : ''
        const verification = ['image', 'video'].includes(step) ? ' · 能力待实测' : ''
        select.append(new Option(`${connection.name}${suffix}${verification}`, connection.id))
      }
      if (selected && ![...select.options].some(option => option.value === selected)) select.append(new Option('原执行端不可用 · 请选择', selected))
      select.value = selected
    }
    renderBatchConnection()
    renderShotResourceStatus()
    if (batchPlan && !batchPlan.attempted) {
      try { assertBatchPlan(batchPlan) }
      catch { invalidateBatchPlan('镜头输入或执行端已变化，请重新预览；未提交生成') }
    }
  }
  function renderShotResourceStatus() {
    if (!shotResourceStatus?.isConnected) return
    const data = context(), image = resolveConnectionRoute(data, 'image'), video = resolveConnectionRoute(data, 'video')
    const constraints = []
    const videoAdapter = mediaAdapterFor(video.connection, 'video')
    if (videoAdapter?.parameterNotes) constraints.push(videoAdapter.parameterNotes)
    if (image.connection?.kind === 'cli') constraints.push('CLI 的画幅／质量是创作要求，是否遵循需检查产物，不冒充 API 参数。')
    shotResourceStatus.textContent = `图片：${image.connection?.name || image.error}；视频：${video.connection?.name || video.error}。${constraints.length ? ` ${constraints.join(' ')}` : ''}`
  }
  function renderSources() {
    const data = context(), documents = Object.entries(data.documents)
    selectedSourceId = data.documents[selectedSourceId] ? selectedSourceId : data.currentDocId || documents[0]?.[0] || ''
    sourceSelect.replaceChildren(...documents.map(([id, doc]) => new Option(doc.title, id)))
    sourceSelect.value = selectedSourceId
  }
  function renderShots({ detail = true } = {}) {
    const data = context(), shots = data.storyboard.shots
    shotBody.classList.toggle('is-empty', !shots.length)
    shotStatus.textContent = !data.projectId ? '创建项目后即可从空白镜头或已有剧本开始。' : `${shots.length} 个镜头 · r${data.storyboard.revision} · 生成结果先进入候选，不自动替换选用素材。`
    shotList.replaceChildren()
    if (!shots.length) {
      const empty = el('div', 'media-empty')
      empty.append(el('h2', '', '把故事变成镜头'), el('p', '', '先选择一份已写好的文档让 AI 拆镜，或手动创建第一个镜头。不会自动填充示例内容。'), button('新建第一个镜头', addShot))
      shotList.append(empty)
    }
    if (!shots.some(shot => shot.id === selectedShotId)) selectedShotId = shots[0]?.id || null
    shots.forEach((shot, index) => {
      const card = el('article', `shot-card${shot.id === selectedShotId ? ' is-selected' : ''}`)
      const select = button(`${String(index + 1).padStart(2, '0')}  ${shot.title}`, () => { selectedShotId = shot.id; renderShots() }, 'shot-select')
      select.setAttribute('aria-pressed', String(shot.id === selectedShotId))
      const chosen = findMediaVersion(assets, shot.selectedImageVersionId)
      if (chosen) select.prepend(preview(chosen.version, shot.title))
      card.append(select, el('p', '', shot.visual || '补充画面、人物与构图'))
      const meta = el('div', 'shot-meta')
      meta.append(el('span', '', `${shot.duration}s · ${shot.transition === 'continuous' ? '连续动作' : '切换机位'}`))
      if (shotIsStale(shot, data.documents)) meta.append(el('span', 'media-warning', '剧本来源已更新'))
      if (shot.references.some(ref => { const found = findMediaVersion(assets, ref.versionId); return found && found.asset.selectedVersionId !== ref.versionId })) meta.append(el('span', 'media-warning', '参考有新选用版本 · 原引用保留'))
      const actions = el('div', 'shot-order-actions')
      const up = button('上移', () => reorder(shot.id, -1)); up.disabled = index === 0
      const down = button('下移', () => reorder(shot.id, 1)); down.disabled = index === shots.length - 1
      actions.append(up, down)
      const drag = button('拖动排序', () => notify('拖动此按钮可排序；也可使用上移、下移按钮'), 'text-button compact-button')
      drag.draggable = true
      drag.addEventListener('dragstart', event => { draggingShotId = shot.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', shot.id) })
      drag.addEventListener('dragend', () => { draggingShotId = null })
      card.addEventListener('dragover', event => { if (draggingShotId && draggingShotId !== shot.id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } })
      card.addEventListener('drop', event => {
        event.preventDefault()
        const moving = draggingShotId; draggingShotId = null
        if (!moving || moving === shot.id) return
        run(async () => { await changeStoryboard(list => { const from = list.findIndex(item => item.id === moving), to = list.findIndex(item => item.id === shot.id); if (from < 0 || to < 0) throw new Error('排序来源已变化'); const [item] = list.splice(from, 1); list.splice(to, 0, item) }); renderShots() })
      })
      actions.append(drag)
      card.append(meta, actions)
      shotList.append(card)
    })
    if (detail) renderShotDetail()
  }
  async function addShot() {
    await run(async () => {
      requireProject()
      if (context().storyboard.shots.length >= SHOT_LIMIT) throw new Error(`最多 ${SHOT_LIMIT} 个镜头`)
      const shot = createShot({ title: `镜头 ${context().storyboard.shots.length + 1}` })
      await changeStoryboard(shots => shots.push(shot)); selectedShotId = shot.id; renderShots()
    })
  }
  async function reorder(id, direction) {
    await run(async () => {
      await changeStoryboard(shots => { const from = shots.findIndex(shot => shot.id === id), to = from + direction; if (from >= 0 && to >= 0 && to < shots.length) [shots[from], shots[to]] = [shots[to], shots[from]] })
      renderShots()
    })
  }
  function editShot(id, patch) {
    return changeStoryboard(shots => {
      const shot = shots.find(item => item.id === id)
      if (!shot) throw new Error('镜头已不存在')
      const videoChanged = Object.hasOwn(patch, 'selectedVideoVersionId') && patch.selectedVideoVersionId !== shot.selectedVideoVersionId
      Object.assign(shot, patch)
      if (videoChanged) shot.reviewedVideoVersionId = ''
    }, { immediate: false }).then(() => renderShots({ detail: false })).catch(problem => notify(String(problem?.message || problem)))
  }
  function renderShotDetail() {
    shotDetail.replaceChildren()
    const shot = selectedShot()
    if (!shot) return
    shotDetail.append(el('h2', '', '镜头详情'), el('p', 'media-help', '输入自动保存。参考固定到具体版本；更新角色素材不会悄悄替换此镜头。'))
    if (shotIsStale(shot, context().documents)) shotDetail.append(el('p', 'media-warning', '剧本来源已变更。请核对本镜头，或重新拆镜；现有素材与状态仍保留。'))
    const fields = el('div', 'shot-fields')
    for (const [key, label, multiline] of [['title', '标题', false], ['visual', '画面与构图', true], ['action', '主要动作', true], ['dialogue', '对白', true], ['camera', '景别与运镜', true], ['entryState', '进入状态 · 人物、服装、位置、道具', true], ['exitState', '结束状态', true]]) {
      const input = el(multiline ? 'textarea' : 'input'); input.value = shot[key]; input.maxLength = key === 'title' ? 200 : 12000
      if (multiline) input.rows = 2
      input.addEventListener('input', () => editShot(shot.id, { [key]: input.value }))
      fields.append(field(label, input))
    }
    const duration = el('input'); duration.type = 'number'; duration.min = '1'; duration.max = '60'; duration.value = shot.duration
    duration.addEventListener('change', () => { if (duration.reportValidity()) editShot(shot.id, { duration: Number(duration.value) }) })
    const transition = el('select'); transition.append(new Option('切换机位／景别', 'cut'), new Option('连续动作', 'continuous')); transition.value = shot.transition
    transition.addEventListener('change', () => editShot(shot.id, { transition: transition.value }))
    fields.append(field('目标时长（以执行端实际支持为准）', duration), field('与上一镜头的关系', transition))
    shotDetail.append(fields, el('h3', '', '固定参考与输入画面'))
    const references = el('div', 'shot-references')
    for (const ref of shot.references) {
      const found = findMediaVersion(assets, ref.versionId), row = el('div', 'shot-reference-row')
      row.append(el('span', '', `${{ reference: '主体参考', start: '起始帧', end: '结束帧', extend: '续接视频' }[ref.role]} · ${found?.asset.name || '文件未找到'} · ${ref.versionId.slice(-8)}`), button('移除', () => editShot(shot.id, { references: selectedShot().references.filter(item => item !== ref && !(item.versionId === ref.versionId && item.role === ref.role)) }).then(renderShotDetail)))
      references.append(row)
    }
    const referenceSelect = el('select'), referenceRole = el('select')
    referenceSelect.setAttribute('aria-label', '参考媒体版本'); referenceRole.setAttribute('aria-label', '参考用途')
    referenceSelect.append(new Option('选择已导入／生成的版本', ''))
    for (const asset of assets) for (const version of asset.versions || []) referenceSelect.append(new Option(`${ASSET_ROLES[asset.role] || '素材'} · ${asset.name} · ${version.id.slice(-8)}`, version.id))
    for (const [value, label] of [['reference', '主体参考'], ['start', '起始帧'], ['end', '结束帧'], ['extend', '续接视频']]) referenceRole.append(new Option(label, value))
    references.append(referenceSelect, referenceRole, button('添加参考', async () => {
      const versionId = referenceSelect.value, role = referenceRole.value, current = selectedShot()
      if (!versionId) return notify('请先选择一个媒体版本')
      if (current.references.some(ref => ref.versionId === versionId && ref.role === role)) return notify('这个版本已作为该用途引用')
      if (current.references.length >= 16) return notify('单镜头最多 16 项参考，实际接口可能支持更少')
      await editShot(shot.id, { references: [...current.references, { versionId, role }] }); renderShotDetail()
    }))
    shotDetail.append(references)
    const settings = el('div', 'shot-fields')
    for (const [key, label, choices, fallback] of [
      ['aspectRatio', '生成画幅', [['16:9', '横屏 16:9'], ['9:16', '竖屏 9:16'], ['1:1', '方形 1:1（图片）']], '16:9'],
      ['imageSize', '图片 API 尺寸', [['auto', '由资源自动选择'], ['1024x1024', '1024 × 1024'], ['1536x1024', '1536 × 1024'], ['1024x1536', '1024 × 1536']], 'auto'],
      ['imageQuality', '图片质量', [['auto', '自动'], ['low', '低'], ['medium', '中'], ['high', '高']], 'auto'],
      ['videoMode', '视频输入模式', [['image-to-video', '选用分镜图 → 视频'], ['reference-to-video', '主体参考图 → 视频（8 秒）'], ['first-last', '首尾帧 → 视频'], ['extend', '原生视频续接（8 秒）']], 'image-to-video']
    ]) {
      const select = el('select'); for (const [value, text] of choices) select.append(new Option(text, value)); select.value = shot[key] || fallback
      select.addEventListener('change', async () => { await editShot(shot.id, { [key]: select.value }); renderShotDetail() }); settings.append(field(label, select))
    }
    shotResourceStatus = el('p', 'media-help')
    shotResourceStatus.setAttribute('role', 'status')
    shotDetail.append(el('h3', '', '生成参数'), settings, shotResourceStatus)
    renderShotResourceStatus()
    shotDetail.append(el('p', 'media-notice', `${({ 'image-to-video': '本次视频只上传起始帧（优先显式指定，否则使用选用分镜图）。主体参考应先融入分镜图。', 'reference-to-video': '本次上传标记为“主体参考”的图片（最多 3 张，8 秒），不混用首尾帧或续接视频。', 'first-last': '本次上传起始帧和结束帧。起始帧未指定时使用选用分镜图，不混用主体参考和续接视频。', extend: '本次上传标记为“续接视频”的同执行端原生 Veo 视频。' })[shot.videoMode || 'image-to-video']} 镜头如包含其他用途的参考，需要先调整；提交不会静默丢弃约束。`))
    const generation = el('div', 'shot-generation-actions')
    if (jobs.some(job => job.targetId === shot.id && job.status === 'submission_unknown')) shotDetail.append(el('p', 'media-warning', '此镜头有提交结果未知的任务，可能已计费。请先在任务中心核对；再次点击生成会明确发起一个新任务，可能重复消耗额度。'))
    generation.append(button('生成图片候选', () => submitShot(shot.id, 'image'), 'primary-button'), button('使用选用图片生成视频', () => submitShot(shot.id, 'video'), 'primary-button'))
    shotDetail.append(generation, el('p', 'media-help', '点击生成即提交当前镜头一次。图片与视频分别使用所选执行端，可能消耗账号额度；不会自动切换资源。首尾帧／参考图／续接的合法组合由适配器校验。'))
    const media = el('div', 'shot-candidates')
    for (const kind of ['image', 'video']) {
      const selectedId = shot[kind === 'image' ? 'selectedImageVersionId' : 'selectedVideoVersionId']
      const candidates = assets.filter(asset => asset.kind === kind && (asset.versions?.some(version => version.id === selectedId) || jobs.some(job => job.targetId === shot.id && (job.assetId === asset.id || asset.versions?.some(version => version.metadata?.provenance?.jobId === job.id)))))
      const group = el('section', 'media-candidate-group'); group.append(el('h3', '', kind === 'image' ? '图片候选' : '视频候选'))
      const imported = el('select'); imported.setAttribute('aria-label', `选用已有${kind === 'image' ? '图片' : '视频'}版本`); imported.append(new Option('选择项目内已有版本', ''))
      for (const asset of assets.filter(asset => asset.kind === kind)) for (const version of asset.versions || []) imported.append(new Option(`${asset.name} · ${version.id.slice(-8)}`, version.id))
      group.append(field('导入／其他镜头素材也可复用', imported), button('选用已有版本', async () => { if (!imported.value) return notify('请选择一个版本'); await editShot(shot.id, { [kind === 'image' ? 'selectedImageVersionId' : 'selectedVideoVersionId']: imported.value }); renderShotDetail() }))
      for (const asset of candidates) for (const version of asset.versions || []) {
        const card = el('article', 'media-version-card'); card.append(preview(version, asset.name), el('p', '', `${asset.name} · ${version.id.slice(-8)}`))
        card.append(button(version.id === selectedId ? '当前选用版本' : '选用此版本', async () => { await editShot(shot.id, { [kind === 'image' ? 'selectedImageVersionId' : 'selectedVideoVersionId']: version.id }); renderShotDetail() }))
        if (kind === 'video') {
          card.append(button('检查关键帧', () => showFrames(version.id, card)), button(shot.reviewedVideoVersionId === version.id ? '人工审核已通过' : '完整播放后标记审核通过', () => editShot(shot.id, { reviewedVideoVersionId: version.id }).then(renderShotDetail)))
        }
        group.append(card)
      }
      if (!candidates.length) group.append(el('p', 'media-help', kind === 'image' ? '生成或导入图片后，在这里明确选用。' : '视频生成完成后仍需检查关键帧并完整播放。'))
      media.append(group)
    }
    shotDetail.append(media, button('删除此镜头', () => run(async () => {
      if (!window.confirm(`删除“${shot.title}”？仅移除分镜与引用，已经生成的素材仍保留。`)) return
      await changeStoryboard(shots => shots.splice(shots.findIndex(item => item.id === shot.id), 1)); renderShots()
    }), 'danger-button'))
  }
  function generateStoryboard() {
    try {
      requireProject()
      const data = context(), doc = data.documents[sourceSelect.value]
      if (!doc?.content.trim()) throw new Error('所选文档为空，请先创作或粘贴剧本')
      const connection = connectionFor('storyboard')
      if (!connection) throw new Error(resolveConnectionRoute(data, 'storyboard').error)
      requestText(storyboardPrompt(), { purpose: 'storyboard', documentId: sourceSelect.value, sourceFingerprint: contentFingerprint(doc.content), storyboardRevision: data.storyboard.revision, connectionId: connection.id })
    } catch (problem) { notify(String(problem?.message || problem)) }
  }
  function candidateSnapshot(text, generationContext, draftId = null) {
    return { text, draftId, projectId: generationContext.projectId, documentId: generationContext.documentId, fingerprint: generationContext.sourceFingerprint, revision: generationContext.storyboardRevision }
  }
  function receiveCandidate(text, generationContext, draftId = null) {
    candidate = candidateSnapshot(text, generationContext, draftId)
    renderCandidate(); navigate('storyboard')
  }
  function clearCandidate(draftId) {
    if (!candidate || candidate.draftId !== draftId) return
    candidate = null
    renderCandidate()
  }
  function restoreSavedCandidate() {
    try {
      const saved = getSavedCandidate?.()
      if (saved?.context?.purpose === 'storyboard' && typeof saved.text === 'string') candidate = candidateSnapshot(saved.text, saved.context, saved.id)
    } catch (problem) { notify(`待审分镜恢复失败：${String(problem?.message || problem)}`) }
  }
  function renderCandidate() {
    candidateHost.replaceChildren(); candidateHost.hidden = !candidate
    if (!candidate) return
    const text = el('textarea'); text.rows = 7; text.value = candidate.text; text.setAttribute('aria-label', '可编辑的 AI 分镜候选 JSON')
    const summary = el('p', 'media-help')
    const displayed = candidate
    const updateSummary = () => { try { summary.textContent = `${parseStoryboardCandidate(displayed.text).length} 个候选镜头，尚未写入项目。` } catch (problem) { summary.textContent = problem.message } }
    text.addEventListener('input', () => {
      if (candidate !== displayed) return
      displayed.text = text.value; updateSummary()
      try {
        Promise.resolve(onCandidateChange?.(displayed.draftId, displayed.text)).catch(problem => notify(`候选修改尚未保存：${String(problem?.message || problem)}`))
      } catch (problem) { notify(`候选修改尚未保存：${String(problem?.message || problem)}`) }
    })
    updateSummary()
    const actions = el('div', 'media-toolbar')
    actions.append(button('采纳并追加镜头', () => applyCandidate(false), 'primary-button'), button('替换当前分镜', () => applyCandidate(true)), button('放弃候选', () => run(async () => {
      text.readOnly = true
      try {
        if (await onCandidateResolved?.(displayed.draftId, { committed: false }) === false) return
        if (candidate === displayed) candidate = null
        renderCandidate()
      } finally { if (text.isConnected) text.readOnly = false }
    })))
    candidateHost.append(el('h2', '', 'AI 分镜候选'), summary, text, actions)
  }
  async function applyCandidate(replace = false) {
    await run(async () => {
      const data = context()
      if (!candidate || candidate.projectId !== data.projectId) throw new Error('候选属于另一个项目')
      if (candidate.revision !== data.storyboard.revision) throw new Error('候选生成后分镜已有修改。候选保留，请重新拆镜或手动整理，未覆盖当前内容。')
      if (contentFingerprint(data.documents[candidate.documentId]?.content || '') !== candidate.fingerprint) throw new Error('剧本在生成后已修改。请重新拆镜，原候选仍保留。')
      const applying = candidate
      const shots = parseStoryboardCandidate(applying.text, { documentId: applying.documentId, fingerprint: applying.fingerprint })
      if (shots.length + (replace ? 0 : data.storyboard.shots.length) > SHOT_LIMIT) throw new Error(`项目最多 ${SHOT_LIMIT} 个镜头`)
      if (replace && data.storyboard.shots.length && !window.confirm(`替换当前 ${data.storyboard.shots.length} 个镜头？已生成素材保留，但当前镜头编辑与引用将被替换。`)) return
      const editor = candidateHost.querySelector('textarea')
      if (editor) editor.readOnly = true
      try {
        await changeStoryboard(list => { if (replace) list.length = 0; list.push(...shots) }, { resolvedCandidateId: applying.draftId })
      } finally { if (editor?.isConnected) editor.readOnly = false }
      if (candidate === applying) candidate = null
      // The commit already resolved this draft with the storyboard. A UI callback
      // failure must never turn a successful commit into a retryable append.
      try { await onCandidateResolved?.(applying.draftId, { committed: true }) }
      catch (problem) { notify(`分镜已保存，待审稿显示刷新失败：${String(problem?.message || problem)}`) }
      if (data.projectId === context().projectId) { selectedShotId = shots[0].id; renderCandidate(); renderShots() }
      notify('分镜已采纳，剧本没有变化')
    })
  }
  function prepareShotRequest(id, capability) {
    const data = context(), shot = data.storyboard.shots.find(item => item.id === id), connection = connectionFor(capability)
    if (!shot) throw new Error('镜头不存在')
    if (!shot.visual.trim()) throw new Error('请先填写镜头画面')
    if (!connection) throw new Error(resolveConnectionRoute(data, capability).error)
    if (invoke && (loading || error)) throw new Error('素材与任务尚未成功读取，请先刷新后预览')
    if (jobs.some(job => job.targetId === id && job.capability === capability && !terminal(job.status))) throw new Error('此镜头同类任务正在执行，请等待或取消后再提交')
    const mode = capability === 'video' ? shot.videoMode || 'image-to-video' : shot.references.length ? 'edit' : 'generate'
    const roles = capability === 'image' ? ['reference', 'start', 'end'] : ({ 'image-to-video': ['start'], 'reference-to-video': ['reference'], 'first-last': ['start', 'end'], extend: ['extend'] })[mode]
    if (!roles || shot.references.some(ref => !roles.includes(ref.role))) throw new Error('所选模式不支持镜头中的部分参考用途，请调整参考或模式；未忽略任何参考提交')
    const refs = structuredClone(shot.references)
    if (capability === 'video' && ['image-to-video', 'first-last'].includes(mode) && !refs.some(ref => ref.role === 'start')) {
      const image = findMediaVersion(assets, shot.selectedImageVersionId)
      if (!image) throw new Error('先审核并选用一张分镜图，再生成视频；或明确指定续接视频')
      refs.push({ versionId: image.version.id, role: 'start' })
    }
    if (refs.some(ref => !findMediaVersion(assets, ref.versionId))) throw new Error('引用的媒体文件不存在，请恢复完整项目包或重新选择，不会忽略参考提交')
    const adapter = mediaAdapterFor(connection, capability)
    if (adapter.modes && !adapter.modes.includes(mode)) throw new Error('所选适配器不支持此生成模式；未提交生成')
    if (adapter.referenceRoles && (refs.length > adapter.maxReferences || refs.some(ref => !adapter.referenceRoles.includes(ref.role)))) throw new Error('参考数量或用途超出所选适配器能力；未提交生成')
    const labels = refs.map((ref, index) => `输入 ${index + 1}：${ref.role} · ${findMediaVersion(assets, ref.versionId).asset.name} · 固定版本 ${ref.versionId}`)
    return {
      projectId: data.projectId, targetId: id, capability, prompt: mediaPrompt(shot, data.project, labels), references: refs,
      connection: { id: connection.id, kind: connection.kind === 'cli' ? 'cli' : 'api', driverId: connection.driverId || null, baseUrl: connection.baseUrl || '', model: connection.kind === 'cli' ? connection.planningModel || '' : connection.model || '', adapter: adapter.id },
      parameters: { mode, aspectRatio: shot.aspectRatio || '16:9', duration: shot.duration, size: shot.imageSize || 'auto', quality: shot.imageQuality || 'auto' },
      allowUserProfile: connection.kind === 'cli'
    }
  }
  function updateBatchConfirmation() {
    batchConfirm.disabled = !invoke || !batchPlan || batchPlan.attempted || operationBusy
  }
  function invalidateBatchPlan(message = '') {
    batchPlan = null; batchPreview.hidden = true; batchPreview.replaceChildren()
    batchStatus.textContent = message || `已选 ${batchSelection.size} 个镜头。选择或输入变化后，请重新预览；尚未提交生成。`
    batchConfirm.textContent = '预览后确认生成'; updateBatchConfirmation()
  }
  function renderBatchConnection() {
    const route = resolveConnectionRoute(context(), batchCapability.value), connection = route.connection
    batchConnection.textContent = connection ? `${connection.name} · ${connection.kind === 'cli' ? `CLI（使用既有账号，权限与额度未验证） · 规划模型：${connection.planningModel || '跟随本机 CLI 配置'}` : connection.model || '尚未配置模型'}${route.source === 'global' ? ' · 继承全局默认' : ''}` : route.error
  }
  function renderBatchSelection() {
    batchShots.replaceChildren()
    for (const [index, shot] of context().storyboard.shots.entries()) {
      const label = el('label', 'media-batch-option'), input = el('input')
      input.type = 'checkbox'; input.checked = batchSelection.has(shot.id)
      input.addEventListener('change', () => {
        if (input.checked && batchSelection.size >= BATCH_LIMIT) { input.checked = false; batchStatus.textContent = '每批最多 20 个镜头，请先移除其他镜头。'; return }
        if (input.checked) batchSelection.add(shot.id); else batchSelection.delete(shot.id)
        invalidateBatchPlan()
      })
      label.append(input, el('span', '', `${String(index + 1).padStart(2, '0')} · ${shot.title}`)); batchShots.append(label)
    }
    if (!context().storyboard.shots.length) batchShots.append(el('p', 'media-help', '尚无镜头。返回分镜新建镜头或从剧本拆镜后再制定计划。'))
  }
  function openBatchPlan(options = {}) {
    try {
      requireProject()
      if (options.projectId && options.projectId !== context().projectId) throw new Error('项目已切换，未打开其他项目的生成计划')
      if (options.shotIds) {
        if (!['image', 'video'].includes(options.capability) || !Array.isArray(options.shotIds) || !options.shotIds.length || options.shotIds.length > BATCH_LIMIT || new Set(options.shotIds).size !== options.shotIds.length || options.shotIds.some(id => !context().storyboard.shots.some(shot => shot.id === id))) throw new Error('待生成镜头或能力已失效，请重新制定计划')
        batchCapability.value = options.capability
      }
      batchSelection = new Set(options.shotIds || (selectedShotId ? [selectedShotId] : []))
      renderBatchSelection(); renderBatchConnection(); invalidateBatchPlan()
      if (!batchDialog.open) batchDialog.showModal()
      return true
    } catch (problem) { notify(String(problem?.message || problem)); return false }
  }
  function batchRequests(capability) {
    const shots = context().storyboard.shots.filter(shot => batchSelection.has(shot.id))
    if (!shots.length || shots.length > BATCH_LIMIT || shots.length !== batchSelection.size) throw new Error('请选择 1–20 个仍存在的镜头')
    return shots.map(shot => {
      try { return prepareShotRequest(shot.id, capability) }
      catch (problem) { throw new Error(`${shot.title}：${problem.message}`) }
    })
  }
  function batchSignature(requests) {
    const data = context()
    const sources = requests.map(request => {
      const shot = data.storyboard.shots.find(item => item.id === request.targetId), sourceId = shot?.sourceDocumentId
      return { targetId: request.targetId, documentId: sourceId || '', fingerprint: sourceId ? contentFingerprint(data.documents[sourceId]?.content || '') : '' }
    })
    return JSON.stringify({ projectId: data.projectId, revision: data.storyboard.revision, sources, requests })
  }
  function previewBatchPlan() {
    invalidateBatchPlan()
    try {
      requireProject()
      const capability = batchCapability.value, requests = batchRequests(capability), connection = connectionFor(capability)
      batchPlan = { id: crypto.randomUUID(), projectId: context().projectId, capability, requests, signature: batchSignature(requests), attempted: false }
      batchPreview.hidden = false
      batchPreview.append(el('h3', '', `${requests.length} 个${capability === 'image' ? '图片' : '视频'}任务 · 每镜头 1 个候选`), el('p', 'media-warning', '费用／额度消耗未知，不能可靠预估；失败不自动重试，也不切换执行端。'))
      if (connection.kind === 'cli') batchPreview.append(el('p', 'media-help', `确认即授权本批次通过 Codex CLI 使用既有账号，可能消耗图片额度；登录、模型权限与额度以实际执行为准。规划模型：${connection.planningModel || '跟随本机 CLI 配置'}；所选模型不可用时停止，不自动更换。底层图片模型以实际可获取信息为准。画幅／质量为创作要求，不保证精确遵循。`))
      const list = el('ol', 'media-batch-items')
      for (const request of requests) {
        const shot = context().storyboard.shots.find(item => item.id === request.targetId), item = el('li', 'media-job')
        item.append(el('strong', '', shot.title), el('p', 'media-help', `${connection.name} · ${request.parameters.mode} · ${request.parameters.aspectRatio}${capability === 'video' ? ` · ${request.parameters.duration} 秒` : ` · ${request.parameters.size} / ${request.parameters.quality}`}`))
        item.append(el('p', 'media-help', request.references.length ? request.references.map(ref => `${ref.role} · 固定版本 ${ref.versionId}`).join('\n') : '未附加媒体参考；身份与场景的一致性约束较弱。'))
        if (shotIsStale(shot, context().documents)) item.append(el('p', 'media-warning', '剧本来源已更新，请核对固定输入后再确认。'))
        if (jobs.some(job => job.targetId === shot.id && job.status === 'submission_unknown')) item.append(el('p', 'media-warning', '此镜头已有提交结果未知的任务，可能已消耗额度。请先核对；本次确认将创建新生成，可能重复计费。'))
        const details = el('details'); details.append(el('summary', '', '查看本镜头完整输入'), el('pre', 'media-job-snapshot', JSON.stringify(request, null, 2))); item.append(details); list.append(item)
      }
      batchPreview.append(list, el('p', 'media-help', '提交前核对参数、凭据配置与实际素材文件；预检失败不会开始本批次，远端权限和额度以实际执行为准。计划改变须重新预览，不会自动追加任务。'))
      batchStatus.textContent = invoke ? '计划已固定，确认后整批保存再执行。取消不会删除已有素材，远端仍可能完成并计费。' : '计划仅供预览；请在桌面版提交真实媒体任务。此处没有模拟生成。'
      batchConfirm.textContent = `确认生成 ${requests.length} 个${capability === 'image' ? '图片' : '视频'}候选`; updateBatchConfirmation()
    } catch (problem) { batchStatus.textContent = String(problem?.message || problem) }
  }
  function assertBatchPlan(plan) {
    if (batchPlan !== plan || context().projectId !== plan.projectId || batchCapability.value !== plan.capability || batchSignature(batchRequests(plan.capability)) !== plan.signature) throw new Error('项目、镜头输入或执行端已变化，请重新预览；未提交生成')
  }
  async function submitBatchPlan() {
    await run(async () => {
      desktop()
      await requireAdapterCatalog()
      const plan = batchPlan
      if (!plan || plan.attempted) throw new Error('请重新预览计划，已提交的批次不会自动重复执行')
      try {
        assertBatchPlan(plan); await beforeSubmit?.(); assertBatchPlan(plan)
        const connection = connectionFor(plan.capability), apiKey = connection.kind === 'cli' ? null : await secret(connection)
        assertBatchPlan(plan)
        if (connection.kind !== 'cli' && !apiKey) throw new Error('请先在连接中心配置当前执行端密钥，再重新预览')
        plan.attempted = true; batchStatus.textContent = '正在保存整批固定输入，尚不能确认远端生成状态…'; updateBatchConfirmation()
        const submitted = await invoke('media_submit_batch', { batchId: plan.id, requests: plan.requests.map(request => ({ ...request, apiKey: apiKey || null })) })
        batchDialog.close()
        if (plan.projectId === context().projectId) { jobs = [...submitted, ...jobs]; showJobs() }
        notify(`已登记 ${submitted.length} 个任务，结果回到原项目；未自动启动下一创作阶段`); await refresh()
      } catch (problem) {
        batchStatus.textContent = `${String(problem?.message || problem)}${plan.attempted ? '。请先从任务中心核对本批次，不会自动重试提交。' : ''}`
        throw problem
      }
    })
  }
  async function submitShot(id, capability) {
    await run(async () => {
      requireProject(); desktop(); await requireAdapterCatalog()
      const submittingProjectId = context().projectId, signature = batchSignature([prepareShotRequest(id, capability)])
      await beforeSubmit?.()
      if (submittingProjectId !== context().projectId) throw new Error('项目已切换，未提交生成')
      const data = context(), request = prepareShotRequest(id, capability), connection = connectionFor(capability)
      if (batchSignature([request]) !== signature) throw new Error('镜头输入或执行端已变化，未提交生成，请核对后重试')
      const apiKey = connection.kind === 'cli' ? null : await secret(connection)
      if (connection.kind !== 'cli' && !apiKey) throw new Error('请到连接中心配置此资源的密钥')
      if (data.projectId !== context().projectId || batchSignature([prepareShotRequest(id, capability)]) !== signature) throw new Error('镜头输入或执行端已变化，未提交生成，请核对后重试')
      const job = await invoke('media_submit', { request: { ...request, apiKey: apiKey || null } })
      if (data.projectId === context().projectId) { jobs = [job, ...jobs.filter(item => item.id !== job.id)]; renderJobs() }
      notify('任务已提交，结果将写回原镜头的候选版本'); await refresh()
    })
  }
  async function refresh() {
    const data = context(), sequence = ++requestSequence
    if (data.projectId !== projectId) { projectId = data.projectId; assets = []; jobs = []; recoveryIssues = []; selectedShotId = null; selectedAssetId = null; candidate = null; selectedSourceId = ''; batchSelection.clear(); invalidateBatchPlan(); batchDialog.close() }
    if (!candidate && !operationBusy) restoreSavedCandidate()
    renderEndpoints(); renderSources(); renderShots({ detail: !shotDetail.contains(document.activeElement) && ![...shotDetail.querySelectorAll('video')].some(video => !video.paused) }); if (!candidateHost.contains(document.activeElement)) renderCandidate(); renderAssets()
    if (!invoke || !data.projectId) { error = ''; renderAssets(); return }
    loading = true; renderAssets()
    try {
      const snapshot = await invoke('media_list', { projectId: data.projectId })
      if (sequence !== requestSequence || data.projectId !== context().projectId) return
      assets = snapshot.assets || []; jobs = snapshot.jobs || []; recoveryIssues = snapshot.recoveryIssues || []; error = ''
    } catch (problem) { if (sequence === requestSequence) error = String(problem?.message || problem) }
    finally {
      if (sequence === requestSequence) { loading = false; renderShots({ detail: !shotDetail.contains(document.activeElement) && ![...shotDetail.querySelectorAll('video')].some(video => !video.paused) }); renderAssets(); renderJobs() }
    }
  }
  function renderAssets() {
    assetNotice.textContent = !invoke ? '媒体生成、文件预览和完整项目包使用桌面版的本地存储。此处不会展示模拟素材。' : loading ? '正在读取本地素材与任务…' : error ? `读取失败：${error}` : `${assets.length} 项素材 · 版本独立保存，镜头引用固定，不随选用版本自动改变。`
    if (!loading && !error && recoveryIssues.length) assetNotice.textContent += `\n${recoveryIssues.join('\n')}。已保留恢复记录；重新读取只尝试收录文件，不会再次生成。`
    if ([...assetGrid.querySelectorAll('video')].some(video => !video.paused)) return
    assetGrid.replaceChildren()
    if (error) assetGrid.append(button('重试读取', refresh))
    const visible = assets.filter(asset => !roleFilter.value || asset.role === roleFilter.value)
    for (const asset of visible) {
      const version = asset.versions?.find(item => item.id === asset.selectedVersionId) || asset.versions?.[0]
      const card = el('article', `asset-card${asset.id === selectedAssetId ? ' is-selected' : ''}`)
      const select = button(asset.name, () => { selectedAssetId = asset.id; renderAssets() }, 'asset-select')
      select.prepend(preview(version, asset.name))
      card.append(select, el('p', 'media-help', `${ASSET_ROLES[asset.role] || '素材'} · ${asset.versions?.length || 0} 个版本`)); assetGrid.append(card)
    }
    if (!visible.length && !loading && !error) assetGrid.append(el('div', 'media-empty', '尚无素材。导入你的角色、场景或已有镜头，也可以在分镜中生成候选。'))
    if (!assetDetail.contains(document.activeElement) && ![...assetDetail.querySelectorAll('video')].some(video => !video.paused)) renderAssetDetail()
  }
  function renderAssetDetail() {
    assetDetail.replaceChildren()
    const asset = assets.find(item => item.id === selectedAssetId)
    if (!asset) return
    assetDetail.append(el('h2', '', asset.name))
    const name = el('input'); name.value = asset.name; name.maxLength = 200
    const role = el('select'); Object.entries(ASSET_ROLES).forEach(([value, label]) => role.append(new Option(label, value))); role.value = asset.role
    const saveAsset = selectedVersionId => run(async () => {
      desktop()
      await invoke('media_update_asset', { projectId: context().projectId, assetId: asset.id, name: name.value.trim(), role: role.value, selectedVersionId: selectedVersionId || asset.selectedVersionId })
      await refresh()
    })
    assetDetail.append(field('素材名称', name), field('用途', role), button('保存素材信息', () => saveAsset()))
    const versions = el('div', 'media-version-grid')
    for (const version of asset.versions || []) {
      const card = el('article', 'media-version-card')
      card.append(preview(version, asset.name), el('p', '', `${version.name || asset.name} · ${version.id.slice(-8)}`), el('p', 'media-help', `${Math.ceil(version.bytes / 1024)} KiB · ${version.mimeType}`), button(version.id === asset.selectedVersionId ? '当前参考版本' : '选为后续默认参考', () => saveAsset(version.id)), button('导出此文件', () => run(async () => { desktop(); notify(await invoke('media_export_version', { projectId: context().projectId, versionId: version.id })) })))
      versions.append(card)
    }
    assetDetail.append(versions)
  }
  async function chooseImport() {
    await run(async () => { requireProject(); desktop(); const data = context(); try { const result = await invoke('media_choose_import', { projectId: data.projectId, role: roleFilter.value || 'other' }); if (result?.length) notify(`已导入 ${result.length} 项真实素材`) } finally { await refresh() } })
  }
  async function exportPackage() {
    await run(async () => { requireProject(); desktop(); const data = context(), portable = await portableProject(); notify(await invoke('media_export_package', { projectId: data.projectId, workspace: portable.workspace, index: portable.index })) })
  }
  async function restorePackage() {
    await run(async () => { desktop(); const newId = crypto.randomUUID(), result = await invoke('media_import_package', { projectId: newId }); if (!result) return; await importPackage(result, newId); notify('完整包已恢复为独立项目，原项目保留'); await refresh() })
  }
  async function showPendingImports() {
    await run(async () => {
      desktop()
      const pending = await invoke('media_pending_imports')
      pendingHost.hidden = false; pendingHost.replaceChildren(el('h2', '', '待完成的项目包导入'))
      pendingHost.append(el('p', 'media-help', '已验证的文件保留在本机。继续导入会把工作区与媒体登记在同一事务中，新增独立项目，不替换原项目。'))
      if (!pending.length) pendingHost.append(el('p', '', '没有待恢复导入。'))
      for (const item of pending) {
        const row = el('div', 'shot-reference-row'); row.append(el('span', '', item.name || '未命名项目'), button('继续创建独立项目', () => run(async () => {
          const data = await invoke('media_get_pending_import', { importId: item.importId })
          await importPackage(data, data.projectId); pendingHost.hidden = true; await refresh(); notify('导入已完成，原项目保留')
        }))); pendingHost.append(row)
      }
      navigate('assets')
    })
  }
  async function showFrames(versionId, container) {
    await run(async () => {
      desktop(); const frames = await invoke('media_keyframes', { projectId: context().projectId, versionId })
      container.querySelector('.media-keyframes')?.remove()
      const host = el('div', 'media-keyframes'); host.append(el('p', 'media-help', '抽帧仅供辅助检查，不能替代完整播放。'))
      for (const frame of frames.frames || []) { const figure = el('figure'); figure.append(preview({ fileId: frame.fileId, mimeType: 'image/png' }, `${frame.seconds}s 关键帧`), el('figcaption', '', `${Number(frame.seconds).toFixed(2)}s`)); host.append(figure) }
      container.append(host)
    })
  }
  function showJobs() { renderJobs(); if (!jobsDialog.open) jobsDialog.showModal() }
  function renderJobs() {
    jobsList.replaceChildren()
    if (!jobs.length) jobsList.append(el('p', 'media-empty', '当前项目尚无生成任务。手动导入素材不消耗生成额度。'))
    const groups = new Map()
    for (const job of jobs) {
      const key = job.batchId ? `batch:${job.batchId}` : `job:${job.id}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(job)
    }
    for (const group of groups.values()) {
      const host = el('section', 'media-job-group'), batchId = group[0].batchId
      if (batchId) {
        group.sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0))
        const heading = el('div', 'media-job-heading'), finished = group.filter(job => job.status === 'completed').length, active = group.filter(job => !terminal(job.status)).length
        heading.append(el('strong', '', `批次 ${batchId.slice(-8)}`), el('span', '', `${group.length} 项 · 已收录 ${finished} · 等待／执行 ${active}`)); host.append(heading)
        if (active) host.append(button('停止本批次等待与后续任务', () => run(async () => {
          await invoke('media_cancel_batch', { projectId: context().projectId, batchId }); notify('正在停止本批次；已完成素材保留，远端仍可能完成并计费'); await refresh()
        })))
      }
      for (const job of group) {
      const row = el('article', 'media-job')
      const heading = el('div', 'media-job-heading'); heading.append(el('strong', '', context().storyboard.shots.find(shot => shot.id === job.targetId)?.title || job.targetId), el('span', '', JOB_STATUSES[job.status] || job.status))
      row.append(heading, el('p', 'media-help', `${job.capability === 'video' ? '视频' : '图片'} · ${job.request?.connection?.id || '执行端'} · ${job.id.slice(-8)}`))
      if (job.error) row.append(el('p', 'media-warning', job.error))
      if (job.remoteId) row.append(el('p', 'media-help', `远端任务：${job.remoteId}`))
      const details = el('details'), summary = el('summary', '', '查看实际输入快照'); details.append(summary, el('pre', 'media-job-snapshot', JSON.stringify(job.request || {}, null, 2))); row.append(details)
      if (!terminal(job.status)) row.append(button('取消等待／停止后续', () => run(async () => { await invoke('media_cancel', { projectId: context().projectId, jobId: job.id }); await refresh() })))
      if (job.restored) row.append(el('p', 'media-help', '从项目包恢复的历史记录，仅供追溯；不复用原执行端授权。'))
      if (!job.restored && terminal(job.status) && job.status !== 'completed') row.append(button('恢复查询／下载／收录', () => run(async () => {
        const connection = context().connections.find(item => item.id === job.request?.connection?.id)
        const snapshot = job.request?.connection
        const matches = connection && snapshot && (snapshot.kind === 'cli' ? connection.kind === 'cli' && connection.driverId === snapshot.driverId : connection.baseUrl === snapshot.baseUrl && connection.adapter === snapshot.adapter)
        const apiKey = matches ? await secret(connection) : null
        if (!matches && snapshot?.kind === 'api') notify('原执行端已修改或移除，仅尝试恢复本地文件；不会把其他资源密钥发送到原地址')
        await invoke('media_resume', { projectId: context().projectId, jobId: job.id, apiKey: apiKey || null }); await refresh()
      })))
      if (job.status === 'submission_unknown') row.append(el('p', 'media-warning', '可能已被远端接受；恢复查询不会创建新生成。无法核对时，重新生成必须由你明确发起。'))
      host.append(row)
      }
      jobsList.append(host)
    }
  }
  const poll = window.setInterval(() => {
    if (!loading && !operationBusy && jobs.some(job => !terminal(job.status))) refresh()
  }, 5000)
  window.addEventListener('beforeunload', () => window.clearInterval(poll), { once: true })
  function contextObjects() {
    const shots = context().storyboard.shots.map(shot => ({ key: `shot:${shot.id}`, kind: '镜头', label: shot.title, content: mediaPrompt(shot, context().project) }))
    const versions = assets.flatMap(asset => asset.versions.map(version => ({
      key: `asset:${version.id}`, kind: '素材说明（无媒体字节）', label: `${asset.name} · ${version.id.slice(-8)}`,
      content: `素材名称：${asset.name}\n用途：${ASSET_ROLES[asset.role] || asset.role}\n固定版本：${version.id}\n格式：${version.mimeType}\n此文字请求仅引用素材说明，未附加图片或视频字节。`
    })))
    return [...shots, ...versions]
  }
  function operationContext() {
    const owner = context().projectId
    return {
      projectId: owner === projectId && !error ? owner : null,
      versions: owner === projectId && !error ? assets.filter(asset => asset.projectId === owner).flatMap(asset => (asset.versions || []).map(version => ({ id: version.id, assetId: asset.id, name: asset.name, kind: asset.kind, mimeType: version.mimeType, bytes: version.bytes }))) : []
    }
  }
  function previewVersion(versionId) {
    const found = context().projectId === projectId && findMediaVersion(assets, versionId)
    return preview(found?.version, found?.asset.name || '所选媒体版本')
  }
  return { hasPendingWork: () => operationBusy, refresh, renderEndpoints, receiveCandidate, clearCandidate, applyCandidate, showJobs, generateStoryboard, restorePackage, showPendingImports, contextObjects, operationContext, previewVersion, openBatchPlan, hasCandidate: () => Boolean(candidate) }
}
