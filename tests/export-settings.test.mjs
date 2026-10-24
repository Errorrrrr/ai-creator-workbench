import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function harness(invoke) {
  const nodes = new Map()
  const document = { querySelector(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: false, open: false, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback } })
    return nodes.get(id)
  } }
  const notices = []
  const env = vm.createContext({ document })
  const source = readFileSync(new URL('../src/export-settings.js', import.meta.url), 'utf8').replace('export function', 'function')
  vm.runInContext(source, env)
  const ui = env.initializeExportSettings({ invoke, openDialog(dialog) { dialog.open = true }, notify(message) { notices.push(message) } })
  return { ui, notices, node: id => document.querySelector(`#${id}`), click: id => document.querySelector(`#${id}`).listeners.click() }
}

test('导出位置读取默认路径、选择后显示已保存目录、重开读取配置并可恢复默认', async () => {
  const defaults = { directory: '/Users/test/Downloads', isDefault: true }
  let saved = defaults
  const calls = []
  const h = harness(async command => {
    calls.push(command)
    if (command === 'export_location_choose') saved = { directory: '/Volumes/创作/交付', isDefault: false }
    if (command === 'export_location_reset') saved = defaults
    return saved
  })
  await h.ui.open()
  assert.equal(h.node('exportDirectoryPath').textContent, defaults.directory)
  assert.equal(h.node('resetExportDirectory').disabled, true)
  await h.click('chooseExportDirectory')
  assert.equal(h.node('exportDirectoryPath').textContent, '/Volumes/创作/交付')
  assert.equal(h.node('resetExportDirectory').disabled, false)
  h.node('exportSettingsDialog').open = false
  await h.ui.open()
  assert.equal(h.node('exportDirectoryPath').textContent, '/Volumes/创作/交付')
  await h.click('resetExportDirectory')
  assert.equal(h.node('exportDirectoryPath').textContent, defaults.directory)
  assert.deepEqual(calls, ['export_location_get', 'export_location_choose', 'export_location_get', 'export_location_reset'])
})

test('取消选择不改位置，选择失败显示错误并保留原路径，忙时不重复打开选择器', async () => {
  let mode = 'cancel', finish, choices = 0
  const h = harness(async command => {
    if (command === 'export_location_get') return { directory: '/old', isDefault: false }
    choices += 1
    if (mode === 'cancel') return null
    if (mode === 'error') throw new Error('无法写入导出文件夹')
    return new Promise(resolve => { finish = resolve })
  })
  await h.ui.open(); const previous = h.node('exportDirectoryStatus').textContent
  await h.click('chooseExportDirectory')
  assert.equal(h.node('exportDirectoryPath').textContent, '/old')
  assert.equal(h.node('exportDirectoryStatus').textContent, previous)
  mode = 'error'; await h.click('chooseExportDirectory')
  assert.match(h.node('exportDirectoryStatus').textContent, /无法写入/)
  assert.equal(h.node('exportDirectoryPath').textContent, '/old')
  assert.equal(h.node('resetExportDirectory').disabled, false)
  mode = 'wait'; const pending = h.click('chooseExportDirectory')
  assert.equal(h.node('chooseExportDirectory').disabled, true)
  await h.click('chooseExportDirectory')
  assert.equal(choices, 3)
  finish(null); await pending
  assert.equal(h.node('chooseExportDirectory').disabled, false)
})

test('损坏设置仍可重选或恢复默认；浏览器版明确使用浏览器下载设置', async () => {
  const h = harness(async () => { throw '无法读取导出设置' })
  await h.ui.open()
  assert.match(h.node('exportDirectoryStatus').textContent, /无法读取/)
  assert.equal(h.node('resetExportDirectory').disabled, false)
  const browser = harness(null)
  await browser.ui.open()
  assert.match(browser.node('exportDirectoryPath').textContent, /浏览器下载设置/)
  assert.equal(browser.node('chooseExportDirectory').disabled, true)
})
