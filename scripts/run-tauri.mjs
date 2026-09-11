import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, join, resolve } from 'node:path'

const environment = { ...process.env }
const cargoCandidates = process.platform === 'win32'
  ? [join(environment.USERPROFILE || '', '.cargo', 'bin', 'cargo.exe')]
  : [join(environment.HOME || '', '.cargo', 'bin', 'cargo')]
const cargo = cargoCandidates.find((candidate) => candidate && existsSync(candidate))

if (cargo) {
  const pathEntries = (environment.PATH || '').split(delimiter).filter(Boolean)
  if (!pathEntries.includes(dirname(cargo))) pathEntries.unshift(dirname(cargo))
  environment.PATH = pathEntries.join(delimiter)
}

const tauriEntrypoint = resolve('node_modules', '@tauri-apps', 'cli', 'tauri.js')
const result = spawnSync(process.execPath, [tauriEntrypoint, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: environment,
  stdio: 'inherit'
})

if (result.error) {
  console.error(`Unable to start Tauri CLI: ${result.error.message}`)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
