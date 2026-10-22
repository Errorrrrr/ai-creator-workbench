import { resolveConnectionRoute } from './storyboard.js'
import { upstreamDocumentIds } from './creation-workflow.js'

const documentStep = (id, label, hint) => ({ id, label, documentId: id, view: 'workspace', capability: 'text', hint })
const idea = documentStep('idea', '灵感', '记录方向与问题，也可以直接进入后续步骤。')
const brief = documentStep('brief', '创作简报', '明确受众、表达目标和边界；已有内容会保留。')
const outline = documentStep('outline', '大纲', '整理内容结构，不自动拆分或覆盖正文。')
const script = { id: 'script', label: '剧本', view: 'workspace', capability: 'text', hint: '打开已有分集／分场；没有分集时可自行创建。' }
const storyboard = { id: 'storyboard', label: '拆镜与校对', view: 'storyboard', capability: 'storyboard', hint: '选择来源文档，再拆镜或手动编辑；切换步骤不会发起 AI 请求。' }
const images = { id: 'images', label: '分镜图', view: 'storyboard', capability: 'image', hint: '确认角色与场景参考，再选择镜头准备图片任务。' }
const videos = { id: 'videos', label: '镜头视频', view: 'storyboard', capability: 'video', hint: '默认先审核分镜图，再制作视频；需要对应的实际视频资源。' }
const references = { id: 'references', label: '正式参考', view: 'assets', hint: '导入并确认角色、服装、场景和风格参考，绑定确切版本。' }
const exportStep = { id: 'export', label: '审阅与导出', hint: '文字可独立交付；媒体只导出已有真实文件，选用不等于审核通过。' }

export function creationSteps(preset) {
  if (preset === 'text') return [idea, brief, outline, documentStep('draft', '正文', '独立完成文章或其他文字内容；首次进入只创建空白正文。'), exportStep]
  if (preset === 'storyboard') return [{ id: 'source', label: '已有文本', view: 'workspace', capability: 'text', hint: '打开或粘贴已有正文；正式拆镜时仍可选择其他文档。' }, references, storyboard, images, videos, exportStep]
  return [idea, brief, documentStep('world', '世界设定', '保留既有规则与代价，可跳过不需要的设定。'), documentStep('characters', '人物', '建立人物目标、关系与行为依据。'), outline, script, references, storyboard, images, videos, exportStep]
}

function currentStep(data, steps) {
  if (data.step === 'export') return steps.find(step => step.id === 'export')
  if (data.view === 'assets') return steps.find(step => step.id === 'references')
  if (data.view === 'storyboard') return steps.find(step => step.id === data.step && step.view === 'storyboard') || steps.find(step => step.id === 'storyboard')
  if (data.view !== 'workspace') return null
  if (data.workflow.preset === 'storyboard') return steps.find(step => step.id === 'source')
  return steps.find(step => step.documentId === data.documentId)
    || (Object.values(data.structure.episodes || {}).some(episode => episode.sceneIds?.includes(data.documentId)) || data.structure.episodes?.[data.documentId] ? steps.find(step => step.id === 'script') : null)
}

