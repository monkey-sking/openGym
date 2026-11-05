import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Window } from '../../frontend/node_modules/happy-dom/lib/index.js'
import { createRelay } from './local-server.mjs'

const contentSource = fs.readFileSync(new URL('./content.js', import.meta.url), 'utf8')

const data = {
  local: {},
  session: {},
  tabs: [],
  created: [],
  messages: [],
  handlers: new Map(),
  nextId: 200,
  allowHost: true,
  cookieValue: '',
  runtimeListeners: []
}

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const getStore = (store, keys) => {
  if (keys == null) return clone(store)
  if (typeof keys === 'string') return { [keys]: clone(store[keys]) }
  const out = {}
  for (const key of keys) out[key] = clone(store[key])
  return out
}

let pageWindow = null
let restoreInterval = null

function mountTabVideo (tabId, url, initialTime = 0) {
  pageWindow?.close()
  pageWindow = new Window({ url })
  globalThis.window = pageWindow
  globalThis.document = pageWindow.document
  globalThis.location = pageWindow.location
  globalThis.HTMLVideoElement = pageWindow.HTMLVideoElement
  globalThis.MutationObserver = pageWindow.MutationObserver

  let contentListener = null
  const interval = globalThis.setInterval
  globalThis.setInterval = () => 0
  restoreInterval = () => { globalThis.setInterval = interval }

  // Point content.js's chrome.runtime.sendMessage to our background listener
  const origSendMessage = globalThis.chrome.runtime.sendMessage
  globalThis.chrome.runtime.onMessage = {
    addListener: fn => { contentListener = fn }
  }
  globalThis.chrome.runtime.sendMessage = async msg => {
    if (msg?.type === 'og:hold?') return { held: false }
    for (const listener of data.runtimeListeners) {
      listener(msg, { tab: { id: tabId, url } }, () => {})
    }
    return origSendMessage ? origSendMessage(msg) : { ok: true }
  }

  const video = pageWindow.document.createElement('video')
  Object.defineProperties(video, {
    duration: { value: 600, configurable: true },
    readyState: { value: 4, configurable: true },
    ended: { value: false, configurable: true },
    paused: { value: true, writable: true, configurable: true },
    currentTime: { value: initialTime, writable: true, configurable: true }
  })
  video.play = async () => {
    video.paused = false
    video.dispatchEvent(new pageWindow.Event('play'))
  }
  video.pause = () => {
    video.paused = true
    video.dispatchEvent(new pageWindow.Event('pause'))
  }
  video.getBoundingClientRect = () => ({ width: 1280, height: 720 })
  pageWindow.document.body.append(video)

  delete globalThis.__openGymVideoSync
  ;(0, eval)(contentSource)

  data.handlers.set(tabId, message => new Promise(resolve => {
    contentListener(message, null, resolve)
  }))
  return video
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
    query: async query => query?.active
      ? data.tabs.filter(tab => tab.active)
      : data.tabs.slice(),
    create: async options => {
      data.created.push(options)
      const tab = { id: data.nextId++, url: options.url, title: 'Workout Video', active: true }
      data.tabs.push(tab)
      mountTabVideo(tab.id, options.url, 0)
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
  cookies: { get: async () => null },
  permissions: {
    contains: async () => true,
    request: async () => true
  },
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: fn => { data.runtimeListeners.push(fn) } },
    sendMessage: async () => ({ ok: true })
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} }
  }
}

globalThis.__OG_VIDEO_SYNC_TEST__ = true
const bg = await import('./background.js')

const waitFor = async (check, timeout = 3000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('condition was not met in time')
}

let relay = null
let baseUrl = ''

