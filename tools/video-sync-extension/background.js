// The link between the app and the tab. The app's server keeps the last command for the account
// and streams it here; this worker forwards pause/resume to the video tab and posts back what the
// athlete did to the page. Everything is a snapshot, never a queue: coming back after a dropped
// connection applies the newest command, which is also the state the workout is in now.

const VIDEO_PATTERNS = [
  '*://*.bilibili.com/*',
  '*://*.youtube.com/*',
  '*://*.vimeo.com/*'
]
const STATUS_KEY = 'status'
const SERVER_KEY = 'serverUrl'
const PAIR_CODE_KEY = 'pairCode'
const SESSION_KEY = 'session'
const APPLIED_SEQ_KEY = 'appliedSeq'
const APPLIED_EPOCH_KEY = 'appliedEpoch'
const HELD_TABS_KEY = 'heldTabs'
const ALARM = 'og-video-sync'
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30000
const RETRY_JITTER_MIN = 0.85
const RETRY_JITTER_MAX = 1.15
const RETRYABLE_STATES = new Set([
  'connecting',
  'relay-offline',
  'host-offline',
  'server-error',
  'error'
])

// ---- LAN discovery for the phone-hosted relay ------------------------------------------------
// The phone now hosts the video-sync server on its own Wi-Fi address. The extension no longer
// needs anything running on the computer: it holds a 4-character pairing code and finds the
// phone by asking every candidate address whether it knows that code.
// Charset matches tools/video-sync-extension/pairing.mjs (no 0/O/1/I/L, which look alike).
const PAIRING_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const PHONE_RELAY_PORT = 8787
const DISCOVER_INTERVAL_MS = 4000
const DISCOVER_TIMEOUT_MS = 350
const DISCOVER_BATCH_SIZE = 28
// Common home-router and phone-hotspot subnets to sweep even when we cannot learn our own prefix.
const COMMON_SUBNET_PREFIXES = [
  '192.168.31.',
  '192.168.1.',
  '192.168.0.',
  '192.168.2.',
  '192.168.50.'
]
const HOTSPOT_PREFIX = '172.20.10.'
const HOTSPOT_HOSTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
let discoverTimer = null
let discoveredServerUrl = null
let lastLanPrefix = null

const STATUS_LABEL = {
  unconfigured: 'waiting for your phone',
  connecting: 'connecting',
  connected: 'connected',
  'relay-offline': 'looking for your phone',
  'host-offline': 'looking for your phone',
  'permission-denied': 'Chrome permission required',
  'signed-out': 'sign-in required',
  'server-error': 'connection problem',
  error: 'connection error'
}

// Plain, human language only. No mention of local-server.mjs / LaunchAgent / port 8787 / Node.js,
// which mean nothing to an athlete and made the old popup look broken while it was simply waiting.
const STATUS_DETAIL = {
  unconfigured: 'Open openGym on your phone and enter the code shown above.',
  connecting: 'Looking for your phone on the same Wi-Fi.',
  connected: 'Connected. The workout and this video pause and resume together.',
  'relay-offline': 'Looking for your phone on the same Wi-Fi. This happens automatically.',
  'host-offline': 'Looking for your phone on the same Wi-Fi. This happens automatically.',
  'permission-denied': 'Allow this extension access to your local network in Chrome, then click Reconnect.',
  'signed-out': 'Sign in to openGym in this Chrome profile, then click Reconnect.',
  'server-error': 'The connection failed. It will retry automatically.',
  error: 'The connection failed. It will retry automatically.'
}

// While we are searching for the phone we are not broken, so a scary permanent red "!" would be a
// lie. These states keep a calm (amber) badge and retry on their own.
const SEARCHING_STATES = new Set(['unconfigured', 'connecting', 'relay-offline', 'host-offline'])

const BADGE = {
  unconfigured: { text: '...', color: '#b7791f' },
  connecting: { text: '...', color: '#b7791f' },
  connected: { text: 'on', color: '#1f9d55' },
  'relay-offline': { text: '...', color: '#b7791f' },
  'host-offline': { text: '...', color: '#b7791f' },
  'permission-denied': { text: '!', color: '#c0392b' },
  'signed-out': { text: '!', color: '#c0392b' },
  'server-error': { text: '...', color: '#b7791f' },
  error: { text: '...', color: '#b7791f' }
}

let current = { seq: 0, action: null, source: null, sessionId: null, videoUrl: null, boundTabId: null, online: false }
let appliedSeq = 0
let appliedEpoch = null
let abort = null
let connecting = false
let lastChunkAt = 0
let retry = null
let retryAt = null
let retryAttempt = 0
let currentStatus = { state: 'unconfigured', detail: STATUS_DETAIL.unconfigured, at: 0, attempt: 0, retryAt: null, retryInMs: null }
let connectedSessionId = null
// Every connect owns one number. A stream aborted by a newer connect must not clear the new
// connection's flags or schedule a retry beside it.
let generation = 0
let reconnectQueued = false
// The worker is killed and restarted while Chrome and the video tab stay open. Without the last
// applied command in session storage, a reconnect would replay an old `start` and autoplay a video
// the athlete paused themselves.
let seqLoaded = false
let seqLoading = null
// Tabs this extension opened as a paused video page, kept paused until an explicit resume. The
// worker can be restarted while the page stays open, so the set lives in session storage too.
let heldTabs = null
let heldLoading = null
let readyTimeout = 10000
// A start can fail because a freshly opened tab has not mounted its player yet. Later snapshots
// must not jump over it: they wait here until the start succeeds, so a seek never becomes the
// only command a tab ever receives.
let pendingCommands = []

