import { ASSET_ROLES, findMediaVersion, mediaPrompt, shotIsStale, validateStoryboard, shotInputFingerprint, shotInputFieldFingerprints } from './storyboard.js'
import { matchShotReferences, referenceBindingWarnings } from './storyboard-references.js'

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const roles = { reference: '主体参考', start: '起始帧', end: '结束帧', selected: '选用分镜图', extend: '续接视频' }

export function buildFlowExport(data, assets) { return buildVideoExport(data, assets, 'flow') }
export function buildMuseExport(data, assets) { return buildVideoExport(data, assets, 'muse') }

function museMessage(shot, project, references, starts, ends, number) {
  const duration = shot.videoDuration ?? shot.duration
  return [
    `请使用 Meta Muse Video 为下面的第 ${number} 镜生成一个视频片段，并返回可查看或下载的生成结果。`,
    '如果当前账号无法调用 Muse Video，请明确说明，不要把剧本说明或静态图片当作已生成的视频。',
    `本次生成时长：${duration} 秒；剧情目标时长：${shot.duration} 秒；目标画幅：${shot.aspectRatio || '16:9'}。如果无法满足，请先告诉我实际支持的选项，不要擅自改写动作或截掉对白。`,
    '', mediaPrompt({ ...shot, duration }, project), '',
    references.length ? '本条消息随附图片的对应关系（仅使用本镜头附件）：' : '本镜头没有附参考图，请依据以上文字生成。',
    ...references.map((ref, index) => `附件 ${index + 1}（${ref.path.split('/').pop()}）：${ref.assetRole}「${ref.name}」，用途：${ref.roles.map(role => roles[role]).join('、')}。`),
    ...(references.length ? ['保持上传图片中的人物身份、服装、道具和场景一致。若无法识别附件或无法同时使用这些图片，请先说明。'] : []),
    ...(starts.length ? [`期望开场画面参考：${starts.map(ref => ref.path.split('/').pop()).join('、')}。`] : []),
    ...(ends.length ? [`期望结束画面参考：${ends.map(ref => ref.path.split('/').pop()).join('、')}。`] : []),
    ...(starts.length || ends.length ? ['首尾画面是创作要求；若不能精确约束首尾帧，请说明可实现的方式。'] : []),
    shot.dialogue.trim() ? '声音：按上述对白及说话人标注发声，保留原文语言，不添加台词。若无法准确生成对白，请告知，便于后期配音。' : '声音：不添加人物对白或旁白；环境声与画面动作相符。',
    ...(shot.videoMode === 'extend' ? ['原镜头设为视频续接，但本包未附源视频；先说明所需源视频及支持方式，收到后再生成。'] : []),
    '仅处理这一镜头，不自动生成其他镜头。', ''
  ].join('\n')
}

