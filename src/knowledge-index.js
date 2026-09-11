const INDEX_VERSION = 1
const VECTOR_DIMENSION = 384
const MIN_CHUNK_SIZE = 500
const TARGET_CHUNK_SIZE = 600
const MAX_CHUNK_SIZE = 700
const CHUNK_OVERLAP = 60
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 100
const DEFAULT_MIN_SEARCH_SCORE = 0.02

export const DEFAULT_KNOWLEDGE_INDEX_STORAGE_KEY = 'ai-creator-workbench:knowledge-index'

function emptyIndex() {
  return {
    version: INDEX_VERSION,
    dimension: VECTOR_DIMENSION,
    createdAt: null,
    chunks: []
  }
}

function stableHash(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function normalizeContent(value) {
  return typeof value === 'string'
    ? value
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    : ''
}

function isHanCharacter(character) {
  const codePoint = character.codePointAt(0)
  return (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x323af)
}

function findBestBoundary(content, start, minimum, target, maximum) {
  const candidates = [[], [], [], []]

  for (let index = minimum; index <= maximum; index += 1) {
    const previous = content[index - 1]
    const current = content[index]
    if (previous === '\n' && current === '\n') candidates[0].push(index)
    else if (/[。！？!?；;]/.test(previous)) candidates[1].push(index)
    else if (previous === '\n') candidates[2].push(index)
    else if (/\s/.test(previous)) candidates[3].push(index)
  }

  for (const group of candidates) {
    if (group.length > 0) {
      return group.reduce((best, value) => (
        Math.abs(value - target) < Math.abs(best - target) ? value : best
      ))
    }
  }

  return Math.max(start + 1, maximum)
}

function splitContent(content) {
  const chunks = []
  let start = 0

  while (start < content.length) {
    const remaining = content.length - start
    let end = content.length

    if (remaining > MAX_CHUNK_SIZE) {
      end = findBestBoundary(
        content,
        start,
        start + MIN_CHUNK_SIZE,
        start + TARGET_CHUNK_SIZE,
        start + MAX_CHUNK_SIZE
      )
    }

    const rawChunk = content.slice(start, end)
    const leadingWhitespace = rawChunk.match(/^\s*/)?.[0].length || 0
    const trailingWhitespace = rawChunk.match(/\s*$/)?.[0].length || 0
    const chunkStart = start + leadingWhitespace
    const chunkEnd = end - trailingWhitespace
    const text = content.slice(chunkStart, chunkEnd)

    if (text) chunks.push({ content: text, start: chunkStart, end: chunkEnd })
    if (end >= content.length) break

    start = Math.max(start + 1, end - CHUNK_OVERLAP)
  }

  return chunks
}

function collectTokenWeights(text) {
  const counts = new Map()
  const add = (token, baseWeight) => {
    const current = counts.get(token)
    counts.set(token, current
      ? { count: current.count + 1, baseWeight }
      : { count: 1, baseWeight })
  }

  const normalized = String(text || '').normalize('NFKC').toLowerCase()
  let hanRun = []
  const flushHanRun = () => {
    for (let index = 0; index < hanRun.length; index += 1) {
      add(`c:${hanRun[index]}`, 1)
      if (index + 1 < hanRun.length) add(`b:${hanRun[index]}${hanRun[index + 1]}`, 1.35)
    }
    hanRun = []
  }

  for (const character of normalized) {
    if (isHanCharacter(character)) hanRun.push(character)
    else flushHanRun()
  }
  flushHanRun()

  for (const match of normalized.matchAll(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g)) {
    add(`e:${match[0]}`, 1.5)
  }

  return new Map(Array.from(counts, ([token, value]) => [
    token,
    value.baseWeight * (1 + Math.log(value.count))
  ]))
}

function normalizeVector(vector) {
  let sumOfSquares = 0
  for (const value of vector) sumOfSquares += value * value
  const magnitude = Math.sqrt(sumOfSquares)
  if (!Number.isFinite(magnitude) || magnitude === 0) return null
  return Array.from(vector, value => value / magnitude)
}

function isVectorLike(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value)
}

