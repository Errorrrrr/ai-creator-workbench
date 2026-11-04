import test from 'node:test'
import assert from 'node:assert/strict'
import { emptySceneContinuity, validateSceneContinuity, sceneContentFingerprint, sceneContinuityContext, sceneContinuityStateDocumentIds } from '../src/scene-continuity.js'
import { contentFingerprint } from '../src/storyboard.js'
import { createEntity, createEntityState } from '../src/continuity-assets.js'

function fixture() {
  const raft = createEntity({
    id: 'raft', kind: 'prop', name: '木筏', aliases: ['浮台'], description: '漂在海面上的拼装浮台', traits: '平板筏面，四个固定油桶', sourceDocumentIds: ['scene-a', 'scene-b'],
    states: [createEntityState({ id: 'intact', name: '完整', description: '四角完整' }), createEntityState({ id: 'damaged', name: '破损', description: '筏头缺一角', basedOnStateId: 'intact', sourceDocumentIds: ['scene-b'] })],
    defaultStateId: 'intact',
  })
  const future = createEntity({ id: 'train', kind: 'prop', name: '火车', sourceDocumentIds: ['scene-c'], states: [createEntityState({ id: 'train-base', name: '基础' })] })
  const documents = {
    'scene-a': { title: '甲场', content: '木筏撞上礁石，筏头破损。' },
    'scene-b': { title: '乙场', content: '浮台仍在海面漂流。' },
    'scene-c': { title: '未来场', content: '火车驶过山谷，未来资料不得加入。' },
    'unrelated': { title: '孤立文档', content: '不在幕集场顺序内。' },
  }
  const state = (id, patch = {}) => ({ ...emptySceneContinuity(), sourceFingerprint: sceneContentFingerprint(documents[id].content), ...patch })
  documents['scene-a'].sceneContinuity = state('scene-a', { exitState: '木筏筏头破损，人物仍在筏上。', exitBindings: [{ entityId: 'raft', stateId: 'damaged' }] })
  documents['scene-b'].sceneContinuity = state('scene-b', { transition: 'continuous', entryState: '筏头保持破损，人物仍在筏上。', changes: '人物移向筏尾。', exitState: '人物站在筏尾。', entryBindings: [{ entityId: 'raft', stateId: 'damaged' }], exitBindings: [{ entityId: 'raft', stateId: 'damaged' }] })
  return {
    documentId: 'scene-b', documents,
    structure: { acts: [{ id: 'act', episodeIds: ['ep-a', 'ep-b'] }], episodes: { 'ep-a': { sceneIds: ['scene-a'] }, 'ep-b': { sceneIds: ['scene-b', 'scene-c'] } } },
    storyboard: { continuity: { version: 1, style: '写实电影，低饱和冷色', entities: [raft, future] } },
  }
}

test('分场状态默认值独立，验证严格拒绝损坏、重复和超限数据', () => {
  const a = emptySceneContinuity(), b = emptySceneContinuity()
  a.entryBindings.push({ entityId: 'raft', stateId: 'intact' })
  assert.equal(b.entryBindings.length, 0)
  assert.equal(validateSceneContinuity(a), a)
  for (const mutate of [
    s => { s.transition = 'unknown' }, s => { s.extra = 'untrusted' }, s => { s.entryState = null }, s => { delete s.changes },
    s => { s.exitState = '字'.repeat(12001) }, s => { s.sourceFingerprint = 'a'.repeat(201) }, s => { s.entryState = 'bad\u0000' },
    s => { s.entryBindings = {} }, s => { s.entryBindings = [{ entityId: '../raft', stateId: 'base' }] },
    s => { s.entryBindings = [{ entityId: 123, stateId: 'base' }] }, s => { s.entryBindings = [{ entityId: 'raft', stateId: 'base', unexpected: true }] },
    s => { s.entryBindings = [{ entityId: 'raft', stateId: 'base' }, { entityId: 'raft', stateId: 'other' }] },
    s => { s.exitBindings = Array.from({ length: 129 }, (_, i) => ({ entityId: `e-${i}`, stateId: 'base' })) },
  ]) { const value = emptySceneContinuity(); mutate(value); assert.throws(() => validateSceneContinuity(value)) }
  for (const value of [null, undefined, [], 1, 'state']) assert.throws(() => validateSceneContinuity(value))
})

test('正文指纹与已有分镜指纹算法一致，支持中文和代理对字符', () => {
  for (const text of ['', '正文', '🌊人物站在筏尾', 'line\nend']) assert.equal(sceneContentFingerprint(text), contentFingerprint(text))
})

