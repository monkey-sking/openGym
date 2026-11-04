// The workout and the video playing on the computer pause and resume together
// (docs/dev/VIDEO_SYNC.md). The app half of it: the phone posts what the athlete did, polls what
// the browser extension saw the video do, and applies that through the same pause the tap uses
// (store/useStore.js pauseWorkout/resumeWorkout, lib/workout-pause.js).
//
// The server only remembers the last command per profile (api/server.js video-sync). `epoch` says
// which process wrote it: the sequence starts again at 1 after a server or relay restart, so a
// new epoch resets the number this app compares against. Within one epoch `seq` is what makes a
// poll safe: an answer no newer than the last one applied is ignored, so a retried request or a
// command from before a reconnect cannot pause a workout that has moved on. A command is applied
// only when it names the session running here, so a late pause from a workout that ended a second
// ago leaves the next one alone.
import { api } from './api.js'
import { isPaused, elapsedMs } from './workout-pause.js'
import { EXIDX } from './exercises.js'
import { linkKind } from './media-refs.js'
import { nativeFetch } from './capacitor-fetch.js'
import { MOBILE, nativePlatform } from './mobile.js'

// How often the app asks what the computer did. The stream carries the extension's side; this is
// the app's, and a phone polling every 1.5 s costs one small GET — the workout screen already
// polls less often than its clock ticks.
export const VIDEO_SYNC_POLL_MS = 1500
// Ask the extension to compare clocks periodically. It only seeks beyond its 5 s
// tolerance, so normal playback is left alone; this is a check, not a hard correction.
export const VIDEO_SYNC_DRIFT_CHECK_MS = 5000

// The sessions that have a clock to pause: a past workout logged after the fact and the editor of
// a saved one both ride `S.active` without one.
const liveSession = A => !!(A && !A.backfill && !A.editingWorkoutId && A.start > 0)
export const videoSyncSessionId = A => (liveSession(A) ? A.id : null)

// The video this chapter belongs to, when the exercise came from a follow-along video.
// lib/video-plan.js puts the source link on every block, including a catalogue-mapped one; older
// plans only have it on the custom exercise. The extension uses it to pick that tab instead of
// whichever video happens to be active; without it, the tab being watched.
export const videoSyncUrl = A => {
  const entry = A?.entries?.[A?.cur]
  const url = [entry?.videoUrl, entry?.target?.videoUrl, entry?.id != null ? EXIDX[entry.id]?.url : null]
    .find(u => u && linkKind(u) === 'video')
  return url ? String(url).slice(0, 500) : null
}

// The server URL configured for local direct relay, stored in localStorage on this phone.
export const SYNC_SERVER_KEY = 'opengym_video_sync_server'
export const readVideoSyncServer = () => {
  try { return (globalThis.localStorage?.getItem(SYNC_SERVER_KEY) || '').trim() } catch { return '' }
}
export const writeVideoSyncServer = s => {
  try {
    const v = String(s || '').trim()
    if (v) globalThis.localStorage?.setItem(SYNC_SERVER_KEY, v)
    else globalThis.localStorage?.removeItem(SYNC_SERVER_KEY)
  } catch { /* ignore */ }
}

// Calculates the target video position (in seconds) for the current active workout session.
// If the current chapter has an explicit vstart or note timestamp, video position is:
// vstart + (seconds elapsed within the current chapter's active hold).
// For an untimed or chapterless video routine, it falls back to the session's overall elapsed seconds.
export function videoSyncPos(A, currentWork = null) {
  if (!liveSession(A)) return null
  const entry = A?.entries?.[A?.cur]
  let startSec = 0
  let hasExplicitStart = false
  if (typeof entry?.target?.vstart === 'number' && Number.isFinite(entry.target.vstart)) {
    startSec = entry.target.vstart
    hasExplicitStart = true
  } else if (typeof entry?.vstart === 'number' && Number.isFinite(entry.vstart)) {
    startSec = entry.vstart
    hasExplicitStart = true
  } else if (typeof entry?.target?.note === 'string' || typeof entry?.note === 'string') {
    const note = entry?.target?.note || entry?.note || ''
    const m = /(\d+):(\d{2})/.exec(note)
    if (m) {
      startSec = Number(m[1]) * 60 + Number(m[2])
      hasExplicitStart = true
    }
  }
  if (hasExplicitStart) {
    let intraSec = 0
    const wk = currentWork
    // Repeated catalogue exercises share an id; the chapter index takes precedence.
    const ownsChapter = wk?.owner?.idx != null
      ? wk.owner.idx === A.cur
      : wk?.owner?.id != null && wk.owner.id === entry?.id &&
        A.entries.filter(e => e.id === wk.owner.id).length === 1
    if (wk && ownsChapter) {
      const total = Number(wk.total) || 0
      const left = Number(wk.left) || 0
      intraSec = Math.max(0, total - Math.max(0, left))
    } else if (Array.isArray(entry?.sets)) {
      const doneSec = entry.sets.filter(s => s.done).reduce((acc, s) => acc + (Number(s.sec) || 0), 0)
      intraSec = Math.max(0, doneSec)
    }
    return Math.max(0, Math.round(startSec + intraSec))
  }
  // Session elapsed seconds
  const elapsedSec = Math.max(0, Math.floor(elapsedMs(A) / 1000))
  return Math.max(0, Math.round(startSec + elapsedSec))
}