const storageGet = keys => chrome.storage.local.get(keys)
const storageSet = obj => chrome.storage.local.set(obj)
const sessionGet = keys => chrome.storage.session.get(keys)
const sessionSet = obj => chrome.storage.session.set(obj)

function loadAppliedSeq () {
  if (seqLoaded) return Promise.resolve()
  if (!seqLoading) {
    seqLoading = sessionGet([APPLIED_SEQ_KEY, APPLIED_EPOCH_KEY, SESSION_KEY])
      .then(v => {
        const epoch = typeof v?.[APPLIED_EPOCH_KEY] === 'string' && v[APPLIED_EPOCH_KEY]
          ? v[APPLIED_EPOCH_KEY]
          : null
        const seq = Number(v?.[APPLIED_SEQ_KEY]) || 0
        const stored = v?.[SESSION_KEY]
        if (stored && typeof stored === 'object') current = { ...current, ...stored }
        const bound = Number(stored?.boundTabId)
        if (Number.isInteger(bound)) current.boundTabId = bound
        connectedSessionId = typeof stored?.sessionId === 'string' ? stored.sessionId : null
        if (epoch) {
          appliedEpoch = epoch
          appliedSeq = seq
        } else {
          // Older versions stored only the number. Keep it until a server sends an epoch.
          appliedSeq = Math.max(appliedSeq, seq)
        }
      })
      .catch(() => {})
      .finally(() => { seqLoaded = true })
  }
  return seqLoading
}

function markApplied (seq) {
  appliedSeq = seq
  const patch = { [APPLIED_SEQ_KEY]: seq }
  if (appliedEpoch) patch[APPLIED_EPOCH_KEY] = appliedEpoch
  sessionSet(patch).catch(() => {})
}

function loadHeldTabs () {
  if (heldTabs) return Promise.resolve(heldTabs)
  if (!heldLoading) {
    heldLoading = sessionGet([HELD_TABS_KEY])
      .then(v => {
        const list = Array.isArray(v?.[HELD_TABS_KEY]) ? v[HELD_TABS_KEY] : []
        heldTabs = new Set(list.map(Number).filter(Number.isInteger))
      })
      .catch(() => { heldTabs = new Set() })
      .finally(() => { heldLoading = null })
  }
  return heldLoading
}

async function isHeld (tabId) {
  if (!Number.isInteger(tabId)) return false
  await loadHeldTabs()
  return heldTabs.has(tabId)
}

async function setHold (tabId, held) {
  if (!Number.isInteger(tabId)) return
  await loadHeldTabs()
  const had = heldTabs.has(tabId)
  if (had === !!held) return
  if (held) heldTabs.add(tabId)
  else heldTabs.delete(tabId)
  sessionSet({ [HELD_TABS_KEY]: [...heldTabs] }).catch(() => {})
  // The page may not have its content script yet: it asks again when it loads. A failed send is
  // not a failure to hold; the stored mark is what matters.
  try { await chrome.tabs.sendMessage(tabId, { type: 'og:hold', held }) } catch { /* content not loaded */ }
}

const normalizeServer = raw => {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  const withScheme = /^https?:\/\//i.test(s) ? s : 'https://' + s
  try {
    const u = new URL(withScheme)
    return u.origin + u.pathname.replace(/\/+$/, '')
  } catch { return '' }
}

function isLocalRelay (server) {
  try {
    const host = new URL(server).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function retryDelayMs (attempt, randomValue = Math.random()) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0))
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(n, 8)))
  const sample = Math.max(0, Math.min(1, Number(randomValue) || 0))
  return Math.round(base * (RETRY_JITTER_MIN + (RETRY_JITTER_MAX - RETRY_JITTER_MIN) * sample))
}

// ---- Pairing code ------------------------------------------------------------------------------
// A 4-character code the athlete types into the phone. It is generated locally and stored, so the
// popup can show it the instant it opens, even before any phone has been found.
function generatePairCode (length = 4, randomValue = Math.random) {
  let code = ''
  for (let i = 0; i < length; i++) {
    const r = Math.max(0, Math.min(0.999999, Number(randomValue()) || 0))
    code += PAIRING_CHARS[Math.floor(r * PAIRING_CHARS.length)]
  }
  return code
}

function normalizePairCode (raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toUpperCase()
    .replace(/0/g, 'O')
    .replace(/[IL]/g, '1')
    .replace(/[^2-9A-Z]/g, '')
    .slice(0, 8)
}

// Returns the stored pairing code, generating and saving a fresh one on first use.
async function ensurePairCode () {
  const { [PAIR_CODE_KEY]: stored } = await storageGet(PAIR_CODE_KEY)
  if (typeof stored === 'string' && stored) return stored
  const code = generatePairCode(4)
  await storageSet({ [PAIR_CODE_KEY]: code })
  return code
}

