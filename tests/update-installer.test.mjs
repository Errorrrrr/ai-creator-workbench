import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateInstaller } from '../src/update-installer.js'
function harness({ fail, save, download } = {}) {
  const calls = [], statuses = [], progress = []
  let unlocked = 0
  const installer = createUpdateInstaller({
    invoke: async (command, args) => { calls.push(command); if (command === fail) throw new Error('simulated failure'); if (command === 'download_update') { args.progress.onmessage({ received: 50, total: 100 }); await download?.() } },
    beforeInstall: async () => { calls.push('save'); await save?.(); return () => unlocked++ },
    createChannel: () => ({}), status: (...value) => statuses.push(value), changed: () => { progress.push(installer.progress) },
  })
  return { installer, calls, statuses, progress, get unlocked() { return unlocked } }
}
test('download and validation precede save, install and restart; editing stays locked until restart', async () => {
  const h = harness(); await h.installer.run('1.0.0')
  assert.deepEqual(h.calls, ['download_update', 'save', 'install_update', 'restart_after_update'])
  assert.equal(h.installer.locked, true); assert.equal(h.unlocked, 0)
  assert.ok(h.progress.some(p => p?.received === 50 && p?.total === 100))
})
test('download or signature failure cannot save/install/restart', async () => {
  const h = harness({ fail: 'download_update' }); await h.installer.run('1.0.0')
  assert.deepEqual(h.calls, ['download_update']); assert.equal(h.installer.phase, 'idle')
})
test('failed save retains verified bytes; retry saves again before installing', async () => {
  let fails = true
  const h = harness({ save: () => { if (fails) throw new Error('save failed') } })
  await h.installer.run('1.0.0'); assert.equal(h.installer.phase, 'ready')
  assert.deepEqual(h.calls, ['download_update', 'save'])
  fails = false; await h.installer.run('1.0.0')
  assert.deepEqual(h.calls, ['download_update', 'save', 'save', 'install_update', 'restart_after_update'])
})
test('install failure unlocks editing and clears cached update; restart failure retains lock and retries restart only', async () => {
  const failed = harness({ fail: 'install_update' }); await failed.installer.run('1.0.0')
  assert.equal(failed.unlocked, 1); assert.equal(failed.installer.phase, 'idle')
  assert.ok(!failed.calls.includes('restart_after_update'))
  const restart = harness({ fail: 'restart_after_update' }); await restart.installer.run('1.0.0')
  assert.equal(restart.installer.phase, 'installed'); assert.equal(restart.installer.locked, true)
  await restart.installer.run('1.0.0'); assert.equal(restart.calls.filter(c => c === 'install_update').length, 1)
})
test('cancelling a download suppresses saving and prevents overlapping downloads until it settles', async () => {
  let finish
  const h = harness({ download: () => new Promise(resolve => { finish = resolve }) })
  const running = h.installer.run('1.0.0'); await h.installer.run('1.0.0')
  await h.installer.cancel(); assert.equal(h.installer.phase, 'cancelling')
  await h.installer.run('1.0.0'); finish(); await running
  assert.equal(h.calls.filter(c => c === 'download_update').length, 1)
  assert.ok(!h.calls.includes('save')); assert.equal(h.installer.phase, 'idle')
})