test('轻量状态范围与真实上下文一致，不构造素材正文，也尊重前场排除', () => {
  const data = fixture()
  assert.deepEqual(sceneContinuityStateDocumentIds(data), sceneContinuityContext(data).stateDocumentIds)
  assert.deepEqual(sceneContinuityStateDocumentIds({ ...data, includePrevious: false }), ['scene-b'])
  delete data.documents['scene-a'].sceneContinuity
  delete data.documents['scene-b'].sceneContinuity
  data.storyboard.continuity.entities[0].description = '大量设定'.repeat(30000)
  assert.deepEqual(sceneContinuityStateDocumentIds(data), [])
})

test('按实际幕集场顺序跨集携带前场结束，素材与派生状态继承完整，不带未来场', () => {
  const data = fixture(), before = structuredClone(data), context = sceneContinuityContext(data)
  assert.deepEqual(context.entityIds, ['raft'])
  assert.deepEqual(context.stateDocumentIds, ['scene-b', 'scene-a'])
  assert.match(context.text, /平板筏面，四个固定油桶/)
  assert.match(context.text, /筏头缺一角/)
  assert.match(context.text, /baseStates.*完整/)
  assert.match(context.text, /木筏撞上礁石/)
  assert.match(context.text, /人物移向筏尾/)
  assert.doesNotMatch(context.text, /火车|未来资料不得加入|孤立文档/)
  assert.deepEqual(context.conflicts, [])
  assert.deepEqual(context.warnings, [])
  assert.deepEqual(data, before)
})

test('明确连续动作入口不匹配前场出口会提示命名冲突，本场变化不能掩盖场间矛盾', () => {
  const data = fixture()
  data.documents['scene-b'].sceneContinuity.entryBindings[0].stateId = 'intact'
  data.documents['scene-b'].sceneContinuity.changes = '木筏随后撞坏了。'
  const context = sceneContinuityContext(data)
  assert.equal(context.conflicts.length, 1)
  assert.match(context.conflicts[0], /木筏.*上一场结束为「破损」.*本场进入为「完整」/)
  assert.match(context.text, /已发现的明确冲突/)
})

test('切镜和时空跳转不把状态变化认定为连续动作冲突，也不自动套用上一场空间', () => {
  for (const transition of ['cut', 'time-jump']) {
    const data = fixture()
    data.documents['scene-b'].sceneContinuity.transition = transition
    data.documents['scene-b'].sceneContinuity.entryBindings[0].stateId = 'intact'
    const context = sceneContinuityContext(data)
    assert.deepEqual(context.conflicts, [])
    assert.match(context.text, /不自动把上一场的空间、光线或实际尾帧套用到本场/)
  }
})

test('自然语言不同措辞不做字面相等冲突推断', () => {
  const data = fixture()
  data.documents['scene-b'].sceneContinuity.entryState = '拼装浮台的前端留有撞击后的缺口。'
  assert.deepEqual(sceneContinuityContext(data).conflicts, [])
})

test('失效素材或状态引用不被丢弃或编造，会明确提示当前与上一场的冲突', () => {
  const data = fixture()
  data.documents['scene-b'].sceneContinuity.entryBindings = [{ entityId: 'gone', stateId: 'base' }]
  data.documents['scene-a'].sceneContinuity.exitBindings = [{ entityId: 'raft', stateId: 'missing' }]
  const context = sceneContinuityContext(data)
  assert.equal(context.conflicts.length, 2)
  assert.match(context.conflicts.join('\n'), /本场进入状态引用的素材已不存在/)
  assert.match(context.conflicts.join('\n'), /上一场结束状态中「木筏」的状态已不存在/)
})

test('正文变化和没有来源指纹均诚实提示重新核对，不把旧状态当作已核实', () => {
  const data = fixture()
  data.documents['scene-a'].content += '后来又修好了。'
  data.documents['scene-b'].sceneContinuity.sourceFingerprint = ''
  const context = sceneContinuityContext(data)
  assert.match(context.warnings.join('\n'), /上一场正文已修改/)
  assert.match(context.warnings.join('\n'), /本场状态尚未记录正文依据/)
})