async function regeneratePairCode () {
  const code = generatePairCode(4)
  await storageSet({ [PAIR_CODE_KEY]: code })
  return code
}

// ---- Candidate addresses -----------------------------------------------------------------------
// Build the list of base URLs to probe. We cannot rely on window/RTCPeerConnection inside a
// service worker, so the local /24 prefix is learned best-effort from RTCPeerConnection when the
// host page can supply it, otherwise we sweep the common router/hotspot subnets.
function candidateBaseUrls (opts = {}) {
  const saved = normalizeServer(opts.savedServerUrl || '')
  const prefix = typeof opts.subnetPrefix === 'string' && opts.subnetPrefix ? opts.subnetPrefix : lastLanPrefix
  const urls = []
  const seen = new Set()
  const add = base => {
    if (!base || seen.has(base)) return
    seen.add(base)
    urls.push(base)
  }
  // 1) The URL we last successfully connected to.
  if (saved) add(saved)
  // 2) Loopback: local E2E on the same Mac / iOS Simulator shares 127.0.0.1.
  add('http://127.0.0.1:' + PHONE_RELAY_PORT)
  add('http://localhost:' + PHONE_RELAY_PORT)
  // 3) Learn our own /24 first (the most likely subnet), then the common ones.
  const prefixes = []
  if (prefix) prefixes.push(prefix)
  for (const p of COMMON_SUBNET_PREFIXES) if (!prefixes.includes(p)) prefixes.push(p)
  for (const p of prefixes) {
    for (let host = 1; host <= 254; host++) add('http://' + p + host + ':' + PHONE_RELAY_PORT)
  }
  // 4) iPhone hotspot block.
  for (const host of HOTSPOT_HOSTS) add('http://' + HOTSPOT_PREFIX + host + ':' + PHONE_RELAY_PORT)
  return urls
}

function rememberLanPrefix (url) {
  try {
    const host = new URL(url).hostname
    const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(host)
    if (m) lastLanPrefix = m[1] + '.'
  } catch { /* not an IP URL */ }
}

// Probe one candidate: does its phone relay recognise our pairing code?
// Resolves to the base URL on success, otherwise null. Never throws.
async function probeCandidate (base, pairCode, timeoutMs = DISCOVER_TIMEOUT_MS) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(base + '/pair/verify?code=' + encodeURIComponent(pairCode), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller ? controller.signal : undefined
    })
    if (res && res.ok) {
      let body = null
      try { body = await res.json() } catch { body = null }
      if (body && body.ok === true) return base
    }
    return null
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Scan all candidates in bounded concurrent batches. Stops as soon as one answers with ok:true.
async function discoverPhoneByPairCode (pairCode, opts = {}) {
  const code = normalizePairCode(pairCode)
  if (!code) return null
  const bases = opts.candidates && Array.isArray(opts.candidates)
    ? opts.candidates
    : candidateBaseUrls(opts)
  const batchSize = Number(opts.batchSize) > 0 ? Number(opts.batchSize) : DISCOVER_BATCH_SIZE
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DISCOVER_TIMEOUT_MS
  for (let i = 0; i < bases.length; i += batchSize) {
    const batch = bases.slice(i, i + batchSize)
    const results = await Promise.all(batch.map(base => probeCandidate(base, code, timeoutMs)))
    const hit = results.find(Boolean)
    if (hit) return hit
  }
  return null
}

// One discovery pass: if the current status means we are still looking for the phone, try to find
// it, and on success save the address and (re)connect. Called on a timer, on reconnect, and at
// startup. It is a no-op while already connected.
async function runDiscoveryPass () {
  const state = currentStatus.state
  if (state === 'connected') return null
  if (!SEARCHING_STATES.has(state)) return null
  const code = await ensurePairCode()
  const { [SERVER_KEY]: savedServerUrl } = await storageGet(SERVER_KEY)
  const hit = await discoverPhoneByPairCode(code, { savedServerUrl })
  if (!hit) return null
  discoveredServerUrl = hit
  rememberLanPrefix(hit)
  const { [SERVER_KEY]: currentSaved } = await storageGet(SERVER_KEY)
  if (currentSaved !== hit) await storageSet({ [SERVER_KEY]: hit })
  if (currentStatus.state !== 'connected') connect()
  return hit
}


function classifyHttpStatus (statusCode) {
  const code = Number(statusCode) || 0
  if (code === 401 || code === 403) {
    return { state: 'signed-out', detail: STATUS_DETAIL['signed-out'] }
  }
  if (code === 404) {
    return {
      state: 'server-error',
      detail: 'The relay address is wrong or this relay version does not support video sync.'
    }
  }
  return {
    state: 'server-error',
    detail: `The relay answered with HTTP ${code || 'error'}. It will retry automatically.`
  }
}

function classifyFetchError (server, error) {
  const message = String(error?.message || error || 'connection failed')
  if (isLocalRelay(server)) {
    return {
      state: 'relay-offline',
      detail: `${STATUS_DETAIL['relay-offline']} (${message})`
    }
  }
  return {
    state: 'host-offline',
    detail: `${STATUS_DETAIL['host-offline']} (${message})`
  }
}

