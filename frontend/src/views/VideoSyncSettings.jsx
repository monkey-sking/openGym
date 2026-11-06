// Settings → Video sync: pair once, then diagnose the phone, Chrome and workout link.
// Pairing belongs here rather than in the middle of a workout. The video each routine plays is
// also chosen here, before a workout starts, so a session never has to guess its video (handover
// items 3 and 4).
import { useState, useEffect } from 'react'
import { t } from '../lib/i18n.js'
import { Section, Row, Button, TextField } from '../components/ui.jsx'
import {
  readVideoSyncServer,
  writeVideoSyncServer,
  probeVideoSyncServer,
  verifyPairingCode,
  extractVideoUrl,
  parseVideoStartSec,
} from '../lib/video-sync.js'
import { linkKind } from '../lib/media-refs.js'
import { defaultExerciseVideoUrl, EXIDX } from '../lib/exercises.js'
import { useStore } from '../store/useStore.js'
import { MOBILE, nativePlatform } from '../lib/mobile.js'
import { useUI } from '../store/useUI.js'

export const VIDEO_SYNC_HEALTH_POLL_MS = 3000
export const VIDEO_SYNC_DISCOVERY_RETRY_MS = 12000
export const VIDEO_SYNC_HEALTH_TIMEOUT_MS = 2500

const DISCOVERY_TIMEOUT_MS = 4000

export function relayPhase(health) {
  if (!health?.ok) return 'relay-unreachable'
  if (!health.extensionConnected) return 'extension-missing'
  if (!health.phoneConnected) return 'phone-missing'
  return 'connected'
}

export function discoveryFailureMessage(reason) {
  switch (reason) {
    case 'permission-denied':
      return t('Local Network access is off. Allow openGym in iPhone Settings > Privacy & Security > Local Network, then return here.')
    case 'search-failed':
      return t('This iPhone could not search the local network. Turn on Wi-Fi and Local Network access, then try again.')
    case 'resolution-failed':
      return t('Your computer was found, but this iPhone could not resolve its Wi-Fi address. Keep both devices on the same Wi-Fi and try again.')
    case 'timeout':
      return t('No computer answered. Open the openGym Chrome extension on your computer and keep both devices on the same Wi-Fi.')
    case 'not-found':
      return t('No computer was found. Open the openGym Chrome extension on your computer and keep both devices on the same Wi-Fi.')
    case 'unsupported':
      return t('Pairing is only available in the openGym iPhone app.')
    case 'canceled':
      return t('The earlier search was replaced. Try again.')
    default:
      return t('No computer was found. Open the openGym Chrome extension on your computer and keep both devices on the same Wi-Fi.')
  }
}

export function relayPhaseLabel(phase) {
  switch (phase) {
    case 'connected':
      return t('Phone and Chrome extension connected')
    case 'phone-missing':
      return t('Chrome extension connected; start a workout on your phone')
    case 'extension-missing':
      return t('Computer available; open the openGym Chrome extension')
    case 'permission-denied':
      return t('Local Network permission required')
    case 'searching':
      return t('Looking for your computer on this Wi-Fi…')
    case 'checking':
      return t('Checking…')
    case 'unconfigured':
      return t('Not paired')
    case 'relay-unreachable':
    default:
      return t('Computer not reachable')
  }
}

export function discoveryUrl(result) {
  if (!result?.found) return ''
  const rawHost = String(result.host || '').trim()
  const port = Number(result.port)
  if (!rawHost || !Number.isFinite(port) || port <= 0 || port > 65535) return ''
  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost
  return `http://${host}:${port}`
}

// The video a routine's exercise plays, resolved the same way a running session resolves it
// (lib/video-sync.js videoSyncUrl): the exercise config's own link, a link written in its note,
// the default tutorial for that exercise, or else empty. A settings-time view of it, before a
// workout exists.
export function exerciseVideoLink(ex = {}) {
  return extractVideoUrl(ex.videoUrl) ||
    extractVideoUrl(ex.note) ||
    defaultExerciseVideoUrl(ex.id) ||
    ''
}

