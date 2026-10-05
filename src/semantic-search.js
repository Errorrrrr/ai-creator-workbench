import { cosineSimilarity, searchKnowledgeIndex } from './knowledge-index.js'

/** Retain only current, unchanged chunks. Removed sources leave no cached source text. */
export function pruneSemanticIndex(index, semantic) {
  if (!semantic || typeof semantic.model !== 'string' || !semantic.model.trim()) return null
  const vectors = {}
  for (const chunk of index?.chunks || []) {
    const item = semantic.vectors?.[chunk.id]
    if (item?.content === chunk.content && Array.isArray(item.vector) && item.vector.length > 0
      && item.vector.length <= 8192 && item.vector.every(Number.isFinite)) vectors[chunk.id] = item
  }
  return { model: semantic.model, vectors, updatedAt: semantic.updatedAt || null }
}

export function semanticIndexCoverage(index, semantic) {
  const total = index?.chunks?.length || 0
  const indexed = Object.keys(pruneSemanticIndex(index, semantic)?.vectors || {}).length
  return { indexed, total, pending: total - indexed }
}

async function embeddings(model, texts) {
  const baseUrl = 'http://127.0.0.1:11434'
  const invoke = window.__TAURI__?.core?.invoke
  let vectors
  if (invoke) vectors = await invoke('embed_text', { baseUrl, model, texts })
  else {
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }), signal: AbortSignal.timeout(60000)
    })
    if (!response.ok) throw new Error(`Embedding 请求失败（${response.status}），请检查本机模型是否已安装`)
    vectors = (await response.json()).embeddings
  }
  if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(v => !Array.isArray(v) || !v.length || v.length > 8192 || v.some(x => !Number.isFinite(x)))) throw new Error('Embedding 返回了无效向量')
  if (vectors.some(v => v.length !== vectors[0].length)) throw new Error('Embedding 向量维度不一致')
  return vectors
}

export async function buildSemanticIndex(index, model, previous, onProgress = () => {}) {
  if (!model.trim()) throw new Error('请填写已安装的 Ollama Embedding 模型名称')
  const cache = previous?.model === model ? pruneSemanticIndex(index, previous)?.vectors || {} : {}
  const vectors = {}
  const missing = []
  for (const chunk of index.chunks) {
    if (cache[chunk.id]?.content === chunk.content) vectors[chunk.id] = cache[chunk.id]
    else missing.push(chunk)
  }
  for (let offset = 0; offset < missing.length; offset += 8) {
    const batch = missing.slice(offset, offset + 8)
    const values = await embeddings(model, batch.map(chunk => chunk.content))
    batch.forEach((chunk, i) => { vectors[chunk.id] = { content: chunk.content, vector: values[i] } })
    onProgress(Object.keys(vectors).length, index.chunks.length)
  }
  if (new Set(Object.values(vectors).map(item => item.vector.length)).size > 1) throw new Error('模型维度已变化，请关闭语义检索后重建')
  return { model, vectors, updatedAt: new Date().toISOString() }
}

export async function semanticSearch(index, query, semantic) {
  const lexical = searchKnowledgeIndex(index, query, { limit: 100 })
  const [vector] = await embeddings(semantic.model, [query])
  const scores = new Map(lexical.map(item => [item.chunk.id, item.score]))
  return index.chunks.map(chunk => {
    const item = semantic.vectors?.[chunk.id]
    const semanticScore = item?.content === chunk.content && Array.isArray(item.vector) && item.vector.length === vector.length
      ? Math.max(0, cosineSimilarity(vector, item.vector)) : 0
    const { vector: ignored, ...publicChunk } = chunk
    return { chunk: publicChunk, score: semanticScore * 0.75 + (scores.get(chunk.id) || 0) * 0.25, keywords: [] }
  }).filter(item => item.score > 0.02).sort((a, b) => b.score - a.score).slice(0, 6)
}