export function initializeCreationNavigation({ getContext, navigate, notify }) {
  const root = document.querySelector('#creationNavigation')
  const select = root.querySelector('#creationStep')
  const previous = root.querySelector('[data-workflow-previous]')
  const next = root.querySelector('[data-workflow-next]')
  const details = root.querySelector('details')
  const path = root.querySelector('#creationPath')
  const hint = root.querySelector('#creationStepHint')
  const input = root.querySelector('#creationStepInput')
  const executor = root.querySelector('#creationStepExecutor')
  const output = root.querySelector('#creationStepOutput')
  let busy = false, optionsKey = ''

  function snapshot() {
    const data = getContext(), steps = creationSteps(data.workflow.preset)
    return { data, steps, step: currentStep(data, steps) }
  }
  async function go(step) {
    if (!step || busy) return
    busy = true; render()
    try {
      const moved = await navigate(step)
      if (moved && step.id === 'export') details.open = true
    } catch (error) { notify(error.message || String(error)) }
    finally { busy = false; render() }
  }
  select.addEventListener('change', () => go(snapshot().steps.find(step => step.id === select.value)))
  previous.addEventListener('click', () => { const { steps, step } = snapshot(); go(steps[steps.indexOf(step) - 1]) })
  next.addEventListener('click', () => { const { steps, step } = snapshot(); go(steps[steps.indexOf(step) + 1]) })

  function render() {
    const { data, steps, step } = snapshot()
    root.hidden = !data.projectId || !['workspace', 'storyboard', 'assets'].includes(data.view)
    if (root.hidden) return
    const key = `${data.projectId}:${data.workflow.preset}`
    if (optionsKey !== key) {
      optionsKey = key; details.open = false
      select.replaceChildren(new Option('自由查看 · 不在当前预设中', ''), ...steps.map((item, index) => new Option(`${index + 1}. ${item.label}`, item.id)))
    }
    const index = steps.indexOf(step)
    select.value = step?.id || ''
    path.textContent = `${{ text: '文字创作', script: '剧本创作', storyboard: '分镜制作' }[data.workflow.preset]}${step ? ` · 第 ${index + 1} / ${steps.length} 步` : ' · 自由查看'}`
    // Project transitions already make the whole shell inert. Only local
    // navigation owns these disabled states, so unlocking cannot leave them stale.
    select.disabled = busy
    previous.disabled = busy || index <= 0
    next.disabled = busy || index < 0 || index === steps.length - 1
    root.setAttribute('aria-busy', String(busy))
    hint.textContent = step?.hint || '当前视图不在此路径预设中，内容仍然保留。可选择步骤返回，或在连接中心切换路径。'
    if (!step) {
      input.textContent = '当前项目内容'
      executor.textContent = '选择步骤后查看；不会自动执行'
      output.textContent = '保留现有文档与素材'
      return
    }
    const targetId = step.documentId || data.documentId
    const target = data.documents[targetId]
    if (step.view === 'workspace') {
      const upstream = upstreamDocumentIds(targetId, data.structure).filter(id => data.documents[id]?.content.trim()).map(id => data.documents[id].title)
      input.textContent = `${target?.title || (step.id === 'draft' ? '空白正文（首次进入时创建）' : '待选择文档')}${upstream.length ? `；可用上游：${upstream.join('、')}` : ''}；已选知识 ${data.knowledgeCount} 项`
      output.textContent = step.id === 'script' ? '已有分集／分场文档；AI 结果先进入候选' : `${target?.title || step.label} · 可编辑正文与候选`
    } else if (step.view === 'storyboard') {
      input.textContent = `${data.storyboard.shots.length} 个镜头${step.id === 'videos' ? `；${data.storyboard.shots.filter(shot => shot.selectedImageVersionId).length} 个已选图片版本（审核仍需人工确认）` : '；实际来源与固定参考见分镜详情／生成计划'}`
      output.textContent = step.id === 'storyboard' ? '分镜候选与可编辑镜头' : '对应镜头的媒体候选，不自动替换选用版本'
    } else {
      input.textContent = step.id === 'export' ? '当前文档、选用素材与审阅结果' : '主动导入的角色、场景、道具与风格素材'
      output.textContent = step.id === 'export' ? '文字导出在创作页；Flow／Muse 素材包在分镜页；完整项目包在素材页' : '本地参考资产及固定版本'
    }
    if (!step.capability) executor.textContent = '无需 AI 执行端'
    else {
      const route = resolveConnectionRoute(data, step.capability), connection = route.connection
      executor.textContent = connection ? `${connection.name}${connection.kind === 'cli' ? ' · CLI · 模型由 CLI 决定' : ` · ${connection.model || '模型由执行端决定'}`} · ${['image', 'video'].includes(step.capability) ? '生成能力待实测' : data.connectionStatus(connection)}${route.source === 'global' ? ' · 继承全局默认' : route.source === 'project-text' ? ' · 继承项目文字' : ''}` : route.error
    }
  }
  return { render }
}
