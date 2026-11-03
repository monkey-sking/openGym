// Settings → Video sync: diagnose and recover the three independent connections.
// A red status is not enough: this page keeps checking the relay, then says whether the Chrome
// extension or the phone workout is the missing part.
import { useState, useEffect } from 'react'
import { t } from '../lib/i18n.js'
import { Section, Row, Button, TextField } from '../components/ui.jsx'
import {
  readVideoSyncServer,
  writeVideoSyncServer,
  probeVideoSyncServer,
} from '../lib/video-sync.js'
import { MOBILE, nativePlatform, shareRemoteFile } from '../lib/mobile.js'
import { useUI } from '../store/useUI.js'

export const VIDEO_SYNC_HEALTH_POLL_MS = 3000
export const VIDEO_SYNC_DISCOVERY_RETRY_MS = 12000
export const VIDEO_SYNC_HEALTH_TIMEOUT_MS = 2500

const DISCOVERY_TIMEOUT_MS = 4000
export const DEFAULT_MAC_HELPER_URL = '/downloads/openGym-Video-Sync.zip'
const MAC_HELPER_FILENAME = 'openGym Video Sync.zip'

export function macHelperUrl(raw = import.meta.env?.VITE_VIDEO_SYNC_MAC_HELPER_URL) {
  const configured = typeof raw === 'string' ? raw.trim() : ''
  const candidate = configured || DEFAULT_MAC_HELPER_URL
  if (candidate.startsWith('/') && !candidate.startsWith('//') && !candidate.includes('\\')) {
    return candidate
  }
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : ''
  } catch {
    return ''
  }
}

export const VIDEO_SYNC_MAC_HELPER_URL = macHelperUrl()

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
      return t('A relay was found, but this iPhone could not resolve its Wi-Fi address. On the Mac, open openGym Video Sync and check that its menu-bar status says it is running, then try again.')
    case 'timeout':
      return t('The relay search timed out. Tap Set up Mac helper above, open it once, and use the same Wi-Fi.')
    case 'not-found':
      return t('No relay was found. Tap Set up Mac helper above, open it once, and keep both devices on the same Wi-Fi.')
    case 'unsupported':
      return t('Automatic discovery is only available in the iPhone app. Enter the computer relay address below.')
    case 'canceled':
      return t('The earlier relay search was replaced. Searching again will not change your saved address.')
    default:
      return t('No relay was found. Tap Set up Mac helper above, open it once, and keep both devices on the same Wi-Fi.')
  }
}

export function relayPhaseLabel(phase) {
  switch (phase) {
    case 'connected':
      return t('Phone workout and Chrome extension connected')
    case 'phone-missing':
      return t('Chrome extension connected; waiting for a phone workout')
    case 'extension-missing':
      return t('Relay running; Chrome extension not connected')
    case 'permission-denied':
      return t('Local Network permission required')
    case 'searching':
      return t('Searching for the relay on this Wi-Fi…')
    case 'checking':
      return t('Checking…')
    case 'unconfigured':
      return t('Not configured')
    case 'relay-unreachable':
    default:
      return t('Relay not running or unreachable')
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
    return t('All three parts are connected. This status refreshes automatically every 3 seconds.')
  }
  if (phase === 'phone-missing') {
    return t('Chrome is connected. Start or resume a workout on this phone; the page will advance automatically.')
  }
  if (phase === 'extension-missing') {
    return t('The relay is running. Open the openGym Chrome extension and allow access to the relay address.')
  }
  if (phase === 'permission-denied') return discoveryFailureMessage(failureReason || 'permission-denied')
  if (phase === 'searching') return t('Looking for the computer relay with Bonjour. No address needs to be typed.')
  if (phase === 'checking') return t('Checking the saved relay address and its two clients.')
  if (phase === 'unconfigured') return t('Enter the computer relay address below, or search on this Wi-Fi network.')
  if (failureReason) return discoveryFailureMessage(failureReason)
  if (discoveredServer && savedServer && discoveredServer !== savedServer) {
    return t('Using the relay found on this Wi-Fi for now. Tap Search to save its new address.')
  }
  return t('Tap Set up Mac helper above, open it once, then keep both devices on the same Wi-Fi.')
}

