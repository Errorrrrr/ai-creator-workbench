import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, '..')
const outputRoot = join(projectRoot, 'dist')
const sourceOutput = join(outputRoot, 'src')

rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(sourceOutput, { recursive: true })

copyFileSync(join(projectRoot, 'index.html'), join(outputRoot, 'index.html'))
for (const fileName of ['app.js', 'knowledge-index.js', 'project-store.js', 'semantic-search.js', 'inspirations.js', 'creation-workflow.js', 'workflow-navigation.js', 'provider-stream.js', 'updates.js', 'update-ui.js', 'storyboard.js', 'media-adapters.js', 'media-workbench.js', 'project-operations.js', 'project-plan-ui.js', 'candidate-drafts.js', 'candidate-drafts-ui.css', 'review-diff.js', 'review-diff.css', 'styles.css']) {
  copyFileSync(join(projectRoot, 'src', fileName), join(sourceOutput, fileName))
}

console.log(`Desktop frontend prepared at ${outputRoot}`)
