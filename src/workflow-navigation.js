import { resolveConnectionRoute } from './storyboard.js'
import { upstreamDocumentIds } from './creation-workflow.js'

const documentStep = (id, label, hint) => ({ id, label, documentId: id, view: 'workspace', capability: 'text', hint })
const idea = documentStep('idea', '灵感', '记录方向与问题，也可以直接进入后续步骤。')
const brief = documentStep('brief', '创作简报', '明确受众、表达目标和边界；已有内容会保留。')
const outline = documentStep('outline', '大纲', '整理内容结构，不自动拆分或覆盖正文。')
const script = { id: 'script', label: '写剧本', view: 'workspace', capability: 'text', hint: '写入或导入剧本，确认分集与分场。灵感、世界观、人物和大纲可从左侧目录按需打开。' }
const storyboard = { id: 'storyboard', label: '做分镜', view: 'storyboard', capability: 'storyboard', hint: '选择分场，在这里拆镜、制作图片并检查画面。已有图片可直接检查，视频制作按需使用。' }
const references = { id: 'references', label: '定形象', view: 'assets', hint: '确认人物、场景和道具使用哪些参考图；已有设定可以继续沿用。' }
const exportStep = { id: 'export', label: '导出', hint: '检查选用画面后，按分场导出 Flow／Muse 素材包；文字也可独立导出。' }

export function creationSteps(preset) {
  if (preset === 'text') return [idea, brief, outline, documentStep('draft', '正文', '独立完成文章或其他文字内容；首次进入只创建空白正文。'), { ...exportStep, hint: '检查正文后导出文字；完整项目备份仍可从素材与备份入口保存。' }]
  if (preset === 'storyboard') return [{ ...script, id: 'source', hint: '写入或导入已有剧本，确认分集与分场；已有镜头和素材会保留。' }, references, storyboard, exportStep]
  return [script, references, storyboard, exportStep]
}

// Older projects and media shortcuts still use images/videos as local stage IDs.
// They belong to the same top-level workspace and must not become extra steps.
export function currentCreationStep(data, steps = creationSteps(data.workflow.preset)) {
  if (data.step === 'export') return steps.find(step => step.id === 'export')
  if (data.view === 'assets') return steps.find(step => step.id === 'references')
  if (data.view === 'storyboard') return steps.find(step => step.id === 'storyboard')
  if (data.view !== 'workspace') return null
  if (data.workflow.preset === 'storyboard') return steps.find(step => step.id === 'source')
  if (data.workflow.preset !== 'text') return steps.find(step => step.id === 'script')
  return steps.find(step => step.documentId === data.documentId)
}

export function initializeCreationNavigation({ getContext, navigate, notify }) {
  const root = document.querySelector('#creationNavigation')
  const select = root.querySelector('#creationStep')
  const stages = root.querySelector('#creationStages')
  const previous = root.querySelector('[data-workflow-previous]')
  const next = root.querySelector('[data-workflow-next]')
  const details = root.querySelector('details')
  const path = root.querySelector('#creationPath')
  const hint = root.querySelector('#creationStepHint')
  const input = root.querySelector('#creationStepInput')
  const executor = root.querySelector('#creationStepExecutor')
  const output = root.querySelector('#creationStepOutput')
  let busy = false, optionsKey = ''
  const stageButtons = new Map()

  function snapshot() {
    const data = getContext(), steps = creationSteps(data.workflow.preset)
    return { data, steps, step: currentCreationStep(data, steps) }
  }
  async function go(step) {
    if (!step || busy) return
    const owner = getContext().projectId
    busy = true; render()
    try {
      const moved = await navigate(step)
      if (moved && step.id === 'export' && getContext().projectId === owner && getContext().workflow.preset === 'text') details.open = true
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
      stageButtons.clear()
      stages.replaceChildren(...steps.map(item => {
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'creation-stage-button'
        button.textContent = item.label
        button.addEventListener('click', () => go(item))
        stageButtons.set(item.id, button)
        return button
      }))
    }
    const index = steps.indexOf(step)
    select.value = step?.id || ''
    path.textContent = `${{ text: '文字创作', script: '剧本创作', storyboard: '分镜制作' }[data.workflow.preset]}${step ? ` · 第 ${index + 1} / ${steps.length} 步` : ' · 自由查看'}`
    // Project transitions already make the whole shell inert. Only local
    // navigation owns these disabled states, so unlocking cannot leave them stale.
    select.disabled = busy
    for (const [id, button] of stageButtons) {
      button.disabled = busy
      if (id === step?.id) button.setAttribute('aria-current', 'step')
      else button.removeAttribute('aria-current')
    }
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
      output.textContent = ['script', 'source'].includes(step.id) ? '集 → 分场 → 分镜；整理分场后逐场创作与拆镜' : `${target?.title || step.label} · 可编辑正文与候选`
    } else if (step.view === 'storyboard') {
      input.textContent = `${data.storyboard.shots.length} 个镜头；实际来源与固定参考见分镜详情／生成计划`
      output.textContent = '归属当前分场的分镜、图片与视频；检查和修改保留在同一工作区'
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
