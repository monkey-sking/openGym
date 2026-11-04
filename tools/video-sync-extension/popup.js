const $ = id => document.getElementById(id)
const LABEL = {
  unconfigured: 'Server not set',
  connecting: 'Connecting…',
  connected: 'Listening for workout',
  'relay-offline': 'Relay not running',
  'host-offline': 'Server unreachable',
  'permission-denied': 'Chrome permission needed',
  'signed-out': 'Not signed in',
  'server-error': 'Server error',
  error: 'Connection error'
}
const WARN = new Set(['connecting', 'relay-offline', 'host-offline'])
const BAD = new Set(['permission-denied', 'signed-out', 'server-error', 'error'])
let shownStatus = null
let countdownTimer = null

function render (status) {
  shownStatus = status || null
  const state = status?.state || 'unconfigured'
  const el = $('status')
  el.textContent = LABEL[state] || state
  el.className = 'status' + (state === 'connected' ? ' ok' : WARN.has(state) ? ' warn' : BAD.has(state) ? ' bad' : ' idle')
  const detail = status?.detail || ''
  $('detail').textContent = detail
  renderCountdown()
}

function renderCountdown () {
  const state = shownStatus?.state || 'unconfigured'
  const retryAt = Number(shownStatus?.retryAt) || 0
  const seconds = retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0
  if (retryAt && seconds > 0) {
    $('next').textContent = `Automatic retry in ${seconds}s (attempt ${shownStatus.attempt || 1}).`
  } else if (state === 'permission-denied') {
    $('next').textContent = 'Click Reconnect and allow Chrome access to this relay address.'
  } else if (state === 'signed-out') {
    $('next').textContent = 'Sign in to this server in the same Chrome profile, then click Reconnect.'
  } else if (state === 'relay-offline') {
    $('next').textContent = 'Open openGym Video Sync on the Mac, check the menu-bar status, then click Reconnect.'
  } else if (state === 'host-offline') {
    $('next').textContent = 'Check the server address and network. The extension retries automatically.'
  } else if (state === 'server-error') {
    $('next').textContent = 'Check that the address points to a compatible openGym relay.'
  } else {
    $('next').textContent = ''
  }
}


async function fetchPairCode () {
  const server = parseServer() || "http://127.0.0.1:8787"
  try {
    const res = await fetch(server + "/pair/code")
    if (res.ok) {
      const data = await res.json()
      if (data?.code && $("pair-code")) {
        $("pair-code").textContent = data.code
        return
      }
    }
  } catch {}
  if ($("pair-code")) $("pair-code").textContent = "----"
}

async function load () {
  const { serverUrl, status } = await chrome.storage.local.get(['serverUrl', 'status'])
  $('server').value = serverUrl || 'http://127.0.0.1:8787'
  render(status)
  fetchPairCode()
}

function parseServer () {
  const raw = $('server').value.trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw)
    return u.origin + u.pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

async function requestHost (server) {
  if (!server) return false
  const origin = new URL(server).origin
  // This runs during a click: Chrome only allows its host-permission prompt from a user gesture.
  return chrome.permissions.request({ origins: [origin + '/*'] }).catch(() => false)
}

function reconnect () {
  render({ state: 'connecting', detail: 'Checking the openGym relay connection.' })
  chrome.runtime.sendMessage({ type: 'og:reconnect' }).catch(() => {})
}

async function save () {
  const server = parseServer()
  if (!server) {
    render({ state: 'unconfigured', detail: 'Enter a full http:// or https:// relay address.' })
    return
  }
  if (!(await requestHost(server))) {
    render({
      state: 'permission-denied',
      detail: 'Chrome did not grant access to ' + new URL(server).origin + '. Click Save or Reconnect to ask again.'
    })
    return
  }
  await chrome.storage.local.set({ serverUrl: server })
  $('server').value = server
  reconnect()
}

$('save').addEventListener('click', save)
$('retry').addEventListener('click', async () => {
  const server = parseServer()
  if (!server) {
    render({ state: 'unconfigured', detail: 'Enter the relay address first.' })
    return
  }
  if (!(await requestHost(server))) {
    render({
      state: 'permission-denied',
      detail: 'Chrome did not grant access to ' + new URL(server).origin + '. Click Reconnect to ask again.'
    })
    return
  }
  if ($('server').value.trim() !== server) $('server').value = server
  const stored = await chrome.storage.local.get('serverUrl')
  if (stored.serverUrl !== server) await chrome.storage.local.set({ serverUrl: server })
  reconnect()
})

chrome.storage.onChanged.addListener(changes => {
  if (changes.status) render(changes.status.newValue)
  if (changes.serverUrl) $('server').value = changes.serverUrl.newValue || ''
})

countdownTimer = setInterval(renderCountdown, 250)
window.addEventListener('pagehide', () => clearInterval(countdownTimer), { once: true })

load()
