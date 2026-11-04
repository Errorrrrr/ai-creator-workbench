import { ASSET_ROLES, findMediaVersion, mediaPrompt, shotIsStale, validateStoryboard, shotInputFingerprint, shotInputFieldFingerprints } from './storyboard.js'
import { matchShotReferences, planReferenceBackfill, referenceBindingWarnings } from './storyboard-references.js'
import { entityStateFingerprint } from './continuity-assets.js'
import { imageVisualReviewState, visualInputFingerprint, visualBaselineText } from './visual-review.js'
import { sceneContinuityContext } from './scene-continuity.js'

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const roles = { reference: '主体参考', start: '起始帧', end: '结束帧', selected: '选用分镜图', extend: '续接视频' }
const stateStatuses = { bound: '已关联当前状态图', manual: '保留手动选择，未自动套用当前状态图', excluded: '已手动排除', missing: '缺少当前状态图', stale: '参考图对应的设定已过期', ambiguous: '旧角色图存在歧义，尚未自动关联', ready: '当前状态图尚未关联到镜头', limit: '参考图数量达到上限' }

// Describe the bytes actually attached. A manual image may belong to an older
// state (or have no known state); never label it as the scene's expected state.
function describeReferenceStates(references, assets, continuity, matches) {
  for (const reference of references) {
    const found = findMediaVersion(assets, reference.versionId)
    const provenance = found.version.metadata?.provenance?.entity
    const states = []
    for (const entity of continuity?.entities || []) {
      if (found.asset.role !== entity.kind) continue
      for (const state of entity.states) {
        const pinned = state.referenceVersionId === reference.versionId
        if (!pinned && !(provenance?.entityId === entity.id && provenance.kind === entity.kind && provenance.stateId === state.id)) continue
        const definitionFingerprint = pinned ? state.referenceFingerprint : provenance.definitionFingerprint || ''
        states.push({ entityId: entity.id, entityName: entity.name, stateId: state.id, stateName: state.name, definitionFingerprint, definitionStatus: !definitionFingerprint ? 'unverified' : definitionFingerprint === entityStateFingerprint(entity, state, continuity.style) ? 'current' : 'stale' })
      }
    }
    if (states.length) {
      reference.states = states
      if (states.length === 1) Object.assign(reference, states[0])
    } else {
      const owners = matches.filter(match => match.entityId && match.assetIds.includes(found.asset.id))
      if (owners.length === 1) Object.assign(reference, { entityId: owners[0].entityId, entityName: owners[0].name, stateId: null, stateName: null, definitionStatus: 'unverified' })
    }
  }
}

function exportContinuity(matches, references, continuity, issues) {
  return { version: 1, style: continuity?.style || '', entities: matches.filter(match => match.entityId).map(match => {
    const { entity, state } = match
    const base = entity.states.find(candidate => candidate.id === state.basedOnStateId)
    const problems = issues.filter(issue => issue.entityId === entity.id && issue.stateId === state.id)
    const usedReferences = references.filter(reference => reference.states?.some(binding => binding.entityId === entity.id) || match.assetIds.includes(reference.assetId)).map(reference => ({
      path: reference.path, versionId: reference.versionId,
      states: (reference.states || []).filter(binding => binding.entityId === entity.id),
      selection: reference.versionId === state.referenceVersionId && !['manual', 'excluded'].includes(match.status) ? 'state' : 'manual'
    }))
    const stale = usedReferences.some(reference => reference.states.some(binding => binding.stateId === state.id && binding.definitionStatus === 'stale'))
    const status = match.status === 'bound' && stale ? 'stale' : match.status === 'missing' && problems.some(issue => issue.reason.startsWith('ambiguous-')) ? 'ambiguous' : match.status
    return { entityId: entity.id, kind: entity.kind, name: entity.name, description: entity.description, fixedTraits: entity.traits, stateId: state.id, stateName: state.name, stateDescription: state.description, basedOnStateId: state.basedOnStateId, basedOnStateName: base?.name || '', basedOnStateDescription: base?.description || '', referenceVersionId: state.referenceVersionId, referenceFingerprint: state.referenceFingerprint, status, usedReferences, issues: problems.map(issue => issue.message) }
  }) }
}

