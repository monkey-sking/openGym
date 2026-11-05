import { beforeEach, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

// These tests exercise the phone-discovery helpers in background.js. background.test.mjs already
// installs a fake globalThis.chrome + fetch; the module is a singleton, so we import the same
// instance here and reuse its __test reset. We drive fetch per-test via the shared data hooks
// exposed by background.test.mjs are not visible here, so we own our own fake fetch instead.

const data = {
  local: {},
  fetchImpl: null,
  fetchCalls: []
}

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const getStore = (store, keys) => {
  if (keys == null) return clone(store)
  if (typeof keys === 'string') return { [keys]: clone(store[keys]) }
  const out = {}
  for (const key of keys) out[key] = clone(store[key])
  return out
}

globalThis.chrome = {
  storage: {
    local: {
      get: async keys => getStore(data.local, keys),
      set: async value => { Object.assign(data.local, clone(value)) }
    },
    session: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    }
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  tabs: {
    query: async () => [],
    create: async () => ({ id: 1 }),
    sendMessage: async () => ({ ok: false }),
    onRemoved: { addListener: () => {} }
  },
  scripting: { executeScript: async () => {} },
  cookies: { get: async () => null },
  permissions: { contains: async () => true, request: async () => true },
  runtime: { onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} }, onMessage: { addListener: () => {} }, sendMessage: async () => {} },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
}

globalThis.__OG_VIDEO_SYNC_TEST__ = true
globalThis.fetch = async (url, init) => {
  data.fetchCalls.push({ url, init })
  if (data.fetchImpl) return data.fetchImpl(url, init)
  throw new Error('unexpected fetch')
}

const bg = await import('./background.js')

beforeEach(() => {
  bg.__test.reset()
  data.local = {}
  data.fetchImpl = null
  data.fetchCalls = []
})

afterEach(() => {
  bg.__test.reset()
})

test('generates a 4-character code from the unambiguous charset', () => {
  for (let i = 0; i < 50; i++) {
    const code = bg.generatePairCode(4)
    assert.equal(code.length, 4)
    assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/)
  }
})

test('generates the same code from a fixed random source', () => {
  const values = [0, 0.1, 0.5, 0.99]
  let i = 0
  const code = bg.generatePairCode(4, () => values[i++])
  assert.equal(code.length, 4)
  assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/)
})

test('normalizes a typed code the way the pairing registry does', () => {
  assert.equal(bg.normalizePairCode(' ab2c '), 'AB2C')
  // 0→O, I/L→1, then 1 is not in the charset [2-9A-Z] so it is stripped: 'o0i1l' → 'OO'.
  assert.equal(bg.normalizePairCode('o0i1l'), 'OO')
  assert.equal(bg.normalizePairCode('ab-2c'), 'AB2C')
  assert.equal(bg.normalizePairCode(null), '')
})

test('ensurePairCode stores a code once and returns the stored one after', async () => {
  const first = await bg.ensurePairCode()
  assert.match(first, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/)
  assert.equal(data.local.pairCode, first)
  const second = await bg.ensurePairCode()
  assert.equal(second, first)
})

test('regeneratePairCode replaces the stored code', async () => {
  await bg.ensurePairCode()
  const before = data.local.pairCode
  let code = ''
  // Collect new codes until one differs (astronomically likely on the first try).
  for (let i = 0; i < 20 && code === ''; i++) {
    const next = await bg.regeneratePairCode()
    if (next !== before) code = next
  }
  assert.notEqual(code, '')
  assert.equal(data.local.pairCode, code)
})

test('candidate list always includes loopback and honour a learned /24 prefix first', () => {
  const bases = bg.candidateBaseUrls({ subnetPrefix: '192.168.31.' })
  assert.equal(bases[0], 'http://127.0.0.1:8787')
  assert.ok(bases.includes('http://192.168.31.1:8787'))
  assert.ok(bases.includes('http://192.168.31.254:8787'))
  assert.ok(bases.includes('http://172.20.10.5:8787'), 'hotspot block is swept')
  // No duplicate addresses.
  assert.equal(new Set(bases).size, bases.length)
})

test('candidate list puts the saved server URL first when present', () => {
  const bases = bg.candidateBaseUrls({ savedServerUrl: 'http://192.168.1.42:8787' })
  assert.equal(bases[0], 'http://192.168.1.42:8787')
})

test('discoverPhoneByPairCode returns the first phone that recognises the code', async () => {
  data.fetchImpl = async url => {
    if (url.includes('192.168.31.7')) {
      return new Response(JSON.stringify({ ok: true, code: 'AB2C' }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 })
  }
  const hit = await bg.discoverPhoneByPairCode('ab2c', { candidates: [
    'http://127.0.0.1:8787',
    'http://192.168.31.7:8787',
    'http://192.168.31.8:8787'
  ] })
  assert.equal(hit, 'http://192.168.31.7:8787')
})

test('discoverPhoneByPairCode returns null when no candidate matches', async () => {
  data.fetchImpl = async () => new Response(JSON.stringify({ ok: false }), { status: 404 })
  const hit = await bg.discoverPhoneByPairCode('ab2c', { candidates: [
    'http://127.0.0.1:8787',
    'http://192.168.31.7:8787'
  ] })
  assert.equal(hit, null)
})

test('discoverPhoneByPairCode tolerates fetch rejections and keeps scanning', async () => {
  let n = 0
  data.fetchImpl = async url => {
    n++
    if (n === 1) throw new Error('ECONNREFUSED')
    if (url.includes('192.168.31.9')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response('', { status: 404 })
  }
  const hit = await bg.discoverPhoneByPairCode('ab2c', { candidates: [
    'http://127.0.0.1:8787',
    'http://192.168.31.9:8787'
  ], batchSize: 1 })
  assert.equal(hit, 'http://192.168.31.9:8787')
})

test('discoverPhoneByPairCode rejects an empty code without fetching', async () => {
  data.fetchImpl = async () => new Response('', { status: 200 })
  const hit = await bg.discoverPhoneByPairCode('', { candidates: ['http://127.0.0.1:8787'] })
  assert.equal(hit, null)
  assert.equal(data.fetchCalls.length, 0)
})