// What the field's text means, for the small hint under it. '' means "no video", null means the
// text is not a usable video link (so the caller should not save it as one).
export function describeVideoInput(text) {
  const s = String(text || '').trim()
  if (!s) return { ok: true, empty: true, startSec: null, label: t('No video') }
  const url = extractVideoUrl(s)
  if (!url) return { ok: false, empty: false, startSec: null, label: t('Not a video link') }
  const startSec = parseVideoStartSec(url)
  return {
    ok: true,
    empty: false,
    url,
    startSec,
    label: startSec != null ? t('Starts at {0}', clockOf(startSec)) : (linkKind(url) === 'video' ? t('Video link') : t('Link')),
  }
}

const clockOf = sec => {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(s / 60)
  return m + ':' + String(s % 60).padStart(2, '0')
}

const exNameOf = id => (EXIDX[id] && EXIDX[id].n) || id

// One text field that saves on blur. `onSave` receives the parsed video URL ('' clears it).
// When empty and `fallback` names a video that will play anyway (a routine default or the
// exercise's own tutorial), no "No video" hint is shown, since leaving it blank is fine.
function VideoField({ initial, placeholder, fallback, onSave }) {
  const [text, setText] = useState(initial || '')
  const info = describeVideoInput(text)
  const save = () => {
    const videoUrl = info.ok && !info.empty ? info.url : ''
    onSave(videoUrl)
  }
  const hint = info.empty ? (fallback ? '' : info.label) : info.label
  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <TextField
          type="url"
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={save}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect="off"
          style={{ flex: 1, minWidth: 0, boxSizing: 'border-box' }}
        />
      </div>
      {hint ? <div className="small muted" style={{ marginTop: 4, lineHeight: 1.4, wordBreak: 'break-all' }}>{hint}</div> : null}
    </div>
  )
}

