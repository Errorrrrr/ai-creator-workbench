import test from 'node:test'
import assert from 'node:assert/strict'
import { validateCliProxy } from '../src/cli-proxy.js'

test('proxy modes default to automatic and discard inactive addresses', () => {
  assert.deepEqual(validateCliProxy(), { mode: 'auto', url: '' })
  assert.deepEqual(validateCliProxy({ mode: 'direct', url: 'old' }), { mode: 'direct', url: '' })
  assert.throws(() => validateCliProxy({ mode: 'unknown' }))
})

test('manual proxy validates transport, port, IPv6, and refuses credentials', () => {
  for (const url of ['http://127.0.0.1:7897', 'http://[::1]:8080/', 'https://host:443']) {
    assert.deepEqual(validateCliProxy({ mode: 'manual', url: ` ${url} ` }), { mode: 'manual', url })
  }
  for (const url of ['', 'host:7897', 'socks5://host:7897', 'http://host', 'http://user:password@host:7897', 'http://@host:7897', 'http://host:0', 'http://host:65536', 'http://host:7897/path', 'http://host:7897?', 'http://host:7897#', 'http://ho\nst:7897']) {
    assert.throws(() => validateCliProxy({ mode: 'manual', url }), undefined, url)
  }
})