function connectionDetail () {
  return connectedSessionId
    ? 'Chrome connected to the relay; phone workout linked.'
    : STATUS_DETAIL.connected
}

function clearRetry () {
  if (retry) clearTimeout(retry)
  retry = null
  retryAt = null
}

// A standing discovery loop that runs while we are looking for the phone (unconfigured /
// relay-offline / host-offline). It is separate from the reconnect backoff: it keeps sweeping the
// LAN every few seconds so a phone that starts hosting later is found on its own, without the
// athlete having to do anything. It stays off in the Node tests.
function scheduleDiscovery () {
  if (globalThis.__OG_VIDEO_SYNC_TEST__) return
  if (discoverTimer != null) return
  discoverTimer = setInterval(() => {
    runDiscoveryPass().catch(() => {})
  }, DISCOVER_INTERVAL_MS)
  // Kick one pass immediately so the first sweep is not delayed by a full interval.
  runDiscoveryPass().catch(() => {})
}

function stopDiscovery () {
  if (discoverTimer != null) {
    clearInterval(discoverTimer)
    discoverTimer = null
  }
}

async function status (state, detail = '', meta = {}) {
  const nextDetail = detail || STATUS_DETAIL[state] || STATUS_LABEL[state] || state
  const attempt = Number.isFinite(meta.attempt) ? meta.attempt : currentStatus.attempt || 0
  const nextRetryAt = meta.retryAt === undefined ? null : meta.retryAt
  const retryInMs = nextRetryAt ? Math.max(0, nextRetryAt - Date.now()) : null
  currentStatus = {
    state,
    detail: nextDetail,
    at: Date.now(),
    attempt,
    retryAt: nextRetryAt,
    retryInMs
  }
  await storageSet({ [STATUS_KEY]: currentStatus })
  const badge = BADGE[state] || BADGE.error
  try {
    await chrome.action.setBadgeText({ text: badge.text })
    await chrome.action.setBadgeBackgroundColor({ color: badge.color })
    await chrome.action.setTitle({
      title: `openGym video sync - ${STATUS_LABEL[state] || state}: ${nextDetail}`
    })
  } catch { /* action APIs are unavailable in some test and popup contexts */ }
}

async function hasHostPermission (server) {
  try {
    const origin = new URL(server).origin + '/*'
    return await chrome.permissions.contains({ origins: [origin] })
  } catch {
    return false
  }
}

function scheduleRetry (state, detail) {
  if (!RETRYABLE_STATES.has(state)) return null
  scheduleDiscovery()
  const delay = retryDelayMs(retryAttempt)
  retryAttempt += 1
  retryAt = Date.now() + delay
  if (retry) clearTimeout(retry)
  retry = setTimeout(() => {
    retry = null
    retryAt = null
    connect()
  }, delay)
  return { attempt: retryAttempt, retryAt }
}

async function sessionToken (serverUrl) {
  if (isLocalRelay(serverUrl)) return 'local-relay'
  for (const name of ['__Host-gymsid', 'gymsid']) {
    const c = await chrome.cookies.get({ url: serverUrl, name })
    if (c?.value) return c.value
  }
  return null
}

async function authHeaders (serverUrl) {
  if (isLocalRelay(serverUrl)) return {}
  const token = await sessionToken(serverUrl)
  return token ? { Authorization: 'Bearer ' + token } : null
}

function dispatch (state) {
  if (!state || typeof state !== 'object') return
  current = { ...current, ...state }
  chrome.storage.session.set({ [SESSION_KEY]: current }).catch(() => {})
}

// The video's key is the part that names the video, not the whole URL: the app's link and the tab
// differ in query strings, `p=` placement and the site's own tracking parameters.
function videoKey (url) {
  try {
    const u = new URL(url)
    const bv = /\/video\/(BV[0-9A-Za-z]+)/.exec(u.pathname)
    if (bv) return 'bv:' + bv[1] + ':' + (u.searchParams.get('p') || '1')
    const yt = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v')
    if (yt && /(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname)) return 'yt:' + yt
    if (/(^|\.)vimeo\.com$/.test(u.hostname)) {
      const vimeo = /^\/(?:video\/)?(\d+)/.exec(u.pathname)
      if (vimeo) return 'vimeo:' + vimeo[1]
    }
  } catch { /* not a URL we can key */ }
  return null
}

async function lastPlayingTab () {
  const got = await chrome.storage.session.get('lastPlayingTab')
  return got.lastPlayingTab?.id || null
}

const exactKeyOf = url => videoKey(url)

// An event from a page only belongs to the workout when it came from the video the app named.
// A second Bilibili/YouTube tab playing on its own must not pause the session. Without a named
// video there is nothing to compare against: an old boundTabId may by now hold another video, or
// the same tab may be playing something that is not this workout at all, so every page event is
// ignored until the app names a video again.
function videoEventMatches (url, tabId) {
  const expected = videoKey(current.videoUrl)
  if (!expected) return false
  // Once the app has bound a tab, a duplicate tab showing the same video must not control the
  // workout. If no tab has been bound yet, the named video's URL is the only available identity.
  if (Number.isInteger(current.boundTabId) && tabId !== current.boundTabId) return false
  return videoKey(url) === expected
}

