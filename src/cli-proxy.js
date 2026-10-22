export function validateCliProxy(value = {}) {
  const mode = value.mode || 'auto'
  if (!['auto', 'manual', 'direct'].includes(mode)) throw new Error('代理模式无效，请重新选择')
  if (mode !== 'manual') return { mode, url: '' }
  const address = typeof value.url === 'string' ? value.url.trim() : ''
  const invalid = '请输入有效的 HTTP／HTTPS 代理地址（含端口，不含账号、密码、路径或查询参数）'
  let url
  try { url = new URL(address) } catch { throw new Error(invalid) }
  const authority = address.split('://')[1]?.replace(/\/$/, '') || ''
  const port = authority.match(/:(\d+)$/)?.[1]
  if (address.length > 2048 || /[\s\x00-\x1f\x7f\\]/.test(address) || !['http:', 'https:'].includes(url.protocol)
      || !url.hostname || url.username || url.password || authority.includes('@') || url.pathname !== '/'
      || url.search || url.hash || address.includes('?') || address.includes('#') || !port || Number(port) < 1 || Number(port) > 65535) throw new Error(invalid)
  return { mode, url: address }
}
