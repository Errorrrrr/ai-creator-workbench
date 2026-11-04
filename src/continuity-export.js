import { normalizeContinuity, entityStateFingerprint, entityReferencePrompt } from './continuity-assets.js'
import { planLegacyContinuityReferences } from './continuity-linking.js'

const labels = { character: '人物', scene: '场景', prop: '关键物品' }
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const bytes = value => new TextEncoder().encode(value).byteLength

// Numbering keeps even identically sanitized names distinct on case-insensitive disks.
function folder(index, name) {
  let value = String(name).normalize('NFKC').replace(/[\p{Cc}<>:"/\\|?*]/gu, '_').replace(/^[\s.]+|[\s.]+$/gu, '') || '未命名'
  while (bytes(value) > 100) value = Array.from(value).slice(0, -1).join('')
  return `${String(index + 1).padStart(3, '0')}_${value.replace(/[\s.]+$/gu, '')}`
}

export function buildContinuityExport(data, assets, { kind = 'all', generatedAt = new Date().toISOString() } = {}) {
  if (!data?.projectId) throw new Error('请先打开项目')
  if (kind !== 'all' && !labels[kind]) throw new Error('设定分类无效')
  const legacy = planLegacyContinuityReferences(normalizeContinuity(data.storyboard?.continuity), assets, data.projectId)
  const continuity = legacy.continuity
  const selected = continuity.entities.filter(entity => kind === 'all' || entity.kind === kind)
  if (!selected.length) throw new Error('当前分类尚无设定，请先提取并采纳或手动新增设定')
  if (selected.reduce((count, entity) => count + entity.states.length, 0) > 4000) throw new Error('设定状态超过 4000 个，请按分类分批导出')
  const texts = [], images = [], entities = []
  const sources = ids => ids.map(id => ({ id, title: data.documents?.[id]?.title || '来源已移除' }))
  for (const [index, entity] of selected.entries()) {
    const directory = `${labels[entity.kind]}/${folder(index, entity.name)}`
    const states = entity.states.map((state, stateIndex) => {
      const path = `${directory}/${folder(stateIndex, state.name)}`, warnings = []
      const matching = assets.flatMap(asset => (asset.versions || []).filter(version => version.id === state.referenceVersionId).map(version => ({ asset, version })))
      let reference = null, status = 'missing'
      if (state.referenceVersionId && matching.length) {
        if (matching.length !== 1) throw new Error(`${entity.name} · ${state.name}：图片版本标识重复，无法确定导出文件`)
        const { asset, version } = matching[0]
        if (asset.projectId !== data.projectId || asset.kind !== 'image' || asset.role !== entity.kind || !extensions[version.mimeType]) throw new Error(`${entity.name} · ${state.name}：参考图不属于当前项目的同类图片，请重新选择`)
        status = state.referenceFingerprint === entityStateFingerprint(entity, state, continuity.style) ? 'ready' : 'stale'
        reference = { path: `${path}/参考图.${extensions[version.mimeType]}`, versionId: version.id, assetId: asset.id, assetName: asset.name, mimeType: version.mimeType }
        images.push({ path: reference.path, versionId: version.id })
      }
      if (status === 'missing') warnings.push(state.referenceVersionId ? '选用的图片版本已不存在，本状态仅导出文字；请重新选图。' : '尚未选用此状态设定图，本状态仅导出文字。')
      if (status === 'stale') warnings.push('图片对应旧定义，仅供核对；重新生成或确认选用后再用于视频。')
      warnings.push(...legacy.issues.filter(issue => issue.entityId === entity.id && issue.stateId === state.id).map(issue => issue.message))
      return { id: state.id, name: state.name, description: state.description, default: state.id === entity.defaultStateId, basedOnStateId: state.basedOnStateId, sources: sources(state.sourceDocumentIds), definitionFingerprint: entityStateFingerprint(entity, state, continuity.style), referenceFingerprint: state.referenceFingerprint, referenceVersionId: state.referenceVersionId, status, reference, directory: path, promptPath: `${path}/prompt.txt`, warnings }
    })
    // A missing or outdated base image must never be described as an attached, usable anchor.
    const promptEntity = { ...entity, states: entity.states.map(state => ({ ...state, referenceVersionId: states.find(item => item.id === state.id)?.status === 'ready' ? state.referenceVersionId : '' })) }
    for (const state of states) {
      const base = states.find(item => item.id === state.basedOnStateId)
      state.baseState = base ? { id: base.id, name: base.name, status: base.status, reference: base.reference } : null
      if (base && base.status !== 'ready') state.warnings.push('基础状态缺图或图片待确认；生成派生状态前请先准备已确认的基础图。')
      const prompt = [entityReferencePrompt(promptEntity, promptEntity.states.find(item => item.id === state.id), continuity.style),
        base?.status === 'ready' ? `生成前上传基础状态「${base.name}」的图片（包根目录相对路径）：${base.reference.path}。此图仅作为外形锚点，不代表本状态已经生成。` : '',
        state.status === 'ready' ? `本状态已有设定图：${state.reference.path}。继续编辑时上传此图并保留固定外形。` : '',
        state.warnings.length ? `生成前核对：${state.warnings.join(' ')}` : '', ''].filter(Boolean).join('\n') + '\n'
      const description = [`# ${entity.name} · ${state.name}`, '', `类型：${labels[entity.kind]}；${state.default ? '默认状态' : '派生／其他状态'}`, `统一风格：${continuity.style || '未指定'}`, `别名：${entity.aliases.join('、') || '无'}`, '', '## 固定外形', entity.traits || '未填写', '', '## 设定说明', entity.description || '未填写', '', '## 状态差异', state.description || '保持固定设定', '', `基础状态：${base?.name || '无'}`, `适用分场：${state.sources.map(source => source.title).join('、') || '默认或未指定'}`, `对象出场：${sources(entity.sourceDocumentIds).map(source => source.title).join('、') || '未指定'}`, '', '## 图片', `当前图：${state.reference?.path || '无'}；状态：${{ ready: '可用', missing: '缺图', stale: '待确认' }[state.status]}`, `固定版本：${state.referenceVersionId || '未选用'}`, `基础图：${base?.reference?.path || '无'}（仅作外形锚点）`, '', '图片路径均相对于素材包根目录。先按 prompt.txt 的要求上传对应图片，再生成或编辑。', ...state.warnings.map(warning => `- ${warning}`), ''].join('\n')
      texts.push({ path: `${state.directory}/设定.md`, content: description }, { path: state.promptPath, content: prompt })
    }
    entities.push({ id: entity.id, kind: entity.kind, name: entity.name, aliases: entity.aliases, description: entity.description, fixedTraits: entity.traits, sources: sources(entity.sourceDocumentIds), defaultStateId: entity.defaultStateId, directory, states })
  }
  const stateCount = entities.reduce((count, entity) => count + entity.states.length, 0)
  const warnings = entities.flatMap(entity => entity.states.flatMap(state => state.warnings.map(message => `${entity.name} · ${state.name}：${message}`)))
  texts.push({ path: 'manifest.json', content: JSON.stringify({ format: 'continuity-setting-handoff', version: 1, projectId: data.projectId, projectName: data.project.name, storyboardRevision: data.storyboard.revision, generatedAt, kind, style: continuity.style, entities }, null, 2) })
  texts.push({ path: '使用说明.md', content: [`# ${data.project.name} · ${kind === 'all' ? '全部' : labels[kind]}设定素材包`, '', `导出时间：${generatedAt}`, `包含 ${entities.length} 项设定、${stateCount} 个状态、${images.length} 张固定版本图片。`, '', '这是独立的图片与文字素材包，无需工作台即可查看；不包含账号、连接设置或生成任务。', '按“人物／场景／关键物品 → 名称 → 状态”查找。每个状态有设定.md 和 prompt.txt，已选用的实际图片保存在同一目录。', '可以在设定面板切换分类，分别导出人物、场景或关键物品。', '', '1. 先查看设定.md 中的固定外形、状态差异和适用分场。', '2. 生成设定图时复制 prompt.txt，按提示上传当前状态或基础状态的对应图片。基础图保存在同一对象的基础状态目录。', '3. 为视频选择与当前分场一致的状态图；缺图时先补齐，不要用基础图冒充破损、变装或其他状态。', '4. Flow／Muse 的逐镜头提示词与图片请使用分镜页的对应导出入口，本包用于独立维护和生成设定素材。', '', '缺图状态仍保留文字；待确认的图片附带原版本供核对，不能当作最新定义。后续在工作台改图或改设定不会改变本包。', 'manifest.json 记录对象、状态、来源分场、基础状态、固定版本与待处理项；路径均相对于本包根目录。', '', '## 待处理项', ...(warnings.length ? warnings.map(warning => `- ${warning}`) : ['无，已选用图片均对应当前设定。']), ''].join('\n') })
  if (texts.reduce((size, entry) => size + bytes(entry.content), 0) > 64 * 1024 * 1024) throw new Error('设定文字超过素材包容量，请按分类分批导出')
  return { projectName: data.project.name, scopeName: kind === 'all' ? '全部设定' : labels[kind], texts, images }
}
