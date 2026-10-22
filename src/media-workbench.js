import { candidateGeneratedAtLabel } from './candidate-drafts.js'
import { buildFlowExport, buildMuseExport } from './video-export.js'
import { parseVideoManifest, planVideoReturn, applyVideoReturn } from './video-return.js'
import { shotStagePanel, shotReadiness } from './shot-workflow.js'
import { ASSET_ROLES, JOB_STATUSES, SHOT_LIMIT, contentFingerprint, storyboardSourceFingerprint, createShot, findMediaVersion, isContinuityReference, prepareShotInputs, videoParameterState, validateVideoParameters, jobResult, mediaPrompt, parseStoryboardCandidate, resolveConnectionRoute, shotIsStale, storyboardPrompt, supportsCapability } from './storyboard.js'
import { mediaAdapterFor, useMediaAdapterCatalog } from './media-adapters.js'
import { biographyCharacters, characterImagePrompt, characterTargetId, prepareCharacterRequest } from './character-images.js'
import { projectCharacterNames } from './storyboard-characters.js'
import { REFERENCE_ENTITY_FIELDS, referenceCatalog, bindShotReferences, referenceBindingWarnings, manualReferencePatch, planReferenceBackfill } from './storyboard-references.js'
import { OTHER_EPISODE, UNASSIGNED_SOURCE, storyboardGroups, scopeForDocument, scopedShots, moveSourceShot, replaceSourceShots } from './storyboard-scope.js'

import { createStoryboardTasks, STORYBOARD_TASK_PHASES } from './storyboard-tasks.js'

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
function disclosure(label, key, className = 'media-disclosure') {
  const node = el('details', className)
  if (key) node.dataset.layoutKey = key
  node.append(el('summary', '', label))
  return node
}
function actionMenu(label, actions) {
  const node = disclosure(label, '', 'media-action-menu')
  const panel = el('div', 'media-action-menu-panel')
  panel.append(...actions)
  node.append(panel)
  node.addEventListener('click', event => {
    if (!event.target.closest('button')) return
    const restoreFocus = node.contains(document.activeElement)
    node.open = false
    if (restoreFocus) node.querySelector('summary').focus()
  })
  node.addEventListener('keydown', event => { if (event.key === 'Escape' && node.open) { event.preventDefault(); event.stopPropagation(); node.open = false; node.querySelector('summary').focus() } })
  node.addEventListener('focusout', event => { if (event.relatedTarget && !node.contains(event.relatedTarget)) node.open = false })
  document.addEventListener('pointerdown', event => { if (!node.contains(event.target)) node.open = false })
  return node
}
function mediaTimeLabel(value) {
  if (value === null || value === undefined || value === '') return '未记录'
  // Native media storage writes Unix milliseconds as strings; imports may use ISO dates.
  const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '未记录'
}
const terminal = status => ['completed', 'failed', 'cancelled', 'submission_unknown'].includes(status)
const BATCH_LIMIT = 20

