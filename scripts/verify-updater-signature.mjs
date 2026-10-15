import { createHash, createPublicKey, verify } from 'node:crypto'

// Minisign's Ed25519 signature plus authenticated trusted comment (Tauri CLI format).
export function verifyUpdaterSignature(bytes, encodedSignature, encodedKey, version) {
  const lines = Buffer.from(encodedSignature.trim(), 'base64').toString('utf8').trim().split('\n')
  const keyLines = Buffer.from(encodedKey.trim(), 'base64').toString('utf8').trim().split('\n')
  const key = Buffer.from(keyLines[1] || '', 'base64')
  const packet = Buffer.from(lines[1] || '', 'base64')
  const comment = lines[2]?.replace(/^trusted comment: /, '')
  if (key.length !== 42 || packet.length !== 74 || packet.subarray(0, 2).toString() !== 'ED' || !key.subarray(2, 10).equals(packet.subarray(2, 10)) || !lines[2]?.startsWith('trusted comment: ')) throw new Error('更新签名格式或公钥不匹配')
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' })
  const signature = packet.subarray(10)
  if (!verify(null, createHash('blake2b512').update(bytes).digest(), publicKey, signature)
    || !verify(null, Buffer.concat([signature, Buffer.from(comment)]), publicKey, Buffer.from(lines[3] || '', 'base64'))
    || comment.split('\t').filter(field => field.startsWith('version:')).length !== 1
    || !comment.split('\t').includes(`version:${version}`)) throw new Error('更新包签名或签名版本验证失败')
}
