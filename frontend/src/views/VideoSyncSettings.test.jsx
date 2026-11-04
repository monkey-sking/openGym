// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoSyncSettingsPage, {
  VIDEO_SYNC_HEALTH_POLL_MS,
  discoveryFailureMessage,
  discoveryUrl,
  macHelperUrl,
  relayPhase,
  relayPhaseLabel,
} from './VideoSyncSettings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  mobile: true,
  platform: 'ios',
  saved: '',
  writes: [],
  probe: vi.fn(),
  plugin: null,
  registerPlugin: vi.fn(),
  shareRemoteFile: vi.fn(),
}))

vi.mock('../lib/i18n.js', () => ({ t: value => value }))
vi.mock('../lib/video-sync.js', () => ({
  readVideoSyncServer: () => mocks.saved,
  writeVideoSyncServer: value => {
    mocks.writes.push(value)
    mocks.saved = value
  },
  probeVideoSyncServer: (...args) => mocks.probe(...args),
}))
vi.mock('../lib/mobile.js', () => ({
  get MOBILE () { return mocks.mobile },
  nativePlatform: () => Promise.resolve(mocks.platform),
  shareRemoteFile: (...args) => mocks.shareRemoteFile(...args),
}))
vi.mock('@capacitor/core', () => ({
  registerPlugin: (...args) => mocks.registerPlugin(...args),
}))
vi.mock('../store/useUI.js', () => {
  const snapshot = () => ({ videoSync: { offset: 0, nudge: vi.fn() } })
  const useUI = selector => selector ? selector(snapshot()) : snapshot()
  useUI.getState = snapshot
  return { useUI }
})

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

let host
let root

beforeEach(() => {
  mocks.mobile = true
  mocks.platform = 'ios'
  mocks.saved = ''
  mocks.writes = []
  mocks.probe = vi.fn()
  mocks.plugin = null
  mocks.registerPlugin = vi.fn(() => mocks.plugin)
  mocks.shareRemoteFile = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    await flush()
  })
  host.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const mount = async (props = {}) => {
  await act(async () => {
    root.render(<VideoSyncSettingsPage {...props} />)
    await flush()
  })
  await act(async () => { await flush() })
}

const health = ({ extension = true, phone = true } = {}) => ({
  ok: true,
  extensionConnected: extension,
  phoneConnected: phone,
})

describe('connection phases', () => {
  it('maps relay, extension and phone facts to four unambiguous phases', () => {
    expect(relayPhase(null)).toBe('relay-unreachable')
    expect(relayPhase({ ok: true, extensionConnected: false, phoneConnected: false })).toBe('extension-missing')
    expect(relayPhase({ ok: true, extensionConnected: true, phoneConnected: false })).toBe('phone-missing')
    expect(relayPhase({ ok: true, extensionConnected: true, phoneConnected: true })).toBe('connected')

    expect(relayPhaseLabel('relay-unreachable')).toBe('Relay not running or unreachable')
    expect(relayPhaseLabel('extension-missing')).toBe('Relay running; Chrome extension not connected')
    expect(relayPhaseLabel('phone-missing')).toBe('Chrome extension connected; waiting for a phone workout')
    expect(relayPhaseLabel('connected')).toBe('Phone workout and Chrome extension connected')
  })

  it('keeps discovery failures actionable instead of collapsing them into no relay', () => {
    expect(discoveryFailureMessage('permission-denied')).toContain('Local Network access is off')
    expect(discoveryFailureMessage('permission-denied')).not.toContain('No relay was found')
    expect(discoveryFailureMessage('not-found')).toContain('Set up Mac helper')
    expect(discoveryFailureMessage('not-found')).not.toContain('Turn On at Login')
    expect(discoveryFailureMessage('timeout')).toContain('Set up Mac helper')
    expect(discoveryFailureMessage('timeout')).not.toContain('Turn On at Login')
    expect(discoveryFailureMessage('resolution-failed')).toContain('could not resolve its Wi-Fi address')
    expect(discoveryFailureMessage('resolution-failed')).toContain('openGym Video Sync')
    expect(discoveryFailureMessage('search-failed')).toContain('could not search the local network')
    expect(discoveryFailureMessage('unsupported')).toContain('only available in the iPhone app')
    for (const reason of ['permission-denied', 'not-found', 'timeout', 'resolution-failed', 'search-failed']) {
      expect(discoveryFailureMessage(reason)).not.toMatch(/\.command|Terminal|Node\.js/)
    }
  })

  it('builds IPv4 and IPv6 relay URLs without malformed ports', () => {
    expect(discoveryUrl({ found: true, host: '192.168.1.8', port: 8787 })).toBe('http://192.168.1.8:8787')
    expect(discoveryUrl({ found: true, host: 'fe80::1', port: '8787' })).toBe('http://[fe80::1]:8787')
    expect(discoveryUrl({ found: true, host: '[fe80::1]', port: 8787 })).toBe('http://[fe80::1]:8787')
    expect(discoveryUrl({ found: true, host: '', port: 8787 })).toBe('')
    expect(discoveryUrl({ found: true, host: '192.168.1.8', port: 0 })).toBe('')
    expect(discoveryUrl({ found: false, host: '192.168.1.8', port: 8787 })).toBe('')
  })
})