function publicChunk(chunk) {
  const { vector, ...metadata } = chunk
  return metadata
}

function sanitizeChunk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.sourceId !== 'string' || !value.sourceId) return null
  if (typeof value.name !== 'string' || typeof value.path !== 'string') return null
  if (typeof value.content !== 'string' || !value.content) return null
  if (typeof value.updatedAt !== 'string') return null
  if (!Number.isInteger(value.start) || value.start < 0) return null
  if (!Number.isInteger(value.end) || value.end < value.start) return null
  if (!isVectorLike(value.vector) || value.vector.length !== VECTOR_DIMENSION) return null

  const vector = Array.from(value.vector)
  if (vector.some(item => !Number.isFinite(item))) return null
  const normalizedVector = normalizeVector(vector)
  if (!normalizedVector) return null

  return {
    id: value.id,
    sourceId: value.sourceId,
    name: value.name,
    path: value.path,
    content: value.content,
    start: value.start,
    end: value.end,
    updatedAt: value.updatedAt,
    vector: normalizedVector
  }
}

function queryKeywords(query, content) {
  const normalizedQuery = String(query || '').normalize('NFKC').toLowerCase()
  const normalizedContent = String(content || '').normalize('NFKC').toLowerCase()
  const candidates = []
  let hanRun = []

  const flushHanRun = () => {
    if (hanRun.length === 1) candidates.push(hanRun[0])
    if (hanRun.length > 1) {
      const phrase = hanRun.join('')
      candidates.push(phrase)
      for (let index = 0; index + 1 < hanRun.length; index += 1) {
        candidates.push(`${hanRun[index]}${hanRun[index + 1]}`)
      }
    }
    hanRun = []
  }

  for (const character of normalizedQuery) {
    if (isHanCharacter(character)) hanRun.push(character)
    else flushHanRun()
  }
  flushHanRun()

  for (const match of normalizedQuery.matchAll(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g)) {
    candidates.push(match[0])
  }

  return Array.from(new Set(candidates))
    .filter(keyword => normalizedContent.includes(keyword))
    .sort((left, right) => right.length - left.length)
    .slice(0, 8)
}

/** 将单篇知识文档按自然边界切成带重叠的可检索片段。 */
export function chunkDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return []
  if (typeof document.id !== 'string' || !document.id.trim()) return []

  const content = normalizeContent(document.content)
  if (!content) return []

  const documentId = document.id.trim()
  const sourceId = typeof document.sourceId === 'string' && document.sourceId.trim()
    ? document.sourceId.trim()
    : documentId
  const name = typeof document.name === 'string' ? document.name : ''
  const path = typeof document.path === 'string' ? document.path : ''
  const updatedAt = typeof document.updatedAt === 'string'
    ? document.updatedAt
    : (Number.isFinite(document.updatedAt) ? String(document.updatedAt) : '')

  return splitContent(content).map(chunk => ({
    id: `${documentId}:${stableHash(`${documentId}\u0000${updatedAt}\u0000${chunk.start}\u0000${chunk.end}\u0000${chunk.content}`).toString(16).padStart(8, '0')}`,
    sourceId,
    name,
    path,
    content: chunk.content,
    start: chunk.start,
    end: chunk.end,
    updatedAt
  }))
}

/** 将多篇知识文档展开为统一的片段列表。 */
export function chunkDocuments(documents) {
  if (!Array.isArray(documents)) return []
  return documents.flatMap(chunkDocument)
}

/** 提取用于哈希向量化的中文单字、中文二元词组和英文 token。 */
export function tokenizeText(text) {
  return Array.from(collectTokenWeights(text).keys(), token => token.slice(2))
}

/** 将文本转换为固定 384 维的稳定归一化哈希向量。 */
export function createTextVector(text) {
  const vector = new Float64Array(VECTOR_DIMENSION)

  for (const [token, weight] of collectTokenWeights(text)) {
    const bucket = stableHash(token) % VECTOR_DIMENSION
    const sign = (stableHash(`sign:${token}`) & 1) === 0 ? 1 : -1
    vector[bucket] += weight * sign
  }

  return normalizeVector(vector) || Array(VECTOR_DIMENSION).fill(0)
}

