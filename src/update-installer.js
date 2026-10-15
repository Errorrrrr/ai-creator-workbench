/** A verified download may be retried after a save failure without downloading again. */
export function createUpdateInstaller({ invoke, createChannel, beforeInstall, status, changed }) {
  let phase = 'idle', ready = false, cancelled = false, unlock = null
  let downloadProgress = null, downloadAttempt = 0
  const setPhase = value => { phase = value; if (value === 'idle') downloadProgress = null; changed() }
  async function run(version) {
    if (!['idle', 'ready', 'installed'].includes(phase)) return
    if (phase === 'installed') return restart()
    cancelled = false
    if (!ready) {
      const attempt = ++downloadAttempt
      downloadProgress = { received: 0, total: null }
      setPhase('downloading')
      status('正在下载更新包…下载完成后会保存内容、安装并重启。', 'downloading')
      try {
        const progress = createChannel()
        progress.onmessage = ({ received, total }) => {
          if (attempt !== downloadAttempt || cancelled || phase !== 'downloading' || !Number.isFinite(received) || received < 0) return
          downloadProgress = { received, total: Number.isFinite(total) && total > 0 ? total : null }
          changed()
        }
        await invoke('download_update', { expectedVersion: version, progress })
        if (cancelled) { await invoke('cancel_update'); return }
        ready = true
      } catch (error) {
        status(cancelled ? '下载已取消，当前版本保持不变。' : `下载失败：${String(error?.message || error)}`, cancelled ? 'idle' : 'error')
        return
      } finally { setPhase(ready ? 'ready' : 'idle') }
    }
    setPhase('saving')
    status('更新包已验证，正在保存创作内容…', 'installing')
    try {
      unlock = await beforeInstall()
    } catch (error) {
      setPhase('ready')
      status(`尚未安装：${String(error?.message || error)}。处理后可重试。`, 'error')
      return
    }
    setPhase('installing')
    status('正在安装更新，请稍候…', 'installing')
    try {
      await invoke('install_update')
    } catch (error) {
      // Backend errors before installation can retain a ready package; clear both sides.
      await invoke('cancel_update').catch(() => {})
      ready = false
      unlock?.(); unlock = null
      setPhase('idle')
      status(`更新未完成：${String(error?.message || error)}`, 'error')
      return
    }
    ready = false
    setPhase('installed')
    await restart()
  }
  async function restart() {
    setPhase('restarting')
    status('安装完成，正在重启到新版本…', 'installing')
    try { await invoke('restart_after_update') }
    catch (error) {
      setPhase('installed')
      status(`新版本已安装，但重启失败：${String(error?.message || error)}。请点击“重启应用”重试。`, 'error')
    }
  }
  async function cancel() {
    if (!['downloading', 'ready'].includes(phase)) return
    cancelled = true
    const wasReady = phase === 'ready'
    setPhase('cancelling')
    try { await invoke('cancel_update') }
    catch (error) { status(`取消失败：${String(error?.message || error)}`, 'error') }
    if (wasReady) { ready = false; setPhase('idle'); status('更新已取消，当前版本保持不变。', 'idle') }
    // An in-flight download owns the transition back to idle, preventing overlapping requests.
  }
  return { run, cancel, get phase() { return phase }, get progress() { return downloadProgress }, get busy() { return !['idle', 'ready', 'installed'].includes(phase) }, get locked() { return ['saving', 'installing', 'installed', 'restarting'].includes(phase) } }
}