function bindTab (tabId) {
  if (!Number.isInteger(tabId)) return
  current = { ...current, boundTabId: tabId }
  chrome.storage.session.set({ [SESSION_KEY]: current }).catch(() => {})
}

async function pickTab (videoUrl) {
  const target = videoKey(videoUrl)
  // No key, no guess: a video URL that cannot be named is never matched against a different tab.
  if (!target) return []
  const tabs = await chrome.tabs.query({ url: VIDEO_PATTERNS })
  // Exact video only. A different Bilibili/YouTube tab is not a fallback: pausing or seeking the
  // wrong video is worse than reporting that the named one is not open.
  const exact = tabs.filter(tab => exactKeyOf(tab.url) === target)
  if (!exact.length) return []
  const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  const lastId = await lastPlayingTab()
  const score = tab => {
    let s = 0
    if (tab.id === lastId) s += 40
    if (active && tab.id === active.id) s += 20
    if (tab.audible) s += 10
    return s
  }
  return exact.slice().sort((a, b) => score(b) - score(a))
}

const videoHost = url => {
  try {
    const h = new URL(url).hostname
    return /(^|\.)bilibili\.com$|(^|\.)youtube\.com$|(^|\.)vimeo\.com$/.test(h)
  } catch { return false }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A newly opened tab has no video until the player has mounted. Poll the page half (which never
// touches playback for this command) so "opened" is reported only once there is something to play.
async function waitForVideo (tabId, timeout = readyTimeout) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const res = await sendCommand(tabId, { action: 'status' })
    if (res?.ok && res.hasVideo) return res
    await sleep(250)
  }
  return null
}

async function sendCommand (tabId, cmd) {
  const payload = typeof cmd === 'string' ? { type: 'og:command', action: cmd } : { type: 'og:command', ...cmd }
  try {
    return await chrome.tabs.sendMessage(tabId, payload)
  } catch {
    // A tab that was open before the extension was installed has no content script yet.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      return await chrome.tabs.sendMessage(tabId, payload)
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
  }
}

async function command (cmd) {
  const action = typeof cmd === 'string' ? cmd : cmd?.action
  // A start without a play intent is an attach: it points the extension at the session's video
  // and leaves whatever the athlete was doing alone. Only a fresh workout (play:true) autoplays,
  // and only an explicit paused start (play:false) opens and holds a tab paused.
  const playIntent = action === 'start' && typeof cmd?.play === 'boolean' ? cmd.play : null
  const preservePlayback = action === 'start' && playIntent === null
  let tabs = await pickTab(current.videoUrl)
  let opened = false
  const target = current.videoUrl
  if (!tabs.length && action === 'start' && !preservePlayback && target && videoHost(target)) {
    // The phone named a video that is not open here: open exactly that URL, then wait for its
    // player before reporting success. Nothing is sent to any other tab.
    let tab
    try { tab = await chrome.tabs.create({ url: target, active: true }) } catch {
      await status('connected', 'video sync: could not open the video tab')
      return { ok: false, reason: 'open-failed' }
    }
    if (tab?.id == null) {
      await status('connected', 'video sync: could not open the video tab')
      return { ok: false, reason: 'open-failed' }
    }
    // The page started by the site's own autoplay must not run ahead of the workout. Hold it
    // before the player mounts, so the content script pauses the first playable video; the mark
    // survives a worker restart until an explicit resume (or a play:true start) clears it.
    if (playIntent === false) await setHold(tab.id, true)
    const ready = await waitForVideo(tab.id)
    if (!ready) {
      await status('connected', 'video sync: the video is still loading in Chrome')
      return { ok: false, reason: 'not-ready', tabId: tab.id, opened: true }
    }
    tabs = [tab]
    opened = true
  }
  if (!tabs.length) {
    await status('connected', current.videoUrl ? 'video sync: that video tab is not open' : 'video sync: no video tab open')
    return { ok: false, reason: 'no-tab' }
  }
  // A tab already bound to this workout wins, even when another tab shows the same video. Without
  // a live binding, one exact match is safe to bind; two or more are ambiguous and nothing is sent.
  const bound = Number.isInteger(current.boundTabId) ? tabs.find(t => t.id === current.boundTabId) : null
  const tab = bound || (tabs.length === 1 ? tabs[0] : null)
  if (!tab) {
    await status('connected', 'video sync: more than one tab has that video')
    return { ok: false, reason: 'ambiguous-tab' }
  }
  // An already-open target tab is held paused for a play:false start too, so a later reload of the
  // page cannot autoplay ahead of the workout. Only an explicit resume (or a start that asks for
  // playback) may release it. Doing this before the command means the content script will not
  // re-pause the play it is about to make. An attach touches no hold mark at all.
  if (playIntent === false) await setHold(tab.id, true)
  if (action === 'resume' || (action === 'start' && playIntent === true)) await setHold(tab.id, false)
  const res = await sendCommand(tab.id, cmd)
  if (!res?.ok) {
    const why = res?.reason === 'no-video' ? 'the video is not ready'
      : res?.reason === 'unreachable' ? 'the page cannot be reached'
      : 'the video did not answer'
    await status('connected', 'video sync: ' + why)
    return { ok: false, reason: res?.reason || 'no-playable-video' }
  }
  bindTab(tab.id)
  // A reload or chapter start must leave a paused video paused, even when the site autoplays it.
  // An attach (no play intent) leaves playback exactly as it found it.
  if (playIntent === false) {
    const paused = await sendCommand(tab.id, 'pause')
    if (!paused?.ok) {
      await status('connected', 'video sync: the video could not be paused')
      return { ok: false, reason: paused?.reason || 'pause-failed' }
    }
  }
  // A fresh workout start plays the named video even when its tab was already open (the athlete
  // may have paused it before starting). A reconnect replay never gets here: appliedSeq survives
  // the worker in session storage, so the same start is not applied twice.
  if (action === 'start' && playIntent === true) {
    // Carry the start position through to the resume so a video with a start timestamp
    // (vstart / ?t=85) opens at that point. `force` is only set when a positive position is
    // known, so a plain start still plays from wherever the tab already is.
    const pos = Number(cmd?.pos)
    const carriesPosition = Number.isFinite(pos) && pos > 0
    const resumeCmd = carriesPosition
      ? { action: 'resume', pos: cmd.pos, offset: cmd.offset, force: true }
      : { action: 'resume' }
    const play = await sendCommand(tab.id, resumeCmd)
    if (!play?.ok && play?.reason === 'blocked') {
      await status('connected', 'autoplay blocked: press play in Chrome')
      return { ok: true, tabId: tab.id, opened, playback: 'blocked' }
    }
    if (!play?.ok) {
      await status('connected', 'the video opened but playback was refused')
      return { ok: true, tabId: tab.id, opened, playback: 'blocked' }
    }
  }
  const detail = action === 'start' ? 'video tab: ' + tab.title
    : action === 'seek' ? `seek → ${Math.round(Number(cmd?.pos || 0))}s`
    : action + ' → ' + tab.title
  await status('connected', detail)
  return { ok: true, tabId: tab.id, opened }
}

