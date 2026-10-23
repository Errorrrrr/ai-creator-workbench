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
copyFileSync(join(projectRoot, 'src/storyboard-characters.js'), join(sourceOutput, 'storyboard-characters.js'))
copyFileSync(join(projectRoot, 'src/video-return.js'), join(sourceOutput, 'video-return.js'))
copyFileSync(join(projectRoot, 'src/shot-workflow.js'), join(sourceOutput, 'shot-workflow.js'))
for (const fileName of ['production-overview.js', 'asset-library-tools.js', 'writing-preview.js']) copyFileSync(join(projectRoot, 'src', fileName), join(sourceOutput, fileName))
for (const stylesheet of ['workbench-layout.css', 'media-layout.css', 'production-tools.css', 'writing-preview.css']) copyFileSync(join(projectRoot, 'src', stylesheet), join(sourceOutput, stylesheet))
for (const fileName of ['storyboard-references.js', 'storyboard-tasks.js', 'storyboard-scope.js', 'cli-proxy.js', 'app.js', 'knowledge-index.js', 'project-store.js', 'semantic-search.js', 'inspirations.js', 'creation-workflow.js', 'workflow-navigation.js', 'provider-stream.js', 'updates.js', 'update-ui.js', 'update-installer.js', 'storyboard.js', 'video-export.js', 'media-adapters.js', 'media-workbench.js', 'character-images.js', 'project-operations.js', 'project-plan-ui.js', 'candidate-drafts.js', 'candidate-drafts-ui.css', 'review-diff.js', 'review-diff.css', 'styles.css']) {
  copyFileSync(join(projectRoot, 'src', fileName), join(sourceOutput, fileName))
}

console.log(`Desktop frontend prepared at ${outputRoot}`)