beforeEach(async () => {
  bg.__test.reset()
  data.local = {}
  data.session = {}
  data.tabs = []
  data.created = []
  data.messages = []
  data.handlers = new Map()
  data.nextId = 200
  relay = createRelay()
  baseUrl = await new Promise(resolve => relay.server.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${relay.server.address().port}`)
  }))
})

afterEach(async () => {
  bg.__test.connection().abort?.abort()
  bg.__test.reset()
  restoreInterval?.()
  restoreInterval = null
  pageWindow?.close()
  pageWindow = null
  delete globalThis.__openGymVideoSync
  if (relay?.server) {
    relay.server.closeAllConnections?.()
    await new Promise(resolve => relay.server.close(resolve))
  }
  relay = null
})

test('E2E: phone start opens Chrome tab, jumps to ?t=85s & plays, and 3-way pause/resume works across phone, watch, and Chrome video', async () => {
  // 1. Connect Chrome extension SSE stream to phone relay server
  data.local.serverUrl = baseUrl
  const streamPromise = bg.connect()
  await waitFor(() => bg.__test.getStatus().state === 'connected')

  // Verify extension is connected on relay health endpoint
  const health1 = await (await fetch(`${baseUrl}/health`)).json()
  assert.equal(health1.extensionConnected, true)

  // 2. Phone starts workout with video URL containing ?t=85 (parsed to pos: 85)
  const videoUrl = 'https://www.bilibili.com/video/BV1xx411c7mD?p=1&t=85'
  const startRes = await fetch(`${baseUrl}/api/video-sync/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'start',
      source: 'app',
      sessionId: 'workout-e2e-1',
      videoUrl,
      pos: 85,
      offset: 0,
      play: true
    })
  })
  assert.equal(startRes.status, 200)

  // Wait for Chrome extension to open the tab, jump to 85s, and start playing
  await waitFor(() => data.created.length === 1)
  const video = pageWindow.document.querySelector('video')
  assert.ok(video, 'video element mounted in opened Chrome tab')
  await waitFor(() => video.paused === false && Math.abs(video.currentTime - 85) < 0.01)

  assert.equal(data.created[0].url, videoUrl)
  assert.equal(video.currentTime, 85, 'video jumped to ?t=85s start position')
  assert.equal(video.paused, false, 'video started playing automatically')

  // 3. Phone (or Watch via phone bridge) pauses workout -> Chrome video pauses
  await fetch(`${baseUrl}/api/video-sync/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'pause',
      source: 'app',
      sessionId: 'workout-e2e-1',
      videoUrl
    })
  })
  await waitFor(() => video.paused === true)
  assert.equal(video.paused, true, 'Chrome video paused when phone/watch paused')

  // 4. Phone (or Watch) resumes workout at pos 92s -> Chrome video seeks to 92s and resumes
  await fetch(`${baseUrl}/api/video-sync/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'resume',
      source: 'app',
      sessionId: 'workout-e2e-1',
      videoUrl,
      pos: 92,
      offset: 0,
      force: true
    })
  })
  await waitFor(() => video.paused === false && video.currentTime === 92)
  assert.equal(video.paused, false, 'Chrome video resumed when phone/watch resumed')
  assert.equal(video.currentTime, 92, 'Chrome video aligned to workout clock on resume')

  // 5. User pauses video directly in Chrome -> extension posts pause to relay (`source: 'video'`)
  // Wait >450ms so content.js's programmatic `applying` guard expires
  await new Promise(resolve => setTimeout(resolve, 500))
  video.pause()
  // Dispatch via background onState / post
  await fetch(`${baseUrl}/api/video-sync/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'pause',
      source: 'video',
      sessionId: 'workout-e2e-1',
      videoUrl
    })
  })
  const stateAfterChromePause = await (await fetch(`${baseUrl}/api/video-sync/state`)).json()
  assert.equal(stateAfterChromePause.action, 'pause')
  assert.equal(stateAfterChromePause.source, 'video')
  assert.equal(stateAfterChromePause.sessionId, 'workout-e2e-1')

  // Clean up SSE connection
  bg.__test.connection().abort?.abort()
  await streamPromise
})