export function initializeMediaWorkbench({ getContext, commit, invoke, secret, requestText, stopText, notify, navigate, importPackage, portableProject, beforeSubmit, openSavedCandidates, onCandidateChange, onCandidateResolved }) {
  let assets = [], jobs = [], recoveryIssues = [], projectId = null, selectedShotId = null, selectedAssetId = null
  let loading = false, error = '', requestSequence = 0, candidate = null, selectedSourceId = ''
  const storyboardTasks = createStoryboardTasks()
  let selectedEpisodeId = '', lastContextDocId = null, batchScopeIds = []
  let operationBusy = false, referenceSyncBusy = false, referenceSyncTimer = null
  let shotResourceStatus = null
  const shotDisclosureState = new Map()
  const assetDrafts = new Map()
  let resultVersionId = ''
  let detailShotId = null
  let detailPanel = 'content', mediaStage = 'storyboard'
  let draggingShotId = null
  let batchPlan = null, batchSelection = new Set()
  let adapterCatalogReady = false
  const adapterCatalogPromise = loadAdapterCatalog()
  const batchDialog = $('#mediaBatchDialog'), batchCapability = $('#mediaBatchCapability'), batchShots = $('#mediaBatchShots')
  const batchConnection = $('#mediaBatchConnection'), batchStatus = $('#mediaBatchStatus'), batchPreview = $('#mediaBatchPreview'), batchConfirm = $('#mediaBatchConfirm')
  batchDialog.querySelectorAll('[data-media-batch-close]').forEach(node => node.addEventListener('click', () => batchDialog.close()))
  batchCapability.addEventListener('change', () => { invalidateBatchPlan(); renderBatchConnection(); renderBatchSelection() })
  batchDialog.querySelector('[data-media-batch-preview]').addEventListener('click', previewBatchPlan)
  batchConfirm.addEventListener('click', submitBatchPlan)
  batchDialog.querySelector('[data-media-batch-select]').addEventListener('click', () => { batchSelection = new Set(batchScopeIds.slice(0, BATCH_LIMIT)); renderBatchSelection(); invalidateBatchPlan() })
  batchDialog.querySelector('[data-media-batch-clear]').addEventListener('click', () => { batchSelection.clear(); renderBatchSelection(); invalidateBatchPlan() })
  const storyboardView = $('#storyboardView'), assetsView = $('#assetsView'), jobsDialog = $('#mediaJobsDialog')
  const sourceSelect = el('select'), episodeSelect = el('select'), presetSelect = el('select')
  sourceSelect.setAttribute('aria-label', '分场与查看范围')
  episodeSelect.setAttribute('aria-label', '分镜所属分集')
  sourceSelect.addEventListener('change', () => { selectedSourceId = sourceSelect.value; renderSources(); renderShots(); renderCandidate() })
  episodeSelect.addEventListener('change', () => {
    selectedEpisodeId = episodeSelect.value
    selectedSourceId = storyboardGroups(context()).find(group => group.id === selectedEpisodeId)?.sceneIds[0] || ''
    renderSources(); renderShots(); renderCandidate()
  })
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

  const shotActions = el('div', 'media-toolbar media-workbench-toolbar')
  const generateButton = button('AI 拆镜', generateStoryboard, 'primary-button'), addShotButton = button('新建镜头', addShot)
  const wholeEpisodeButton = button('查看全集', () => { selectedSourceId = ''; renderSources(); renderShots(); renderCandidate() })
  const scopeControls = el('div', 'media-scope-controls'), primaryActions = el('div', 'media-primary-actions')
  scopeControls.append(field('分集', episodeSelect), field('分场', sourceSelect), wholeEpisodeButton)
  primaryActions.append(generateButton, actionMenu('导出', [button('Google Flow 素材包', exportFlow), button('Muse 聊天素材包', exportMuse)]), button('回填外部视频', openVideoReturn), button('任务中心', showJobs), actionMenu('更多', [addShotButton, button('批量生成计划', () => openBatchPlan()), button('查看历史候选', () => openSavedCandidates?.())]))
  shotActions.append(scopeControls, primaryActions)
  const storyboardHelp = disclosure('分镜使用说明', '', 'media-help-disclosure')
  storyboardHelp.append(el('p', 'media-help', '选择分场后点击 AI 拆镜，完成后自动保存镜头并关联角色、场景和道具参考图。后续补图也会补齐关联，保留手动选择与固定版本。导出和批量生成使用当前查看范围；查看全集可汇总本集镜头。'))
  storyboardView.querySelector('.media-view-content').append(shotActions)
  const storyboardTaskHost = el('section', 'storyboard-task-status')
  storyboardTaskHost.setAttribute('aria-label', '分场拆镜任务进度')
  const shotStatus = el('p', 'media-notice'), candidateHost = el('section', 'storyboard-candidate'), shotBody = el('div', 'storyboard-body')
  shotStatus.setAttribute('role', 'status')
  candidateHost.hidden = true
  const shotList = el('div', 'shot-list'), shotDetail = el('section', 'shot-detail')
  shotDetail.setAttribute('aria-label', '镜头详情')
  shotBody.append(shotList, shotDetail)
  const storyboardNotices = el('div', 'media-workspace-notices')
  storyboardNotices.append(storyboardHelp, storyboardTaskHost, shotStatus, candidateHost)
  storyboardView.querySelector('.media-view-content').append(storyboardNotices, shotBody)

  const assetToolbar = el('div', 'media-toolbar media-workbench-toolbar asset-workbench-toolbar')
  const roleFilter = el('select')
  roleFilter.setAttribute('aria-label', '筛选素材用途')
  roleFilter.append(new Option('全部素材', ''))
  Object.entries(ASSET_ROLES).forEach(([value, text]) => roleFilter.append(new Option(text, value)))
  roleFilter.addEventListener('change', renderAssets)
  const assetActions = el('div', 'media-primary-actions')
  assetActions.append(button('生成角色图', openCharacterImages, 'primary-button'), button('导入图片／视频', chooseImport), button('任务中心', showJobs), actionMenu('更多', [button('导出完整项目包', exportPackage), button('导入项目包', restorePackage), button('恢复待完成导入', showPendingImports)]))
  assetToolbar.append(field('素材用途', roleFilter), assetActions)
  const pendingHost = el('section', 'media-pending-imports'); pendingHost.hidden = true
  const assetNotice = el('p', 'media-notice'), assetGrid = el('div', 'asset-grid'), assetDetail = el('section', 'asset-detail')
  const assetBody = el('div', 'asset-workbench-body'); assetBody.append(assetGrid, assetDetail)
  assetNotice.setAttribute('role', 'status')
  assetsView.querySelector('.media-view-content').append(assetToolbar, pendingHost, assetNotice, assetBody)
  const jobsList = jobsDialog.querySelector('.media-jobs-list')
  jobsDialog.querySelector('[data-media-refresh]').addEventListener('click', () => refresh())
  jobsDialog.querySelector('[data-media-close]').addEventListener('click', () => jobsDialog.close())

  const characterDialog = el('dialog', 'app-dialog character-image-dialog')
  characterDialog.id = 'characterImageDialog'
  characterDialog.setAttribute('aria-labelledby', 'characterImageTitle')
  const characterHeading = el('h2', '', '从人物小传生成角色图'); characterHeading.id = 'characterImageTitle'
  const characterPicker = el('select'), characterName = el('input'), characterBiography = el('textarea'), characterAppearance = el('textarea'), characterStyle = el('input'), characterReference = el('select')
  characterName.maxLength = 80; characterBiography.maxLength = 12000; characterAppearance.maxLength = 4000; characterStyle.maxLength = 1000
  characterBiography.rows = 7; characterAppearance.rows = 3
  characterAppearance.placeholder = '可补充年龄、脸型、发型、服装和配饰；不修改人物小传原文'
  const characterResource = el('p', 'media-notice'), characterStatus = el('p', 'media-notice'), characterPrompt = el('pre', 'media-job-snapshot')
  characterStatus.setAttribute('role', 'status')
  const characterPreview = el('details'); characterPreview.append(el('summary', '', '查看实际图片提示词'), characterPrompt)
  const characterSubmit = button('生成并保存到角色素材', submitCharacterImages, 'primary-button')
  const characterClose = button('取消', () => characterDialog.close()); characterClose.dataset.characterClose = ''
  const characterConfigure = button('配置图片执行端', () => { characterDialog.close(); navigate('connections') })
  const characterActions = el('div', 'dialog-actions'); characterActions.append(characterClose, characterConfigure, characterSubmit)
  characterDialog.append(characterHeading, el('p', 'dialog-description', '生成一张角色设定图：左侧正脸特写，右侧正面、90 度侧面、背面三视图。完成后自动存入角色素材；同名角色再次生成保留为独立版本。'), field('选择人物小传中的角色', characterPicker), field('角色名称', characterName), field('该角色的人物小传（可调整本次发送内容）', characterBiography), field('外观补充（可选）', characterAppearance), field('视觉风格', characterStyle), field('现有角色参考（可选）', characterReference), characterResource, characterPreview, characterStatus, characterActions)
  document.body.append(characterDialog)
  let characterOwner = null, characterSourceFingerprint = '', characterOptions = []
  characterPicker.addEventListener('change', () => {
    const selected = characterOptions[Number(characterPicker.value)]
    characterName.value = selected?.name || ''; characterBiography.value = selected?.biography || ''
    characterAppearance.value = ''; selectCharacterReference(); renderCharacterPreview()
  })
  for (const input of [characterName, characterBiography, characterAppearance, characterStyle, characterReference]) input.addEventListener('input', renderCharacterPreview)

  function selectCharacterReference() {
    const asset = assets.find(item => item.role === 'character' && item.name === `${characterName.value.trim()} · 正脸与三视图`)
    characterReference.value = asset?.selectedVersionId || ''
  }
  function characterInput() {
    return { name: characterName.value, biography: characterBiography.value, appearance: characterAppearance.value, style: characterStyle.value, referenceVersionId: characterReference.value }
  }
  function renderCharacterPreview() {
    const route = resolveConnectionRoute(context(), 'image')
    characterResource.textContent = `图片执行端：${route.connection?.name || route.error}。横向构图；生成会使用该执行端的账号额度。`
    try {
      characterPrompt.textContent = characterImagePrompt(characterInput())
      characterStatus.textContent = !invoke ? '请在桌面版生成角色图片。' : !route.connection ? route.error : '请核对本次角色资料和外观，再生成。'
      characterSubmit.disabled = !invoke || !route.connection || operationBusy
    } catch (problem) { characterPrompt.textContent = ''; characterStatus.textContent = problem.message; characterSubmit.disabled = true }
  }
  async function openCharacterImages() {
    await run(async () => {
      requireProject()
      const owner = context().projectId
      await beforeSubmit?.()
      if (context().projectId !== owner) throw new Error('项目已切换，请在目标项目中打开角色生成')
      await refresh()
      if (context().projectId !== owner) throw new Error('项目已切换，请重新打开角色生成')
      characterOwner = owner
      const source = context().documents.characters?.content || ''
      characterSourceFingerprint = contentFingerprint(source)
      characterOptions = biographyCharacters(source)
      characterPicker.replaceChildren(...characterOptions.map((item, index) => new Option(item.name, String(index))), new Option('手动填写单个角色', 'manual'))
      characterPicker.value = characterOptions.length ? '0' : 'manual'
      characterName.value = characterOptions[0]?.name || ''
      characterBiography.value = characterOptions[0]?.biography || (source.length <= 12000 ? source : '')
      characterAppearance.value = ''
      characterStyle.value = context().project.type === '漫剧' ? '漫画插画，清晰细致的角色设定' : '写实角色设定'
      characterReference.replaceChildren(new Option('不使用现有参考 · 设计新形象', ''))
      for (const asset of assets.filter(item => item.role === 'character' && item.kind === 'image')) for (const version of asset.versions || []) characterReference.append(new Option(`${asset.name} · ${version.id.slice(-8)}`, version.id))
      selectCharacterReference(); renderCharacterPreview(); characterDialog.showModal()
    })
    renderCharacterPreview()
  }
  async function submitCharacterImages() {
    await run(async () => {
      desktop(); await requireAdapterCatalog()
      const input = characterInput(), inputSignature = JSON.stringify(input), owner = characterOwner
      const prior = jobs.find(job => job.request?.character?.name === input.name.trim())
      input.targetId = prior?.targetId || await characterTargetId(input.name)
      const request = prepareCharacterRequest(context(), input), signature = JSON.stringify(request)
      const assertCurrent = () => {
        if (!characterDialog.open || owner !== context().projectId || owner !== request.projectId || characterSourceFingerprint !== contentFingerprint(context().documents.characters?.content || '') || inputSignature !== JSON.stringify(characterInput()) || signature !== JSON.stringify(prepareCharacterRequest(context(), input))) throw new Error('项目、人物小传、角色输入或图片执行端已变化，请重新打开并核对；未提交生成')
        if (loading || error) throw new Error('素材与任务尚未成功读取，请刷新后重试')
        if (jobs.some(job => job.targetId === request.targetId && job.capability === 'image' && !terminal(job.status))) throw new Error('该角色正在生成，请等待或取消后再试')
        if (request.references.some(ref => !findMediaVersion(assets, ref.versionId))) throw new Error('角色参考已不存在，请重新选择')
      }
      assertCurrent(); characterStatus.textContent = '正在保存创作并准备角色图片任务…'
      await beforeSubmit?.(); assertCurrent()
      const connection = connectionFor('image'), apiKey = connection.kind === 'cli' ? null : await secret(connection)
      assertCurrent()
      if (connection.kind !== 'cli' && !apiKey) throw new Error('请到连接中心配置图片执行端密钥')
      const job = await invoke('media_submit', { request: { ...request, apiKey: apiKey || null } })
      characterDialog.close()
      if (owner === context().projectId) {
        jobs = [job, ...jobs.filter(item => item.id !== job.id)]
        roleFilter.value = 'character'; navigate('assets'); await refresh()
      }
      notify('角色图任务已提交，完成后自动保存到原项目的角色素材，可在任务中心查看进度')
    })
    if (characterDialog.open) renderCharacterPreview()
  }

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
    const controls = [...document.querySelectorAll('#storyboardView button, #assetsView button, #mediaJobsDialog button, #mediaBatchDialog button, #characterImageDialog button')].filter(node => !node.disabled && !node.hasAttribute('data-media-close') && !node.hasAttribute('data-media-batch-close') && !node.hasAttribute('data-character-close'))
    controls.forEach(node => { node.disabled = true })
    storyboardView.setAttribute('aria-busy', 'true'); assetsView.setAttribute('aria-busy', 'true')
    try { return await action() }
    catch (problem) { notify(String(problem?.message || problem)) }
    finally { operationBusy = false; controls.forEach(node => { if (node.isConnected) node.disabled = false }); updateBatchConfirmation(); if (characterDialog.open) renderCharacterPreview(); storyboardView.removeAttribute('aria-busy'); assetsView.removeAttribute('aria-busy'); renderSources(); renderGenerationReadiness(); scheduleReferenceSync() }
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
    renderGenerationReadiness()
    if (characterDialog.open) renderCharacterPreview()
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
  function visibleShots(data = context()) { return scopedShots(data, selectedEpisodeId, selectedSourceId) }
  function selectDocument(documentId) {
    const scope = scopeForDocument(context(), documentId)
    if (!scope) return
    selectedEpisodeId = scope.episodeId; selectedSourceId = scope.sourceId; lastContextDocId = context().currentDocId
    renderSources(); renderShots(); renderCandidate()
  }
  function showSource(documentId) {
    const scope = scopeForDocument(context(), documentId)
    if (scope) { selectedEpisodeId = scope.episodeId; selectedSourceId = documentId }
  }
  function renderSources() {
    const data = context(), groups = storyboardGroups(data)
    if (lastContextDocId !== data.currentDocId) {
      lastContextDocId = data.currentDocId
      const scope = scopeForDocument(data, data.currentDocId)
      if (scope) { selectedEpisodeId = scope.episodeId; selectedSourceId = scope.sourceId }
    }
    let group = groups.find(item => item.id === selectedEpisodeId)
    if (!group) { group = groups[0]; selectedEpisodeId = group.id; selectedSourceId = group.sceneIds[0] || '' }
    if (selectedSourceId && !group.sourceIds.includes(selectedSourceId) && !(group.id === OTHER_EPISODE && selectedSourceId === UNASSIGNED_SOURCE)) selectedSourceId = group.sceneIds[0] || ''
    episodeSelect.replaceChildren(...groups.map(item => new Option(item.title, item.id)))
    episodeSelect.value = selectedEpisodeId
    sourceSelect.replaceChildren(new Option(group.id === OTHER_EPISODE ? '查看全部其他内容' : '查看全集', ''))
    for (const id of group.sourceIds) sourceSelect.append(new Option(`${id === group.id ? '分集正文 · ' : ''}${data.documents[id].title}`, id))
    if (group.id === OTHER_EPISODE) sourceSelect.append(new Option('未归属镜头（无来源或来源已删除）', UNASSIGNED_SOURCE))
    sourceSelect.value = selectedSourceId
    wholeEpisodeButton.textContent = group.id === OTHER_EPISODE ? '查看全部其他内容' : '查看全集'
    wholeEpisodeButton.setAttribute('aria-pressed', String(!selectedSourceId))
    addShotButton.disabled = !data.projectId || !data.documents[selectedSourceId]
    generateButton.disabled = addShotButton.disabled || Boolean(storyboardTasks.active()) || Boolean(data.textGenerating)
    generateButton.textContent = storyboardTasks.active() ? '拆镜任务执行中…' : 'AI 拆镜'
    renderStoryboardTaskProgress()
  }
  function renderShots({ detail = true } = {}) {
    const data = context(), shots = visibleShots(data)
    const group = storyboardGroups(data).find(item => item.id === selectedEpisodeId)
    const scopeTitle = selectedSourceId ? data.documents[selectedSourceId]?.title || '未归属镜头' : `${group?.title || '分镜'} · 全部`
    shotBody.classList.toggle('is-empty', !shots.length)
    shotStatus.textContent = !data.projectId ? '创建项目后即可从空白镜头或已有剧本开始。' : `${scopeTitle} · ${shots.length} 个镜头 · 项目共 ${data.storyboard.shots.length} 个 · 导出与批量生成使用当前查看范围。`
    const focusKey = shotList.contains(document.activeElement) ? document.activeElement.dataset.shotFocus : null
    const scrollTop = shotList.scrollTop
    shotList.replaceChildren()
    if (!shots.length) {
      const empty = el('div', 'media-empty')
      empty.append(el('h2', '', '当前范围尚无分镜'), el('p', '', selectedSourceId && data.documents[selectedSourceId] ? '点击 AI 拆镜或新建镜头，结果将归入当前分场。' : '选择具体分场或分集正文后，可 AI 拆镜或新建镜头。'))
      if (data.documents[selectedSourceId]) empty.append(button('新建第一个镜头', addShot))
      shotList.append(empty)
    }
    if (!shots.some(shot => shot.id === selectedShotId)) selectedShotId = shots[0]?.id || null
    let previousSource = null
    shots.forEach((shot, index) => {
      if (!selectedSourceId && previousSource !== shot.sourceDocumentId) {
        previousSource = shot.sourceDocumentId
        shotList.append(el('h3', 'shot-scene-heading', data.documents[shot.sourceDocumentId]?.title || '未归属镜头'))
      }
      const card = el('article', `shot-card${shot.id === selectedShotId ? ' is-selected' : ''}`)
      const select = button(`${String(index + 1).padStart(2, '0')}  ${shot.title}`, () => { select.focus({ preventScroll: true }); selectedShotId = shot.id; renderShots() }, 'shot-select')
      select.dataset.shotFocus = `${shot.id}:select`
      select.setAttribute('aria-pressed', String(shot.id === selectedShotId))
      const chosen = findMediaVersion(assets, shot.selectedImageVersionId)
      if (chosen) select.prepend(preview(chosen.version, shot.title))
      card.append(select, el('p', 'shot-list-excerpt', shot.visual || '补充画面、人物与构图'))
      const meta = el('div', 'shot-meta')
      meta.append(el('span', '', `${shot.duration}s · ${shot.transition === 'continuous' ? '连续动作' : '切换机位'}`))
      const readiness = shotReadiness(shot, assets, jobs, data.documents)
      meta.append(el('span', `shot-readiness is-${readiness.tone}`, readiness.label))
      if (shotIsStale(shot, data.documents)) meta.append(el('span', 'media-warning', '剧本来源已更新'))
      if (shot.references.some(ref => { const found = findMediaVersion(assets, ref.versionId); return found && found.asset.selectedVersionId !== ref.versionId })) meta.append(el('span', 'media-warning', '参考有新选用版本 · 原引用保留'))
      const actions = el('div', 'shot-order-actions')
      const up = button('↑', () => { up.focus({ preventScroll: true }); return reorder(shot.id, -1) }); up.setAttribute('aria-label', `上移镜头：${shot.title}`); up.title = '上移'; up.disabled = !shots.slice(0, index).some(item => item.sourceDocumentId === shot.sourceDocumentId)
      const down = button('↓', () => { down.focus({ preventScroll: true }); return reorder(shot.id, 1) }); down.setAttribute('aria-label', `下移镜头：${shot.title}`); down.title = '下移'; down.disabled = !shots.slice(index + 1).some(item => item.sourceDocumentId === shot.sourceDocumentId)
      up.dataset.shotFocus = `${shot.id}:up`; down.dataset.shotFocus = `${shot.id}:down`
      actions.append(up, down)
      const drag = button('⠿', () => notify('拖动此按钮可排序；也可使用上移、下移按钮'), 'text-button compact-button')
      drag.setAttribute('aria-label', `拖动排序镜头：${shot.title}`); drag.title = '拖动排序'
      drag.dataset.shotFocus = `${shot.id}:drag`
      drag.draggable = true
      drag.addEventListener('dragstart', event => { draggingShotId = shot.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', shot.id) })
      drag.addEventListener('dragend', () => { draggingShotId = null })
      card.addEventListener('dragover', event => { if (draggingShotId && draggingShotId !== shot.id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } })
      card.addEventListener('drop', event => {
        event.preventDefault()
        const moving = draggingShotId; draggingShotId = null
        if (!moving || moving === shot.id) return
        run(async () => { await changeStoryboard(list => moveSourceShot(list, moving, shot.id)); renderShots() })
      })
      actions.append(drag)
      card.append(meta, actions)
      shotList.append(card)
    })
    if (detail) renderShotDetail()
    if (focusKey) {
      const controls = [...shotList.querySelectorAll('[data-shot-focus]')]
      const target = controls.find(node => node.dataset.shotFocus === focusKey && !node.disabled) || controls.find(node => node.dataset.shotFocus === `${selectedShotId}:select`)
      target?.focus({ preventScroll: true })
      shotList.scrollTop = scrollTop
    }
  }
  async function addShot() {
    await run(async () => {
      requireProject()
      if (context().storyboard.shots.length >= SHOT_LIMIT) throw new Error(`最多 ${SHOT_LIMIT} 个镜头`)
      const data = context(), doc = data.documents[selectedSourceId]
      if (!doc) throw new Error('请先选择具体分场或分集正文')
      const shot = createShot({ title: `镜头 ${visibleShots().length + 1}` }, { documentId: selectedSourceId, fingerprint: contentFingerprint(doc.content) })
      await changeStoryboard(shots => shots.push(shot)); selectedShotId = shot.id; renderShots()
    })
  }
  async function reorder(id, direction) {
    await run(async () => {
      await changeStoryboard(shots => {
        const current = shots.find(shot => shot.id === id)
        if (!current) return
        const siblings = shots.filter(shot => shot.sourceDocumentId === current.sourceDocumentId)
        const target = siblings[siblings.findIndex(shot => shot.id === id) + direction]
        if (target) moveSourceShot(shots, id, target.id)
      })
      renderShots()
    })
  }
  function editShot(id, patch) {
    return changeStoryboard(shots => {
      const shot = shots.find(item => item.id === id)
      if (!shot) throw new Error('镜头已不存在')
      const videoChanged = Object.hasOwn(patch, 'selectedVideoVersionId') && patch.selectedVideoVersionId !== shot.selectedVideoVersionId
      const previousReferences = shot.references
      Object.assign(shot, patch)
      if (patch.references) Object.assign(shot, manualReferencePatch({ ...shot, references: previousReferences }, patch.references, assets))
      for (const field of Object.values(REFERENCE_ENTITY_FIELDS)) if (Object.hasOwn(patch, field) && patch[field] === undefined) delete shot[field]
      if (!loading && !error && projectId === context().projectId) shot.references = bindShotReferences(shot, assets, context().documents).references
      if (videoChanged) shot.reviewedVideoVersionId = ''
    }, { immediate: false }).then(() => { renderShots({ detail: false }); refreshReferenceDetails(); renderGenerationReadiness() }).catch(problem => notify(String(problem?.message || problem)))
  }
  function rememberShotDisclosures() {
    if (!detailShotId) return
    shotDisclosureState.set(detailShotId, new Map([...shotDetail.querySelectorAll('details[data-layout-key]')].map(node => [node.dataset.layoutKey, node.open])))
  }
  function restoreShotDisclosures() {
    const saved = shotDisclosureState.get(detailShotId)
    if (!saved) return
    for (const node of shotDetail.querySelectorAll('details[data-layout-key]')) if (saved.has(node.dataset.layoutKey)) node.open = saved.get(node.dataset.layoutKey)
  }
  function selectDetailPanel(panel, { focus = false, resetScroll = true } = {}) {
    detailPanel = panel
    for (const tab of shotDetail.querySelectorAll('[data-shot-panel-tab]')) {
      const selected = tab.dataset.shotPanelTab === panel
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1
      if (selected && focus) tab.focus({ preventScroll: true })
    }
    for (const node of shotDetail.querySelectorAll('[data-shot-panel]')) node.hidden = node.dataset.shotPanel !== panel
    if (resetScroll) shotDetail.scrollTop = 0
  }
  function showStage(stage) {
    mediaStage = stage; detailPanel = shotStagePanel(stage)
    renderShots()
    selectDetailPanel(detailPanel, { focus: true })
  }
  function renderGenerationReadiness() {
    const shot = selectedShot()
    if (!shot) return
    for (const control of shotDetail.querySelectorAll('[data-generate-capability]')) {
      const capability = control.dataset.generateCapability
      let problem = ''
      try {
        if (!invoke) throw new Error('请在桌面版生成媒体')
        if (!adapterCatalogReady) throw new Error('生成能力尚未读取，请刷新后重试')
        prepareShotRequest(shot.id, capability)
      } catch (error) { problem = error.message || String(error) }
      control.disabled = Boolean(problem) || operationBusy
      const status = shotDetail.querySelector(`[data-generation-readiness="${capability}"]`)
      if (status) { status.textContent = `${capability === 'image' ? '图片' : '视频'}：${problem || '已准备好，可以生成'}`; status.className = problem ? 'media-warning' : 'media-help' }
    }
  }
  function renderShotDetail() {
    rememberShotDisclosures()
    shotDetail.replaceChildren()
    const shot = selectedShot()
    const changedShot = detailShotId !== (shot?.id || null)
    detailShotId = shot?.id || null
    if (changedShot) shotDetail.scrollTop = 0
    if (!shot) return
    const heading = el('div', 'shot-detail-heading')
    heading.append(el('h2', '', '镜头详情'), el('span', 'media-help', '修改自动保存'))
    shotDetail.append(heading)
    const tabs = el('div', 'shot-detail-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '镜头工作区域')
    const panels = {}
    for (const [key, label] of [['content', '内容'], ['references', '参考'], ['generation', '生成'], ['versions', '版本']]) {
      const tab = button(label, () => selectDetailPanel(key), 'shot-detail-tab')
      tab.id = `shot-tab-${key}`; tab.dataset.shotPanelTab = key; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `shot-panel-${key}`)
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const keys = ['content', 'references', 'generation', 'versions'], index = keys.indexOf(key)
        selectDetailPanel(keys[event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4], { focus: true })
      })
      tabs.append(tab)
      const panel = el('section', 'shot-detail-panel'); panel.dataset.shotPanel = key; panel.id = `shot-panel-${key}`
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panels[key] = panel
    }
    shotDetail.append(tabs, ...Object.values(panels))
    if (shotIsStale(shot, context().documents)) shotDetail.append(el('p', 'media-warning', '剧本来源已变更。请核对本镜头，或重新拆镜；现有素材与状态仍保留。'))
    const fields = el('div', 'shot-fields')
    for (const [key, label, multiline] of [['title', '标题', false], ['visual', '画面与构图', true], ['action', '主要动作', true], ['dialogue', '对白', true], ['camera', '景别与运镜', true]]) {
      const input = el(multiline ? 'textarea' : 'input'); input.value = shot[key]; input.maxLength = key === 'title' ? 200 : 12000
      if (multiline) input.rows = 2
      input.addEventListener('input', () => editShot(shot.id, { [key]: input.value }))
      fields.append(field(label, input))
    }
    const duration = el('input'); duration.type = 'number'; duration.min = '1'; duration.max = '60'; duration.value = shot.duration
    duration.addEventListener('change', () => { if (duration.reportValidity()) editShot(shot.id, { duration: Number(duration.value) }) })
    const transition = el('select'); transition.append(new Option('切换机位／景别', 'cut'), new Option('连续动作', 'continuous')); transition.value = shot.transition
    transition.addEventListener('change', () => editShot(shot.id, { transition: transition.value }))
    const continuity = disclosure(`时长与衔接 · ${shot.duration} 秒 · ${shot.transition === 'continuous' ? '连续动作' : '切换机位'}`, 'continuity')
    const continuityFields = el('div', 'shot-fields')
    continuityFields.append(field('剧情时长（生成时长在“生成”中单独设置）', duration), field('与上一镜头的关系', transition))
    for (const [key, label] of [['entryState', '进入状态 · 人物、服装、位置、道具'], ['exitState', '结束状态']]) {
      const input = el('textarea'); input.value = shot[key]; input.maxLength = 12000; input.rows = 2
      input.addEventListener('input', () => editShot(shot.id, { [key]: input.value }))
      continuityFields.append(field(label, input))
    }
    continuity.append(continuityFields)
    panels.content.append(fields, continuity)
    renderShotCharacters(shot)
    renderShotReferenceInputs(shot)
    panels.references.append(shotDetail.querySelector('.shot-characters'), shotDetail.querySelector('.shot-reference-inputs'))
    const generationOptions = shotDetail.querySelector('.shot-generation-options')
    if (generationOptions) panels.generation.append(generationOptions)
    const selectedMedia = el('div', 'shot-selected-media')
    const selectedKind = mediaStage === 'videos' || mediaStage === 'export' ? 'video' : 'image'
    const currentMedia = findMediaVersion(assets, shot[selectedKind === 'image' ? 'selectedImageVersionId' : 'selectedVideoVersionId'])
    selectedMedia.append(el('h3', '', selectedKind === 'video' ? '当前选用视频' : '当前选用分镜图'), preview(currentMedia?.version, shot.title))
    selectedMedia.append(button('查看与选择版本', () => selectDetailPanel('versions', { focus: true })))
    panels.generation.prepend(selectedMedia)
    const generation = el('div', 'shot-generation-actions')
    if (jobs.some(job => job.targetId === shot.id && job.status === 'submission_unknown')) panels.generation.prepend(el('p', 'media-warning', '此镜头有提交结果未知的任务，可能已计费。请先在任务中心核对；再次点击生成会明确发起一个新任务，可能重复消耗额度。'))
    const readiness = el('div', 'shot-generation-readiness'); readiness.setAttribute('aria-live', 'polite')
    for (const capability of ['image', 'video']) {
      const generate = button(capability === 'image' ? '生成图片' : '生成视频', () => submitShot(shot.id, capability), (mediaStage === 'videos' ? capability === 'video' : capability === 'image') ? 'primary-button' : 'secondary-button')
      generate.dataset.generateCapability = capability; generation.append(generate)
      const status = el('p', 'media-help'); status.dataset.generationReadiness = capability; readiness.append(status)
    }
    panels.generation.prepend(generation, readiness)
    panels.generation.append(el('p', 'media-help', '生成会使用当前执行端的账号额度；图片与视频先保存为候选，需要明确选用。'), button('配置生成执行端', () => navigate('connections')))
    const media = el('div', 'shot-candidates')
    for (const kind of ['image', 'video']) {
      const selectedId = shot[kind === 'image' ? 'selectedImageVersionId' : 'selectedVideoVersionId']
      const candidates = assets.filter(asset => asset.kind === kind && (asset.versions?.some(version => version.id === selectedId) || jobs.some(job => job.targetId === shot.id && (job.assetId === asset.id || asset.versions?.some(version => version.metadata?.provenance?.jobId === job.id)))))
      const candidateCount = candidates.reduce((count, asset) => count + (asset.versions?.length || 0), 0)
      const group = disclosure(`${kind === 'image' ? '图片' : '视频'}候选 · ${candidateCount} 个版本`, `candidates-${kind}`, 'media-disclosure media-candidate-group')
      group.open = candidateCount > 0
      const imported = el('select'); imported.setAttribute('aria-label', `选用已有${kind === 'image' ? '图片' : '视频'}版本`); imported.append(new Option('选择项目内已有版本', ''))
      for (const asset of assets.filter(asset => asset.kind === kind)) for (const version of asset.versions || []) imported.append(new Option(`${asset.name} · ${version.id.slice(-8)}`, version.id))
      const reuse = disclosure('选用项目内已有素材', `reuse-${kind}`, 'media-help-disclosure')
      reuse.append(field('可复用导入素材与其他镜头版本', imported), button('选用已有版本', async () => { if (!imported.value) return notify('请选择一个版本'); await editShot(shot.id, { [kind === 'image' ? 'selectedImageVersionId' : 'selectedVideoVersionId']: imported.value }); renderShotDetail() }))
      group.append(reuse)
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
    const management = disclosure('镜头管理', 'management', 'media-help-disclosure shot-management')
    management.append(button('删除此镜头', () => run(async () => {
      if (!window.confirm(`删除“${shot.title}”？仅移除分镜与引用，已经生成的素材仍保留。`)) return
      await changeStoryboard(shots => shots.splice(shots.findIndex(item => item.id === shot.id), 1)); renderShots()
    }), 'danger-button'))
    panels.versions.append(media)
    panels.content.append(management)
    restoreShotDisclosures()
    const settingsPanel = panels.generation.querySelector('[data-layout-key="generation-settings"]')
    if (settingsPanel) settingsPanel.open = true
    renderGenerationReadiness()
    selectDetailPanel(detailPanel, { resetScroll: changedShot })
  }
  function renderShotReferenceInputs(shot) {
    const section = el('section', 'shot-reference-inputs')
    const generationOptions = el('section', 'shot-generation-options')
    const fixed = disclosure(`固定引用与输入画面 · ${shot.references.length} 项`, 'reference-inputs')
    const missingReferences = shot.references.filter(ref => !findMediaVersion(assets, ref.versionId)).length
    if (missingReferences) section.append(el('p', 'media-warning', `${missingReferences} 项固定引用的文件未找到，请展开下方引用检查。`))
    const bindingWarnings = referenceBindingWarnings(shot, assets, context().documents)
    if (bindingWarnings.legacy.length) section.append(el('p', 'media-notice', `${bindingWarnings.legacy.length} 项旧引用未记录自动或手动来源，已保留。修改角色、场景或道具后不会自动删除这些旧引用；请核对后移除或设为手动保留。`))
    if (bindingWarnings.unmatched.length) section.append(el('p', 'media-warning', `当前镜头未匹配但仍保留的手动／旧参考：${bindingWarnings.unmatched.map(item => item.name).join('、')}。请核对是否仍需用于生成与导出。`))
    fixed.append(el('p', 'media-help', '引用固定到具体版本。自动引用会随镜头人物、场景和道具同步；手动引用始终保留。'))
    const references = el('div', 'shot-references')
    for (const ref of shot.references) {
      const found = findMediaVersion(assets, ref.versionId), row = el('div', 'shot-reference-row')
      row.append(el('span', '', `${isContinuityReference(ref, assets) ? '图像一致性参考' : { reference: '主体视频参考', start: '起始帧', end: '结束帧', extend: '续接视频' }[ref.role]} · ${found?.asset.name || '文件未找到'} · ${ref.versionId.slice(-8)} · ${{ auto: '自动关联', manual: '手动保留' }[ref.origin] || '旧引用'}`), button('移除', () => editShot(shot.id, { references: selectedShot().references.filter(item => item !== ref && !(item.versionId === ref.versionId && item.role === ref.role)) }).then(renderShotDetail)))
      if (ref.origin !== 'manual') row.append(button('设为手动保留', () => editShot(shot.id, { references: selectedShot().references.map(item => item.versionId === ref.versionId && item.role === ref.role ? { ...item, origin: 'manual' } : item) }).then(renderShotDetail)))
      if (ref.role === 'reference') row.append(button(isContinuityReference(ref, assets) ? '改为视频输入' : '仅作一致性参考', () => editShot(shot.id, { references: selectedShot().references.map(item => item.versionId === ref.versionId && item.role === ref.role ? { ...item, scope: isContinuityReference(ref, assets) ? 'video' : 'continuity' } : item) }).then(renderShotDetail)))
      references.append(row)
    }
    const referenceSelect = el('select'), referenceRole = el('select')
    referenceSelect.setAttribute('aria-label', '参考媒体版本'); referenceRole.setAttribute('aria-label', '参考用途')
    referenceSelect.append(new Option('选择已导入／生成的版本', ''))
    for (const asset of assets) for (const version of asset.versions || []) referenceSelect.append(new Option(`${ASSET_ROLES[asset.role] || '素材'} · ${asset.name} · ${version.id.slice(-8)}`, version.id))
    for (const [value, label] of [['reference', '主体参考（视频输入）'], ['continuity', '图像一致性参考'], ['start', '起始帧'], ['end', '结束帧'], ['extend', '续接视频']]) referenceRole.append(new Option(label, value))
    references.append(referenceSelect, referenceRole, button('添加参考', async () => {
      const versionId = referenceSelect.value, role = referenceRole.value === 'continuity' ? 'reference' : referenceRole.value, scope = referenceRole.value === 'continuity' ? 'continuity' : 'video', current = selectedShot()
      if (!versionId) return notify('请先选择一个媒体版本')
      if (current.references.some(ref => ref.versionId === versionId && ref.role === role)) return notify('这个版本已作为该用途引用')
      if (current.references.length >= 16) return notify('单镜头最多 16 项参考，实际接口可能支持更少')
      await editShot(shot.id, { references: [...current.references, { versionId, role, scope }] }); renderShotDetail()
    }))
    fixed.append(references); section.append(fixed)
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
    const videoConnection = connectionFor('video'), videoParameters = videoParameterState(shot, videoConnection)
    const videoDuration = el('select')
    videoDuration.append(new Option(`沿用剧情时长（${shot.duration} 秒）`, ''))
    const durations = videoParameters.allowedDurations.length ? videoParameters.allowedDurations : [4, 6, 8]
    if (shot.videoDuration !== undefined && !durations.includes(shot.videoDuration)) videoDuration.append(new Option(`${shot.videoDuration} 秒（当前模式不支持）`, String(shot.videoDuration)))
    for (const seconds of durations) videoDuration.append(new Option(`${seconds} 秒`, String(seconds)))
    videoDuration.value = shot.videoDuration === undefined ? '' : String(shot.videoDuration)
    videoDuration.addEventListener('change', async () => { await editShot(shot.id, { videoDuration: videoDuration.value ? Number(videoDuration.value) : undefined }); renderShotDetail() })
    settings.append(field('视频生成时长（不改变剧情时长）', videoDuration))
    shotResourceStatus = el('p', 'media-help')
    shotResourceStatus.setAttribute('role', 'status')
    const modeName = ({ 'image-to-video': '分镜图生成视频', 'reference-to-video': '主体参考图生成视频', 'first-last': '首尾帧生成视频', extend: '视频续接' })[shot.videoMode || 'image-to-video']
    const generationSettings = disclosure(`生成设置 · ${shot.aspectRatio || '16:9'} · ${modeName} · ${videoParameters.duration} 秒`, 'generation-settings')
    generationSettings.append(settings, shotResourceStatus, el('p', 'media-notice', `${({ 'image-to-video': '本次视频只上传起始帧（优先显式指定，否则使用选用分镜图）。主体参考应先融入分镜图。', 'reference-to-video': '本次上传标记为“主体参考”的图片（最多 3 张，8 秒），不混用首尾帧或续接视频。', 'first-last': '本次上传起始帧和结束帧。起始帧未指定时使用选用分镜图，不混用主体参考和续接视频。', extend: '本次上传标记为“续接视频”的同执行端原生 Veo 视频。' })[shot.videoMode || 'image-to-video']} 一致性参考保留在镜头中；显式视频输入仍按所选模式校验。`))
    try {
      const input = prepareShotInputs(shot, assets, 'video')
      generationOptions.append(el('p', 'media-notice', `本次视频上传：${input.references.map(ref => `${({ start: '起始帧', end: '结束帧', reference: '主体参考', extend: '续接视频' })[ref.role]} · ${findMediaVersion(assets, ref.versionId)?.asset.name || ref.versionId}`).join('；') || '暂无输入'}。${input.retained.length ? `另有 ${input.retained.length} 项一致性参考保留用于分镜图，本次不单独上传，请先核对选用图中的人物与场景。` : ''}`))
      if (videoConnection && !videoParameters.issues.length) validateVideoParameters(shot, assets, videoConnection, input)
    } catch (problem) { generationOptions.append(el('p', 'media-warning', `视频输入：${problem.message}`)) }
    for (const issue of videoParameters.issues) generationOptions.append(el('p', 'media-warning', issue))
    generationOptions.append(generationSettings, el('p', 'media-help', `剧情时长 ${shot.duration} 秒；本次生成 ${videoParameters.duration} 秒。生成结果的实际时长以执行端返回为准，剪辑时按剧情节奏处理。`))
    shotDetail.append(section, generationOptions)
    renderShotResourceStatus()
  }
  function renderShotCharacters(shot) {
    const section = el('section', 'shot-characters')
    section.append(el('h3', '', '角色、场景与道具参考'))
    const adjustment = disclosure('调整自动识别与参考图', 'reference-matching', 'media-help-disclosure')
    adjustment.append(el('p', 'media-help', '补图后自动关联；改角色、场景或道具时同步移除不再匹配的自动引用。手动选择、旧引用与仍适用的固定版本保留；手动移除不会自动加回。'))
    for (const [role, fieldName] of Object.entries(REFERENCE_ENTITY_FIELDS)) {
      const input = el('input'); input.value = (shot[fieldName] || []).join('、')
      input.placeholder = shot[fieldName] === undefined ? '按镜头内容自动识别' : '为空表示本镜头不需要此类参考'
      input.addEventListener('change', () => run(async () => {
        const names = [...new Set(input.value.split(/[、,，\n]/).map(name => name.trim()).filter(Boolean))]
        if (names.length > 16 || names.some(name => name.length > 80)) throw new Error('每类最多 16 个名称，每项不超过 80 字')
        await editShot(shot.id, { [fieldName]: names }); renderShotDetail()
      }))
      adjustment.append(field(`本镜头${ASSET_ROLES[role]}名称`, input))
    }
    const matches = bindShotReferences(shot, assets, context().documents).matches
    for (const match of matches) section.append(el('p', ['bound', 'excluded'].includes(match.status) ? 'media-help' : 'media-warning', `${ASSET_ROLES[match.role]} · ${match.name}${match.inferred ? '（自动识别）' : ''}：${({ bound: '已关联参考图', ready: '等待自动关联', missing: '缺少已选用的图片版本，补图后自动关联', ambiguous: '同名或场景时段无法唯一确定，请手动选择', excluded: '已手动排除，不自动关联', limit: '已达 16 项参考上限' })[match.status]}`))
    if (!matches.length) section.append(el('p', 'media-help', '未识别到需要关联的已知素材。可在下方补充名称；场景素材请用“地点 · 日／夜”等名称区分时段。'))
    adjustment.append(button('重新按镜头内容识别', () => run(async () => { await editShot(shot.id, { characterNames: undefined, sceneNames: undefined, propNames: undefined }); renderShotDetail() })))
    if (shot.referenceExclusions?.length) adjustment.append(button('恢复自动关联已排除素材', () => run(async () => { await editShot(shot.id, { referenceExclusions: [] }); renderShotDetail() })))
    const choices = el('div', 'shot-character-choices')
    for (const asset of assets.filter(item => Object.hasOwn(REFERENCE_ENTITY_FIELDS, item.role) && item.kind === 'image')) {
      const pinned = asset.versions.filter(version => shot.references.some(ref => ref.versionId === version.id))
      const selected = asset.versions.find(version => version.id === asset.selectedVersionId)
      const versions = [...pinned, ...(selected && !pinned.some(version => version.id === selected.id) ? [selected] : [])]
      for (const version of versions) {
        const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = shot.references.some(ref => ref.role === 'reference' && ref.versionId === version.id)
        checkbox.addEventListener('change', () => run(async () => {
          const current = context().storyboard.shots.find(item => item.id === shot.id)
          if (!current) throw new Error('镜头已不存在')
          const references = current.references.filter(ref => !(ref.role === 'reference' && ref.versionId === version.id))
          if (checkbox.checked) {
            if (references.length >= 16) { checkbox.checked = false; throw new Error('单镜头最多 16 项参考') }
            references.push({ versionId: version.id, role: 'reference', scope: 'continuity' })
          }
          await editShot(shot.id, { references }); renderShotDetail()
        }))
        const label = el('label', 'shot-character-choice'); label.append(checkbox, el('span', '', `${ASSET_ROLES[asset.role]} · ${asset.name} · ${version.id.slice(-8)}${version.id !== asset.selectedVersionId ? '（已固定的旧版本）' : ''}`)); choices.append(label)
      }
    }
    if (!choices.childElementCount) choices.append(el('p', 'media-help', '暂无可用参考图。导入图片并标为角色、场景或道具，选用版本后会自动匹配。'))
    adjustment.append(choices); section.append(adjustment); shotDetail.append(section)
  }
  function refreshReferenceDetails() {
    const shot = selectedShot()
    if (!shot) return
    rememberShotDisclosures()
    const characters = shotDetail.querySelector('.shot-characters')
    if (characters && !characters.contains(document.activeElement)) { renderShotCharacters(shot); characters.replaceWith(shotDetail.lastElementChild) }
    const references = shotDetail.querySelector('.shot-reference-inputs'), options = shotDetail.querySelector('.shot-generation-options')
    if (references && !references.contains(document.activeElement) && !options?.contains(document.activeElement)) {
      renderShotReferenceInputs(shot)
      const nextOptions = shotDetail.lastElementChild, nextReferences = nextOptions.previousElementSibling
      references.replaceWith(nextReferences)
      if (options) options.replaceWith(nextOptions)
      else shotDetail.querySelector('[data-shot-panel="generation"]')?.append(nextOptions)
    }
    restoreShotDisclosures()
    renderGenerationReadiness()
  }
  function scheduleReferenceSync() {
    window.clearTimeout(referenceSyncTimer)
    referenceSyncTimer = window.setTimeout(() => { referenceSyncTimer = null; synchronizeReferences() }, 100)
  }
  async function synchronizeReferences() {
    const data = context()
    if (!invoke || !data.projectId || projectId !== data.projectId || error) return
    if (data.mutationBusy && !referenceSyncBusy) { scheduleReferenceSync(); return }
    if (referenceSyncBusy || loading || operationBusy || storyboardTasks.active() || data.textGenerating) return
    const plan = planReferenceBackfill(data.storyboard, assets, data.documents)
    if (!plan.changed) return
    referenceSyncBusy = true
    try {
      await commit({ storyboard: plan.storyboard }, { projectId: data.projectId, revision: data.storyboard.revision, atomic: true })
      if (context().projectId !== data.projectId) return
      renderShots({ detail: false }); refreshReferenceDetails()
      notify(`已同步 ${plan.changed} 个镜头的参考：补齐 ${plan.added} 项${plan.removed ? `，移除 ${plan.removed} 项已失效自动引用` : ''}`)
    } catch (problem) { notify(`参考自动关联未保存：${String(problem?.message || problem)}；可在任务中心刷新后重试`) }
    finally { referenceSyncBusy = false }
  }
  function reserveStoryboardTask(input) {
    const task = storyboardTasks.reserve(input)
    renderSources(); if (jobsDialog.open) renderJobs()
    return task.id
  }
  function updateStoryboardTask(id, patch) {
    const previousPhase = storyboardTasks.get(id)?.phase
    storyboardTasks.update(id, patch)
    if (previousPhase === storyboardTasks.get(id)?.phase) { updateStoryboardTaskLabels(); return }
    renderSources()
    if (jobsDialog.open) renderJobs()
  }
  function releaseStoryboardTask(id) {
    storyboardTasks.release(id)
    scheduleReferenceSync()
    renderSources(); if (jobsDialog.open) renderJobs()
  }
  function stopStoryboardTask(id) {
    const task = storyboardTasks.get(id)
    if (!task?.locked) return
    updateStoryboardTask(id, { phase: 'cancelling' })
    if (task.bound) stopText?.()
    else releaseStoryboardTask(id)
  }
  function storyboardTaskCard(task) {
    const data = context(), card = el('article', 'media-job')
    const title = data.projectId === task.projectId ? data.documents[task.documentId]?.title || task.title : task.title
    const status = el('p', 'media-help storyboard-task-progress-label', storyboardTaskLabel(task))
    status.dataset.storyboardTaskId = task.id
    card.append(el('strong', '', `AI 拆镜 · ${title}`), status)
    if (task.locked) {
      const progress = el('progress'); progress.setAttribute('aria-label', `${title}：${STORYBOARD_TASK_PHASES[task.phase]}`)
      card.append(progress)
    }
    if (task.message) card.append(el('p', 'media-warning', task.message))
    if (data.projectId === task.projectId && data.documents[task.documentId]) card.append(button('定位分场', () => { selectDocument(task.documentId); if (jobsDialog.open) jobsDialog.close(); navigate('storyboard') }))
    if (task.locked && task.phase !== 'saving') {
      const stop = button(task.phase === 'cancelling' ? '正在停止…' : '停止拆镜', () => stopStoryboardTask(task.id))
      stop.disabled = task.phase === 'cancelling'; card.append(stop)
    }
    return card
  }
  function storyboardTaskLabel(task) {
    const elapsed = Math.max(0, Math.floor(((task.finishedAt || Date.now()) - task.startedAt) / 1000))
    return `${STORYBOARD_TASK_PHASES[task.phase]} · ${elapsed} 秒 · 已收到 ${task.characters} 字符 · 任务 ${task.id.slice(-8)}`
  }
  function updateStoryboardTaskLabels() {
    for (const node of document.querySelectorAll('.storyboard-task-progress-label')) {
      const task = storyboardTasks.get(node.dataset.storyboardTaskId)
      if (task) node.textContent = storyboardTaskLabel(task)
    }
  }
  function renderStoryboardTaskProgress() {
    const data = context(), active = storyboardTasks.active()
    const task = active || storyboardTasks.list(data.projectId).find(item => !selectedSourceId || item.documentId === selectedSourceId)
    storyboardTaskHost.replaceChildren(); storyboardTaskHost.hidden = !task
    if (task) storyboardTaskHost.append(storyboardTaskCard(task), button('查看任务中心', showJobs))
  }
  async function generateStoryboard() {
    let taskId = null
    try {
      requireProject()
      const data = context(), documentId = sourceSelect.value, doc = data.documents[documentId]
      if (referenceSyncBusy || storyboardTasks.active() || data.textGenerating) throw new Error('已有 AI 任务正在执行，请等待结束后再拆镜')
      if (invoke && (loading || error || projectId !== data.projectId)) throw new Error('角色素材尚未读取完成，请稍后重试拆镜')
      if (!doc?.content.trim()) throw new Error('所选文档为空，请先创作或粘贴剧本')
      const connection = connectionFor('storyboard')
      if (!connection) throw new Error(resolveConnectionRoute(data, 'storyboard').error)
      taskId = reserveStoryboardTask({ id: crypto.randomUUID(), projectId: data.projectId, documentId, title: doc.title })
      const started = await requestText(storyboardPrompt('', projectCharacterNames(data.documents, assets), referenceCatalog(assets)), { purpose: 'storyboard', documentId, sourceFingerprint: contentFingerprint(doc.content), storyboardSourceFingerprint: storyboardSourceFingerprint(data.storyboard, documentId), storyboardRevision: data.storyboard.revision, connectionId: connection.id, storyboardTaskId: taskId })
      if (!started && !storyboardTasks.get(taskId)?.bound) releaseStoryboardTask(taskId)
    } catch (problem) {
      if (taskId && !storyboardTasks.get(taskId)?.bound) { updateStoryboardTask(taskId, { phase: 'failed', message: String(problem?.message || problem) }); releaseStoryboardTask(taskId) }
      notify(String(problem?.message || problem))
    }
  }
  function candidateSnapshot(text, generationContext, draftId = null, createdAt = null) {
    return { text, draftId, createdAt, projectId: generationContext.projectId, documentId: generationContext.documentId, fingerprint: generationContext.sourceFingerprint, revision: generationContext.storyboardRevision, storyboardSourceFingerprint: generationContext.storyboardSourceFingerprint }
  }
  async function receiveCandidate(text, generationContext, draftId = null, { autoApply = false, createdAt = null } = {}) {
    const received = candidateSnapshot(text, generationContext, draftId, createdAt)
    candidate = received
    renderCandidate()
    const applied = autoApply ? await applyCandidate(false, { automatic: true, expectedCandidate: received }) : false
    if (context().projectId === received.projectId) navigate('storyboard')
    return applied
  }
  function clearCandidate(draftId) {
    if (!candidate || candidate.draftId !== draftId) return
    candidate = null
    renderCandidate()
  }
  function renderCandidate() {
    candidateHost.replaceChildren()
    const group = storyboardGroups(context()).find(item => item.id === selectedEpisodeId)
    const visible = candidate?.text.trim() && (selectedSourceId ? candidate.documentId === selectedSourceId : group?.sourceIds.includes(candidate.documentId))
    candidateHost.hidden = !visible
    if (!visible) return
    const text = el('textarea'); text.rows = 7; text.value = candidate.text; text.setAttribute('aria-label', '可编辑的 AI 分镜候选 JSON')
    const summary = el('div', 'media-help')
    const candidateSummary = el('p', 'media-help')
    const previewDetails = disclosure('查看镜头与参考图明细', '', 'media-help-disclosure')
    previewDetails.append(summary)
    const rawDetails = disclosure('编辑候选原始数据', '', 'media-help-disclosure')
    rawDetails.append(text)
    const displayed = candidate
    const updateSummary = () => {
      try {
        const shots = parseStoryboardCandidate(displayed.text)
        candidateSummary.className = 'media-help'
        candidateSummary.textContent = `${shots.length} 个候选镜头，尚未写入项目。采纳时自动关联参考图。`
        summary.replaceChildren(el('p', '', `${shots.length} 个候选镜头，尚未写入项目。采纳时将关联下面列出的角色、场景和道具图。`))
        for (const [index, shot] of shots.entries()) {
          const { matches } = bindShotReferences(shot, assets, context().documents)
          summary.append(el('p', '', `${index + 1}. ${shot.title} · ${matches.length ? matches.map(match => `${ASSET_ROLES[match.role]} · ${match.name}（${({ excluded: '已手动排除', ready: '可关联', bound: '已关联', missing: '缺图', ambiguous: '同名需手选', limit: '超出参考上限' })[match.status]}）`).join('、') : shot.characterNames ? '无出场角色' : '未提供角色信息，可补充 characterNames 或重新拆镜'}`))
        }
      } catch (problem) { candidateSummary.textContent = problem.message; candidateSummary.className = 'media-warning'; summary.textContent = problem.message; rawDetails.open = true }
    }
    text.addEventListener('input', () => {
      if (candidate !== displayed) return
      displayed.text = text.value; updateSummary()
      try {
        Promise.resolve(onCandidateChange?.(displayed.draftId, displayed.text)).catch(problem => notify(`候选修改尚未保存：${String(problem?.message || problem)}`))
      } catch (problem) { notify(`候选修改尚未保存：${String(problem?.message || problem)}`) }
    })
    updateSummary()
    const actions = el('div', 'media-toolbar')
    actions.append(button('采纳并追加镜头', () => applyCandidate(false), 'primary-button'), button('替换该来源的分镜', () => applyCandidate(true)), button('放弃候选', () => run(async () => {
      text.readOnly = true
      try {
        if (await onCandidateResolved?.(displayed.draftId, { committed: false }) === false) return
        if (candidate === displayed) candidate = null
        renderCandidate()
      } finally { if (text.isConnected) text.readOnly = false }
    })))
    candidateHost.append(el('h2', '', 'AI 分镜候选'), el('p', 'media-help', `${candidateGeneratedAtLabel(displayed.createdAt)} · 批次 ${displayed.draftId?.slice(-8) || '未记录'}`), candidateSummary, actions, previewDetails, rawDetails)
  }
  async function applyCandidate(replace = false, { automatic = false, expectedCandidate = candidate } = {}) {
    return run(async () => {
      // Refresh inside the operation lock so newly selected asset versions are
      // used, and a slow media read cannot apply a different/restored candidate.
      if (automatic) await refresh()
      const data = context()
      if (candidate !== expectedCandidate) throw new Error('当前候选或项目已切换，未自动添加分镜')
      if (!candidate || candidate.projectId !== data.projectId) throw new Error('候选属于另一个项目')
      if (invoke && (loading || error || projectId !== data.projectId)) throw new Error('角色素材尚未读取完成，请稍后重试采纳')
      if (candidate.storyboardSourceFingerprint && candidate.storyboardSourceFingerprint !== storyboardSourceFingerprint(data.storyboard, candidate.documentId)) throw new Error('此分场的分镜在生成后已有修改。候选已保留，请核对此分场后重新拆镜；其他分场的修改不会影响采纳。')
      if (contentFingerprint(data.documents[candidate.documentId]?.content || '') !== candidate.fingerprint) throw new Error('剧本在生成后已修改。请重新拆镜，原候选仍保留。')
      const applying = candidate
      const shots = parseStoryboardCandidate(applying.text, { documentId: applying.documentId, fingerprint: applying.fingerprint })
      const unresolved = new Set()
      let boundReferences = 0
      for (const shot of shots) {
        const binding = bindShotReferences(shot, assets, context().documents)
        shot.references = binding.references
        boundReferences += shot.references.length
        for (const match of binding.matches) if (!['ready', 'bound', 'excluded'].includes(match.status)) unresolved.add(match.name)
      }
      const replacingCount = replace ? data.storyboard.shots.filter(shot => shot.sourceDocumentId === applying.documentId).length : 0
      if (shots.length + data.storyboard.shots.length - replacingCount > SHOT_LIMIT) throw new Error(`项目最多 ${SHOT_LIMIT} 个镜头`)
      if (replace && replacingCount && !window.confirm(`替换此来源的 ${replacingCount} 个镜头？${!applying.storyboardSourceFingerprint ? '这是旧版候选，无法核对生成时的分场镜头快照，请先检查当前分镜。' : ''}其他分场的镜头保留，已生成素材保留。`)) return
      const editor = candidateHost.querySelector('textarea')
      if (editor) editor.readOnly = true
      try {
        await changeStoryboard(list => { if (replace) replaceSourceShots(list, applying.documentId, shots); else list.push(...shots) }, { resolvedCandidateId: applying.draftId })
      } finally { if (editor?.isConnected) editor.readOnly = false }
      if (candidate === applying) candidate = null
      // The commit already resolved this draft with the storyboard. A UI callback
      // failure must never turn a successful commit into a retryable append.
      try { await onCandidateResolved?.(applying.draftId, { committed: true }) }
      catch (problem) { notify(`分镜已保存，待审稿显示刷新失败：${String(problem?.message || problem)}`) }
      if (data.projectId === context().projectId) { showSource(applying.documentId); renderSources(); selectedShotId = shots[0].id; renderCandidate(); renderShots() }
      notify(`${automatic ? '拆镜完成，已自动保存' : '已保存'} ${shots.length} 个镜头，关联 ${boundReferences} 项角色／场景／道具参考${unresolved.size ? `；待补充或确认：${[...unresolved].join('、')}` : ''}`)
      return shots.length
    })
  }
  function prepareShotRequest(id, capability) {
    const data = context(), shot = data.storyboard.shots.find(item => item.id === id), connection = connectionFor(capability)
    if (!shot) throw new Error('镜头不存在')
    if (!shot.visual.trim()) throw new Error('请先填写镜头画面')
    if (!connection) throw new Error(resolveConnectionRoute(data, capability).error)
    if (invoke && (loading || error)) throw new Error('素材与任务尚未成功读取，请先刷新后预览')
    if (jobs.some(job => job.targetId === id && job.capability === capability && !terminal(job.status))) throw new Error('此镜头同类任务正在执行，请等待或取消后再提交')
    const videoParameters = capability === 'video' ? videoParameterState(shot, connection) : null
    if (videoParameters?.issues.length) throw new Error(videoParameters.issues.join('；'))
    const input = prepareShotInputs(shot, assets, capability), { mode, references: refs } = input
    if (capability === 'video') validateVideoParameters(shot, assets, connection, input)
    const adapter = mediaAdapterFor(connection, capability)
    if (adapter.modes && !adapter.modes.includes(mode)) throw new Error('所选适配器不支持此生成模式；未提交生成')
    if (adapter.referenceRoles && (refs.length > adapter.maxReferences || refs.some(ref => !adapter.referenceRoles.includes(ref.role)))) throw new Error('参考数量或用途超出所选适配器能力；未提交生成')
    const labels = refs.map((ref, index) => `输入 ${index + 1}：${ref.role} · ${findMediaVersion(assets, ref.versionId).asset.name} · 固定版本 ${ref.versionId}`)
    return {
      projectId: data.projectId, targetId: id, capability, prompt: mediaPrompt(shot, data.project, labels), references: refs,
      connection: { id: connection.id, kind: connection.kind === 'cli' ? 'cli' : 'api', driverId: connection.driverId || null, baseUrl: connection.baseUrl || '', model: connection.kind === 'cli' ? connection.planningModel || '' : connection.model || '', adapter: adapter.id },
      parameters: { mode, aspectRatio: shot.aspectRatio || '16:9', duration: videoParameters?.duration ?? shot.duration, size: shot.imageSize || 'auto', quality: shot.imageQuality || 'auto' },
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
    if (batchCapability.value === 'video') {
      const duration = el('select'); duration.append(new Option('选择生成时长', ''), ...[4, 6, 8].map(seconds => new Option(`${seconds} 秒`, String(seconds))))
      const controls = el('div', 'shot-fields')
      controls.append(field('统一设置已选镜头的视频时长', duration), button('应用到已选镜头', () => run(() => setBatchVideoDuration(Number(duration.value)))))
      batchShots.append(controls, el('p', 'media-help', '仅修改视频生成时长，保留各镜头剧情时长。Veo 图生视频／首尾帧支持 4、6、8 秒，主体参考和续接需 8 秒；应用后重新预览。'))
    }
    for (const [index, shot] of context().storyboard.shots.filter(shot => batchScopeIds.includes(shot.id)).entries()) {
      const label = el('label', 'media-batch-option'), input = el('input')
      input.type = 'checkbox'; input.checked = batchSelection.has(shot.id)
      input.addEventListener('change', () => {
        if (input.checked && batchSelection.size >= BATCH_LIMIT) { input.checked = false; batchStatus.textContent = '每批最多 20 个镜头，请先移除其他镜头。'; return }
        if (input.checked) batchSelection.add(shot.id); else batchSelection.delete(shot.id)
        invalidateBatchPlan()
      })
      label.append(input, el('span', '', `${String(index + 1).padStart(2, '0')} · ${shot.title}${batchCapability.value === 'video' ? ` · 生成 ${shot.videoDuration ?? shot.duration} 秒／剧情 ${shot.duration} 秒` : ''}`)); batchShots.append(label)
    }
    if (!batchScopeIds.length) batchShots.append(el('p', 'media-help', '尚无镜头。返回分镜新建镜头或从剧本拆镜后再制定计划。'))
  }
  async function setBatchVideoDuration(seconds) {
    if (![4, 6, 8].includes(seconds)) throw new Error('请明确选择 4、6 或 8 秒的视频生成时长')
    const ids = new Set(batchSelection)
    if (!ids.size || ids.size > BATCH_LIMIT) throw new Error('请先选择 1–20 个镜头')
    await changeStoryboard(shots => {
      if (shots.filter(shot => ids.has(shot.id)).length !== ids.size) throw new Error('所选镜头已变化，请重新打开批量计划')
      for (const shot of shots) if (ids.has(shot.id)) shot.videoDuration = seconds
    })
    renderShots({ detail: false }); refreshReferenceDetails(); renderGenerationReadiness(); renderBatchSelection()
    invalidateBatchPlan(`已将 ${ids.size} 个镜头的生成时长设为 ${seconds} 秒，剧情时长保持不变。请重新预览检查模式与输入。`)
  }
  function openBatchPlan(options = {}) {
    try {
      requireProject()
      if (options.projectId && options.projectId !== context().projectId) throw new Error('项目已切换，未打开其他项目的生成计划')
      if (options.shotIds) {
        if (!['image', 'video'].includes(options.capability) || !Array.isArray(options.shotIds) || !options.shotIds.length || options.shotIds.length > BATCH_LIMIT || new Set(options.shotIds).size !== options.shotIds.length || options.shotIds.some(id => !context().storyboard.shots.some(shot => shot.id === id))) throw new Error('待生成镜头或能力已失效，请重新制定计划')
        batchCapability.value = options.capability
      }
      batchScopeIds = options.shotIds || visibleShots().map(shot => shot.id)
      batchSelection = new Set(options.shotIds || (batchScopeIds.includes(selectedShotId) ? [selectedShotId] : []))
      renderBatchSelection(); renderBatchConnection(); invalidateBatchPlan()
      if (!batchDialog.open) batchDialog.showModal()
      return true
    } catch (problem) { notify(String(problem?.message || problem)); return false }
  }
  function batchRequests(capability) {
    const shots = context().storyboard.shots.filter(shot => batchSelection.has(shot.id))
    if (!shots.length || shots.length > BATCH_LIMIT || shots.length !== batchSelection.size) throw new Error('请选择 1–20 个仍存在的镜头')
    const requests = [], problems = []
    for (const shot of shots) {
      try { requests.push(prepareShotRequest(shot.id, capability)) }
      catch (problem) { problems.push(`${shot.title}：${problem.message}`) }
    }
    if (problems.length) throw new Error(`有 ${problems.length} 个镜头暂不能生成，尚未提交本批次：\n${problems.join('\n')}`)
    return requests
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
        item.append(el('strong', '', shot.title), el('p', 'media-help', `${connection.name} · ${request.parameters.mode} · ${request.parameters.aspectRatio}${capability === 'video' ? ` · 生成 ${request.parameters.duration} 秒／剧情 ${shot.duration} 秒` : ` · ${request.parameters.size} / ${request.parameters.quality}`}`))
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
    if (data.projectId !== projectId) { projectId = data.projectId; assets = []; jobs = []; recoveryIssues = []; selectedShotId = null; selectedAssetId = null; candidate = null; selectedSourceId = ''; selectedEpisodeId = ''; lastContextDocId = null; shotDisclosureState.clear(); detailShotId = null; detailPanel = 'content'; mediaStage = 'storyboard'; batchSelection.clear(); invalidateBatchPlan(); batchDialog.close() }
    renderEndpoints(); renderSources(); renderShots({ detail: !shotDetail.contains(document.activeElement) && ![...shotDetail.querySelectorAll('video')].some(video => !video.paused) }); if (!candidateHost.contains(document.activeElement)) renderCandidate(); renderAssets()
    if (!invoke || !data.projectId) { error = ''; renderAssets(); return }
    loading = true; renderAssets()
    try {
      const snapshot = await invoke('media_list', { projectId: data.projectId })
      if (sequence !== requestSequence || data.projectId !== context().projectId) return
      const completedCharacters = (snapshot.jobs || []).filter(job => job.request?.character && job.status === 'completed' && jobs.some(prior => prior.id === job.id && prior.status !== 'completed'))
      assets = snapshot.assets || []; jobs = snapshot.jobs || []; recoveryIssues = snapshot.recoveryIssues || []; error = ''
      if (completedCharacters.length) {
        if (!assetsView.hidden && roleFilter.value === 'character' && !assetDrafts.has(`${data.projectId}:${selectedAssetId}`)) selectedAssetId = completedCharacters[0].assetId
        notify(`${completedCharacters.map(job => job.request.character.name).join('、')}的正脸与三视图已保存到角色素材`)
      }
    } catch (problem) { if (sequence === requestSequence) error = String(problem?.message || problem) }
    finally {
      if (sequence === requestSequence) { loading = false; scheduleReferenceSync(); renderShots({ detail: !shotDetail.contains(document.activeElement) && ![...shotDetail.querySelectorAll('video')].some(video => !video.paused) }); if (!candidateHost.contains(document.activeElement) && !operationBusy) renderCandidate(); renderAssets(); renderJobs(); renderGenerationReadiness() }
    }
  }
  function renderAssets() {
    assetNotice.textContent = !invoke ? '媒体生成、文件预览和完整项目包使用桌面版的本地存储。此处不会展示模拟素材。' : loading ? '正在读取本地素材与任务…' : error ? `读取失败：${error}` : `${assets.length} 项素材 · 版本独立保存，镜头引用固定，不随选用版本自动改变。`
    if (!loading && !error && recoveryIssues.length) assetNotice.textContent += `\n${recoveryIssues.join('\n')}。已保留恢复记录；重新读取只尝试收录文件，不会再次生成。`
    if ([...assetGrid.querySelectorAll('video')].some(video => !video.paused)) return
    assetGrid.replaceChildren()
    if (error) assetGrid.append(button('重试读取', refresh))
    const visible = assets.filter(asset => !roleFilter.value || asset.role === roleFilter.value)
    if (selectedAssetId && !visible.some(asset => asset.id === selectedAssetId)) selectedAssetId = null
    assetBody.classList.toggle('has-selection', Boolean(selectedAssetId))
    for (const asset of visible) {
      const version = asset.versions?.find(item => item.id === asset.selectedVersionId) || asset.versions?.[0]
      const card = el('article', `asset-card${asset.id === selectedAssetId ? ' is-selected' : ''}`)
      const select = button(asset.name, () => { selectedAssetId = asset.id; resultVersionId = ''; renderAssets() }, 'asset-select')
      select.prepend(preview(version, asset.name))
      card.append(select, el('p', 'media-help', `${ASSET_ROLES[asset.role] || '素材'} · ${asset.versions?.length || 0} 个版本`)); assetGrid.append(card)
    }
    if (!visible.length && !loading && !error) assetGrid.append(el('div', 'media-empty', '尚无素材。可从人物小传生成角色图，导入角色／场景素材，或在分镜中生成候选。'))
    if (assetDetail.dataset.assetId !== (selectedAssetId || '') || (!assetDetail.contains(document.activeElement) && ![...assetDetail.querySelectorAll('video')].some(video => !video.paused))) renderAssetDetail()
  }
  function renderAssetDetail() {
    assetDetail.dataset.assetId = selectedAssetId || ''
    assetDetail.replaceChildren()
    const asset = assets.find(item => item.id === selectedAssetId)
    if (!asset) return
    assetDetail.append(el('h2', '', asset.name))
    const owner = context().projectId, key = `${owner}:${asset.id}`
    const draft = assetDrafts.get(key)
    const name = el('input'); name.value = draft?.name ?? asset.name; name.maxLength = 200
    const role = el('select'); Object.entries(ASSET_ROLES).forEach(([value, label]) => role.append(new Option(label, value))); role.value = draft?.role ?? asset.role
    const draftStatus = el('p', 'media-help'); draftStatus.setAttribute('role', 'status')
    const updateDraftStatus = () => { draftStatus.textContent = assetDrafts.has(key) ? '有未保存修改 · 本次会话内保留，切换素材或刷新不会丢失；关闭应用前请保存。' : '素材信息已保存' }
    let saving = false
    const captureDraft = () => {
      if (!saving && name.value === asset.name && role.value === asset.role) assetDrafts.delete(key)
      else assetDrafts.set(key, { name: name.value, role: role.value })
      updateDraftStatus()
    }
    name.addEventListener('input', captureDraft); role.addEventListener('change', captureDraft); updateDraftStatus()
    const saveAsset = selectedVersionId => run(async () => {
      desktop()
      if (owner !== context().projectId) throw new Error('项目已切换，请回到原项目保存素材')
      const submitted = { name: name.value, role: role.value }
      saving = true
      try { await invoke('media_update_asset', { projectId: owner, assetId: asset.id, name: submitted.name.trim(), role: submitted.role, selectedVersionId: selectedVersionId || asset.selectedVersionId }) }
      finally { saving = false }
      asset.name = submitted.name.trim(); asset.role = submitted.role
      if (selectedVersionId) asset.selectedVersionId = selectedVersionId
      // A pending save must not discard edits entered while the request was in flight.
      const latest = assetDrafts.get(key)
      if (!latest || (latest.name === submitted.name && latest.role === submitted.role)) assetDrafts.delete(key)
      updateDraftStatus()
      await refresh()
      notify('素材信息已保存')
    })
    assetDetail.append(field('素材名称', name), field('用途', role), draftStatus, button('保存素材信息', () => saveAsset()), button('放弃未保存修改', () => { assetDrafts.delete(key); renderAssetDetail() }))
    const versions = el('div', 'media-version-grid')
    for (const version of asset.versions || []) {
      const card = el('article', `media-version-card${version.id === resultVersionId ? ' is-job-result' : ''}`)
      card.dataset.versionId = version.id
      if (version.id === resultVersionId) card.append(el('strong', 'media-help', '本次任务生成的版本'))
      card.append(preview(version, asset.name), el('p', '', `${version.name || asset.name} · ${version.id.slice(-8)}`), el('p', 'media-help', `${Math.ceil(version.bytes / 1024)} KiB · ${version.mimeType}`), button(version.id === asset.selectedVersionId ? '当前参考版本' : '选为后续默认参考', () => saveAsset(version.id)), button('导出此文件', () => run(async () => { desktop(); notify(await invoke('media_export_version', { projectId: context().projectId, versionId: version.id })) })))
      versions.append(card)
    }
    assetDetail.append(versions)
  }
  async function chooseImport() {
    await run(async () => { requireProject(); desktop(); const data = context(); try { const result = await invoke('media_choose_import', { projectId: data.projectId, role: roleFilter.value || 'other' }); if (result?.length) notify(`已导入 ${result.length} 项真实素材`) } finally { await refresh() } })
  }
  async function openVideoReturn() {
    await run(async () => {
      requireProject(); desktop(); await refresh()
      const owner = context().projectId
      if (error || projectId !== owner) throw new Error('素材尚未读取，请刷新后重试')
      let manifest = null, busy = false, reviewRevision = context().storyboard.revision, assignments = []
      const importedAssetIds = new Set()
      const dialog = el('dialog', 'app-dialog video-return-dialog'); dialog.id = 'videoReturnDialog'
      dialog.setAttribute('aria-labelledby', 'videoReturnTitle')
      const heading = el('h2', '', '回填外部视频'); heading.id = 'videoReturnTitle'
      const manifestInput = el('input'); manifestInput.type = 'file'; manifestInput.accept = '.json,application/json'
      manifestInput.hidden = true
      const manifestPicker = button('选择导出清单', () => manifestInput.click())
      const manifestName = el('span', 'media-help', '尚未选择 manifest.json')
      const manifestControl = el('div', 'media-toolbar video-return-manifest'); manifestControl.append(manifestPicker, manifestName, manifestInput)
      const status = el('p', 'media-notice', '可读取 Flow／Muse 素材包中的 manifest.json，按导出时编号匹配；也支持文件名中的完整镜头标识。'); status.setAttribute('role', 'status')
      const list = el('div', 'video-return-list')
      const cancel = button('取消', () => { if (!busy) dialog.close() })
      const confirm = button('确认关联选中的视频', apply, 'primary-button')
      const importButton = button('导入视频文件', importVideos)
      const includeExisting = el('input'); includeExisting.type = 'checkbox'
      const existingLabel = el('label', 'video-return-selection'); existingLabel.append(includeExisting, el('span', '', '同时列出素材库已有视频（需手动勾选）'))
      includeExisting.addEventListener('change', renderMatches)
      const tools = el('div', 'media-toolbar'); tools.append(importButton)
      const actions = el('div', 'dialog-actions'); actions.append(cancel, confirm)
      dialog.append(heading, el('p', 'dialog-description', '先导入视频，再核对对应镜头。确认会更换选用版本，原视频仍在素材库；新版本需要重新审核。取消仅放弃关联，已导入文件仍保留。'), field('读取导出清单（文件名仅有 shot-001 等编号时必选）', manifestControl), tools, existingLabel, status, list, actions)
      document.body.append(dialog)
      dialog.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return
        event.preventDefault(); event.stopPropagation()
        if (!busy) dialog.close()
      })
      dialog.addEventListener('cancel', event => { if (busy) event.preventDefault() })
      dialog.addEventListener('close', () => dialog.remove(), { once: true })
      function setBusy(value) { busy = value; cancel.disabled = value; importButton.disabled = value; manifestInput.disabled = value; manifestPicker.disabled = value; includeExisting.disabled = value; confirm.disabled = value || !assignments.some(item => item.checked && item.shotId); list.inert = value }
      function assertOwner() { if (owner !== context().projectId) throw new Error('项目已切换，请在原项目重新打开回填窗口') }
      function renderMatches() {
        assertOwner()
        const shots = context().storyboard.shots
        const rows = planVideoReturn({ shots, assets: assets.filter(asset => importedAssetIds.has(asset.id) || includeExisting.checked), manifest })
        reviewRevision = context().storyboard.revision; assignments = []
        list.replaceChildren()
        if (!rows.length) list.append(el('p', 'media-empty', '请导入从 Flow／Muse 下载的视频，或勾选“同时列出素材库已有视频”。'))
        const counts = new Map()
        rows.forEach(row => { if (row.shotId) counts.set(row.shotId, (counts.get(row.shotId) || 0) + 1) })
        for (const row of rows) {
          const entry = { ...row, checked: Boolean(importedAssetIds.has(row.assetId) && row.shotId && counts.get(row.shotId) === 1) }; assignments.push(entry)
          const card = el('article', 'video-return-row')
          const check = el('input'); check.type = 'checkbox'; check.checked = entry.checked
          check.addEventListener('change', () => { entry.checked = check.checked; setBusy(false) })
          const choice = el('select'); choice.setAttribute('aria-label', `“${row.name}”对应镜头`)
          choice.append(new Option('不关联／请选择镜头', ''))
          shots.forEach((shot, index) => choice.append(new Option(`${String(index + 1).padStart(2, '0')} · ${context().documents[shot.sourceDocumentId]?.title || '未归属'} · ${shot.title}`, shot.id)))
          choice.value = entry.shotId
          choice.addEventListener('change', () => { entry.shotId = choice.value; entry.checked = Boolean(choice.value); check.checked = entry.checked; setBusy(false) })
          const label = el('label', 'video-return-selection'); label.append(check, el('strong', '', row.name))
          card.append(label, el('p', 'media-help', `${row.reason} · 版本 ${row.versionId.slice(-8)}`), choice)
          const owners = shots.filter(shot => shot.selectedVideoVersionId === row.versionId)
          if (owners.length) card.append(el('p', 'media-warning', `当前已用于：${owners.map(shot => shot.title).join('、')}。请核对后再选用。`))
          if (counts.get(row.shotId) > 1) card.append(el('p', 'media-warning', '多个视频对应同一镜头，请勾选其中一个作为选用版本。'))
          row.warnings.forEach(warning => card.append(el('p', 'media-warning', warning)))
          list.append(card)
        }
        setBusy(false)
      }
      manifestInput.addEventListener('change', async () => {
        if (busy) return
        setBusy(true); manifest = null
        try {
          const file = manifestInput.files?.[0]
          manifestName.textContent = file?.name || '尚未选择 manifest.json'
          if (file) { if (file.size > 2_000_000) throw new Error('清单过大，请选择 manifest.json'); const text = await file.text(); assertOwner(); manifest = parseVideoManifest(text, owner) }
          renderMatches(); status.textContent = manifest ? `已读取 ${manifest.shots.length} 个导出镜头；请核对下方匹配结果。` : '未使用清单，仅按完整镜头标识匹配。'
        } catch (problem) { if (owner === context().projectId) renderMatches(); else assignments = []; status.textContent = problem.message }
        finally { setBusy(false) }
      })
      async function importVideos() {
        if (busy) return
        setBusy(true)
        try {
          await run(async () => {
            assertOwner()
            try { const imported = await invoke('media_choose_import', { projectId: owner, role: 'shot' }); for (const asset of imported || []) if (asset.kind === 'video') importedAssetIds.add(asset.id) }
            finally { await refresh() }
            assertOwner(); renderMatches(); status.textContent = '已刷新视频清单。未匹配项可手动选择镜头，勾选后确认关联。'
          })
        } finally { setBusy(false) }
      }
      async function apply() {
        if (busy) return
        setBusy(true)
        try {
          await run(async () => {
            assertOwner()
            if (context().storyboard.revision !== reviewRevision) { renderMatches(); throw new Error('分镜已变化，已重新匹配，请重新核对后确认') }
            const chosen = assignments.filter(item => item.checked)
            const storyboard = applyVideoReturn(context().storyboard, chosen, assets)
            await commit({ storyboard }, { projectId: owner, revision: reviewRevision, atomic: true })
            dialog.close(); selectedShotId = chosen[0].shotId
            const sourceId = storyboard.shots.find(shot => shot.id === selectedShotId)?.sourceDocumentId
            if (context().documents[sourceId]) showSource(sourceId)
            else { selectedEpisodeId = OTHER_EPISODE; selectedSourceId = UNASSIGNED_SOURCE }
            lastContextDocId = context().currentDocId
            navigate('storyboard'); showStage('export'); notify(`已关联 ${chosen.length} 个视频，原素材保留；请完整播放后审核。`)
          })
        } finally { setBusy(false) }
      }
      renderMatches(); dialog.showModal()
    })
  }
  async function exportFlow() {
    return exportVideoBundle(buildFlowExport, 'media_export_flow')
  }
  async function exportMuse() {
    return exportVideoBundle(buildMuseExport, 'media_export_muse')
  }
  async function exportVideoBundle(build, command) {
    await run(async () => {
      requireProject(); desktop()
      const data = structuredClone(context())
      data.storyboard.shots = visibleShots(data)
      if (!data.storyboard.shots.length) throw new Error('尚无分镜，请先拆镜或新建镜头再导出')
      const latest = await invoke('media_list', { projectId: data.projectId })
      if (context().projectId !== data.projectId) throw new Error('项目已切换，请在目标项目重新导出')
      data.storyboard = planReferenceBackfill(data.storyboard, latest.assets, data.documents).storyboard
      const bundle = build(data, latest.assets)
      notify(await invoke(command, { projectId: data.projectId, bundle }))
    })
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
  function pendingAssetDraft(owner = null) {
    const first = [...assetDrafts.keys()].find(key => !owner || key.startsWith(`${owner}:`))
    if (!first) return null
    const separator = first.indexOf(':')
    return { projectId: first.slice(0, separator), assetId: first.slice(separator + 1) }
  }
  function discardAssetDrafts(owner, assetId = null) {
    for (const key of assetDrafts.keys()) {
      if (assetId ? key === `${owner}:${assetId}` : key.startsWith(`${owner}:`)) assetDrafts.delete(key)
    }
    if (owner === context().projectId) renderAssetDetail()
  }
  async function saveAssetDrafts(owner) {
    if (operationBusy || referenceSyncBusy) throw new Error('素材正在保存或同步，请稍后再试')
    desktop()
    const pending = [...assetDrafts].filter(([key]) => key.startsWith(`${owner}:`))
    if (!pending.length) return
    operationBusy = true
    try {
      const snapshot = await invoke('media_list', { projectId: owner })
      const updates = pending.map(([key, draft]) => {
        const assetId = key.slice(owner.length + 1)
        const asset = snapshot.assets?.find(item => item.id === assetId)
        if (!asset) throw new Error('待保存的素材已不存在，请返回素材库检查或放弃修改')
        if (!draft.name.trim() || draft.name.length > 200) throw new Error('素材名称须为 1–200 个字符，请返回素材库修改')
        return { key, draft, asset }
      })
      for (const { key, draft, asset } of updates) {
        await invoke('media_update_asset', { projectId: owner, assetId: asset.id, name: draft.name.trim(), role: draft.role, selectedVersionId: asset.selectedVersionId })
        const latest = assetDrafts.get(key)
        if (latest?.name === draft.name && latest?.role === draft.role) assetDrafts.delete(key)
      }
      if (owner === context().projectId) await refresh()
    } finally { operationBusy = false }
  }
  function showAssetDraft(assetId) {
    if (!assets.some(asset => asset.id === assetId)) return false
    selectedAssetId = assetId; roleFilter.value = ''; resultVersionId = ''
    navigate('assets'); renderAssets(); renderAssetDetail()
    assetDetail.querySelector('input')?.focus()
    return true
  }
  function showJobs() { renderJobs(); if (!jobsDialog.open) jobsDialog.showModal() }
  function openJobResult(job, target) {
    const result = jobResult(job, assets, context().storyboard.shots)
    jobsDialog.close()
    if (target === 'shot' && result.shot) {
      const sourceId = result.shot.sourceDocumentId
      if (context().documents[sourceId]) showSource(sourceId)
      else { selectedEpisodeId = OTHER_EPISODE; selectedSourceId = UNASSIGNED_SOURCE }
      lastContextDocId = context().currentDocId
      selectedShotId = result.shot.id
      navigate('storyboard'); renderSources(); renderShots()
      const control = [...shotList.querySelectorAll('[data-shot-focus]')].find(node => node.dataset.shotFocus === `${selectedShotId}:select`)
      control?.focus({ preventScroll: true }); control?.scrollIntoView({ block: 'nearest' })
    } else if (result.asset) {
      roleFilter.value = result.asset.role
      selectedAssetId = result.asset.id
      resultVersionId = result.versions[0]?.id || ''
      navigate('assets'); renderAssets(); renderAssetDetail()
      const target = [...assetDetail.querySelectorAll('[data-version-id]')].find(node => node.dataset.versionId === resultVersionId) || assetDetail.querySelector('h2')
      target?.setAttribute('tabindex', '-1'); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' })
    }
  }
  function renderJobs() {
    jobsList.replaceChildren()
    const textTasks = storyboardTasks.list(context().projectId)
    if (textTasks.length) {
      const section = el('section'); section.append(el('h3', '', '分场拆镜任务 · 本次会话'))
      for (const task of textTasks) section.append(storyboardTaskCard(task))
      jobsList.append(section)
    }
    if (!jobs.length && !textTasks.length) jobsList.append(el('p', 'media-empty', '当前项目尚无生成任务。手动导入素材不消耗生成额度。'))
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
      const result = jobResult(job, assets, context().storyboard.shots)
      const row = el('article', 'media-job')
      const heading = el('div', 'media-job-heading'); heading.append(el('strong', '', job.request?.character ? `${job.request.character.name} · 正脸与三视图` : context().storyboard.shots.find(shot => shot.id === job.targetId)?.title || job.targetId), el('span', '', result.status))
      row.append(heading, el('p', 'media-help', `${job.capability === 'video' ? '视频' : '图片'} · ${job.request?.connection?.id || '执行端'} · ${job.id.slice(-8)}`))
      row.append(el('p', 'media-help', `创建：${mediaTimeLabel(job.createdAt)} · 更新：${mediaTimeLabel(job.updatedAt)}`))
      const resultActions = el('div', 'media-toolbar')
      if (job.status === 'completed' && result.asset) resultActions.append(button('查看结果', () => openJobResult(job, 'asset')))
      if (result.shot) resultActions.append(button('定位镜头', () => openJobResult(job, 'shot')))
      if (resultActions.children.length) row.append(resultActions)
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
  const taskProgressTimer = window.setInterval(() => { if (storyboardTasks.active()) updateStoryboardTaskLabels() }, 1000)
  window.addEventListener('beforeunload', () => { window.clearInterval(taskProgressTimer); window.clearTimeout(referenceSyncTimer) }, { once: true })
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
  return { showStage, reserveStoryboardTask, updateStoryboardTask, releaseStoryboardTask, bindStoryboardTask: id => storyboardTasks.bind(id), getStoryboardTask: id => storyboardTasks.get(id), isStoryboardBusy: () => Boolean(storyboardTasks.active()), hasPendingWork: () => operationBusy || referenceSyncBusy, pendingAssetDraft, discardAssetDrafts, saveAssetDrafts, showAssetDraft, selectDocument, refresh, renderEndpoints, receiveCandidate, clearCandidate, applyCandidate, showJobs, generateStoryboard, restorePackage, showPendingImports, contextObjects, operationContext, previewVersion, openBatchPlan, openCharacterImages, hasCandidate: () => Boolean(candidate) }
}