export async function startVideoSync ({ useStore, useUI, request = api, poll = VIDEO_SYNC_POLL_MS }) {
  let stopped = false
  let sessionId = null
  let videoUrl = null
  let lastSeq = 0
  let lastEpoch = null
  let timer = null
  let online = null
  let curIdx = null
  let lastDriftCheckAt = 0
  // Finish sends `end` before the session is removed; the subscription that sees the removal must
  // not send a second one.
  let endedSession = null
  // A command from the computer is applied with this set: the store's own subscription sees the
  // change and must not send it straight back out as the athlete's.
  let applying = false

  const currentWork = () => useUI?.getState?.()?.work || null
  const posNow = active => videoSyncPos(active, currentWork())

  const resolveServer = () => {
    const custom = readVideoSyncServer()
    if (custom) return custom.replace(/\/+$/, '')
    return ''
  }

  const customRequest = async (path, opts = {}) => {
    const base = resolveServer()
    if (!base) return request(path, opts)
    const url = base + path
    const res = await nativeFetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }

  const doRequest = (path, opts) => (resolveServer() ? customRequest(path, opts) : request(path, opts))

  const send = (action, source, id = sessionId, url = videoUrl, extra = {}) => {
    if (!id) return Promise.resolve(null)
    return Promise.resolve(doRequest('/api/video-sync/command', {
      method: 'POST',
      body: JSON.stringify({
        action,
        source,
        sessionId: id,
        ...(url ? { videoUrl: url } : {}),
        ...extra
      })
    })).catch(() => null)
  }

  const setOnline = v => {
    if (online === v) return
    online = v
    try { useUI.getState().setVideoSync({ online: v }) } catch { /* a test without the UI store */ }
  }

  // The same two things a tap on Pause/Resume does: freeze the session and the rest countdown
  // together. A rest that is already over (ready) has nothing to hold.
  const pauseHere = by => {
    if (!useStore.getState().pauseWorkout(by)) return false
    const ui = useUI.getState()
    if (ui.timer && !ui.timer.paused && !ui.timer.ready) ui.pauseRest()
    ui.pauseWork()
    return true
  }
  const resumeHere = by => {
    if (!useStore.getState().resumeWorkout(by)) return false
    const ui = useUI.getState()
    if (ui.timer?.paused) ui.resumeRest()
    ui.resumeWork()
    return true
  }

  const apply = st => {
    if (!st || typeof st !== 'object') return
    setOnline(!!st.online)
    // A restarted server or relay begins again at seq 1. Its epoch is different even when the
    // old number was much higher, so reset before deciding the snapshot is stale.
    const epoch = typeof st.epoch === 'string' && st.epoch ? st.epoch : null
    if (epoch && epoch !== lastEpoch) {
      lastEpoch = epoch
      lastSeq = 0
    }
    const seq = Number(st.seq) || 0
    if (seq <= lastSeq) return
    lastSeq = seq
    // Our own commands come back through the same state; only the computer's are acted on.
    if (st.source !== 'video') return
    const A = useStore.getState().S.active
    if (!A || A.id !== st.sessionId) return
    applying = true
    try {
      if (st.action === 'pause') pauseHere('video')
      // The store refuses this unless the video made the pause: a pause the athlete chose is
      // theirs to end, and a tab that started playing on its own must not end it.
      else if (st.action === 'resume') resumeHere('video')
    } finally { applying = false }
  }

  const checkDrift = force => {
    const A = useStore.getState().S.active
    if (!sessionId || !videoUrl || !A || A.id !== sessionId || isPaused(A)) return
    const now = Date.now()
    if (!force && now - lastDriftCheckAt < VIDEO_SYNC_DRIFT_CHECK_MS) return
    lastDriftCheckAt = now
    const pos = posNow(A)
    const offset = useUI.getState()?.videoSync?.offset || 0
    // force:false lets content.js keep the 5 s tolerance; it only snaps beyond that.
    send('seek', 'app', sessionId, videoUrl, { pos, offset, force: false })
  }

  const startAtCurrentPosition = (id, url, play = null) => {
    const A = useStore.getState().S.active
    if (!A || A.id !== id) return Promise.resolve(null)
    const pos = posNow(A)
    const offset = useUI.getState()?.videoSync?.offset || 0
    // Only a start with a real intent carries `play`: true autoplays a fresh workout, false holds
    // an explicit paused start, and omitted means attach/reload and leave playback alone.
    const intent = typeof play === 'boolean' ? { play } : {}
    // Retarget first, then compare clocks. Promise ordering keeps the seek from arriving
    // before the start that tells the extension which tab to inspect.
    return send('start', 'app', id, url, { pos, offset, ...intent }).then(() => {
      if (sessionId === id && videoUrl === url) checkDrift(true)
    })
  }

  const endNow = (id, url = videoUrl) => {
    if (!id || endedSession === id) return Promise.resolve(null)
    endedSession = id
    return send('end', 'app', id, url)
  }

  const schedule = (ms = poll) => {
    clearTimeout(timer)
    timer = null
    if (stopped || !sessionId) return
    timer = setTimeout(tick, Math.max(0, ms))
  }

  async function tick () {
    timer = null
    if (stopped) return
    if (!sessionId) return
    try { apply(await doRequest('/api/video-sync/state')) } catch { /* offline: the next poll asks again */ }
    checkDrift(false)
    schedule()
  }

  const onChange = (s, prev) => {
    const A = s?.S?.active
    const next = videoSyncSessionId(A)
    if (next !== sessionId) {
      const ended = sessionId
      sessionId = next
      videoUrl = videoSyncUrl(A)
      curIdx = A?.cur ?? null
      // A new session starts its own numbering: nothing said about the one before can apply.
      lastSeq = 0
      lastDriftCheckAt = 0
      if (next) {
        endedSession = null
        // A fresh workout starts the named video. A reload of an already-running one does not
        // touch playback: the initial call below and chapter retargets pass no play intent.
        startAtCurrentPosition(next, videoUrl, !isPaused(A))
        schedule(0)
      } else {
        if (ended) endNow(ended, null)
        clearTimeout(timer)
        timer = null
        setOnline(false)
      }
      return
    }
    if (!next) return

    const chapterChanged = A.cur !== curIdx
    const url = videoSyncUrl(A)
    if (url !== videoUrl) {
      // The chapter moved to another video: point the extension at it, then snap the new tab to
      // the chapter's first frame. The start must land first, or the seek goes to the old tab.
      videoUrl = url
      const pos = posNow(A)
      const offset = useUI.getState()?.videoSync?.offset || 0
      send('start', 'app', next, url, { pos, offset })
        .then(() => send('seek', 'app', next, url, { pos, offset, force: true }))
    } else if (chapterChanged) {
      // Same video, next chapter: send seek with force: true to snap to its beginning.
      const pos = posNow(A)
      const offset = useUI.getState()?.videoSync?.offset || 0
      send('seek', 'app', next, videoUrl, { pos, offset, force: true })
    }
    if (chapterChanged) curIdx = A.cur
    const wasPaused = isPaused(prev?.S?.active)
    const nowPaused = isPaused(A)
    const pos = posNow(A)
    const offset = useUI.getState()?.videoSync?.offset || 0
    // Any pause that did not come from the video itself is the athlete's (phone, watch or another
    // local control) and stops the video too. A video pause is not sent back out as ours.
    if (!wasPaused && nowPaused && !applying && A.pausedBy !== 'video') {
      send('pause', 'app', next, videoUrl, { pos, offset })
    } else if (wasPaused && !nowPaused && !applying) {
      send('resume', 'app', next, videoUrl, { pos, offset, force: true })
      lastDriftCheckAt = Date.now()
    }
  }

  const off = useStore.subscribe(onChange)
  // Coming back to the app is the moment a pause made on the computer is likely waiting.
  const onVisible = () => { if (!stopped && sessionId && document.visibilityState === 'visible') tick() }
  try { document.addEventListener('visibilitychange', onVisible) } catch { /* no document in a test */ }

  // A workout may already be running (the app reloaded mid-session): link to it now, and read
  // what the computer last said.
  const A = useStore.getState().S.active
  sessionId = videoSyncSessionId(A)
  videoUrl = videoSyncUrl(A)
  curIdx = A?.cur ?? null
  if (sessionId) {
    startAtCurrentPosition(sessionId, videoUrl)
    tick()
  }

  // Expose nudge helper on useUI
  try {
    useUI.getState().setVideoSync({
      server: resolveServer(),
      end: () => endNow(sessionId),
      nudge: delta => {
        const ui = useUI.getState()
        const currentOffset = ui.videoSync?.offset || 0
        const nextOffset = delta === 0 ? 0 : Math.max(-3600, Math.min(3600, currentOffset + delta))
        ui.setVideoSync({ offset: nextOffset })
        const curA = useStore.getState().S.active
        if (sessionId && curA) {
          const pos = posNow(curA)
          send('seek', 'app', sessionId, videoUrl, { pos, offset: nextOffset, force: true })
        }
      }
    })
  } catch { /* test context */ }

  return () => {
    stopped = true
    clearTimeout(timer)
    timer = null
    off?.()
    try { document.removeEventListener('visibilitychange', onVisible) } catch { /* see above */ }
  }
}