function stateLines(continuity, { prompt = false } = {}) {
  const entities = continuity.entities.filter(entity => !prompt || !['manual', 'excluded'].includes(entity.status))
  if (!entities.length) return []
  return [prompt ? '本镜头的一致性设定与实际附件：' : '## 人物、场景与关键物品状态',
    ...(continuity.style ? [`统一视觉风格：${continuity.style}`] : []),
    ...entities.flatMap(entity => [
      `${ASSET_ROLES[entity.kind]}「${entity.name}」· ${entity.stateName}；${stateStatuses[entity.status] || entity.status}。`,
      ...(entity.basedOnStateId ? [`基础状态：${entity.basedOnStateName}（${entity.basedOnStateId}）${entity.basedOnStateDescription ? `；${entity.basedOnStateDescription}` : ''}。基础状态只说明继承关系，不替代当前状态的图片。`] : []),
      `固定特征：${entity.fixedTraits || entity.description || '以有效的设定参考图为准'}`,
      ...(entity.fixedTraits && entity.description ? [`整体描述：${entity.description}`] : []),
      `当前状态要求：${entity.stateDescription || '保持默认设定'}`,
      `实际附件：${entity.usedReferences.map(reference => `${reference.path.split('/').pop()}（固定版本 ${reference.versionId}；${reference.states.length ? reference.states.map(state => `${state.stateName}${state.definitionStatus === 'stale' ? '，设定已过期' : state.definitionStatus === 'unverified' ? '，设定尚未验证' : ''}`).join('、') : '手选图片，状态未确认'}）`).join('；') || '无；本包未用其他状态图片代替'}`,
      ...entity.issues.map(message => `核对：${message}`)
    ]), ...(prompt ? ['保持上述固定特征与本镜头指定状态，不能擅自改变人物身份、物品结构与材质、场景布局。缺图或过期时须先核对，不把基础状态或手选未知状态的图片当作当前状态设定图。'] : [])]
}

export function buildFlowExport(data, assets) { return buildVideoExport(data, assets, 'flow') }
export function buildMuseExport(data, assets) { return buildVideoExport(data, assets, 'muse') }

function exportVisualReview(shot, assets, documents, continuity, context) {
  const review = imageVisualReviewState(shot, assets, documents, continuity, context)
  return {
    version: 1, status: review.status, label: review.label, reviewed: review.reviewed,
    imageVersionId: shot.selectedImageVersionId || '', fingerprint: visualInputFingerprint(shot, assets, documents, continuity, context),
    baseline: continuity?.style || '', issues: review.issues || [], changedFields: review.changedFields || [],
    ...(shot.visualReview ? { recordedReview: { decision: shot.visualReview.decision, reviewedAt: shot.visualReview.reviewedAt, notes: shot.visualReview.notes || '', imageVersionId: shot.visualReview.imageVersionId, fingerprint: shot.visualReview.fingerprint } } : {})
  }
}

// The selected image is a candidate start frame, not proof of visual approval.
// A review of that image cannot certify a different explicitly chosen frame.
function flowInputs(shot, references, starts, ends, review) {
  const mode = shot.videoMode === 'extend' ? 'extend' : shot.videoMode === 'reference-to-video' ? 'ingredients' : starts.length || ends.length ? 'frames' : references.length ? 'ingredients' : 'text'
  const ingredients = references.filter(ref => ref.roles.includes('reference'))
  const frameIds = [...starts, ...ends].map(ref => ref.versionId)
  const uncheckedFrames = frameIds.filter(id => id !== review.imageVersionId || !review.reviewed)
  const notes = []
  if (!review.reviewed) notes.push(`${review.label}：先将分镜图与统一基准及设定图并排核对；本包保留图片，不将其视为已经视觉审核通过。`)
  if (mode === 'frames' && frameIds.some(id => id !== review.imageVersionId)) notes.push('存在不同于选用分镜图的显式首尾帧。本镜分镜图的审核不能认证这些图片，请另行核对其人物、物品、场景及光线。')
  if (mode === 'frames' && (!starts.length || starts.length > 1 || ends.length > 1)) notes.push('首尾帧选择尚未确定，请先明确一张首帧及至多一张尾帧。')
  if (mode === 'frames' && shot.videoMode === 'first-last' && !ends.length) notes.push('本镜选择首尾帧模式，但尚未指定尾帧；补齐并核对后再生成。')
  if (mode === 'ingredients' && !ingredients.length) notes.push('尚无主体参考用途的图片。首尾帧与分镜图仅用于校对，不能自动当成 Ingredients 素材。')
  if (mode === 'ingredients' && references.some(ref => ref.roles.includes('start') || ref.roles.includes('end'))) notes.push('显式首尾帧仍保留在包中供校对；当前 Ingredients 模式不把它们作为首尾帧输入。')
  if (mode === 'extend') notes.push('本包不含续接源视频，不能直接开始续接生成。')
  const ready = review.reviewed && (mode === 'frames' && uncheckedFrames.length === 0 && starts.length === 1 && ends.length <= 1 && (shot.videoMode !== 'first-last' || ends.length === 1) || mode === 'ingredients' && ingredients.length > 0)
  const upload = mode === 'frames' ? [...new Set([...starts, ...ends].map(ref => ref.path))] : mode === 'ingredients' ? ingredients.map(ref => ref.path) : []
  return {
    mode, ready, requiresReview: !ready, startPaths: mode === 'frames' ? starts.map(ref => ref.path) : [], endPaths: mode === 'frames' ? ends.map(ref => ref.path) : [],
    ingredientPaths: ingredients.map(ref => ref.path), uploadPaths: upload,
    comparisonPaths: references.filter(ref => !upload.includes(ref.path)).map(ref => ref.path), notes
  }
}