// One routine: a default video for the whole plan, plus (on expand) a row per exercise so a plan
// with several exercises can give each its own link. An exercise row is empty by default and
// inherits the routine default when left blank. This sets the plan/exercise/video mapping BEFORE
// a workout starts (handover item 3), for hand-made plans too.
function RoutineVideos({ routine, setRoutineDefault, setExerciseVideo }) {
  const [open, setOpen] = useState(false)
  const ex = routine.ex || []
  const count = ex.length
  return (
    <div style={{ padding: '12px 16px', borderTop: '1px solid var(--sep, #2c2c2e)' }}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <span className="small" style={{ fontWeight: 600 }}>{routine.name || t('Routine')}</span>
        <span className="small muted">{t('{0} exercises', count)}</span>
      </div>
      <VideoField
        key={routine.id + ':' + (routine.ex?.[0]?.videoUrl || '')}
        initial={routine.ex?.[0]?.videoUrl || ''}
        placeholder={t('Default video for this plan (optional)')}
        onSave={url => setRoutineDefault(routine.id, url)}
      />
      {count > 0 && (
        <button
          className="small muted"
          onClick={() => setOpen(o => !o)}
          style={{ marginTop: 8, background: 'none', border: 0, padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {open ? t('Hide each exercise') : t('Set a video for each exercise')}
        </button>
      )}
      {open && ex.map((e, i) => {
        const fallback = exerciseVideoLink(e)
        return (
          <div key={routine.id + ':' + i + ':' + e.id} style={{ marginTop: 10, paddingLeft: 10, borderLeft: '2px solid var(--sep, #2c2c2e)' }}>
            <div className="small" style={{ marginBottom: 4 }}>{exNameOf(e.id)}</div>
            <VideoField
              initial={e.videoUrl || ''}
              placeholder={fallback || t('Video for this exercise (optional)')}
              fallback={fallback}
              onSave={url => setExerciseVideo(routine.id, i, url)}
            />
          </div>
        )
      })}
    </div>
  )
}

function PreWorkoutVideos() {
  const routines = useStore(s => s.routines) || []
  const update = useStore(s => s.update)
  // Routine default: fills every exercise that has no link of its own yet. Clearing it removes
  // the routine-wide link (an exercise that set its own keeps it).
  const setRoutineDefault = (routineId, videoUrl) => {
    update(S => {
      const r = (S.routines || []).find(x => x.id === routineId)
      if (!r) return
      for (const ex of r.ex || []) {
        if (videoUrl) ex.videoUrl = videoUrl
        else delete ex.videoUrl
      }
    })
  }
  // One exercise's own link overrides the routine default for that exercise.
  const setExerciseVideo = (routineId, index, videoUrl) => {
    update(S => {
      const r = (S.routines || []).find(x => x.id === routineId)
      const ex = r?.ex?.[index]
      if (!ex) return
      if (videoUrl) ex.videoUrl = videoUrl
      else delete ex.videoUrl
    })
  }
  if (!routines.length) return null
  return (
    <Section
      title={t('Videos for your plans')}
      footer={t('Set the video each plan plays before you train. Give a whole plan one video, or open it and give each exercise its own. If an exercise has none, the workout falls back to the exercise\'s own link, a link in its note, or a default tutorial.')}
    >
      {routines.map(r => (
        <RoutineVideos
          key={r.id}
          routine={r}
          setRoutineDefault={setRoutineDefault}
          setExerciseVideo={setExerciseVideo}
        />
      ))}
    </Section>
  )
}


async function discoverRelayOnce(timeout = DISCOVERY_TIMEOUT_MS) {
  if (!MOBILE) return { found: false, reason: 'unsupported' }
  const platform = await nativePlatform().catch(() => null)
  if (platform !== 'ios') return { found: false, reason: 'unsupported' }
  try {
    const { registerPlugin } = await import('@capacitor/core')
    const plugin = registerPlugin('VideoSyncDiscovery')
    if (!plugin?.discover) return { found: false, reason: 'search-failed' }
    const result = await plugin.discover({ timeout })
    const url = discoveryUrl(result)
    if (url) return { ...result, found: true, url }
    return {
      found: false,
      reason: result?.reason || (result?.found ? 'resolution-failed' : 'not-found'),
      message: result?.message || '',
    }
  } catch {
    return { found: false, reason: 'search-failed' }
  }
}

function phaseDetail(phase, failureReason, discoveredServer, savedServer) {
  if (phase === 'connected') {
    return t('Your phone, Chrome and workout are connected. This status refreshes automatically.')
  }
  if (phase === 'phone-missing') {
    return t('Chrome is connected. Start or resume a workout on this phone; the page will advance automatically.')
  }
  if (phase === 'extension-missing') {
    return t('Your computer is available. Open the openGym Chrome extension and keep it enabled.')
  }
  if (phase === 'permission-denied') return discoveryFailureMessage(failureReason || 'permission-denied')
  if (phase === 'searching') return t('Looking for your computer on this Wi-Fi. No address is needed.')
  if (phase === 'checking') return t('Checking the saved computer connection.')
  if (phase === 'unconfigured') return t('Pair with the 4-character code shown in the openGym Chrome extension.')
  if (failureReason) return discoveryFailureMessage(failureReason)
  if (discoveredServer && savedServer && discoveredServer !== savedServer) {
    return t('Using the computer found on this Wi-Fi for this workout.')
  }
  return t('Open the openGym Chrome extension and keep both devices on the same Wi-Fi.')
}

export default function VideoSyncSettingsPage() {
  const initialServer = readVideoSyncServer()
  const [server, setServer] = useState(initialServer)
  const [savedServer, setSavedServer] = useState(initialServer)
  const [effectiveServer, setEffectiveServer] = useState(initialServer)
  const [phase, setPhase] = useState(initialServer ? 'checking' : (MOBILE ? 'searching' : 'unconfigured'))
  const [healthInfo, setHealthInfo] = useState(null)
  const [failureReason, setFailureReason] = useState('')
  const [discoveredServer, setDiscoveredServer] = useState('')
  const offset = useUI(s => s.videoSync?.offset || 0)
  const nudge = useUI(s => s.videoSync?.nudge)
  const [pairCode, setPairCode] = useState('')
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pairMsg, setPairMsg] = useState('')

  const handlePairCode = async () => {
    const code = (pairCode || '').trim().toUpperCase()
    if (!code || code.length !== 4) {
      setPairMsg(t('Please enter a 4-character pairing code.'))
      return
    }
    setPairingBusy(true)
    setPairMsg(t('Verifying pairing code…'))
    try {
      let resolved = null
      const knownServer = server || effectiveServer
      if (knownServer) {
        resolved = await verifyPairingCode(code, { candidateUrl: knownServer })
      }
      if (!resolved) {
        const found = await discoverRelayOnce()
        if (found.url) {
          resolved = await verifyPairingCode(code, { candidateUrl: found.url })
        } else if (!knownServer) {
          setPairMsg(discoveryFailureMessage(found.reason))
          return
        }
      }
      if (!resolved && MOBILE) {
        resolved = await verifyPairingCode(code)
      }
      if (resolved) {
        writeVideoSyncServer(resolved)
        setServer(resolved)
        setSavedServer(resolved)
        setEffectiveServer(resolved)
        setDiscoveredServer('')
        setPairMsg(t('Paired successfully.'))
        testServer(resolved)
      } else {
        setPairMsg(t('Pairing code not found or expired. Check the openGym Chrome extension.'))
      }
    } catch {
      setPairMsg(t('Pairing failed. Keep your phone and computer on the same Wi-Fi and try again.'))
    } finally {
      setPairingBusy(false)
    }
  }


  useEffect(() => {
    let canceled = false
    let timer = null
    let active = savedServer
    let lastDiscoveryAt = 0
    let lastFailureReason = ''
    let firstProbe = true

    const schedule = ms => {
      if (canceled) return
      timer = setTimeout(run, ms)
    }

    const showHealth = health => {
      const nextPhase = relayPhase(health)
      lastFailureReason = ''
      setHealthInfo(health)
      setEffectiveServer(active)
      setFailureReason('')
      setPhase(nextPhase)
    }

    const showUnavailable = reason => {
      lastFailureReason = reason || lastFailureReason
      setHealthInfo(null)
      setFailureReason(lastFailureReason)
      setPhase(lastFailureReason === 'permission-denied' ? 'permission-denied' : 'relay-unreachable')
    }

    const probe = async target => {
      if (firstProbe && !healthInfo) setPhase('checking')
      firstProbe = false
      return probeVideoSyncServer(target, { timeout: VIDEO_SYNC_HEALTH_TIMEOUT_MS })
    }

    const run = async () => {
      if (canceled) return

      if (!active) {
        setHealthInfo(null)
        setFailureReason('')
        setPhase('unconfigured')
        return
      }

      const health = await probe(active)
      if (canceled) return
      if (health?.ok) {
        showHealth(health)
        schedule(VIDEO_SYNC_HEALTH_POLL_MS)
        return
      }

      showUnavailable(lastFailureReason)
      const canDiscover = MOBILE
      const discoveryDue = canDiscover && Date.now() - lastDiscoveryAt >= VIDEO_SYNC_DISCOVERY_RETRY_MS
      if (discoveryDue) {
        lastDiscoveryAt = Date.now()
        const found = await discoverRelayOnce()
        if (canceled) return
        if (found.url) {
          if (found.url !== active) {
            active = found.url
            setEffectiveServer(found.url)
            setDiscoveredServer(savedServer && found.url !== savedServer ? found.url : '')
          }
          const recovered = await probeVideoSyncServer(found.url, { timeout: VIDEO_SYNC_HEALTH_TIMEOUT_MS })
          if (canceled) return
          if (recovered?.ok) {
            showHealth(recovered)
            schedule(VIDEO_SYNC_HEALTH_POLL_MS)
            return
          }
          lastFailureReason = ''
        } else {
          showUnavailable(found.reason)
        }
      }
      schedule(VIDEO_SYNC_HEALTH_POLL_MS)
    }

    run().catch(() => {
      if (canceled) return
      showUnavailable('search-failed')
      schedule(VIDEO_SYNC_HEALTH_POLL_MS)
    })
    return () => {
      canceled = true
      clearTimeout(timer)
    }
  }, [savedServer])

  const testServer = async (addr) => {
    const target = (addr ?? server).trim()
    if (!target) {
      setHealthInfo(null)
      setFailureReason('')
      setPhase('unconfigured')
      return
    }
    setPhase('checking')
    const health = await probeVideoSyncServer(target, { timeout: VIDEO_SYNC_HEALTH_TIMEOUT_MS })
    setEffectiveServer(target)
    if (health?.ok) {
      setHealthInfo(health)
      setFailureReason('')
      setPhase(relayPhase(health))
    } else {
      setHealthInfo(null)
      setFailureReason('')
      setPhase('relay-unreachable')
    }
  }

  const statusLabel = relayPhaseLabel(phase)
  const statusDetail = phaseDetail(phase, failureReason, discoveredServer, savedServer)
  const statusTone = phase === 'connected'
    ? 'var(--green, #1f9d55)'
    : phase === 'checking' || phase === 'searching'
      ? 'var(--orange, #b7791f)'
      : 'var(--red, #c0392b)'

  return (
    <>
      <Section
        title={t('Pair with Chrome')}
        footer={t('Open the openGym extension in Chrome on your computer, find the 4-character code in its popup, and enter it here.')}
      >
        <div style={{ padding: '12px 16px' }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <TextField
              type="text"
              value={pairCode}
              onChange={e => setPairCode(e.target.value.toUpperCase().replace(/[^2-9A-Z]/g, '').slice(0, 4))}
              placeholder="4-CHARACTER CODE"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              style={{ flex: 1, minWidth: 0, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, boxSizing: 'border-box', background: 'var(--surface-2, #1c1c1e)' }}
            />
            <Button
              variant="primary"
              style={{ width: 'auto', flexShrink: 0, minHeight: 44, padding: '0 20px', whiteSpace: 'nowrap' }}
              onClick={handlePairCode}
              disabled={pairingBusy || pairCode.trim().length !== 4}
            >
              {pairingBusy ? t('Pairing…') : t('Pair')}
            </Button>
          </div>
          {pairMsg ? (
            <div className="small muted" role="status" aria-live="polite" style={{ marginTop: 8, lineHeight: 1.4 }}>{pairMsg}</div>
          ) : null}
        </div>
      </Section>

      <Section
        title={t('Video sync')}
        footer={t('Connect your computer Chrome browser on the same Wi-Fi network without any server account.')}
      >
        <Row
          icon="tv"
          iconTint={statusTone}
          title={t('Computer connection')}
          subtitle={statusLabel}
        />
        <Row
          title={t('What this means')}
          subtitle={statusDetail}
        />
      </Section>

      {phase !== 'connected' ? (
        <Section
          title={t('Automatic recovery')}
          footer={t('The app keeps checking the connection and reconnects automatically.')}
        >
          <div className="small muted" style={{ padding: '12px 16px', lineHeight: 1.5 }}>
            <div>{t('Keep the openGym Chrome extension enabled on your computer.')}</div>
            <div>{t('Keep both devices on the same Wi-Fi and allow Local Network access for openGym.')}</div>
          </div>
        </Section>
      ) : null}

      {typeof nudge === 'function' ? (
        <Section
          title={t('Timeline adjustment')}
          footer={t('Adjusts the video timeline when it drifts slightly ahead or behind.')}
        >
          <div style={{ padding: '12px 16px' }}>
            <div className="small muted" style={{ marginBottom: 8 }}>
              {t('Nudge video timeline')} ({offset > 0 ? '+' + offset + 's' : offset + 's'})
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="grow small" onClick={() => nudge(-5)}>-5s</button>
              <button className="grow small" onClick={() => nudge(-1)}>-1s</button>
              <button className="grow small" onClick={() => nudge(0)}>{t('Reset')}</button>
              <button className="grow small" onClick={() => nudge(1)}>+1s</button>
              <button className="grow small" onClick={() => nudge(5)}>+5s</button>
            </div>
          </div>
        </Section>
      ) : null}

      <PreWorkoutVideos />
    </>
  )
}