async function post (action, source) {
  const { [SERVER_KEY]: raw } = await storageGet(SERVER_KEY)
  const server = normalizeServer(raw)
  if (!server) return
  if (!(await hasHostPermission(server))) {
    await status('permission-denied', STATUS_DETAIL['permission-denied'], { attempt: 0 })
    return
  }
  const headers = await authHeaders(server)
  if (!headers) {
    await status('signed-out', STATUS_DETAIL['signed-out'], { attempt: 0 })
    return
  }
  try {
    const res = await fetch(server + '/api/video-sync/command', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        action,
        source,
        sessionId: current.sessionId,
        ...(current.videoUrl ? { videoUrl: current.videoUrl } : {})
      })
    })
    if (!res.ok) {
      const classified = classifyHttpStatus(res.status)
      await status(classified.state, classified.detail, { attempt: 0 })
    } else {
      dispatch(await res.json())
    }
  } catch (error) {
    // The stream owns the reconnect loop. This command's failure is reported now, and the next
    // stream snapshot (or reconnect) brings the authoritative state back.
    const classified = classifyFetchError(server, error)
    await status(classified.state, classified.detail)
  }
}

function commandFor (next) {
  if (next.action === 'start') {
    const carriesPosition = Number.isFinite(Number(next.pos)) && Number(next.pos) > 0
    if (typeof next.play === 'boolean') {
      // Carry the start position (a vstart / ?t= timestamp) through to the tab so a workout
      // that begins partway into the video opens and plays from that point, not from zero.
      return carriesPosition
        ? { action: 'start', play: next.play, pos: next.pos, offset: next.offset }
        : { action: 'start', play: next.play }
    }
    return carriesPosition
      ? { action: 'start', pos: next.pos, offset: next.offset }
      : { action: 'start' }
  }
  if (next.action === 'seek') {
    return { action: 'seek', pos: next.pos, offset: next.offset, force: !!next.force }
  }
  if (next.action === 'pause') return 'pause'
  if (next.action === 'resume') {
    return { action: 'resume', pos: next.pos, offset: next.offset, force: next.force === true }
  }
  return null
}

async function drainPending () {
  while (pendingCommands.length) {
    const item = pendingCommands[0]
    if (item.seq <= appliedSeq) { pendingCommands.shift(); continue }
    const cmd = commandFor(item)
    if (!cmd) { markApplied(item.seq); pendingCommands.shift(); continue }
    const res = await command(cmd)
    if (!res?.ok) {
      if (cmd?.action === 'start') return false
      // The start that held this queue is done; a later command that cannot run now must not
      // trap every newer command behind it.
      pendingCommands.shift()
      continue
    }
    markApplied(item.seq)
    pendingCommands.shift()
  }
  return true
}

function clearBoundTab () {
  current = { ...current, boundTabId: null }
  chrome.storage.session.set({ [SESSION_KEY]: current }).catch(() => {})
}

async function endSession (next, before) {
  // An end is final: nothing queued behind it belongs to this workout any more.
  pendingCommands = []
  const tabId = Number.isInteger(before.boundTabId) ? before.boundTabId : null
  if (tabId != null) {
    await setHold(tabId, false)
    // Only touch the bound tab when it still shows the video this session named. A tab that has
    // navigated since is not ours to pause.
    if (before.videoUrl) {
      try {
        const tab = (await chrome.tabs.query({})).find(t => t.id === tabId)
        if (tab && videoKey(tab.url) === videoKey(before.videoUrl)) await sendCommand(tabId, 'pause')
      } catch { /* the tab is gone; there is nothing left to pause */ }
    }
    clearBoundTab()
  }
  markApplied(next.seq)
}