function flowInputLines(input, references) {
  const names = paths => paths.map(path => path.split('/').pop()).join('、') || '无'
  const label = { frames: 'Frames（首尾帧）', ingredients: 'Ingredients（参考素材）', text: '文字生成', extend: '续接（需另备源视频）' }[input.mode]
  return [
    '## 本次上传与校对', `本次模式：${label}；${input.ready ? '选用分镜图已人工核对，可按清单生成，仍需审核视频结果' : '尚需视觉核对，不代表可直接生成'}。`,
    ...(input.mode === 'frames' ? [`Frames 首帧：${names(input.startPaths)}`, `Frames 尾帧：${names(input.endPaths)}`, 'Frames 只按以上首尾帧放置图片；人物、场景和道具设定图用于先校对或修正分镜图，不应全部塞入首尾帧位置，也不代表该模式能同时采用全部设定图。'] : []),
    ...(input.mode === 'ingredients' ? [`Ingredients 上传：${names(input.ingredientPaths)}`, '只将以上图片作为主体参考，不同时声明为首尾帧。根据所选模型实际限制选择素材；超出数量时先合成并核对统一分镜图，再切换 Frames。'] : []),
    `额外校对图片：${names(input.comparisonPaths)}`,
    ...references.filter(ref => input.comparisonPaths.includes(ref.path)).map(ref => `- ${ref.path.split('/').pop()}：${ref.assetRole}「${ref.name}」`),
    ...input.notes.map(note => `- ${note}`),
    '不要自动把上一镜末帧用于换机位、闪回或时空跳转；连续动作可在确认实际画面后，再明确选择衔接首帧。'
  ]
}

function flowPrompt(shot, project, continuity, review, input, context) {
  return [
    `视觉复核：${review.label}。${review.reviewed ? '审核记录针对当前选用图片与当前参考基准，不保证视频生成后不会漂移。' : '先核对或修正分镜图；下方文字不能把相互矛盾的图片自动变成一致画面。'}`,
    visualBaselineText(continuity),
    ({ frames: '画面依据：以本次明确上传的首尾帧为画面约束。保持其中人物的脸型、发型、服装配件，物品的结构、材质与比例，以及场景布局、光线方向、天气和色调；只执行下方动作与运镜及剧情明确要求的状态变化，不重新设计外观或添加建筑、物品与人物。',
      ingredients: '画面依据：按本次实际上传的主体参考保持身份、服装、物品结构与材质、场景布局及指定光线；不同参考若有冲突，先修正参考，不靠提示词重新猜选外观。',
      text: '本镜没有图片约束，仅文字生成不能确认跨镜头的外观细节一致。先固定视觉基准并制作、核对分镜图，再用于正式视频。',
      extend: '本镜要求视频续接，但本包未附源视频。先确认并提供实际续接源视频，不得把当前设定图或文字当作已有视频的实际末帧。' })[input.mode],
    mediaPrompt({ ...shot, duration: shot.videoDuration ?? shot.duration, continuityNotes: '' }, project, [], context),
    ...stateLines(continuity, { prompt: true }),
    `剧情目标时长：${shot.duration} 秒；本次生成：${shot.videoDuration ?? shot.duration} 秒。`,
    '仅生成当前镜头的动作与运镜，不扩写剧情，不重新建立另一套场景或物品外观。', ''
  ].filter(Boolean).join('\n')
}

