export const STORYBOARD_TASK_PHASES = {
  preparing: '准备输入', confirming: '等待执行确认', running: '等待 AI 返回', receiving: '正在接收分镜',
  saving: '校验、绑定参考图并保存', cancelling: '正在停止', completed: '已完成并保存', review: '待处理 · 候选已保留',
  failed: '执行失败', cancelled: '已停止'
}

// One reservation covers input preparation, provider execution and final saving.
// A stop request keeps the lock until the provider promise actually settles.
export function createStoryboardTasks() {
  const tasks = []
  return {
    active: () => tasks.find(task => task.locked) || null,
    list: projectId => tasks.filter(task => task.projectId === projectId).slice().reverse(),
    get: id => tasks.find(task => task.id === id),
    reserve(input) {
      if (tasks.some(task => task.locked)) throw new Error('已有分场正在拆镜，请等待任务结束或停止后再执行')
      const task = { ...input, phase: 'preparing', startedAt: Date.now(), finishedAt: null, characters: 0, locked: true, bound: false, message: '' }
      tasks.push(task)
      if (tasks.length > 50) tasks.shift()
      return task
    },
    bind(id) {
      const task = tasks.find(task => task.id === id)
      if (!task?.locked || task.bound || task.phase === 'cancelling') throw new Error('拆镜任务已失效或正在执行，请勿重复提交')
      task.bound = true
      return task
    },
    update(id, patch) {
      const task = tasks.find(task => task.id === id)
      if (!task?.locked) return
      // Late stream/provider callbacks cannot undo cancellation.
      if (task.phase === 'cancelling' && patch.phase && patch.phase !== 'cancelled') return
      Object.assign(task, patch)
    },
    release(id) {
      const task = tasks.find(task => task.id === id)
      if (!task?.locked) return
      if (['preparing', 'confirming', 'running', 'receiving', 'cancelling'].includes(task.phase)) task.phase = 'cancelled'
      task.locked = false; task.finishedAt = Date.now()
    }
  }
}
