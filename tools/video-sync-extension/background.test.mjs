import { beforeEach, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

const EXACT = 'https://www.bilibili.com/video/BV1xx411c7mD?p=1'
const OTHER = 'https://www.bilibili.com/video/BV1ab411c7mE?p=1'

const data = {
  local: {},
  session: {},
  tabs: [],
  created: [],
  messages: [],
  handlers: new Map(),
  nextId: 100,
  fetchCalls: 0,
  fetch: null,
  allowHost: true,
  cookieValue: '',
  cookieCalls: 0
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
      get: async keys => getStore(data.session, keys),
      set: async value => { Object.assign(data.session, clone(value)) },
      remove: async key => { delete data.session[key] }
    }
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {}
  },
  tabs: {
    query: async query => query.active
      ? data.tabs.filter(tab => tab.active)
      : data.tabs.slice(),
    create: async options => {
      data.created.push(options)
      const tab = { id: data.nextId++, url: options.url, title: 'opened video', active: true }
      data.tabs.push(tab)
      return tab
    },
    sendMessage: async (tabId, message) => {
      data.messages.push({ tabId, message })
      const handler = data.handlers.get(tabId)
      return handler ? handler(message) : { ok: false, reason: 'unreachable' }
    },
    onRemoved: { addListener: () => {} }
  },
  scripting: { executeScript: async () => {} },
  cookies: {
    get: async () => {
      data.cookieCalls++
      return data.cookieValue ? { value: data.cookieValue } : null
    }
  },
  permissions: {
    contains: async ({ origins }) => data.allowHost !== false && Array.isArray(origins) && origins.length > 0,
    request: async () => true
  },
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: () => {} },
    sendMessage: async () => {}
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} }
  }
}

globalThis.__OG_VIDEO_SYNC_TEST__ = true
globalThis.fetch = async (...args) => {
  data.fetchCalls++
  if (data.fetch) return data.fetch(...args)
  throw new Error('unexpected fetch')
}

const bg = await import('./background.js')

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const waitFor = async (check, timeout = 1500) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition was not met')
}

beforeEach(() => {
  bg.__test.reset()
  data.local = {}
  data.session = {}
  data.tabs = []
  data.created = []
  data.messages = []
  data.handlers = new Map()
  data.nextId = 100
  data.fetchCalls = 0
  data.fetch = null
  data.allowHost = true
  data.cookieValue = ''
  data.cookieCalls = 0
  bg.__test.setReadyTimeout(1000)
})

afterEach(() => {
  bg.__test.reset()
})

test('never sends a command to a different video in another tab', async () => {
  data.tabs = [{ id: 1, url: OTHER, title: 'other video', active: true }]
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  const result = await bg.command({ action: 'pause' })

  assert.deepEqual(result, { ok: false, reason: 'no-tab' })
  assert.equal(data.messages.length, 0)
})

test('keys Vimeo pages and player embeds by their numeric video id', () => {
  assert.equal(bg.videoKey('https://vimeo.com/123456789'), 'vimeo:123456789')
  assert.equal(bg.videoKey('https://vimeo.com/123456789/abcdef?share=copy'), 'vimeo:123456789')
  assert.equal(bg.videoKey('https://player.vimeo.com/video/123456789?h=abc'), 'vimeo:123456789')
  assert.notEqual(bg.videoKey('https://vimeo.com/123456789'), bg.videoKey('https://vimeo.com/987654321'))
  assert.equal(bg.videoKey('https://vimeo.com/channels/staffpicks'), null)
})