async function onState (next) {
  await loadAppliedSeq()
  const before = { ...current }
  dispatch(next)
  const nextSessionId = typeof next.sessionId === 'string' && next.sessionId ? next.sessionId : null
  const sessionChanged = nextSessionId !== connectedSessionId
  connectedSessionId = nextSessionId
  if (sessionChanged && currentStatus.state === 'connected') {
    await status('connected', connectionDetail(), { attempt: 0 })
  }
  // A restarted server or relay begins again at seq 1. The epoch is different even when the old
  // number was much higher, so reset before deciding the snapshot is stale.
  const epoch = typeof next.epoch === 'string' && next.epoch ? next.epoch : null
  if (epoch && epoch !== appliedEpoch) {
    appliedEpoch = epoch
    appliedSeq = 0
    pendingCommands = []
    sessionSet({ [APPLIED_EPOCH_KEY]: epoch, [APPLIED_SEQ_KEY]: 0 }).catch(() => {})
  }
  if (next.source !== 'app') return
  if (next.action === 'end') {
    // `end` names no workout, but it still has to reach the player that was bound before it.
    if (next.seq > appliedSeq) await endSession(next, before)
    return
  }
  if (!next.sessionId) return
  if (next.seq <= appliedSeq) return
  if (pendingCommands.length) {
    pendingCommands.push(next)
    await drainPending()
    return
  }
  const cmd = commandFor(next)
  if (!cmd) { markApplied(next.seq); return }
  const res = await command(cmd)
  if (res.ok) {
    markApplied(next.seq)
  } else if (cmd?.action === 'start' && res.reason === 'not-ready') {
    // The tab is still loading. Keep this start at the front and let the next snapshot retry it;
    // a seek or resume behind it must not be applied first.
    pendingCommands.push(next)
  }
}

function consume (text) {
  let at
  while ((at = text.indexOf('\n\n')) >= 0) {
    const block = text.slice(0, at)
    text = text.slice(at + 2)
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('\n')
    if (!data) continue
    // One command at a time, in stream order: a start that opens a tab must finish before the
    // seek behind it is applied.
    try {
      const state = JSON.parse(data)
      stateChain = stateChain.then(() => onState(state)).catch(() => {})
    } catch { /* a partial frame is dropped */ }
  }
  return text
}

let stateChain = Promise.resolve()

async function connect () {
  if (connecting) { reconnectQueued = true; return }
  clearRetry()
  const my = ++generation
  connecting = true
  let controller = null
  try {
    abort?.abort()
    abort = null
    const { [SERVER_KEY]: raw } = await storageGet(SERVER_KEY)
    const server = normalizeServer(raw)
    if (!server) {
      // No address yet: fall into the phone-discovery state and let the discovery loop find one.
      // This is not "broken", it is "waiting for your phone", so the popup shows a calm message.
      await status('unconfigured', STATUS_DETAIL.unconfigured, { attempt: 0 })
      scheduleDiscovery()
      return
    }
    if (!(await hasHostPermission(server))) {
      await status('permission-denied', STATUS_DETAIL['permission-denied'], { attempt: 0 })
      return
    }
    const headers = await authHeaders(server)
    if (!headers) {
      await status('signed-out', STATUS_DETAIL['signed-out'], { attempt: 0 })
      return
    }
    await status('connecting', retryAttempt
      ? `Reconnecting to the relay (attempt ${retryAttempt}).`
      : STATUS_DETAIL.connecting)
    controller = new AbortController()
    abort = controller
    const res = await fetch(server + '/api/video-sync/stream', {
      headers: { ...headers, Accept: 'text/event-stream' },
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    })
    if (!res.ok) {
      const classified = classifyHttpStatus(res.status)
      const retryMeta = scheduleRetry(classified.state, classified.detail)
      await status(classified.state, classified.detail, retryMeta || { attempt: 0 })
      return
    }
    if (!res.body) throw new Error('stream response has no body')
    retryAttempt = 0
    // Found and connected: stop sweeping the LAN until the stream drops again.
    stopDiscovery()
    await status('connected', connectionDetail(), { attempt: 0 })
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      lastChunkAt = Date.now()
      buffer += value
      buffer = consume(buffer)
    }
    const classified = classifyFetchError(server, new Error('stream closed'))
    const retryMeta = scheduleRetry(classified.state, classified.detail)
    await status(classified.state, classified.detail, retryMeta || {})
  } catch (error) {
    if (error?.name === 'AbortError') return
    const { [SERVER_KEY]: raw } = await storageGet(SERVER_KEY)
    const server = normalizeServer(raw)
    const classified = classifyFetchError(server, error)
    const retryMeta = scheduleRetry(classified.state, classified.detail)
    await status(classified.state, classified.detail, retryMeta || {})
  } finally {
    if (my !== generation) return
    if (abort === controller) abort = null
    connecting = false
    if (reconnectQueued) { reconnectQueued = false; connect(); return }
  }
}