// Discovery for openGym Video Sync local relay over Wi-Fi (mDNS Bonjour: _opengym._tcp).
// On iOS, talks to VideoSyncDiscoveryPlugin. Returns http://<ip>:<port> or null.
let _discoveryPluginPromise = null
function getVideoSyncDiscoveryPlugin() {
  if (!_discoveryPluginPromise) {
    _discoveryPluginPromise = import('@capacitor/core')
      .then(c => ({ VideoSyncDiscovery: c.registerPlugin('VideoSyncDiscovery') }))
      .catch(() => null)
  }
  return _discoveryPluginPromise
}

export function _resetVideoSyncDiscoveryForTests() {
  _discoveryPluginPromise = null
}

export async function discoverVideoSyncRelay({ timeout = 4000 } = {}) {
  if (!MOBILE) return null
  const platform = await nativePlatform().catch(() => null)
  if (platform !== 'ios') return null
  try {
    const loaded = await getVideoSyncDiscoveryPlugin()
    const plugin = loaded?.VideoSyncDiscovery
    if (!plugin?.discover) return null
    const res = await plugin.discover({ timeout })
    if (res?.found && res.host && res.port) {
      const port = Number(res.port)
      if (Number.isFinite(port) && port > 0 && port <= 65535) {
        const host = String(res.host).trim()
        return 'http://' + host + ':' + port
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Probes a candidate relay server's /health endpoint.
 * Works on web and native iOS/Android through nativeFetch.
 */

/**
 * Resolves a 4-digit pairing code by querying either the local candidate or cloud relay.
 * Returns the resolved server URL (e.g. http://192.168.1.50:8787) or null.
 */
export async function verifyPairingCode(code, { candidateUrl = null, timeout = 3000 } = {}) {
  const norm = String(code || "").trim().toUpperCase().replace(/[^2-9A-Z]/g, "")
  if (!norm || norm.length !== 4) return null

  // 1. If candidateUrl provided (e.g. localhost or previously known LAN IP)
  const candidates = candidateUrl ? [candidateUrl] : ["http://127.0.0.1:8787", "http://localhost:8787"]
  for (const base of candidates) {
    try {
      const url = base.replace(/\/+$/, "") + "/pair/verify?code=" + encodeURIComponent(norm)
      const res = await nativeFetch(url, {
        method: "GET",
        signal: AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined
      })
      if (res.ok) {
        const data = await res.json().catch(() => null)
        if (data?.ok && (data.url || (data.ips?.[0] && data.port))) {
          if (data.ips?.[0] && data.port) {
            return "http://" + data.ips[0] + ":" + data.port
          }
          return data.url
        }
      }
    } catch {}
  }
  return null
}

export async function probeVideoSyncServer(serverUrl, { timeout = 3000 } = {}) {
  const base = String(serverUrl || '').trim().replace(/\/+$/, '')
  if (!base) return null
  try {
    const res = await nativeFetch(base + '/health', {
      method: 'GET',
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined,
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return data && data.ok ? data : null
  } catch {
    return null
  }
}