function museMessage(shot, project, references, starts, ends, number, continuity, context) {
  const duration = shot.videoDuration ?? shot.duration
  return [
    `请使用 Meta Muse Video 为下面的第 ${number} 镜生成一个视频片段，并返回可查看或下载的生成结果。`,
    '如果当前账号无法调用 Muse Video，请明确说明，不要把剧本说明或静态图片当作已生成的视频。',
    `本次生成时长：${duration} 秒；剧情目标时长：${shot.duration} 秒；目标画幅：${shot.aspectRatio || '16:9'}。如果无法满足，请先告诉我实际支持的选项，不要擅自改写动作或截掉对白。`,
    '', mediaPrompt({ ...shot, duration, continuityNotes: '' }, project, [], context), '', ...stateLines(continuity, { prompt: true }), '',
    references.length ? '本条消息随附图片的对应关系（仅使用本镜头附件）：' : '本镜头没有附参考图，请依据以上文字生成。',
    ...references.map((ref, index) => `附件 ${index + 1}（${ref.path.split('/').pop()}）：${ref.assetRole}「${ref.name}」，用途：${ref.roles.map(role => roles[role]).join('、')}。`),
    ...(references.length ? ['保持上传图片中的人物身份、服装、道具和场景一致。若无法识别附件或无法同时使用这些图片，请先说明。'] : []),
    ...(starts.length ? [`期望开场画面参考：${starts.map(ref => ref.path.split('/').pop()).join('、')}。`] : []),
    ...(ends.length ? [`期望结束画面参考：${ends.map(ref => ref.path.split('/').pop()).join('、')}。`] : []),
    ...(starts.length || ends.length ? ['首尾画面是创作要求；若不能精确约束首尾帧，请说明可实现的方式。'] : []),
    shot.dialogue.trim() ? '声音：按上述对白及说话人标注发声，保留原文语言，不添加台词。若无法准确生成对白，请告知，便于后期配音。' : '声音：不添加人物对白或旁白；环境声与画面动作相符。',
    ...(shot.videoMode === 'extend' ? ['原镜头设为视频续接，但本包未附源视频；先说明所需源视频及支持方式，收到后再生成。'] : []),
    '仅处理这一镜头，不自动生成其他镜头。', ''
  ].join('\n')
}