test('连续场缺少前场或前场结束状态时给出不确定性提示，不假造状态', () => {
  const data = fixture()
  delete data.documents['scene-a'].sceneContinuity
  assert.match(sceneContinuityContext(data).warnings.join('\n'), /上一场尚未保存结束状态/)
  data.documentId = 'scene-a'
  data.documents['scene-a'].sceneContinuity = { ...emptySceneContinuity(), transition: 'continuous' }
  assert.match(sceneContinuityContext(data).warnings.join('\n'), /没有可用的上一场/)
})

test('旧项目没有分场状态仍可生成，只提供实际素材与前文并提示未确认', () => {
  const data = fixture()
  for (const doc of Object.values(data.documents)) delete doc.sceneContinuity
  const context = sceneContinuityContext(data)
  assert.deepEqual(context.stateDocumentIds, [])
  assert.match(context.warnings.join('\n'), /本场尚未保存/)
  assert.deepEqual(context.conflicts, [])
  assert.match(context.text, /木筏撞上礁石/)
})

test('明确排除前场时不绕过排除规则携带前文、状态、冲突或缺失提醒', () => {
  const data = fixture()
  data.documents['scene-a'].sceneContinuity.exitBindings[0].stateId = 'intact'
  data.documents['scene-a'].content += '已修改的前文'
  const context = sceneContinuityContext({ ...data, includePrevious: false })
  assert.deepEqual(context.stateDocumentIds, ['scene-b'])
  assert.deepEqual(context.conflicts, [])
  assert.deepEqual(context.warnings, [])
  assert.doesNotMatch(context.text, /上一场实际资料|木筏撞上礁石|已修改的前文/)
  const before = context.fingerprint
  data.documents['scene-a'].content += '又一处前文修改'
  assert.equal(sceneContinuityContext({ ...data, includePrevious: false }).fingerprint, before)
})

test('前场只有结束状态参与承接检查，不将前场未用到的入口失效误报为本次冲突', () => {
  const data = fixture()
  data.documents['scene-a'].sceneContinuity.entryBindings = [{ entityId: 'gone', stateId: 'gone' }]
  assert.deepEqual(sceneContinuityContext(data).conflicts, [])
})

test('相关素材可由当前正文、要求、镜头名单和绑定匹配，英文别名不匹配单词子串', () => {
  const data = fixture()
  const entity = data.storyboard.continuity.entities[1]
  entity.sourceDocumentIds = []; entity.name = 'Train'; entity.aliases = ['Ann']
  assert.deepEqual(sceneContinuityContext({ ...data, prompt: 'Joanne 在车站。' }).entityIds, ['raft'])
  assert.deepEqual(sceneContinuityContext({ ...data, prompt: 'Ann 在车站。' }).entityIds, ['raft', 'train'])
  assert.deepEqual(sceneContinuityContext({ ...data, shot: { propNames: ['Train'] } }).entityIds, ['raft', 'train'])
  data.documents['scene-b'].sceneContinuity.exitBindings.push({ entityId: 'train', stateId: 'train-base' })
  assert.deepEqual(sceneContinuityContext(data).entityIds, ['raft', 'train'])
})

test('上下文指纹捕获相关素材祖先及前场结尾变化，忽略未来场和无关素材', () => {
  const data = fixture(), original = sceneContinuityContext(data).fingerprint
  data.storyboard.continuity.entities[1].traits = '未来火车变红色'
  data.documents['scene-c'].content += '未来内容已修改'
  assert.equal(sceneContinuityContext(data).fingerprint, original)
  data.storyboard.continuity.entities[0].states[0].description = '四角有金属护板'
  assert.notEqual(sceneContinuityContext(data).fingerprint, original)
  const second = sceneContinuityContext(data).fingerprint
  data.documents['scene-a'].sceneContinuity.exitState = '筏尾也破损了。'
  assert.notEqual(sceneContinuityContext(data).fingerprint, second)
})

test('前文长正文只标明结尾摘录，固定设定过大直接拒绝，不生成截断JSON', () => {
  const data = fixture()
  data.documents['scene-a'].content = '早期内容'.repeat(1000) + '最后一条已采纳事实'
  const context = sceneContinuityContext(data)
  assert.match(context.text, /"excerptOnly":true/)
  assert.match(context.text, /最后一条已采纳事实/)
  const material = data.storyboard.continuity.entities[0]
  material.description = '字'.repeat(12000)
  material.traits = '字'.repeat(12000)
  data.documents['scene-b'].sceneContinuity.entryState = '字'.repeat(12000)
  data.documents['scene-b'].sceneContinuity.exitState = '字'.repeat(12000)
  assert.throws(() => sceneContinuityContext(data), /超过 48000.*未截断设定/)
  const unrestricted = sceneContinuityContext({ ...data, enforceLimit: false })
  assert.ok(unrestricted.text.length > 48000)
  assert.ok(unrestricted.text.includes(material.description))
  assert.ok(unrestricted.text.includes(data.documents['scene-b'].sceneContinuity.exitState))
})

