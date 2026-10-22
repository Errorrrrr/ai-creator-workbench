// Candidate snapshots contain writing and request context, never execution credentials.
export const MAX_CANDIDATE_DRAFTS = 100
export function candidateGeneratedAtLabel(createdAt) {
  const date = createdAt ? new Date(createdAt) : null
  return date && Number.isFinite(date.getTime())
    ? `生成时间：${date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`
    : '生成时间：未记录（旧候选）'
}
const MAX_TEXT_CHARACTERS = 2 * 1024 * 1024
const TABS = ['script', 'outline', 'references']
const DRAFT_FIELDS = ['id', 'documentId', 'tabName', 'prompt', 'text', 'createdAt', 'status', 'context']
const CONTEXT_FIELDS = ['projectId', 'purpose', 'creativeAction', 'sourceFingerprint', 'storyboardRevision', 'storyboardSourceFingerprint', 'operationContext', 'documentId', 'tabName', 'title', 'baseContent', 'selectionStart', 'selectionEnd', 'knowledgeChunks', 'messages']
const CHUNK_FIELDS = ['id', 'sourceId', 'name', 'path', 'content', 'start', 'end', 'updatedAt', 'vector']
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SENSITIVE_KEYS = new Set(['authorization', 'proxyauthorization', 'headers', 'cookie', 'cookies', 'setcookie', 'apikey', 'key', 'secret', 'clientsecret', 'password', 'passwd', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'credential', 'credentials', 'connection', 'connections', 'connectionid', 'baseurl', 'endpoint', 'privatekey', 'env', 'environment'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const id = value => typeof value === 'string' && !FORBIDDEN_KEYS.has(value) && /^[a-zA-Z0-9_-]{1,1024}$/.test(value)
const chunkId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024
const text = value => typeof value === 'string' && value.length <= MAX_TEXT_CHARACTERS
const integer = value => Number.isSafeInteger(value) && value >= 0
function assert(condition, message) { if (!condition) throw new Error(message) }
function fields(value, allowed, label) {
  assert(object(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key)), `${label}包含未知字段或格式无效`)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    assert(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), `${label}须为纯 JSON 数据`)
  }
}

// Check descriptors before reading values: a snapshot must be plain, acyclic JSON.
// IDs in keyed maps are data, so a document named "token" is not a credential field.
function validateJson(value, ancestors = new Set(), depth = 0, inspectKeys = true) {
  assert(depth <= 64, '候选上下文嵌套过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { assert(Number.isFinite(value), '候选上下文包含无效数值'); return }
  assert(Array.isArray(value) || object(value), '候选上下文须为纯 JSON 数据')
  assert(!ancestors.has(value), '候选上下文包含循环引用')
  ancestors.add(value)
  const keys = Reflect.ownKeys(value)
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue
    assert(typeof key === 'string' && !FORBIDDEN_KEYS.has(key), '候选上下文包含非法字段')
    assert(!Array.isArray(value) || /^(0|[1-9]\d*)$/.test(key), '候选上下文数组包含非法字段')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    assert(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), '候选上下文须为纯 JSON 数据')
    if (inspectKeys) assert(!SENSITIVE_KEYS.has(key.replace(/[-_]/g, '').toLowerCase()), '候选上下文不能包含凭据或连接配置')
    validateJson(descriptor.value, ancestors, depth + 1)
  }
  if (Array.isArray(value)) assert(keys.length - 1 === value.length, '候选上下文数组不能包含空项')
  ancestors.delete(value)
}

function validateOperationContext(value, projectId) {
  fields(value, ['projectId', 'documents', 'shots', 'mediaVersions', 'storyboardRevision'], '候选操作上下文')
  assert(value.projectId === projectId && id(value.projectId), '候选操作上下文项目不一致')
  assert(integer(value.storyboardRevision), '候选操作上下文修订号无效')
  for (const field of ['documents', 'shots', 'mediaVersions']) {
    assert(object(value[field]), '候选操作上下文目标格式无效')
    validateJson(value[field], new Set(), 0, false)
    for (const [key, record] of Object.entries(value[field])) assert(id(key) && object(record), '候选操作上下文目标标识或内容无效')
  }
}