/** 计算两个等长数值向量的余弦相似度，无效输入返回 0。 */
export function cosineSimilarity(left, right) {
  if (!isVectorLike(left) || !isVectorLike(right) || left.length !== right.length || left.length === 0) return 0

  let dotProduct = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]
    const rightValue = right[index]
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return 0
    dotProduct += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0
  return dotProduct / Math.sqrt(leftMagnitude * rightMagnitude)
}

/** 为文档列表建立可序列化的本地知识索引。 */
export function createKnowledgeIndex(documents) {
  return {
    version: INDEX_VERSION,
    dimension: VECTOR_DIMENSION,
    createdAt: new Date().toISOString(),
    chunks: chunkDocuments(documents).map(chunk => ({
      ...chunk,
      vector: createTextVector(chunk.content)
    }))
  }
}

/** 按余弦相似度检索索引，可用 limit 和 sourceId 约束结果。 */
export function searchKnowledgeIndex(index, queryOrOptions, searchOptions = {}) {
  const options = typeof queryOrOptions === 'object' && queryOrOptions !== null
    ? queryOrOptions
    : searchOptions
  const query = typeof queryOrOptions === 'string' ? queryOrOptions : options.query
  if (typeof query !== 'string' || !query.trim()) return []

  const limitValue = Number(options.limit)
  const limit = Number.isFinite(limitValue)
    ? Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limitValue)))
    : DEFAULT_SEARCH_LIMIT
  const sourceId = options.sourceId == null ? null : String(options.sourceId)
  const minimumScore = Number.isFinite(Number(options.minScore))
    ? Math.max(0, Number(options.minScore))
    : DEFAULT_MIN_SEARCH_SCORE
  const chunks = index && typeof index === 'object' && Array.isArray(index.chunks)
    ? index.chunks
    : []
  const queryVector = createTextVector(query)

  return chunks
    .filter(chunk => sourceId === null || chunk?.sourceId === sourceId)
    .map(chunk => {
      const safeChunk = sanitizeChunk(chunk)
      if (!safeChunk) return null
      return {
        score: cosineSimilarity(queryVector, safeChunk.vector),
        chunk: publicChunk(safeChunk),
        keywords: queryKeywords(query, safeChunk.content)
      }
    })
    .filter(result => result && result.score >= minimumScore)
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .slice(0, limit)
}

/** 将知识索引安全序列化为可写入 localStorage 的字符串。 */
export function serializeKnowledgeIndex(index) {
  return JSON.stringify(deserializeKnowledgeIndex(index))
}

/** 解析并校验持久化索引，损坏数据会降级为空索引。 */
export function deserializeKnowledgeIndex(serialized) {
  let parsed = serialized
  if (typeof serialized === 'string') {
    try {
      parsed = JSON.parse(serialized)
    } catch {
      return emptyIndex()
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyIndex()
  if (parsed.version !== INDEX_VERSION || parsed.dimension !== VECTOR_DIMENSION || !Array.isArray(parsed.chunks)) {
    return emptyIndex()
  }

  const createdAt = typeof parsed.createdAt === 'string' && Number.isFinite(Date.parse(parsed.createdAt))
    ? parsed.createdAt
    : null

  return {
    version: INDEX_VERSION,
    dimension: VECTOR_DIMENSION,
    createdAt,
    chunks: parsed.chunks.map(sanitizeChunk).filter(Boolean)
  }
}

/** 从给定存储读取知识索引，读取或解析失败时返回空索引。 */
export function loadKnowledgeIndex(storage = globalThis.localStorage, storageKey = DEFAULT_KNOWLEDGE_INDEX_STORAGE_KEY) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return emptyIndex()
    return deserializeKnowledgeIndex(storage.getItem(storageKey))
  } catch {
    return emptyIndex()
  }
}

/** 清理给定存储中的知识索引，返回清理是否成功。 */
export function clearKnowledgeIndex(storage = globalThis.localStorage, storageKey = DEFAULT_KNOWLEDGE_INDEX_STORAGE_KEY) {
  try {
    if (!storage || typeof storage.removeItem !== 'function') return false
    storage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}