// Export only the current storyboard and its explicitly pinned versions, never connections or jobs.
function buildVideoExport({ projectId, project, storyboard, documents = {}, structure = {}, exportScope = '' }, assets, target) {
  const muse = target === 'muse', platform = muse ? 'Muse' : 'Flow'
  validateStoryboard(storyboard)
  if (!storyboard.shots.length) throw new Error('尚无分镜，请先拆镜或新建镜头再导出')
  const synchronized = planReferenceBackfill(storyboard, assets, documents, projectId)
  storyboard = synchronized.storyboard
  assets = assets.filter(asset => projectId === undefined || asset.projectId === projectId)
  const context = { documents, structure, storyboard, assets }
  const texts = [], images = [], shots = []
  for (const [index, shot] of storyboard.shots.entries()) {
    const folder = `shot-${String(index + 1).padStart(3, '0')}`
    const generationDuration = shot.videoDuration ?? shot.duration
    const warnings = [], references = [], byVersion = new Map()
    const scene = documents[shot.sourceDocumentId] && sceneContinuityContext({ ...context, documentId: shot.sourceDocumentId, shot })
    if (scene) warnings.push(...scene.conflicts.map(message => `分场连续性冲突：${message}`), ...scene.warnings.map(message => `分场状态待核对：${message}`))
    const bindings = referenceBindingWarnings(shot, assets, documents, storyboard.continuity)
    if (bindings.legacy.length) warnings.push(`${bindings.legacy.length} 项旧引用未记录自动或手动来源，原版本已保留，请核对。`)
    if (bindings.unmatched.length) warnings.push(`以下保留引用未匹配本镜头当前角色、场景或道具，请核对：${bindings.unmatched.map(item => item.name).join('、')}。`)
    const matches = matchShotReferences(shot, assets, documents, storyboard.continuity)
    for (const match of matches.filter(match => !match.entityId)) if (!['bound', 'excluded', 'manual'].includes(match.status)) warnings.push(`${ASSET_ROLES[match.role]}「${match.name}」${match.status === 'ambiguous' ? '参考图存在歧义，未自动选取' : '尚未绑定对应参考图'}，请核对或补充参考。`)
    if (shotIsStale(shot, documents)) warnings.push('剧本来源已更新，请核对本镜头内容。')
    for (const ref of [...shot.references, ...(shot.selectedImageVersionId ? [{ role: 'selected', versionId: shot.selectedImageVersionId }] : [])]) {
      const found = findMediaVersion(assets, ref.versionId)
      if (!found) throw new Error(`第 ${index + 1} 镜「${shot.title}」的${roles[ref.role]}版本不存在，请修复引用后导出`)
      const extension = extensions[found.version.mimeType]
      if (!extension) {
        warnings.push(`${roles[ref.role]}「${found.asset.name}」不是图片，未导出；视频续接需在 ${platform} 中另行处理。`)
        continue
      }
      let entry = byVersion.get(ref.versionId)
      if (!entry) {
        const path = `${folder}/ref-${String(byVersion.size + 1).padStart(2, '0')}.${extension}`
        entry = { path, versionId: ref.versionId, assetId: found.asset.id, name: found.asset.name, assetRole: ASSET_ROLES[found.asset.role] || '其他', roles: [] }
        byVersion.set(ref.versionId, entry)
        references.push(entry)
        images.push({ path, versionId: ref.versionId })
      }
      if (!entry.roles.includes(ref.role)) entry.roles.push(ref.role)
    }
    describeReferenceStates(references, assets, storyboard.continuity, matches)
    const continuity = exportContinuity(matches, references, storyboard.continuity, synchronized.issues || [])
    for (const entity of continuity.entities) {
      if (!['bound', 'excluded'].includes(entity.status)) warnings.push(`${ASSET_ROLES[entity.kind]}「${entity.name}」· ${entity.stateName}：${stateStatuses[entity.status] || entity.status}。`)
      warnings.push(...entity.issues)
    }
    if (!references.length) warnings.push('本镜头没有参考图片，可用文字生成，或先补充并绑定参考图。')
    if (shot.videoMode === 'extend') warnings.push(`本镜头原设为视频续接，本包仅提供提示词与图片，需在 ${platform} 内确认续接方式。`)
    const explicitStarts = references.filter(ref => ref.roles.includes('start'))
    const starts = explicitStarts.length ? explicitStarts : references.filter(ref => ref.roles.includes('selected'))
    const ends = references.filter(ref => ref.roles.includes('end'))
    const visualReview = exportVisualReview(shot, assets, documents, storyboard.continuity, context)
    const inputPlan = muse ? null : flowInputs(shot, references, starts, ends, visualReview)
    if (inputPlan && scene?.conflicts.length) { inputPlan.ready = false; inputPlan.requiresReview = true; inputPlan.notes.push('存在分场连续性冲突，请先核对素材与进入／结束状态，再生成视频。') }
    if (!muse && !storyboard.continuity?.style?.trim()) warnings.push('尚未填写全项目统一视觉基准，请在素材设定中固定画风、色彩、场景布局、光线规则与禁止变化的细节。')
    if (!visualReview.reviewed) warnings.push(`分镜图视觉复核：${visualReview.label}。补齐参考关联不代表已有分镜图内容一致，请先核对再生成。`)
    if (!muse) warnings.push(...inputPlan.notes)
    if (starts.length > 1 || ends.length > 1) warnings.push(`存在多个首帧或尾帧，请在 ${platform} 中人工选择。`)
    const mode = muse ? '聊天生成（Meta Muse Video）' : { frames: 'Frames（首尾帧）', ingredients: 'Ingredients（参考素材）', text: '文字生成', extend: '续接（需另备源视频）' }[inputPlan.mode]
    const prompt = muse ? museMessage(shot, project, references, starts, ends, index + 1, continuity, context) : flowPrompt(shot, project, continuity, visualReview, inputPlan, context)
    const instructions = [
      `# 第 ${index + 1} 镜：${shot.title}`, '', `建议入口：${mode}`, `剧情目标时长：${shot.duration} 秒；本次生成时长：${generationDuration} 秒；画幅：${shot.aspectRatio || '16:9'}。请以 ${platform} 当前模型实际支持为准。`,
      `下载后建议命名：${folder}-${shot.id}.mp4（保留镜头标识，便于回填工作台）。`,
      `视觉复核：${visualReview.label}；当前图片固定版本：${visualReview.imageVersionId || '未选用'}。`,
      ...(visualReview.issues.length ? visualReview.issues.map(issue => `核对：${typeof issue === 'string' ? issue : issue.message || '当前分镜图需重新核对'}`) : []),
      `首帧建议：${starts.map(ref => ref.path.split('/').pop()).join('、') || '未指定'}${!muse && !inputPlan.ready && starts.length ? '（候选，需先核对，不建议直接生成）' : ''}`, `尾帧建议：${ends.map(ref => ref.path.split('/').pop()).join('、') || '未指定'}`,
      ...(!muse ? ['', ...flowInputLines(inputPlan, references)] : []),
      '', '## 参考图片', ...references.map(ref => `- ${ref.path.split('/').pop()}：${ref.assetRole}「${ref.name}」；用途：${ref.roles.map(role => roles[role]).join('、')}；固定版本：${ref.versionId}`),
      '', ...stateLines(continuity),
      ...(scene?.text ? ['', '## 素材与分场状态承接', scene.text] : []),
      '', '## 核对事项', ...warnings.map(warning => `- ${warning}`),
      muse ? '- 首尾帧和多图用途通过聊天表达；不保证当前账号支持精确首尾帧约束、全部参考图片或目标时长。' : '- Ingredients 与 Frames 的素材用途不同，请按所选模式上传；不需要把所有图片都塞进同一次生成。',
      '', muse ? '建议为本镜头新建聊天。按清单顺序上传本目录图片，并发送 prompt.txt 全文。若附件显示名变化，请在消息中对应修改。修改已有结果时，填写「修改消息.txt」中的方括号内容后，在同一聊天发送。' : '复制同目录 prompt.txt 的内容到 Flow 提示词框，再按以上清单上传图片。', ''
    ].join('\n')
    texts.push({ path: `${folder}/prompt.txt`, content: prompt }, { path: `${folder}/说明.md`, content: instructions })
    if (muse) texts.push({ path: `${folder}/修改消息.txt`, content: [
      '使用前填写方括号内容；本文件是修改模板，不要原样发送。', '',
      `请修改第 ${index + 1} 镜「${shot.title}」的上一版视频。`,
      '需要调整：[填写具体时间点、画面或声音问题，以及希望如何修改]。',
      '保留本镜头原先的角色身份、服装、场景、构图和未要求修改的动作及对白。',
      '请使用 Meta Muse Video 生成修改后的版本，并返回实际结果。若无法直接编辑上一版，请说明后按原参考和新要求重新生成。', ''
    ].join('\n') })
    shots.push({ number: index + 1, id: shot.id, title: shot.title, duration: shot.duration, videoDuration: generationDuration, sourceFingerprint: shot.sourceFingerprint, inputFingerprint: shotInputFingerprint(shot, documents, context), inputSnapshotVersion: 1, inputSnapshot: shotInputFieldFingerprints(shot, documents, context), suggestedVideoFilename: `${folder}-${shot.id}.mp4`, aspectRatio: shot.aspectRatio || '16:9', mode, promptPath: `${folder}/prompt.txt`, references, continuity, visualReview, ...(!muse ? { inputPlan } : {}), warnings })
  }
  if (!muse) texts.push({ path: '视觉检查.md', content: [
    `# ${project.name} · 分镜图视觉检查`, '',
    '本报告记录导出时的人工复核状态与输入变更检查，不是模型自动识图结论，也不保证生成的视频能直接拼接。',
    ...(!storyboard.continuity?.style?.trim() ? ['统一视觉基准：尚未填写，请先在工作台的素材设定中固定全项目视觉要求。'] : []),
    visualBaselineText(storyboard.continuity),
    '', `共 ${shots.length} 镜；当前分镜图人工复核通过 ${shots.filter(shot => shot.visualReview.reviewed).length} 镜；其余须核对或修正。`,
    '先将分镜图与人物、场景、物品设定图并排检查，再生成视频。参考关联已齐不等于画面内容一致；旧分镜图不会随设定图变更自动重绘。',
    '', ...shots.flatMap(shot => [
      `## ${String(shot.number).padStart(3, '0')} ${shot.title}`, `视觉复核：${shot.visualReview.label}`, `图片版本：${shot.visualReview.imageVersionId || '未选用'}`, `输入指纹：${shot.visualReview.fingerprint}`,
      `生成准备：${shot.inputPlan.ready ? '可按逐镜上传清单操作，仍须审核生成结果' : '待视觉核对；素材保留，不应直接批量生成'}`,
      ...shot.warnings.map(warning => `- ${warning}`), ''
    ])
  ].filter(line => line !== undefined).join('\n') })
  texts.push({ path: 'manifest.json', content: JSON.stringify({ format: muse ? 'meta-muse-chat-handoff' : 'google-flow-handoff', version: 1, projectId, projectName: project.name, storyboardRevision: storyboard.revision, shots }, null, 2) })
  texts.push({ path: '使用说明.md', content: [
    `# ${project.name} · ${muse ? 'Muse 聊天' : 'Google Flow'}素材包`, '', `这是供手动上传使用的文件夹，不是 ${platform} 一键导入格式，也不会自动提交生成任务。`, '',
    ...(muse ? [
      '1. 打开 https://muse.ai/ 并进入聊天。建议每个镜头新建聊天，避免同名附件与前一镜头混淆。',
      '2. 按 shot-001、shot-002 的顺序打开镜头文件夹，先阅读「说明.md」并处理核对事项。',
      '3. 按说明顺序上传该镜头图片，将 prompt.txt 全文作为聊天消息发送。没有图片时直接发送文字。',
      '4. 消息已包含视频生成请求、画幅、目标时长、参考用途、画面动作及对白要求。能力或附件数量不支持时，按 Muse 实际反馈调整。',
      '5. 审核返回的视频；需要修改时填写「修改消息.txt」模板，在原聊天继续。完成后下载视频并按镜头编号命名，再剪辑。'
    ] : ['1. 先阅读「视觉检查.md」。待复核、参考已变化或已标记不一致的分镜图，先返回工作台并排核对或修正；不要因为图片已关联就直接生成。', '2. 打开 https://flow.google/，新建或进入项目。按 shot-001、shot-002 的顺序打开镜头文件夹，阅读「说明.md」。', '3. 严格按本次上传清单操作：Frames 只放明确的首帧和尾帧，其他设定图先用于校对；Ingredients 按主体参考清单上传，不能将两种用途混为一谈。', '4. 复制 prompt.txt，设置支持的画幅与时长后生成；超出可选时长时，拆成多段或按 Flow 当前支持方式续接。', '5. 核对人物外观、服装、物品结构、场景布局、天气光线及动作衔接，再下载视频进行剪辑。统一提示词与设定图只能提供约束，不能替代生成结果审核。']),
    '', '## 视频回填', '下载视频后，按各镜头说明中的建议文件名保存。在工作台分镜页选择“回填外部视频”，读取本包 manifest.json 并导入视频，核对匹配结果后确认关联。编号匹配使用本次导出清单，不使用当前镜头排序；文件名包含镜头完整标识时也可直接匹配。未匹配的视频可手动选择镜头。关联只更换选用版本，旧素材保留，视频仍需人工审核。',
    '', '参考图是镜头绑定的固定版本，不会替换为素材库的新版本。相同图片在同一镜头内只保存一份。没有绑定到镜头的素材不在本包中。',
    '人物、场景与关键物品按本镜头所属分场选择状态。各镜头说明和 manifest.json 记录设定、基础状态及实际图片版本；缺失或过期的状态图不会用基础状态图冒充，手动选择与排除继续保留。',
    `本包仅导出图片，不包含续接视频；缺少图片、来源变化等情况见各镜头说明。图片格式、参考数量、声音与生成能力以 ${platform} 当前账号和模型为准。`,
    '', ...(muse ? ['官方产品介绍：https://ai.meta.com/muse/', '官方模型介绍：https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/', '本包的聊天模板为工作台整理的使用建议，不是官方 API 参数或已验证的账号能力。'] : ['官方操作说明：https://support.google.com/flow/answer/16353334']), '', '## 镜头清单',
    ...shots.map(shot => `- ${String(shot.number).padStart(3, '0')} ${shot.title}：${shot.references.length} 张图片${shot.warnings.length ? `；${shot.warnings.join(' ')}` : ''}`), ''
  ].join('\n') })
  return { projectName: project.name, scopeName: exportScope, texts, images }
}