function validateContext(context, draft) {
  fields(context, CONTEXT_FIELDS, '候选上下文')
  // Only operation target map keys are exempt from credential-key checks.
  for (const [key, value] of Object.entries(context)) if (key !== 'operationContext') validateJson(value)
  assert(id(context.projectId) && context.documentId === draft.documentId && context.tabName === draft.tabName, '候选上下文归属无效')
  assert(['text', 'discussion', 'project-plan', 'storyboard'].includes(context.purpose), '候选用途无效')
  if (context.creativeAction !== undefined) assert(['', 'continuity'].includes(context.creativeAction), '候选创作操作无效')
  // The output cap does not truncate an existing large document's baseline;
  // workspace storage still enforces the total library size budget.
  assert(typeof context.title === 'string' && typeof context.baseContent === 'string', '候选原文快照无效')
  if (context.sourceFingerprint !== undefined) assert(typeof context.sourceFingerprint === 'string' && context.sourceFingerprint.length <= 1024, '候选原文指纹无效')
  if (context.storyboardSourceFingerprint !== undefined) assert(typeof context.storyboardSourceFingerprint === 'string' && context.storyboardSourceFingerprint.length <= 1024, '候选分场快照指纹无效')
  if (context.storyboardRevision !== undefined && context.storyboardRevision !== null) assert(integer(context.storyboardRevision), '候选分镜修订号无效')
  for (const field of ['selectionStart', 'selectionEnd']) if (context[field] !== undefined) assert(integer(context[field]) && context[field] <= context.baseContent.length, '候选原文选区无效')
  if (context.selectionStart !== undefined && context.selectionEnd !== undefined) assert(context.selectionEnd >= context.selectionStart, '候选原文选区无效')
  if (context.messages !== undefined) {
    assert(Array.isArray(context.messages), '候选请求消息无效')
    for (const message of context.messages) {
      fields(message, ['role', 'content'], '候选请求消息')
      assert(['system', 'user', 'assistant'].includes(message.role) && text(message.content), '候选请求消息无效')
    }
  }
  if (context.knowledgeChunks !== undefined) {
    assert(Array.isArray(context.knowledgeChunks) && context.knowledgeChunks.length <= 6, '候选知识引用无效')
    for (const chunk of context.knowledgeChunks) {
      fields(chunk, CHUNK_FIELDS, '候选知识引用')
      assert(chunkId(chunk.id) && ['name', 'path', 'content'].every(key => text(chunk[key])), '候选知识引用内容无效')
      if (chunk.sourceId !== undefined) assert(typeof chunk.sourceId === 'string' && chunk.sourceId.length <= 1024, '候选知识来源无效')
      if (chunk.updatedAt !== undefined) assert(typeof chunk.updatedAt === 'string', '候选知识引用时间无效')
      for (const field of ['start', 'end']) if (chunk[field] !== undefined) assert(integer(chunk[field]), '候选知识引用位置无效')
      if (chunk.start !== undefined && chunk.end !== undefined) assert(chunk.end >= chunk.start, '候选知识引用位置无效')
      if (chunk.vector !== undefined) assert(Array.isArray(chunk.vector) && chunk.vector.length === 384 && chunk.vector.every(Number.isFinite), '候选知识向量无效')
    }
  }
  if (context.operationContext !== undefined && context.operationContext !== null) validateOperationContext(context.operationContext, context.projectId)
}

/** Validate without normalizing or dropping recoverable writing. */
export function validateCandidateDrafts(value) {
  assert(Array.isArray(value) && value.length <= MAX_CANDIDATE_DRAFTS, `待审稿最多保留 ${MAX_CANDIDATE_DRAFTS} 份，请先采纳或移除部分候选`)
  assert(Reflect.ownKeys(value).length === value.length + 1, '候选稿列表须为纯 JSON 数组')
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), '候选稿列表须为纯 JSON 数组')
  }
  const ids = new Set()
  for (const draft of value) {
    fields(draft, DRAFT_FIELDS, '候选稿')
    assert(id(draft.id) && !ids.has(draft.id) && id(draft.documentId), '候选稿标识无效或重复')
    ids.add(draft.id)
    assert(TABS.includes(draft.tabName), '候选稿文档视图无效')
    assert(typeof draft.prompt === 'string' && draft.prompt.length <= 12000 && text(draft.text), '候选稿要求或文本无效')
    assert(typeof draft.createdAt === 'string' && draft.createdAt.length <= 64 && Number.isFinite(Date.parse(draft.createdAt)), '候选稿时间无效')
    assert(['complete', 'partial', 'error'].includes(draft.status), '候选稿状态无效')
    validateContext(draft.context, draft)
  }
  return value
}

export function candidateDraftsFor(drafts, documentId, tabName) {
  validateCandidateDrafts(drafts)
  return structuredClone(drafts.filter(draft => draft.documentId === documentId && draft.tabName === tabName))
}

export function upsertCandidateDraft(drafts, draft) {
  validateCandidateDrafts(drafts)
  validateCandidateDrafts([draft])
  const index = drafts.findIndex(item => item.id === draft.id)
  assert(index >= 0 || drafts.length < MAX_CANDIDATE_DRAFTS, `待审稿已达 ${MAX_CANDIDATE_DRAFTS} 份，请先采纳或移除部分候选`)
  const next = structuredClone(drafts)
  if (index < 0) next.push(structuredClone(draft))
  else next[index] = structuredClone(draft)
  return next
}

export function removeCandidateDraft(drafts, id) {
  validateCandidateDrafts(drafts)
  return structuredClone(drafts.filter(draft => draft.id !== id))
}