test('镜头手动排除按实体ID、规范名称或别名生效，不借分场绑定强制恢复规范', () => {
  for (const key of ['prop:@raft', 'prop:木筏', 'prop:浮台', 'prop:浮台（主要物品）']) {
    const data = fixture(), shot = { referenceExclusions: [key], references: [] }, before = structuredClone(data)
    const context = sceneContinuityContext({ ...data, shot })
    assert.deepEqual(context.entityIds, [])
    assert.doesNotMatch(context.text, /平板筏面，四个固定油桶|四角完整|筏头缺一角|"entityId":"raft"/)
    assert.match(context.warnings.join('\n'), /手动排除.*不自动恢复/)
    assert.match(context.warnings.join('\n'), /本场进入状态绑定了「木筏」/)
    assert.deepEqual(context.conflicts, [])
    assert.deepEqual(data, before)
    assert.deepEqual(shot, { referenceExclusions: [key], references: [] })
  }
})

test('手选异版参考明确保留人工选择，不强加规范或修改引用和参考版本', () => {
  const data = fixture(), item = data.storyboard.continuity.entities[0]
  item.states[1].referenceVersionId = 'canonical-image'
  const shot = { references: [{ versionId: 'manual-image', entityId: 'raft', role: 'reference', origin: 'manual' }] }
  const before = structuredClone({ data, shot }), context = sceneContinuityContext({ ...data, shot })
  assert.match(context.warnings.join('\n'), /已手动选用其他参考图，保留人工选择/)
  assert.match(context.warnings.join('\n'), /本场进入状态绑定了「木筏」.*未强加规范状态/)
  assert.doesNotMatch(context.text, /平板筏面，四个固定油桶|四角完整|筏头缺一角|"entityId":"raft"/)
  assert.deepEqual(context.entityIds, [])
  assert.deepEqual({ data, shot }, before)
  shot.references[0].versionId = 'canonical-image'
  assert.doesNotMatch(sceneContinuityContext({ ...data, shot }).warnings.join('\n'), /已手动选用其他参考图/)
})

test('手选异版已有分场状态时，未使用规范特征和状态变化不改变连续性指纹', () => {
  const data = fixture(), item = data.storyboard.continuity.entities[0]
  item.states[1].referenceVersionId = 'canonical-image'
  const shot = { references: [{ versionId: 'manual-image', entityId: 'raft', role: 'reference', origin: 'manual' }] }
  const original = sceneContinuityContext({ ...data, shot }).fingerprint
  item.traits = '修改为红色圆木结构'
  item.description = '全新规范外观描述'
  item.states[0].name = '未选用的新基础状态名'
  item.states[0].description = '未选用的祖先状态描述'
  item.states[1].name = '未选用的新派生状态名'
  item.states[1].description = '未选用的派生状态描述'
  const context = sceneContinuityContext({ ...data, shot })
  assert.equal(context.fingerprint, original)
  assert.doesNotMatch(context.text, /红色圆木|全新规范|未选用的/)
  assert.deepEqual(context.conflicts, [])
})

test('没有实体ID的旧手选参考可通过固定版本或素材来源识别，自动绑定不误报', () => {
  const data = fixture(), item = data.storyboard.continuity.entities[0]
  item.states[0].referenceVersionId = 'base-image'
  item.states[1].referenceVersionId = 'damaged-image'
  const shot = { references: [{ versionId: 'base-image', role: 'reference' }] }
  assert.match(sceneContinuityContext({ ...data, shot }).warnings.join('\n'), /已手动选用其他参考图/)
  shot.references[0].origin = 'auto'
  assert.doesNotMatch(sceneContinuityContext({ ...data, shot }).warnings.join('\n'), /已手动选用其他参考图/)
  const assets = [{ id: 'asset', kind: 'image', role: 'prop', name: '木筏', versions: [{ id: 'unknown-manual-image', mimeType: 'image/png' }] }]
  shot.references = [{ versionId: 'unknown-manual-image', role: 'reference' }]
  assert.match(sceneContinuityContext({ ...data, shot, assets }).warnings.join('\n'), /已手动选用其他参考图/)
})

