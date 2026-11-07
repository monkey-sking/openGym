const $ = id => document.getElementById(id)

const STATUS_TEXTS = {
  unconfigured: 'Waiting',
  connecting: 'Searching…',
  connected: 'Connected',
  'relay-offline': 'Searching…',
  'host-offline': 'Searching…',
  'permission-denied': 'Permission needed',
  'signed-out': 'Sign in needed',
  'server-error': 'Offline',
  error: 'Offline'
}

const SEARCHING = new Set(['unconfigured', 'connecting', 'relay-offline', 'host-offline'])
const BAD = new Set(['permission-denied', 'signed-out', 'server-error', 'error'])

let currentStatus = null
let currentPhoneMeta = null

function formatTime (seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function renderStatus (status) {
  currentStatus = status || null
  const state = status?.state || 'unconfigured'
  const pill = $('status-pill')
  const textEl = $('status-text')
  
  textEl.textContent = STATUS_TEXTS[state] || state
  pill.className = 'status-pill ' + (state === 'connected' ? 'status-ok' : SEARCHING.has(state) ? 'status-warn' : 'status-bad')
  updateLayout()
}

function renderPhoneMeta (meta) {
  currentPhoneMeta = meta || null
  updateLayout()
}

function updateLayout () {
  const isConnected = currentStatus?.state === 'connected'
  const hasWorkout = Boolean(currentPhoneMeta && (currentPhoneMeta.exerciseName || currentPhoneMeta.workoutName))

  const phoneCard = $('phone-card')
  const idleCard = $('idle-card')
  const pairCard = $('pair-card')

  if (isConnected && hasWorkout) {
    phoneCard.classList.remove('hidden')
    idleCard.classList.add('hidden')
    pairCard.classList.add('hidden')

    // Fill phone card content
    $('phone-workout-name').textContent = currentPhoneMeta.workoutName || 'Workout'
    
    const cur = currentPhoneMeta.curIndex || 1
    const total = currentPhoneMeta.totalCount || 1
    $('phone-step-pill').textContent = `${cur} / ${total}`
    
    $('phone-exercise-name').textContent = currentPhoneMeta.exerciseName || 'Exercise'

    const timerPill = $('phone-timer-pill')
    const timerIcon = $('phone-timer-icon')
    const timerText = $('phone-timer-text')
    const stateBadge = $('phone-state-badge')

    if (currentPhoneMeta.isResting) {
      timerPill.className = 'timer-pill rest'
      timerIcon.textContent = '☕'
      timerText.textContent = currentPhoneMeta.workLeft != null ? formatTime(currentPhoneMeta.workLeft) : 'Rest'
      stateBadge.textContent = 'Rest'
    } else if (currentPhoneMeta.isWorkPaused) {
      timerPill.className = 'timer-pill paused'
      timerIcon.textContent = '⏸'
      timerText.textContent = currentPhoneMeta.workLeft != null ? formatTime(currentPhoneMeta.workLeft) : 'Paused'
      stateBadge.textContent = 'Paused'
    } else if (currentPhoneMeta.isWorkActive) {
      timerPill.className = 'timer-pill work'
      timerIcon.textContent = '▶'
      timerText.textContent = currentPhoneMeta.workLeft != null ? formatTime(currentPhoneMeta.workLeft) : 'Active'
      stateBadge.textContent = 'Running'
    } else {
      timerPill.className = 'timer-pill work'
      timerIcon.textContent = '●'
      timerText.textContent = 'Ready'
      stateBadge.textContent = 'Active'
    }
  } else if (isConnected) {
    phoneCard.classList.add('hidden')
    idleCard.classList.remove('hidden')
    pairCard.classList.remove('hidden')
  } else {
    phoneCard.classList.add('hidden')
    idleCard.classList.add('hidden')
    pairCard.classList.remove('hidden')
  }
}

function paintPairCode (code) {
  if ($('pair-code')) $('pair-code').textContent = code || '----'
}

async function load () {
  const { serverUrl, status, pairCode, phoneMeta } = await chrome.storage.local.get(['serverUrl', 'status', 'pairCode', 'phoneMeta'])
  $('server').value = serverUrl || ''
  paintPairCode(pairCode)
  renderStatus(status)
  renderPhoneMeta(phoneMeta)

  try {
    const res = await chrome.runtime.sendMessage({ type: 'og:ensurepaircode' }).catch(() => null)
    if (res?.code) paintPairCode(res.code)
  } catch { /* background handles startup */ }
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
  return chrome.permissions.request({ origins: [origin + '/*'] }).catch(() => false)
}

function reconnect () {
  renderStatus({ state: 'connecting' })
  chrome.runtime.sendMessage({ type: 'og:reconnect' }).catch(() => {})
}

async function refreshCode () {
  const res = await chrome.runtime.sendMessage({ type: 'og:newpaircode' }).catch(() => null)
  if (res?.code) {
    paintPairCode(res.code)
    reconnect()
  }
}

async function save () {
  const server = parseServer()
  if (!server) {
    await chrome.storage.local.set({ serverUrl: '' })
    reconnect()
    return
  }
  if (!(await requestHost(server))) {
    renderStatus({ state: 'permission-denied' })
    return
  }
  await chrome.storage.local.set({ serverUrl: server })
  $('server').value = server
  reconnect()
}

$('save').addEventListener('click', save)
$('retry').addEventListener('click', reconnect)
$('refresh-code').addEventListener('click', refreshCode)

chrome.storage.onChanged.addListener(changes => {
  if (changes.status) renderStatus(changes.status.newValue)
  if (changes.phoneMeta) renderPhoneMeta(changes.phoneMeta.newValue)
  if (changes.serverUrl) $('server').value = changes.serverUrl.newValue || ''
  if (changes.pairCode) paintPairCode(changes.pairCode.newValue)
})

load()