describe('Mac helper setup', () => {
  it('uses the bundled same-origin helper by default and accepts only safe overrides', () => {
    expect(macHelperUrl(' https://opengym.example/downloads/helper.zip ')).toBe('https://opengym.example/downloads/helper.zip')
    expect(macHelperUrl('http://localhost:4173/helper.zip')).toBe('http://localhost:4173/helper.zip')
    expect(macHelperUrl('file:///Users/me/helper.zip')).toBe('')
    expect(macHelperUrl('javascript:alert(1)')).toBe('')
    expect(macHelperUrl('//opengym.example/helper.zip')).toBe('')
    expect(macHelperUrl('/downloads/helper.zip')).toBe('/downloads/helper.zip')
    expect(macHelperUrl('')).toBe('/downloads/openGym-Video-Sync.zip')
    expect(macHelperUrl()).toBe('/downloads/openGym-Video-Sync.zip')
  })

  it('offers one ordinary-user setup entry and explains what opening it does', async () => {
    mocks.mobile = false
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await mount({ macHelperUrl: 'https://opengym.example/downloads/helper.zip' })

    const setup = [...host.querySelectorAll('button')]
      .find(button => button.textContent.trim() === 'Set up Mac helper')
    expect(setup).toBeTruthy()
    expect(host.querySelectorAll('.btn.primary')).toHaveLength(1)
    expect(setup.classList.contains('primary')).toBe(true)
    expect(host.textContent).toContain('installs for this user')
    expect(host.textContent).toContain('starts automatically when you sign in')
    expect(host.textContent).toContain('may ask once to confirm')
    expect(host.textContent).not.toContain('Turn On at Login')
    expect(host.textContent).not.toContain('One-time recovery steps')

    await act(async () => setup.click())
    expect(open).toHaveBeenCalledWith(
      'https://opengym.example/downloads/helper.zip',
      '_blank',
      'noopener,noreferrer'
    )
  })

  it('shares the bundled helper on iPhone without exposing technical setup', async () => {
    mocks.mobile = true
    mocks.platform = 'ios'
    mocks.shareRemoteFile.mockResolvedValue()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await mount()

    const setup = [...host.querySelectorAll('button')]
      .find(button => button.textContent.trim() === 'Set up Mac helper')
    expect(setup).toBeTruthy()
    expect(host.textContent).toContain('Tap once')
    expect(host.textContent).toContain('open it once on the Mac')
    expect(host.textContent).not.toContain('Turn On at Login')
    expect(host.textContent).not.toContain('Developer build')
    expect(host.textContent).not.toContain('VITE_VIDEO_SYNC_MAC_HELPER_URL')

    await act(async () => {
      setup.click()
      await flush()
    })

    expect(mocks.shareRemoteFile).toHaveBeenCalledWith(
      '/downloads/openGym-Video-Sync.zip',
      'openGym Video Sync.zip'
    )
    expect(open).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Choose AirDrop to your Mac or Save to Files')
  })

  it('falls back to the direct helper page when mobile sharing fails, without showing the error', async () => {
    mocks.mobile = true
    mocks.platform = 'ios'
    mocks.shareRemoteFile.mockRejectedValue(new Error('native bridge unavailable'))
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await mount()
    const setup = [...host.querySelectorAll('button')]
      .find(button => button.textContent.trim() === 'Set up Mac helper')

    await act(async () => {
      setup.click()
      await flush()
    })

    expect(open).toHaveBeenCalledWith(
      '/downloads/openGym-Video-Sync.zip',
      '_blank',
      'noopener,noreferrer'
    )
    expect(host.textContent).toContain('The helper could not be shared')
    expect(host.textContent).not.toContain('native bridge unavailable')
  })

  it('keeps a friendly message when no helper URL can be resolved', async () => {
    mocks.mobile = false
    await mount({ macHelperUrl: 'javascript:alert(1)' })

    expect(host.textContent).toContain('The Mac helper is temporarily unavailable')
    expect(host.textContent).not.toContain('Developer build')
  })
})