// Export only the current storyboard and its explicitly pinned versions, never connections or jobs.
function buildVideoExport({ projectId, project, storyboard, documents = {}, exportScope = '' }, assets, target) {
  const muse = target === 'muse', platform = muse ? 'Muse' : 'Flow'
  validateStoryboard(storyboard)
  if (!storyboard.shots.length) throw new Error('尚无分镜，请先拆镜或新建镜头再导出')
  const texts = [], images = [], shots = []
  for (const [index, shot] of storyboard.shots.entries()) {
    const folder = `shot-${String(index + 1).padStart(3, '0')}`
    const generationDuration = shot.videoDuration ?? shot.duration
    const warnings = [], references = [], byVersion = new Map()
    const bindings = referenceBindingWarnings(shot, assets, documents)
    if (bindings.legacy.length) warnings.push(`${bindings.legacy.length} 项旧引用未记录自动或手动来源，原版本已保留，请核对。`)
    if (bindings.unmatched.length) warnings.push(`以下保留引用未匹配本镜头当前角色、场景或道具，请核对：${bindings.unmatched.map(item => item.name).join('、')}。`)
    for (const match of matchShotReferences(shot, assets, documents)) if (!['bound', 'excluded'].includes(match.status)) warnings.push(`${ASSET_ROLES[match.role]}「${match.name}」尚未绑定对应参考图，请核对或补充参考。`)
    if (shotIsStale(shot, documents)) warnings.push('剧本来源已更新，请核对本镜头内容。')
    for (const ref of [...shot.references, ...(shot.selectedImageVersionId ? [{ role: 'selected', versionId: shot.selectedImageVersionId }] : [])]) {
      const found = findMediaVersion(assets, ref.versionId)
      if (!found) throw new Error(`第 ${index + 1} 镜「${shot.title}」的${roles[ref.role]}版本不存在，请修复引用后导出`)
      const extension = extensions[found.version.mimeType]
      if (!extension) {
        warnings.push(`${roles[ref.role]}「${found.asset.name}」不是图片，未导出；视频续接需在 ${platform} 中另行处理。`)
        continue
      }
      let entry = byVersion.get(ref.versionId)
      if (!entry) {
        const path = `${folder}/ref-${String(byVersion.size + 1).padStart(2, '0')}.${extension}`
        entry = { path, versionId: ref.versionId, name: found.asset.name, assetRole: ASSET_ROLES[found.asset.role] || '其他', roles: [] }
        byVersion.set(ref.versionId, entry)
        references.push(entry)
        images.push({ path, versionId: ref.versionId })
      }
      if (!entry.roles.includes(ref.role)) entry.roles.push(ref.role)
    }
    if (!references.length) warnings.push('本镜头没有参考图片，可用文字生成，或先补充并绑定参考图。')
    if (shot.videoMode === 'extend') warnings.push(`本镜头原设为视频续接，本包仅提供提示词与图片，需在 ${platform} 内确认续接方式。`)
    const explicitStarts = references.filter(ref => ref.roles.includes('start'))
    const starts = explicitStarts.length ? explicitStarts : references.filter(ref => ref.roles.includes('selected'))
    const ends = references.filter(ref => ref.roles.includes('end'))
    if (starts.length > 1 || ends.length > 1) warnings.push(`存在多个首帧或尾帧，请在 ${platform} 中人工选择。`)
    const mode = muse ? '聊天生成（Meta Muse Video）' : shot.videoMode === 'reference-to-video' ? 'Ingredients（参考素材）' : starts.length || ends.length ? 'Frames（首尾帧）' : references.length ? 'Ingredients（参考素材）' : '文字生成'
    const prompt = muse ? museMessage(shot, project, references, starts, ends, index + 1) : `${mediaPrompt({ ...shot, duration: generationDuration }, project)}\n剧情目标时长：${shot.duration} 秒；本次生成：${generationDuration} 秒。${references.length ? '\n保持上传参考中的人物身份、服装、道具和场景一致。' : ''}\n`
    const instructions = [
      `# 第 ${index + 1} 镜：${shot.title}`, '', `建议入口：${mode}`, `剧情目标时长：${shot.duration} 秒；本次生成时长：${generationDuration} 秒；画幅：${shot.aspectRatio || '16:9'}。请以 ${platform} 当前模型实际支持为准。`,
      `下载后建议命名：${folder}-${shot.id}.mp4（保留镜头标识，便于回填工作台）。`,
      `首帧建议：${starts.map(ref => ref.path.split('/').pop()).join('、') || '未指定'}`, `尾帧建议：${ends.map(ref => ref.path.split('/').pop()).join('、') || '未指定'}`,
      '', '## 参考图片', ...references.map(ref => `- ${ref.path.split('/').pop()}：${ref.assetRole}「${ref.name}」；用途：${ref.roles.map(role => roles[role]).join('、')}；固定版本：${ref.versionId}`),
      '', '## 核对事项', ...warnings.map(warning => `- ${warning}`),
      muse ? '- 首尾帧和多图用途通过聊天表达；不保证当前账号支持精确首尾帧约束、全部参考图片或目标时长。' : '- Ingredients 与 Frames 的素材用途不同，请按所选模式上传；不需要把所有图片都塞进同一次生成。',
      '', muse ? '建议为本镜头新建聊天。按清单顺序上传本目录图片，并发送 prompt.txt 全文。若附件显示名变化，请在消息中对应修改。修改已有结果时，填写「修改消息.txt」中的方括号内容后，在同一聊天发送。' : '复制同目录 prompt.txt 的内容到 Flow 提示词框，再按以上清单上传图片。', ''
    ].join('\n')
    texts.push({ path: `${folder}/prompt.txt`, content: prompt }, { path: `${folder}/说明.md`, content: instructions })
    if (muse) texts.push({ path: `${folder}/修改消息.txt`, content: [
      '使用前填写方括号内容；本文件是修改模板，不要原样发送。', '',
      `请修改第 ${index + 1} 镜「${shot.title}」的上一版视频。`,
      '需要调整：[填写具体时间点、画面或声音问题，以及希望如何修改]。',
      '保留本镜头原先的角色身份、服装、场景、构图和未要求修改的动作及对白。',
      '请使用 Meta Muse Video 生成修改后的版本，并返回实际结果。若无法直接编辑上一版，请说明后按原参考和新要求重新生成。', ''
    ].join('\n') })
    shots.push({ number: index + 1, id: shot.id, title: shot.title, duration: shot.duration, videoDuration: generationDuration, sourceFingerprint: shot.sourceFingerprint, inputFingerprint: shotInputFingerprint(shot, documents), inputSnapshotVersion: 1, inputSnapshot: shotInputFieldFingerprints(shot, documents), suggestedVideoFilename: `${folder}-${shot.id}.mp4`, aspectRatio: shot.aspectRatio || '16:9', mode, promptPath: `${folder}/prompt.txt`, references, warnings })
  }
  texts.push({ path: 'manifest.json', content: JSON.stringify({ format: muse ? 'meta-muse-chat-handoff' : 'google-flow-handoff', version: 1, projectId, projectName: project.name, storyboardRevision: storyboard.revision, shots }, null, 2) })
  texts.push({ path: '使用说明.md', content: [
    `# ${project.name} · ${muse ? 'Muse 聊天' : 'Google Flow'}素材包`, '', `这是供手动上传使用的文件夹，不是 ${platform} 一键导入格式，也不会自动提交生成任务。`, '',
    ...(muse ? [
      '1. 打开 https://muse.ai/ 并进入聊天。建议每个镜头新建聊天，避免同名附件与前一镜头混淆。',
      '2. 按 shot-001、shot-002 的顺序打开镜头文件夹，先阅读「说明.md」并处理核对事项。',
      '3. 按说明顺序上传该镜头图片，将 prompt.txt 全文作为聊天消息发送。没有图片时直接发送文字。',
      '4. 消息已包含视频生成请求、画幅、目标时长、参考用途、画面动作及对白要求。能力或附件数量不支持时，按 Muse 实际反馈调整。',
      '5. 审核返回的视频；需要修改时填写「修改消息.txt」模板，在原聊天继续。完成后下载视频并按镜头编号命名，再剪辑。'
    ] : ['1. 打开 https://flow.google/，新建或进入项目。', '2. 按 shot-001、shot-002 的顺序打开镜头文件夹，先阅读「说明.md」。', '3. 选择视频生成，根据镜头说明选择 Frames（首尾帧）或 Ingredients（参考素材），上传相应图片。', '4. 复制 prompt.txt，设置支持的画幅与时长后生成；超出可选时长时，拆成多段或在 Flow 内续接。', '5. 审核人物、动作、对白与衔接，再下载视频进行剪辑。']),
    '', '## 视频回填', '下载视频后，按各镜头说明中的建议文件名保存。在工作台分镜页选择“回填外部视频”，读取本包 manifest.json 并导入视频，核对匹配结果后确认关联。编号匹配使用本次导出清单，不使用当前镜头排序；文件名包含镜头完整标识时也可直接匹配。未匹配的视频可手动选择镜头。关联只更换选用版本，旧素材保留，视频仍需人工审核。',
    '', '参考图是镜头绑定的固定版本，不会替换为素材库的新版本。相同图片在同一镜头内只保存一份。没有绑定到镜头的素材不在本包中。',
    `本包仅导出图片，不包含续接视频；缺少图片、来源变化等情况见各镜头说明。图片格式、参考数量、声音与生成能力以 ${platform} 当前账号和模型为准。`,
    '', ...(muse ? ['官方产品介绍：https://ai.meta.com/muse/', '官方模型介绍：https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/', '本包的聊天模板为工作台整理的使用建议，不是官方 API 参数或已验证的账号能力。'] : ['官方操作说明：https://support.google.com/flow/answer/16353334']), '', '## 镜头清单',
    ...shots.map(shot => `- ${String(shot.number).padStart(3, '0')} ${shot.title}：${shot.references.length} 张图片${shot.warnings.length ? `；${shot.warnings.join(' ')}` : ''}`), ''
  ].join('\n') })
  return { projectName: project.name, scopeName: exportScope, texts, images }
}
