export function initializeExportSettings({ invoke, openDialog, notify }) {
  const dialog = document.querySelector('#exportSettingsDialog')
  const path = document.querySelector('#exportDirectoryPath')
  const status = document.querySelector('#exportDirectoryStatus')
  const choose = document.querySelector('#chooseExportDirectory')
  const reset = document.querySelector('#resetExportDirectory')
  let busy = false, currentLocation = null
  function render(location) {
    currentLocation = location
    path.textContent = location.directory
    status.textContent = location.isDefault ? '使用默认位置：系统下载文件夹' : '已设置自定义导出文件夹，全部项目共用'
    reset.disabled = location.isDefault
  }
  async function perform(command) {
    if (busy || !invoke) return
    busy = true; choose.disabled = true; reset.disabled = true
    const previous = status.textContent
    status.textContent = command === 'export_location_choose' ? '请选择导出文件夹…' : '正在读取导出位置…'
    let location
    try {
      location = await invoke(command)
      if (location) render(location)
      else status.textContent = previous
    } catch (error) {
      status.textContent = String(error?.message || error)
      notify(status.textContent)
    } finally {
      busy = false; choose.disabled = false
      // After a read error, allow reset so damaged settings can be repaired.
      reset.disabled = location ? location.isDefault : command === 'export_location_get' ? false : currentLocation?.isDefault === true
    }
  }
  choose.addEventListener('click', () => perform('export_location_choose'))
  reset.addEventListener('click', () => perform('export_location_reset'))
  return {
    async open() {
      if (dialog.open || busy) return
      openDialog(dialog)
      if (!invoke) {
        path.textContent = '由浏览器下载设置决定'
        status.textContent = '选择导出文件夹请使用桌面版'
        choose.disabled = true; reset.disabled = true
        return
      }
      await perform('export_location_get')
    }
  }
}