test('prefers the tab already bound to the workout over a louder duplicate', async () => {
  data.tabs = [
    { id: 7, url: EXACT, title: 'bound', active: false, audible: false },
    { id: 8, url: EXACT, title: 'active duplicate', active: true, audible: true }
  ]
  data.handlers.set(7, () => ({ ok: true, hasVideo: true }))
  data.handlers.set(8, () => ({ ok: true, hasVideo: true }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1', boundTabId: 7 })

  const result = await bg.command({ action: 'pause' })

  assert.equal(result.tabId, 7)
  assert.deepEqual(data.messages.map(m => m.tabId), [7])
})

test('refuses to guess between two exact tabs when no tab is bound', async () => {
  data.tabs = [
    { id: 7, url: EXACT, title: 'one', active: true },
    { id: 8, url: EXACT, title: 'two', active: false }
  ]
  data.handlers.set(7, () => ({ ok: true, hasVideo: true }))
  data.handlers.set(8, () => ({ ok: true, hasVideo: true }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  const result = await bg.command({ action: 'pause' })

  assert.deepEqual(result, { ok: false, reason: 'ambiguous-tab' })
  assert.equal(data.messages.length, 0, 'neither tab is controlled')
})

test('rebinds a lost tab only when exactly one exact match is open', async () => {
  data.tabs = [{ id: 9, url: EXACT, title: 'only match', active: true }]
  data.handlers.set(9, () => ({ ok: true, hasVideo: true }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1', boundTabId: 77 })

  const result = await bg.command({ action: 'pause' })

  assert.equal(result.ok, true)
  assert.equal(result.tabId, 9)
  assert.equal(bg.__test.getCurrent().boundTabId, 9)
})

test('an event from a different video tab is not the workout', () => {
  bg.__test.setCurrent({ videoUrl: EXACT })
  assert.equal(bg.videoEventMatches(EXACT), true)
  assert.equal(bg.videoEventMatches(EXACT + '&t=12'), true, 'tracking parameters do not change the video')
  assert.equal(bg.videoEventMatches(OTHER), false)
  assert.equal(bg.videoEventMatches(undefined), false, 'an event with no URL cannot be the named video')
})

test('a duplicate tab showing the same video cannot control the workout', async () => {
  data.tabs = [{ id: 3, url: EXACT, title: 'the video', active: true }]
  data.handlers.set(3, () => ({ ok: true, hasVideo: true, paused: true }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  await bg.command({ action: 'pause' })

  assert.equal(bg.videoEventMatches(EXACT, 3), true)
  assert.equal(bg.videoEventMatches(EXACT, 4), false, 'same URL, but not the tab bound to this workout')
})

test('without a named video, an old bound tab cannot control the workout', async () => {
  data.tabs = [{ id: 3, url: EXACT, title: 'the video', active: true }]
  data.handlers.set(3, () => ({ ok: true, hasVideo: true, paused: true }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  await bg.command({ action: 'pause' })
  bg.__test.setCurrent({ videoUrl: null, sessionId: 'session-2' })

  assert.equal(bg.videoEventMatches(EXACT, 3), false, 'the old binding may now be another video')
  assert.equal(bg.videoEventMatches(EXACT, 4), false)
  assert.equal(bg.videoEventMatches(OTHER, 3), false)
  assert.equal(bg.videoEventMatches(EXACT), false, 'a missing tab id cannot match the bound tab')
})

test('a resume carries the exact position and alignment to the video', async () => {
  data.tabs = [{ id: 12, url: EXACT, title: 'the video', active: true }]
  data.handlers.set(12, message => ({ ok: true, hasVideo: true, paused: message.action === 'resume' ? false : true }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  await bg.onState({ source: 'app', sessionId: 'session-1', seq: 13, action: 'resume', pos: 42, offset: -2, force: true })

  assert.deepEqual(data.messages.map(m => [m.tabId, m.message]), [[12, {
    type: 'og:command', action: 'resume', pos: 42, offset: -2, force: true,
  }]])
  assert.equal(bg.__test.getAppliedSeq(), 13)
})

test('opens the exact video URL and waits for its player before reporting ready', async () => {
  let probes = 0
  data.handlers.set(100, message => {
    if (message.action === 'status') return { ok: true, hasVideo: ++probes >= 3 }
    if (message.action === 'start') return { ok: true }
    if (message.action === 'resume') return { ok: true, paused: false }
    return { ok: true }
  })
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  const result = await bg.command({ action: 'start', play: true })

  assert.equal(result.ok, true)
  assert.equal(result.opened, true)
  assert.deepEqual(data.created, [{ url: EXACT, active: true }])
  assert.deepEqual(data.messages.map(m => m.message.action), ['status', 'status', 'status', 'start', 'resume'])
  assert.equal(data.messages.every(m => m.tabId === 100), true)
})

test('a play:false start on a new page holds it paused until an explicit resume', async () => {
  const actions = []
  data.handlers.set(100, message => {
    if (message.type === 'og:hold') {
      actions.push('hold:' + message.held)
      return { ok: true, held: message.held }
    }
    actions.push(message.action)
    return { ok: true, hasVideo: true, paused: message.action !== 'resume' }
  })
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  const started = await bg.command({ action: 'start', play: false })

  assert.equal(started.ok, true)
  assert.equal(started.opened, true)
  assert.deepEqual(actions, ['hold:true', 'status', 'start', 'pause'])
  assert.deepEqual(data.session.heldTabs, [100], 'the opened tab stays held after the pause')

  actions.length = 0
  const resumed = await bg.command({ action: 'resume' })

  assert.equal(resumed.ok, true)
  assert.deepEqual(actions, ['hold:false', 'resume'])
  assert.deepEqual(data.session.heldTabs, [], 'an explicit resume clears the hold')
})

test('a play:false start on an already-open tab holds it until an explicit resume', async () => {
  const actions = []
  data.tabs = [{ id: 11, url: EXACT, title: 'open video', active: true }]
  data.handlers.set(11, message => {
    if (message.type === 'og:hold') {
      actions.push('hold:' + message.held)
      return { ok: true, held: message.held }
    }
    actions.push(message.action)
    return { ok: true, hasVideo: true, paused: message.action !== 'resume' }
  })
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  const started = await bg.command({ action: 'start', play: false })

  assert.equal(started.ok, true)
  assert.equal(started.opened, false)
  assert.deepEqual(actions, ['hold:true', 'start', 'pause'])
  assert.deepEqual(data.session.heldTabs, [11], 'the open tab stays held after the pause')

  actions.length = 0
  const resumed = await bg.command({ action: 'resume' })

  assert.equal(resumed.ok, true)
  assert.deepEqual(actions, ['hold:false', 'resume'])
  assert.deepEqual(data.session.heldTabs, [], 'an explicit resume clears the hold')
})

test('a play:true start on a new page never holds it paused', async () => {
  const actions = []
  data.handlers.set(100, message => {
    if (message.type === 'og:hold') { actions.push('hold:' + message.held); return { ok: true } }
    actions.push(message.action)
    return { ok: true, hasVideo: true, paused: false }
  })
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  const result = await bg.command({ action: 'start', play: true })

  assert.equal(result.ok, true)
  assert.deepEqual(actions, ['status', 'start', 'resume'])
  assert.deepEqual(data.session.heldTabs ?? [], [])
})

test('retries readiness and reports a loading tab without touching another one', async () => {
  data.tabs = [{ id: 2, url: OTHER, title: 'other video', active: true }]
  data.handlers.set(100, () => ({ ok: true, hasVideo: false }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })
  bg.__test.setReadyTimeout(120)

  const result = await bg.command({ action: 'start', play: true })

  assert.deepEqual(result, { ok: false, reason: 'not-ready', tabId: 100, opened: true })
  assert.equal(data.messages.every(m => m.tabId === 100 && m.message.action === 'status'), true)
})

test('reports autoplay blocked instead of claiming the video is playing', async () => {
  data.tabs = [{ id: 5, url: EXACT, title: 'the video', active: false }]
  data.handlers.set(5, message => {
    if (message.action === 'start') return { ok: true }
    if (message.action === 'resume') return { ok: false, reason: 'blocked' }
    return { ok: true, hasVideo: true }
  })
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  const result = await bg.command({ action: 'start', play: true })

  assert.deepEqual(result, { ok: true, tabId: 5, opened: false, playback: 'blocked' })
  assert.equal(data.local.status.detail, 'autoplay blocked: press play in Chrome')
})

test('a fresh start plays an already-open exact tab once, and a replay does nothing', async () => {
  data.tabs = [{ id: 7, url: EXACT, title: 'the video', active: true }]
  data.handlers.set(7, message => {
    if (message.action === 'resume') return { ok: true, paused: false }
    return { ok: true, hasVideo: true }
  })
  bg.__test.setCurrent({ videoUrl: OTHER, sessionId: 'old-session' })
  const start = { source: 'app', sessionId: 'session-1', seq: 11, action: 'start', videoUrl: EXACT, play: true, at: Date.now() }

  await bg.onState(start)
  assert.deepEqual(data.messages.map(m => [m.tabId, m.message.action]), [[7, 'start'], [7, 'resume']])
  assert.equal(bg.__test.getAppliedSeq(), 11)

  data.messages = []
  await bg.onState(start)
  assert.equal(data.messages.length, 0)
})

test('an explicit paused start holds and pauses the video', async () => {
  data.tabs = [{ id: 9, url: EXACT, title: 'the video', active: true }]
  data.handlers.set(9, message => ({ ok: true, hasVideo: true, action: message.action }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  await bg.onState({ source: 'app', sessionId: 'session-1', seq: 12, action: 'start', videoUrl: EXACT, play: false })

  assert.deepEqual(
    data.messages.map(m => [m.tabId, m.message.type === 'og:hold' ? 'hold' : m.message.action]),
    [[9, 'hold'], [9, 'start'], [9, 'pause']]
  )
  assert.deepEqual(data.session.heldTabs, [9], 'a paused start stays held')
  assert.equal(bg.__test.getAppliedSeq(), 12)
})

test('an attach start leaves playback and hold alone', async () => {
  data.tabs = [{ id: 9, url: EXACT, title: 'the video', active: true }]
  data.handlers.set(9, message => ({ ok: true, hasVideo: true, action: message.action }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  await bg.onState({ source: 'app', sessionId: 'session-1', seq: 12, action: 'start', videoUrl: EXACT })

  assert.deepEqual(data.messages.map(m => [m.tabId, m.message.action]), [[9, 'start']])
  assert.equal(data.session.heldTabs, undefined, 'an attach neither holds nor releases the tab')
  assert.equal(bg.__test.getAppliedSeq(), 12)
})

test('an attach start does not open a tab that is not there', async () => {
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  const result = await bg.command({ action: 'start' })

  assert.deepEqual(result, { ok: false, reason: 'no-tab' })
  assert.deepEqual(data.created, [])
  assert.deepEqual(data.messages, [])
})

test('a failed start is retried before the seek behind it', async () => {
  let ready = false
  data.handlers.set(100, message => {
    if (message.action === 'status') return { ok: true, hasVideo: ready }
    return { ok: true, hasVideo: true }
  })
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })
  bg.__test.setReadyTimeout(30)

  await bg.onState({ source: 'app', sessionId: 'session-1', seq: 11, action: 'start', videoUrl: EXACT, play: true })
  assert.equal(data.messages.some(m => m.message.action === 'seek'), false, 'the seek waits for the start')
  assert.deepEqual(bg.__test.getPending(), [11])

  ready = true
  await bg.onState({ source: 'app', sessionId: 'session-1', seq: 12, action: 'seek', videoUrl: EXACT, pos: 42, force: true })

  assert.deepEqual(
    data.messages.filter(m => m.message.action !== 'status').map(m => [m.message.action, m.message.pos]),
    [['start', undefined], ['resume', undefined], ['seek', 42]]
  )
  assert.deepEqual(bg.__test.getPending(), [])
  assert.equal(bg.__test.getAppliedSeq(), 12)
})

test('end pauses the bound tab, releases its hold and forgets the binding', async () => {
  const actions = []
  data.tabs = [{ id: 12, url: EXACT, title: 'the video', active: true }]
  data.handlers.set(12, message => {
    if (message.type === 'og:hold') { actions.push('hold:' + message.held); return { ok: true } }
    actions.push(message.action)
    return { ok: true, hasVideo: true }
  })
  data.session.heldTabs = [12]
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1', boundTabId: 12 })

  await bg.onState({ source: 'app', seq: 20, action: 'end', sessionId: null, videoUrl: null })

  assert.deepEqual(actions, ['hold:false', 'pause'])
  assert.deepEqual(data.session.heldTabs, [])
  assert.equal(bg.__test.getCurrent().boundTabId, null)
  assert.equal(bg.__test.getAppliedSeq(), 20)
})

test('end does not pause a bound tab that now shows another video', async () => {
  data.tabs = [{ id: 12, url: OTHER, title: 'another video', active: true }]
  data.handlers.set(12, message => ({ ok: true, hasVideo: true, action: message.action }))
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1', boundTabId: 12 })

  await bg.onState({ source: 'app', seq: 21, action: 'end', sessionId: null, videoUrl: null })

  assert.equal(data.messages.some(m => m.message.action === 'pause'), false)
  assert.equal(bg.__test.getCurrent().boundTabId, null)
  assert.equal(bg.__test.getAppliedSeq(), 21)
})

test('restored appliedSeq stops a worker restart from replaying autoplay', async () => {
  data.tabs = [{ id: 8, url: EXACT, title: 'the video', active: true }]
  data.handlers.set(8, () => ({ ok: true, hasVideo: true }))
  data.session.appliedSeq = 21
  bg.__test.setAppliedSeq(0)
  bg.__test.reset()
  data.session.appliedSeq = 21
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  await bg.onState({ source: 'app', sessionId: 'session-1', seq: 21, action: 'start', videoUrl: EXACT, at: Date.now() })

  assert.equal(data.messages.length, 0)
})

test('a new epoch accepts seq 1 after a server or relay restart', async () => {
  data.tabs = [{ id: 10, url: EXACT, title: 'the video', active: true }]
  data.handlers.set(10, message => {
    if (message.action === 'resume') return { ok: true, paused: false }
    return { ok: true, hasVideo: true, action: message.action }
  })
  data.session.appliedSeq = 21
  data.session.appliedEpoch = 'old'
  bg.__test.reset()
  bg.__test.setCurrent({ videoUrl: EXACT, sessionId: 'session-1' })

  await bg.onState({ epoch: 'restarted', source: 'app', sessionId: 'session-1', seq: 1, action: 'start', videoUrl: EXACT, play: true })

  assert.deepEqual(data.messages.map(m => [m.tabId, m.message.action]), [[10, 'start'], [10, 'resume']])
  assert.equal(bg.__test.getAppliedSeq(), 1)
  assert.equal(bg.__test.getAppliedEpoch(), 'restarted')
})

test('retryDelayMs uses a bounded exponential backoff with jitter', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(attempt => bg.retryDelayMs(attempt, 0.5)),
    [1000, 2000, 4000, 8000, 16000, 30000]
  )
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(attempt => bg.retryDelayMs(attempt, 0)),
    [850, 1700, 3400, 6800, 13600, 25500]
  )
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(attempt => bg.retryDelayMs(attempt, 1)),
    [1150, 2300, 4600, 9200, 18400, 34500]
  )
})

test('a local relay fetch failure is reported as relay-offline and retried', async () => {
  data.local.serverUrl = 'http://127.0.0.1:8787'
  data.fetch = async () => {
    throw new Error('ECONNREFUSED')
  }

  await bg.connect()

  assert.equal(bg.__test.getStatus().state, 'relay-offline')
  assert.equal(data.fetchCalls, 1)
  assert.equal(bg.__test.connection().retry !== null, true)
  assert.equal(bg.__test.connection().retryAttempt, 1)
})

test('a remote fetch failure is reported as host-offline and retried', async () => {
  data.local.serverUrl = 'https://gym.example'
  data.cookieValue = 'session-token'
  data.fetch = async () => {
    throw new Error('network unreachable')
  }

  await bg.connect()

  assert.equal(bg.__test.getStatus().state, 'host-offline')
  assert.equal(data.fetchCalls, 1)
  assert.equal(bg.__test.connection().retry !== null, true)
})

test('missing relay host permission is explicit and does not fetch or retry', async () => {
  data.local.serverUrl = 'http://127.0.0.1:8787'
  data.allowHost = false

  await bg.connect()

  assert.equal(bg.__test.getStatus().state, 'permission-denied')
  assert.equal(data.fetchCalls, 0)
  assert.equal(bg.__test.connection().retry, null)
})

test('HTTP 401 and 403 mean sign-in is required and are not retried', async () => {
  assert.equal(bg.classifyHttpStatus(401).state, 'signed-out')
  assert.equal(bg.classifyHttpStatus(403).state, 'signed-out')

  data.local.serverUrl = 'http://127.0.0.1:8787'
  data.fetch = async () => new Response('', { status: 401 })

  await bg.connect()

  assert.equal(bg.__test.getStatus().state, 'signed-out')
  assert.equal(bg.__test.connection().retry, null)
})

test('a closed stream schedules one automatic retry', async () => {
  data.local.serverUrl = 'http://127.0.0.1:8787'
  let controller = null
  data.fetch = async () => new Response(new ReadableStream({
    start (streamController) { controller = streamController }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

  const connected = bg.connect()
  await waitFor(() => controller !== null)
  await waitFor(() => bg.__test.getStatus().state === 'connected')
  controller.close()
  await connected

  assert.equal(bg.__test.getStatus().state, 'relay-offline')
  assert.equal(bg.__test.connection().retry !== null, true)
  assert.equal(bg.__test.connection().retryAttempt, 1)
})

test('a manual reconnect aborts the open stream and reconnects exactly once', async () => {
  data.local.serverUrl = 'http://127.0.0.1:8787'
  const controllers = []
  const abortableStream = signal => new ReadableStream({
    start (controller) {
      controllers.push(controller)
      signal?.addEventListener('abort', () => {
        try { controller.error(new DOMException('aborted', 'AbortError')) } catch {}
      }, { once: true })
    }
  })
  data.fetch = async (_url, init) => new Response(abortableStream(init.signal), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })

  const first = bg.connect()
  await waitFor(() => data.fetchCalls === 1)

  const reconnect = bg.reconnectNow()
  assert.equal(bg.__test.connection().reconnectQueued, true)

  await first
  await reconnect
  await waitFor(() => data.fetchCalls === 2)
  await waitFor(() => bg.__test.getStatus().state === 'connected')
  assert.equal(controllers.length, 2)
  assert.equal(bg.__test.connection().connecting, true)

  bg.__test.connection().abort?.abort()
  await waitFor(() => bg.__test.connection().connecting === false)
  assert.equal(bg.__test.connection().retry, null, 'a manual abort does not schedule a retry beside the new stream')
})

test('IPv6 loopback is a local relay and does not read a cookie or require Authorization', async () => {
  data.local.serverUrl = 'http://[::1]:8787'
  let requestHeaders = null
  let controller = null
  data.fetch = async (_url, init) => {
    requestHeaders = init.headers
    return new Response(new ReadableStream({
      start (streamController) {
        controller = streamController
        init.signal?.addEventListener('abort', () => {
          try { streamController.error(new DOMException('aborted', 'AbortError')) } catch {}
        }, { once: true })
      }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  const connected = bg.connect()
  await waitFor(() => controller !== null)
  await waitFor(() => bg.__test.getStatus().state === 'connected')

  assert.equal(bg.isLocalRelay('http://[::1]:8787'), true)
  assert.equal(data.cookieCalls, 0)
  assert.equal(requestHeaders.Authorization, undefined)
  assert.notEqual(bg.__test.getStatus().state, 'signed-out')

  bg.__test.connection().abort?.abort()
  await connected
  assert.equal(bg.__test.connection().connecting, false)
})

test('a private Bilibili video that redirects to the homepage never opens a second tab on subsequent seeks', async () => {
  let polls = 0
  data.handlers.set(100, message => {
    if (message.action === 'status') {
      polls += 1
      if (polls === 1) {
        // Simulate Bilibili redirecting the private video tab to the homepage after error notice
        const tab = data.tabs.find(t => t.id === 100)
        if (tab) tab.url = 'https://www.bilibili.com/'
      }
      return { ok: true, hasVideo: false }
    }
    return { ok: false, reason: 'no-video' }
  })
  bg.__test.setReadyTimeout(2000)

  await bg.onState({
    source: 'app',
    sessionId: 'session-private',
    seq: 1,
    action: 'start',
    videoUrl: EXACT,
    play: true
  })

  assert.equal(data.created.length, 1, 'opens the tab only once')
  assert.deepEqual(bg.__test.getPending(), [], 'does not keep a redirected/unavailable start in pendingCommands')
  assert.equal(bg.__test.getAppliedSeq(), 1)

  // Subsequent drift-check seeks from the phone must never open another tab
  await bg.onState({
    source: 'app',
    sessionId: 'session-private',
    seq: 2,
    action: 'seek',
    videoUrl: EXACT,
    pos: 30,
    force: false
  })
  await bg.onState({
    source: 'app',
    sessionId: 'session-private',
    seq: 3,
    action: 'start',
    videoUrl: EXACT,
    play: true
  })

  assert.equal(data.created.length, 1, 'still only 1 tab ever created for the broken video')
  assert.equal(bg.__test.getAppliedSeq(), 3)
})

test('a page that reports video-unavailable immediately aborts start and notifies the relay', async () => {
  data.local.serverUrl = 'http://127.0.0.1:8787'
  const posted = []
  data.fetch = async (url, init) => {
    if (String(url).endsWith('/api/video-sync/command')) {
      const body = JSON.parse(init.body)
      posted.push(body)
      return new Response(JSON.stringify({ seq: 2, ...body }), { status: 200 })
    }
    throw new Error('unexpected fetch: ' + url)
  }
  data.handlers.set(100, message => {
    if (message.action === 'status') {
      return { ok: true, hasVideo: false, unavailable: true, reason: 'video-unavailable' }
    }
    return { ok: false, reason: 'video-unavailable', unavailable: true }
  })
  bg.__test.setReadyTimeout(5000)

  await bg.onState({
    source: 'app',
    sessionId: 'session-unavail',
    seq: 1,
    action: 'start',
    videoUrl: EXACT,
    play: true
  })

  assert.equal(data.created.length, 1)
  assert.deepEqual(bg.__test.getPending(), [])
  assert.equal(bg.__test.getAppliedSeq(), 1)
  await waitFor(() => posted.length === 1)
  assert.equal(posted[0].action, 'pause')
  assert.equal(posted[0].source, 'video')
  assert.equal(posted[0].phoneMeta?.videoError, 'video-unavailable')
})