async function reconnectNow () {
  clearRetry()
  retryAttempt = 0
  if (connecting) {
    reconnectQueued = true
    abort?.abort()
    return
  }
  return connect()
}

export {
  command,
  onState,
  connect,
  reconnectNow,
  pickTab,
  videoKey,
  videoEventMatches,
  retryDelayMs,
  classifyFetchError,
  classifyHttpStatus,
  isLocalRelay,
  discoverPhoneByPairCode,
  candidateBaseUrls,
  generatePairCode,
  normalizePairCode,
  ensurePairCode,
  regeneratePairCode,
  runDiscoveryPass
}

// The Node tests import this module with a fake chrome namespace. Keeping the listeners behind
// the flag stops a test import from starting a live stream or registering into a fake event bus.
export const __test = {
  setCurrent (next) { current = { ...current, ...next } },
  getCurrent () { return current },
  getAppliedSeq () { return appliedSeq },
  getAppliedEpoch () { return appliedEpoch },
  getPending () { return pendingCommands.map(item => item.seq) },
  setAppliedSeq (seq) { appliedSeq = seq; seqLoaded = true },
  setAppliedEpoch (epoch) { appliedEpoch = epoch || null },
  setReadyTimeout (ms) { readyTimeout = ms },
  getStatus () { return currentStatus },
  connection () {
    return { abort, connecting, retry, retryAt, retryAttempt, generation, reconnectQueued, seqLoaded }
  },
  getDiscoveredServerUrl () { return discoveredServerUrl },
  setLanPrefix (prefix) { lastLanPrefix = prefix || null },
  reset () {
    clearRetry()
    stopDiscovery()
    discoveredServerUrl = null
    lastLanPrefix = null
    current = { seq: 0, action: null, source: null, sessionId: null, videoUrl: null, boundTabId: null, online: false }
    appliedSeq = 0
    appliedEpoch = null
    abort = null
    connecting = false
    retry = null
    retryAt = null
    retryAttempt = 0
    currentStatus = { state: 'unconfigured', detail: STATUS_DETAIL.unconfigured, at: 0, attempt: 0, retryAt: null, retryInMs: null }
    connectedSessionId = null
    generation = 0
    reconnectQueued = false
    seqLoaded = false
    seqLoading = null
    heldTabs = null
    heldLoading = null
    pendingCommands = []
    stateChain = Promise.resolve()
  }
}

if (!globalThis.__OG_VIDEO_SYNC_TEST__) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(ALARM, { periodInMinutes: 1 })
    ensurePairCode().catch(() => {})
    connect()
  })
  chrome.runtime.onStartup.addListener(() => { ensurePairCode().catch(() => {}); connect() })
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== ALARM) return
    // The worker is terminated when it goes idle; the alarm is what brings the stream back. While
    // it is alive the server pings every 20 s, so silence for over a minute means a dead socket.
    if (!abort || Date.now() - lastChunkAt > 70000) reconnectNow()
  })

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg?.type === 'og:hold?') {
      // A page that loaded while the worker was asleep asks whether it was opened paused.
      isHeld(sender.tab?.id).then(held => respond({ held })).catch(() => respond({ held: false }))
      return true
    }
    if (msg?.type === 'og:video') {
      if (msg.hasVideo && sender.tab?.id != null && msg.playing) {
        chrome.storage.session.set({ lastPlayingTab: { id: sender.tab.id, at: Date.now() } }).catch(() => {})
      }
      return
    }
    if (msg?.type === 'og:event' && current.sessionId) {
      if (!videoEventMatches(msg.url || sender.tab?.url, sender.tab?.id)) return
      post(msg.action === 'pause' ? 'pause' : 'resume', 'video')
      return
    }
    if (msg?.type === 'og:reconnect') {
      // A manual Reconnect always sweeps the LAN once before/around reconnecting, so a phone that
      // just started hosting is picked up even if it was invisible a moment ago.
      reconnectNow()
      runDiscoveryPass().catch(() => {})
      return
    }
    if (msg?.type === 'og:newpaircode') {
      // New code from the popup's Refresh button: store it, then sweep the LAN for a phone that
      // already knows this code.
      regeneratePairCode()
        .then(code => { respond?.({ ok: true, code }); runDiscoveryPass().catch(() => {}) })
        .catch(() => respond?.({ ok: false }))
      return true
    }
    if (msg?.type === 'og:ensurepaircode') {
      // The popup asks for the code on open; generate one if this is the very first time.
      ensurePairCode()
        .then(code => respond?.({ ok: true, code }))
        .catch(() => respond?.({ ok: false }))
      return true
    }
  })

  chrome.tabs.onRemoved.addListener(async tabId => {
    await loadHeldTabs()
    if (heldTabs.has(tabId)) {
      heldTabs.delete(tabId)
      sessionSet({ [HELD_TABS_KEY]: [...heldTabs] }).catch(() => {})
    }
    const last = await chrome.storage.session.get('lastPlayingTab')
    if (last?.lastPlayingTab?.id === tabId) chrome.storage.session.remove('lastPlayingTab').catch(() => {})
  })

  connect()
}