export default function VideoSyncSettingsPage({ macHelperUrl: configuredHelperUrl = VIDEO_SYNC_MAC_HELPER_URL }) {
  const initialServer = readVideoSyncServer()
  const [server, setServer] = useState(initialServer)
  const [savedServer, setSavedServer] = useState(initialServer)
  const [effectiveServer, setEffectiveServer] = useState(initialServer)
  const [phase, setPhase] = useState(initialServer ? 'checking' : (MOBILE ? 'searching' : 'unconfigured'))
  const [healthInfo, setHealthInfo] = useState(null)
  const [failureReason, setFailureReason] = useState('')
  const [discoveredServer, setDiscoveredServer] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchMsg, setSearchMsg] = useState('')
  const [helperBusy, setHelperBusy] = useState(false)
  const [helperMsg, setHelperMsg] = useState('')
  const offset = useUI(s => s.videoSync?.offset || 0)
  const nudge = useUI(s => s.videoSync?.nudge)

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
      if (nextPhase === 'connected') setSearchMsg('')
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
        if (!MOBILE) {
          setHealthInfo(null)
          setPhase('unconfigured')
          return
        }
        setSearching(true)
        setPhase('searching')
        const found = await discoverRelayOnce()
        if (canceled) return
        setSearching(false)
        if (!found.url) {
          showUnavailable(found.reason)
          setSearchMsg(discoveryFailureMessage(found.reason))
          schedule(VIDEO_SYNC_DISCOVERY_RETRY_MS)
          return
        }
        // There was no user-entered address to preserve, so automatic discovery may persist it.
        writeVideoSyncServer(found.url)
        setServer(found.url)
        setSavedServer(found.url)
        setEffectiveServer(found.url)
        setSearchMsg(t('Relay found. Checking its Chrome extension and this phone workout.'))
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
            if (savedServer && found.url !== savedServer) {
              setSearchMsg(t('Relay found at a new Wi-Fi address. Using it for this session; tap Search to save it.'))
            }
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

  const runDiscovery = async () => {
    setSearching(true)
    setSearchMsg(t('Searching…'))
    const found = await discoverRelayOnce()
    setSearching(false)
    if (!found.url) {
      const message = discoveryFailureMessage(found.reason)
      setSearchMsg(message)
      if (!healthInfo) {
        setFailureReason(found.reason)
        setPhase(found.reason === 'permission-denied' ? 'permission-denied' : 'relay-unreachable')
      }
      return
    }
    writeVideoSyncServer(found.url)
    setServer(found.url)
    setSavedServer(found.url)
    setEffectiveServer(found.url)
    setDiscoveredServer('')
    setSearchMsg(t('Relay found. Checking its Chrome extension and this phone workout.'))
  }

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

  const save = () => {
    const trimmed = (server || '').trim()
    writeVideoSyncServer(trimmed)
    setServer(trimmed)
    setSavedServer(trimmed)
    setEffectiveServer(trimmed)
    setDiscoveredServer('')
    setFailureReason('')
    setHealthInfo(null)
    setPhase(trimmed ? 'checking' : (MOBILE ? 'searching' : 'unconfigured'))
  }

  const clear = () => {
    writeVideoSyncServer('')
    setServer('')
    setSavedServer('')
    setEffectiveServer('')
    setDiscoveredServer('')
    setHealthInfo(null)
    setFailureReason('')
    setSearchMsg('')
    setPhase(MOBILE ? 'searching' : 'unconfigured')
  }

  const statusLabel = relayPhaseLabel(phase)
  const statusDetail = phaseDetail(phase, failureReason, discoveredServer, savedServer)
  const statusTone = phase === 'connected'
    ? 'var(--green, #1f9d55)'
    : phase === 'checking' || phase === 'searching'
      ? 'var(--orange, #b7791f)'
      : 'var(--red, #c0392b)'
  const helperUrl = macHelperUrl(configuredHelperUrl)

  const openMacHelper = async () => {
    if (!helperUrl || helperBusy) return
    if (!MOBILE) {
      window.open(helperUrl, '_blank', 'noopener,noreferrer')
      return
    }

    setHelperBusy(true)
    setHelperMsg(t('Preparing the Mac helper…'))
    try {
      await shareRemoteFile(helperUrl, MAC_HELPER_FILENAME)
      setHelperMsg(t('Choose AirDrop to your Mac or Save to Files, then open it once on the Mac.'))
    } catch {
      const opened = window.open(helperUrl, '_blank', 'noopener,noreferrer')
      setHelperMsg(opened
        ? t('The share sheet did not open. Use the new page to save the helper, then open it once on the Mac.')
        : t('The helper could not be shared. Keep Wi-Fi on and try again, or open this page in Safari.'))
    } finally {
      setHelperBusy(false)
    }
  }

  return (
    <>
      <Section
        title={t('Mac helper')}
        footer={t('Video sync stays on your local Wi-Fi. No account, Terminal, Node.js, or administrator password is needed.')}
      >
        <div style={{ padding: '12px 16px' }}>
          {helperUrl ? (
            <Button
              variant="primary"
              className="grow"
              onClick={openMacHelper}
              disabled={helperBusy}
            >
              {helperBusy ? t('Preparing…') : t('Set up Mac helper')}
            </Button>
          ) : null}
          <div className="small muted" style={{ marginTop: helperUrl ? 10 : 0, lineHeight: 1.5 }}>
            {helperUrl
              ? MOBILE
                ? t('Tap once. Share it to your Mac or save it to Files, then open it once on the Mac. It stays in the menu bar afterward.')
                : t('Click once to download it, then open it once on the Mac. It installs for this user, stays in the menu bar, and starts automatically when you sign in. macOS may ask once to confirm opening the downloaded app.')
              : t('The Mac helper is temporarily unavailable. Please try again later.')}
          </div>
          {helperMsg ? (
            <div className="small muted" role="status" aria-live="polite" style={{ marginTop: 8, lineHeight: 1.5 }}>
              {helperMsg}
            </div>
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
          title={t('Computer relay address')}
          subtitle={statusLabel}
        >
          {searching ? (
            <span className="small muted">{t('Searching…')}</span>
          ) : (
            <Button size="small" onClick={runDiscovery}>
              {t('Search')}
            </Button>
          )}
        </Row>
        <Row
          title={t('Connection detail')}
          subtitle={statusDetail}
        />
        <Row
          title={t('Address in use')}
          subtitle={effectiveServer || t('Automatic discovery')}
        />
      </Section>

      <Section title={t('Relay configuration')}>
        <div style={{ padding: '12px 16px' }}>
          <TextField
            type="text"
            value={server}
            onChange={e => setServer(e.target.value)}
            placeholder="http://192.168.31.124:8787"
            style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box' }}
          />
          {searchMsg && !searching ? (
            <div className="small muted" style={{ marginBottom: 10 }}>{searchMsg}</div>
          ) : null}
          <div className="row" style={{ gap: 8 }}>
            <Button className="grow" onClick={save}>
              {t('Save')}
            </Button>
            <Button className="grow" onClick={() => testServer(server)}>
              {t('Test')}
            </Button>
            {savedServer || server ? (
              <Button onClick={clear}>
                {t('Clear')}
              </Button>
            ) : null}
          </div>
        </div>
      </Section>

      {phase !== 'connected' ? (
        <Section
          title={t('Automatic recovery')}
          footer={t('The app keeps retrying the relay and refreshes all three connection states every 3 seconds. A restored stream reconnects with a bounded backoff.')}
        >
          <div className="small muted" style={{ padding: '12px 16px', lineHeight: 1.5 }}>
            <div>{t('Chrome extension lost its stream: it reconnects automatically.')}</div>
            <div>{t('Relay, extension, or phone appears: this page advances automatically.')}</div>
            <div>{t('If a connection stays missing, use the Mac helper button above and allow Chrome or iPhone Local Network access once.')}</div>
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
    </>
  )
}
