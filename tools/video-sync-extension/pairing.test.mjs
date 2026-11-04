import test from 'node:test'
import assert from 'node:assert/strict'
import {
  generatePairCode,
  normalizePairCode,
  createPairingRegistry,
  DEFAULT_PAIRING_TTL_MS
} from './pairing.mjs'

test('generates valid 4-character pairing code', () => {
  const code = generatePairCode(4)
  assert.equal(code.length, 4)
  assert.match(code, /^[2-9A-Z]{4}$/)
})

test('normalizes pairing code input', () => {
  assert.equal(normalizePairCode(' 7a2b '), '7A2B')
  assert.equal(normalizePairCode('7-A-2-B'), '7A2B')
  assert.equal(normalizePairCode(''), '')
  assert.equal(normalizePairCode(null), '')
})

test('pairing registry stores and looks up records', () => {
  let mockTime = 1000000
  const registry = createPairingRegistry({
    ttlMs: 60000,
    now: () => mockTime
  })

  const rec = registry.register({
    ips: ['192.168.1.50'],
    port: 8787,
    url: 'http://192.168.1.50:8787'
  })

  assert.ok(rec.code)
  assert.equal(rec.port, 8787)
  assert.deepEqual(rec.ips, ['192.168.1.50'])

  const found = registry.lookup(rec.code)
  assert.ok(found)
  assert.equal(found.code, rec.code)
  assert.equal(found.bound, false)

  // Bind
  const bound = registry.bind(rec.code)
  assert.equal(bound.bound, true)
  assert.equal(registry.lookup(rec.code).bound, true)

  // Expire
  mockTime += 65000
  assert.equal(registry.lookup(rec.code), null)
  assert.equal(registry.count(), 0)
})
