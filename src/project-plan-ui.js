import { materializeOperationPlan, operationTargetManifest, parseOperationPlan } from './project-operations.js'

export function initializeProjectPlanUI({ getContext, captureContext, commit, renderMedia, queryTasks, openMediaPlan, notify, openDialog }) {
  const dialog = document.querySelector('#projectPlanDialog'), input = document.querySelector('#projectPlanInput')
  const targets = document.querySelector('#projectPlanTargets'), preview = document.querySelector('#projectPlanPreview')
  const status = document.querySelector('#projectPlanStatus'), apply = document.querySelector('#projectPlanApply')
  const previewButton = document.querySelector('#projectPlanPreviewButton')
  let base = null, reviewed = null, busy = false
  function invalidate() {
    reviewed = null; preview.hidden = true; preview.replaceChildren(); apply.disabled = true
    apply.textContent = '预览后继续'
    status.textContent = '先预览全部操作；任务查询只读本地摘要，预览不会修改项目或调用模型。'
  }
  input.addEventListener('input', invalidate)
  previewButton.addEventListener('click', async () => {
    if (busy) return
    invalidate()
    try {
      if (!base) throw new Error('本次修改上下文已失效，请关闭后重新打开')
      const currentBase = base, text = input.value
      const plan = parseOperationPlan(text, currentBase)
      let result = materializeOperationPlan(plan, currentBase, getContext()), queryResult = null
      if (result.taskQuery) {
        if (!queryTasks) throw new Error('本地任务查询尚不可用，未修改项目')
        busy = true; previewButton.disabled = true; dialog.setAttribute('aria-busy', 'true')
        status.textContent = '正在读取所选镜头的本地任务摘要；不会查询远端或启动生成。'
        queryResult = await queryTasks(result.taskQuery)
        if (!dialog.open || base !== currentBase || input.value !== text) throw new Error('计划或上下文已改变，请重新预览；未修改项目')
        result = materializeOperationPlan(plan, currentBase, getContext())
        const change = result.changes.find(item => item.kind === 'task-query')
        change.after = JSON.stringify(queryResult, null, 2)
      }
      const canContinue = result.hasWorkspaceChanges || Boolean(result.mediaBatch)
      reviewed = canContinue ? { plan, text, base: currentBase } : null
      const title = document.createElement('h3'); title.textContent = plan.summary
      preview.append(title)
      for (const change of result.changes) {
        const card = document.createElement('article'); card.className = 'project-plan-change'
        const heading = document.createElement('h4'); heading.textContent = change.label; card.append(heading)
        if (change.versionId && renderMedia) card.append(renderMedia(change.versionId))
        for (const [label, content] of [[change.kind === 'task-query' ? '查询范围与边界' : '改动前', change.before], [change.kind === 'task-query' ? '本地任务快照' : '改动后', change.after]]) {
          const details = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('pre')
          summary.textContent = `${label} · ${content.length} 字符`; body.textContent = content || '空白内容'
          if (change.kind === 'task-query' && label === '本地任务快照') details.open = true
          details.append(summary, body); card.append(details)
        }
        preview.append(card)
      }
      preview.hidden = false; apply.disabled = !canContinue
      const count = result.changes.filter(change => !['media-batch', 'task-query'].includes(change.kind)).length
      apply.textContent = !canContinue ? '只读查询已完成，无需保存' : result.mediaBatch ? count ? `保存 ${count} 项改动并核对媒体计划` : `继续核对 ${result.mediaBatch.shotIds.length} 个媒体任务` : `采纳 ${count} 项改动并保存`
      const queryStatus = queryResult ? `${queryResult.jobs.length ? `已读取 ${queryResult.jobs.length} 项本地任务` : '所选镜头尚无本地任务'}${queryResult.hasMore ? '，仅显示最近 20 项' : ''}；这是本地阶段快照，不是远端实时状态。` : ''
      status.textContent = queryStatus + (!canContinue ? '查询已完成，未保存项目或创建版本。' : result.mediaBatch ? `已校验 ${count} 项本地改动及 ${result.mediaBatch.shotIds.length} 个媒体目标。继续后打开媒体计划，预览实际输入后另行确认生成；此处不会提交。` : `已校验 ${count} 项实际改动。请展开核对；采纳只写本地项目，不启动媒体生成。`)
    } catch (error) { status.textContent = error.message || String(error); status.focus() }
    finally { busy = false; previewButton.disabled = false; dialog.removeAttribute('aria-busy') }
  })
  apply.addEventListener('click', async () => {
    if (busy || !reviewed) return
    const current = reviewed
    busy = true; apply.disabled = true; dialog.setAttribute('aria-busy', 'true')
    try {
      if (input.value !== current.text || base !== current.base) throw new Error('计划已改变，请重新预览')
      materializeOperationPlan(current.plan, current.base, getContext())
      const result = await commit(current.plan, current.base)
      dialog.close(); reviewed = null
      if (result?.mediaBatch) {
        try {
          if (!openMediaPlan(result.mediaBatch)) throw new Error('未能打开媒体计划')
          notify(result.hasWorkspaceChanges ? '本地改动已保存，已打开媒体计划；核对完整输入后再确认生成' : '已打开媒体计划，尚未提交生成或修改项目')
        } catch (error) { notify(`${result.hasWorkspaceChanges ? '本地改动已保存，但' : ''}媒体计划未打开：${error.message || error}。可从分镜重新制定计划，未提交生成。`) }
      } else notify('项目修改计划已保存；原文快照保留，未启动图片或视频生成')
    } catch (error) {
      reviewed = null; preview.hidden = true
      status.textContent = `${error.message || error}。计划仍保留，请核对后重新预览。`; status.focus()
    } finally { busy = false; dialog.removeAttribute('aria-busy') }
  })
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault() })
  dialog.addEventListener('close', () => { reviewed = null; base = null })
  return {
    open(text = '', context = null) {
      if (busy) return
      try {
        base = context || captureContext()
        targets.textContent = JSON.stringify(operationTargetManifest(base), null, 2)
        input.value = text; invalidate(); openDialog(dialog)
      } catch (error) { notify(error.message || String(error)) }
    },
    reset() { reviewed = null; base = null; input.value = ''; if (dialog.open) dialog.close() }
  }
}