test('素材、别名和阶段绑定重新排序不改变连续性输入指纹', () => {
  const data = fixture()
  const train = data.storyboard.continuity.entities[1]
  train.sourceDocumentIds = ['scene-b']; train.aliases = ['列车', '轨道车']
  data.documents['scene-b'].sceneContinuity.entryBindings.push({ entityId: 'train', stateId: 'train-base' })
  data.documents['scene-b'].sceneContinuity.exitBindings.push({ entityId: 'train', stateId: 'train-base' })
  const original = sceneContinuityContext(data).fingerprint
  data.storyboard.continuity.entities.reverse()
  train.aliases.reverse()
  data.documents['scene-b'].sceneContinuity.entryBindings.reverse()
  data.documents['scene-b'].sceneContinuity.exitBindings.reverse()
  assert.equal(sceneContinuityContext(data).fingerprint, original)
})

test('首镜自动参考与明确进入状态不同时只提示核对，不换图或误判为硬冲突', () => {
  const data = fixture(), shot = { id: 'first', sourceDocumentId: 'scene-b', references: [{ entityId: 'raft', stateId: 'intact', versionId: 'intact-image', role: 'reference', origin: 'auto' }] }
  data.storyboard.shots = [shot, { id: 'later', sourceDocumentId: 'scene-b', references: [] }]
  const before = structuredClone({ data, shot }), context = sceneContinuityContext({ ...data, shot })
  assert.match(context.warnings.join('\n'), /首镜自动参考为「完整」，本场进入为「破损」.*不自动换图/)
  assert.deepEqual(context.conflicts, [])
  assert.deepEqual({ data, shot }, before)
  shot.references[0].stateId = 'damaged'
  assert.doesNotMatch(sceneContinuityContext({ ...data, shot }).warnings.join('\n'), /首镜自动参考为/)
})

test('非首镜、手选和排除不推断阶段；本镜合法变化不要求参考等于整场结束状态', () => {
  const data = fixture(), shot = { id: 'first', sourceDocumentId: 'scene-b', references: [{ entityId: 'raft', stateId: 'damaged', versionId: 'damaged-image', role: 'reference', origin: 'auto' }] }
  data.storyboard.shots = [shot, { id: 'later', sourceDocumentId: 'scene-b', references: [] }]
  data.documents['scene-b'].sceneContinuity.exitBindings[0].stateId = 'intact'
  assert.doesNotMatch(sceneContinuityContext({ ...data, shot }).warnings.join('\n'), /首镜自动参考为/)
  shot.references[0].stateId = 'intact'
  assert.doesNotMatch(sceneContinuityContext({ ...data, shot: { ...shot, id: 'later' } }).warnings.join('\n'), /首镜自动参考为/)
  shot.references[0].origin = 'manual'
  assert.doesNotMatch(sceneContinuityContext({ ...data, shot }).warnings.join('\n'), /首镜自动参考为/)
  shot.references[0].origin = 'auto'; shot.referenceExclusions = ['prop:@raft']
  assert.doesNotMatch(sceneContinuityContext({ ...data, shot }).warnings.join('\n'), /首镜自动参考为/)
})

test('首镜自动参考实际存在但版本不同于状态已选图时提示核对', () => {
  const data = fixture(), shot = { id: 'first', sourceDocumentId: 'scene-b', references: [{ entityId: 'raft', stateId: 'damaged', versionId: 'old-image', role: 'reference', origin: 'auto' }] }
  data.storyboard.shots = [shot]
  data.storyboard.continuity.entities[0].states[1].referenceVersionId = 'new-image'
  const assets = [{ id: 'asset', kind: 'image', role: 'prop', name: '木筏', versions: [{ id: 'old-image', mimeType: 'image/png' }, { id: 'new-image', mimeType: 'image/png' }] }]
  assert.match(sceneContinuityContext({ ...data, shot, assets }).warnings.join('\n'), /首镜自动参考版本与「破损」已选状态图不同/)
})

test('无相关数据的普通文档不增加连续性资料，缺失目标文档拒绝生成', () => {
  const data = fixture()
  const context = sceneContinuityContext({ ...data, documentId: 'unrelated' })
  assert.equal(context.text, '')
  assert.deepEqual(context.warnings, [])
  assert.deepEqual(context.entityIds, [])
  assert.throws(() => sceneContinuityContext({ ...data, documentId: 'missing' }), /文档不存在/)
})