describe('automatic status recovery', () => {
  it('advances relay -> extension -> phone without flashing Checking during a background probe', async () => {
    vi.useFakeTimers()
    mocks.saved = 'http://192.168.1.8:8787'
    let resolveSecond
    mocks.probe
      .mockResolvedValueOnce(health({ extension: true, phone: false }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve }))
      .mockResolvedValueOnce(health({ extension: true, phone: true }))

    await mount()
    expect(mocks.probe).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Chrome extension connected; waiting for a phone workout')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIDEO_SYNC_HEALTH_POLL_MS)
      await flush()
    })
    expect(mocks.probe).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Chrome extension connected; waiting for a phone workout')
    expect(host.textContent).not.toContain('Checking…')

    await act(async () => {
      resolveSecond(health({ extension: true, phone: true }))
      await flush()
    })
    expect(host.textContent).toContain('Phone workout and Chrome extension connected')
  })

  it('uses a newly discovered Wi-Fi address without silently replacing a saved address', async () => {
    const saved = 'http://192.168.1.8:8787'
    const discovered = 'http://192.168.1.19:8787'
    mocks.saved = saved
    mocks.probe.mockImplementation(url => Promise.resolve(
      url === saved ? null : health({ extension: true, phone: false })
    ))
    mocks.plugin = {
      discover: vi.fn().mockResolvedValue({ found: true, host: '192.168.1.19', port: 8787 }),
    }

    await mount()

    expect(mocks.probe.mock.calls.map(call => call[0])).toEqual([saved, discovered])
    expect(mocks.writes).toEqual([])
    expect(host.textContent).toContain(discovered)
    expect(host.textContent).toContain('tap Search to save it')
  })

  it('saves an automatically discovered address only when no user address exists', async () => {
    const discovered = 'http://192.168.1.19:8787'
    mocks.probe.mockResolvedValue(health({ extension: true, phone: false }))
    mocks.plugin = {
      discover: vi.fn().mockResolvedValue({ found: true, host: '192.168.1.19', port: 8787 }),
    }

    await mount()

    expect(mocks.writes).toEqual([discovered])
    expect(host.textContent).toContain(discovered)
  })

  it('shows a Local Network permission problem, not a generic offline relay', async () => {
    mocks.saved = 'http://192.168.1.8:8787'
    mocks.probe.mockResolvedValue(null)
    mocks.plugin = {
      discover: vi.fn().mockResolvedValue({
        found: false,
        reason: 'permission-denied',
        message: 'Local network denied',
      }),
    }

    await mount()

    expect(host.textContent).toContain('Local Network permission required')
    expect(host.textContent).toContain('Local Network access is off')
    expect(host.textContent).not.toContain('Relay not running or unreachable')
  })
})

describe("4-digit pairing code", () => {
  it("renders the pairing input and button", async () => {
    await mount()
    expect(host.textContent).toContain("Quick pair with Chrome")
    const pairBtn = [...host.querySelectorAll("button")]
      .find(b => b.textContent.trim() === "Pair")
    expect(pairBtn).toBeTruthy()
    expect(pairBtn.disabled).toBe(true)
  })
})
