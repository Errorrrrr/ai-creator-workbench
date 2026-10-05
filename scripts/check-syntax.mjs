import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
for (const directory of ['src', 'scripts', 'tests']) {
  for (const file of readdirSync(directory).filter(name => /\.(js|mjs)$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status || 1)
  }
}
console.log('All source, script and test JavaScript syntax checks passed.')
