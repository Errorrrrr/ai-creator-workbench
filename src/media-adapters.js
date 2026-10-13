// Browser-only preview and migration identities; the desktop registry remains the
// execution authority. No guessed supplier or first-available resource fallback.
let catalog = [
  { id: 'openai-images', transport: 'api', capability: 'image', driverId: null },
  { id: 'veo', transport: 'api', capability: 'video', driverId: null },
  { id: 'codex-native-image', transport: 'cli', capability: 'image', driverId: 'codex' }
]

export function configuredMediaAdapterId(connection) {
  // Only genuinely absent legacy fields inherit their historical protocol.
  // An explicit unknown/empty adapter is preserved and rejected, never rewritten.
  if (typeof connection?.adapter === 'string') return connection.adapter
  if (connection?.adapter !== undefined && connection?.adapter !== null) return ''
  if (connection?.kind === 'image-api') return 'openai-images'
  if (connection?.kind === 'video-api') return 'veo'
  if (connection?.kind === 'cli' && connection.driverId === 'codex') return 'codex-native-image'
  return null
}

export function mediaAdapterFor(connection, capability) {
  if ((connection?.kind === 'image-api' && capability !== 'image') || (connection?.kind === 'video-api' && capability !== 'video')) return null
  const transport = connection?.kind === 'cli' ? 'cli' : ['image-api', 'video-api'].includes(connection?.kind) ? 'api' : ''
  return catalog.find(adapter => adapter.id === configuredMediaAdapterId(connection) && adapter.transport === transport && adapter.capability === capability && (adapter.driverId || null) === (connection?.driverId || null)) || null
}

export function mediaAdaptersForKind(kind) {
  const capability = kind === 'image-api' ? 'image' : kind === 'video-api' ? 'video' : null
  return catalog.filter(adapter => adapter.transport === 'api' && adapter.capability === capability).map(adapter => ({ ...adapter }))
}

export function useMediaAdapterCatalog(snapshot) {
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.adapters) || snapshot.adapters.some(adapter => !adapter || typeof adapter.id !== 'string' || !['api', 'cli'].includes(adapter.transport) || !['image', 'video'].includes(adapter.capability) || !Array.isArray(adapter.modes) || !Array.isArray(adapter.referenceRoles))) throw new Error('媒体适配器目录无效；未启用未知协议')
  if (new Set(snapshot.adapters.map(adapter => adapter.id)).size !== snapshot.adapters.length) throw new Error('媒体适配器目录存在重复标识')
  catalog = structuredClone(snapshot.adapters)
  return catalog
}
