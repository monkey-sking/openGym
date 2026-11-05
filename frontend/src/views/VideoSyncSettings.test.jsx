// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoSyncSettingsPage, {
  VIDEO_SYNC_HEALTH_POLL_MS,
  discoveryFailureMessage,
  discoveryUrl,
  relayPhase,
  relayPhaseLabel,
  exerciseVideoLink,
  describeVideoInput,
} from './VideoSyncSettings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  mobile: true,
  platform: 'ios',
  saved: '',
  writes: [],
  probe: vi.fn(),
  verify: vi.fn(),
  plugin: null,
  registerPlugin: vi.fn(),
  routines: [],
  update: vi.fn(),
}))

vi.mock('../lib/i18n.js', () => ({ t: value => value }))
vi.mock('../lib/video-sync.js', () => ({
  readVideoSyncServer: () => mocks.saved,
  writeVideoSyncServer: value => {
    mocks.writes.push(value)
    mocks.saved = value
  },
  probeVideoSyncServer: (...args) => mocks.probe(...args),
  verifyPairingCode: (...args) => mocks.verify(...args),
  extractVideoUrl: url => {
    const s = String(url || '').trim()
    if (!s) return null
    const m = /https?:\/\/[^\s"'<>]+/.exec(s)
    if (!m) return null
    return /youtu\.be|youtube\.com|bilibili\.com|vimeo\.com|tiktok\.com|instagram\.com|b23\.tv/.test(m[0]) ? m[0] : null
  },
  parseVideoStartSec: url => {
    const m = /[?&#](?:t|start)=(\d+)/.exec(String(url || ''))
    return m ? Number(m[1]) : null
  },
}))
vi.mock('../lib/mobile.js', () => ({
  get MOBILE () { return mocks.mobile },
  nativePlatform: () => Promise.resolve(mocks.platform),
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
vi.mock('../store/useStore.js', () => {
  const snapshot = () => ({ routines: mocks.routines, update: mocks.update })
  const useStore = selector => selector ? selector(snapshot()) : snapshot()
  useStore.getState = snapshot
  return { useStore }
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
  mocks.verify = vi.fn()
  mocks.plugin = null
  mocks.registerPlugin = vi.fn(() => mocks.plugin)
  mocks.routines = []
  mocks.update = vi.fn()
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
  it('maps computer, extension and phone facts to four unambiguous user-facing phases', () => {
    expect(relayPhase(null)).toBe('relay-unreachable')
    expect(relayPhase({ ok: true, extensionConnected: false, phoneConnected: false })).toBe('extension-missing')
    expect(relayPhase({ ok: true, extensionConnected: true, phoneConnected: false })).toBe('phone-missing')
    expect(relayPhase({ ok: true, extensionConnected: true, phoneConnected: true })).toBe('connected')

    expect(relayPhaseLabel('relay-unreachable')).toBe('Computer not reachable')
    expect(relayPhaseLabel('extension-missing')).toBe('Computer available; open the openGym Chrome extension')
    expect(relayPhaseLabel('phone-missing')).toBe('Chrome extension connected; start a workout on your phone')
    expect(relayPhaseLabel('connected')).toBe('Phone and Chrome extension connected')
    expect(relayPhaseLabel('unconfigured')).toBe('Not paired')
  })

  it('keeps discovery failures actionable without technical relay/Mac helper wording', () => {
    expect(discoveryFailureMessage('permission-denied')).toContain('Local Network access is off')
    expect(discoveryFailureMessage('permission-denied')).not.toContain('No computer was found')
    expect(discoveryFailureMessage('not-found')).toContain('Open the openGym Chrome extension')
    expect(discoveryFailureMessage('not-found')).not.toContain('Set up Mac helper')
    expect(discoveryFailureMessage('timeout')).toContain('Open the openGym Chrome extension')
    expect(discoveryFailureMessage('timeout')).not.toContain('Set up Mac helper')
    expect(discoveryFailureMessage('resolution-failed')).toContain('could not resolve its Wi-Fi address')
    expect(discoveryFailureMessage('search-failed')).toContain('could not search the local network')
    expect(discoveryFailureMessage('unsupported')).toContain('only available in the openGym iPhone app')
    for (const reason of ['permission-denied', 'not-found', 'timeout', 'resolution-failed', 'search-failed']) {
      expect(discoveryFailureMessage(reason)).not.toMatch(/relay|Mac helper|\.command|Terminal|Node\.js/i)
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

describe('pairing flow', () => {
  it('renders the pairing input and button in the primary position', async () => {
    await mount()
    expect(host.textContent).toContain('Pair with Chrome')
    const input = host.querySelector('input')
    expect(input).toBeTruthy()
    expect(input.placeholder).toBe('4-CHARACTER CODE')

    const pairBtn = [...host.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Pair')
    expect(pairBtn).toBeTruthy()
    expect(pairBtn.disabled).toBe(true)

    // No legacy technical fields in the DOM
    expect(host.textContent).not.toContain('Relay configuration')
    expect(host.textContent).not.toContain('Set up Mac helper')
    expect(host.textContent).not.toContain('Address in use')
  })

  it('pairs using 4-character code and updates saved address on success', async () => {
    mocks.plugin = {
      discover: vi.fn().mockResolvedValue({ found: true, host: '192.168.1.55', port: 8787 }),
    }
    mocks.verify.mockResolvedValue('http://192.168.1.55:8787')
    mocks.probe.mockResolvedValue(health({ extension: true, phone: true }))

    await mount()

    const input = host.querySelector('input')
    const pairBtn = [...host.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Pair')

    await act(async () => {
      const propDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      propDesc.set.call(input, '7FEI')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    })

    expect(pairBtn.disabled).toBe(false)

    await act(async () => {
      pairBtn.click()
      await flush()
    })

    expect(mocks.verify).toHaveBeenCalledWith('7FEI', { candidateUrl: 'http://192.168.1.55:8787' })
    expect(mocks.writes).toContain('http://192.168.1.55:8787')
    expect(host.textContent).toContain('Paired successfully.')
    expect(host.textContent).toContain('Phone and Chrome extension connected')
  })

  it('rejects an expired or unknown pairing code without saving', async () => {
    mocks.plugin = {
      discover: vi.fn().mockResolvedValue({ found: true, host: '192.168.1.55', port: 8787 }),
    }
    mocks.verify.mockResolvedValue(null)

    await mount()
    const input = host.querySelector('input')
    const pairBtn = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Pair')

    await act(async () => {
      const propDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      propDesc.set.call(input, 'ABCD')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    })

    await act(async () => {
      pairBtn.click()
      await flush()
    })

    expect(mocks.writes).toEqual([])
    expect(host.textContent).toContain('Pairing code not found or expired. Check the openGym Chrome extension.')
  })
})

describe('automatic status recovery', () => {
  it('advances extension -> phone without flashing Checking during a background probe', async () => {
    vi.useFakeTimers()
    mocks.saved = 'http://192.168.1.8:8787'
    let resolveSecond
    mocks.probe
      .mockResolvedValueOnce(health({ extension: true, phone: false }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve }))
      .mockResolvedValueOnce(health({ extension: true, phone: true }))

    await mount()
    expect(mocks.probe).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Chrome extension connected; start a workout on your phone')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIDEO_SYNC_HEALTH_POLL_MS)
      await flush()
    })
    expect(mocks.probe).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Chrome extension connected; start a workout on your phone')
    expect(host.textContent).not.toContain('Checking…')

    await act(async () => {
      resolveSecond(health({ extension: true, phone: true }))
      await flush()
    })
    expect(host.textContent).toContain('Phone and Chrome extension connected')
  })

  it('uses a newly discovered Wi-Fi address for the current session without overwriting saved address', async () => {
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
    expect(host.textContent).toContain('Chrome extension connected; start a workout on your phone')
  })

  it('stays unconfigured and does not write to storage when unconfigured and no pairing done', async () => {
    mocks.saved = ''
    mocks.plugin = {
      discover: vi.fn().mockResolvedValue({ found: true, host: '192.168.1.19', port: 8787 }),
    }

    await mount()

    expect(mocks.writes).toEqual([])
    expect(host.textContent).toContain('Not paired')
  })

  it('shows a Local Network permission problem, not a generic offline error', async () => {
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
    expect(host.textContent).not.toContain('Computer not reachable')
  })
})

describe('pre-workout video configuration', () => {
  it('resolves a routine exercise video from its link, its note, or the exercise default', () => {
    expect(exerciseVideoLink({ id: 'v1', videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD/' }))
      .toBe('https://www.bilibili.com/video/BV1xx411c7mD/')
    expect(exerciseVideoLink({ id: 'v1', note: 'watch https://youtu.be/dQw4w9WgXcQ first' }))
      .toBe('https://youtu.be/dQw4w9WgXcQ')
    // A catalogue exercise with no link/note still gets its default tutorial.
    expect(exerciseVideoLink({ id: '0025' })).toMatch(/^https:\/\//)
  })

  it('tells apart a video link, a start-second link, a plain link and junk', () => {
    expect(describeVideoInput('').empty).toBe(true)
    expect(describeVideoInput('https://www.youtube.com/watch?v=abc&t=85').startSec).toBe(85)
    expect(describeVideoInput('https://www.youtube.com/watch?v=abc&t=85').ok).toBe(true)
    expect(describeVideoInput('https://example.com/notes').ok).toBe(false)
    expect(describeVideoInput('not a url').ok).toBe(false)
  })

  it('lists a play-video field per routine and saves its link onto the routine exercises', async () => {
    mocks.routines = [{
      id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 4, reps: 8 }, { id: '0047', sets: 3, reps: 10 }]
    }]
    mocks.plugin = { discover: vi.fn().mockResolvedValue({ found: false, reason: 'timeout' }) }
    mocks.probe.mockResolvedValue(null)
    await mount()
    expect(host.textContent).toContain('Videos for your plans')
    expect(host.textContent).toContain('Push Day')

    const input = host.querySelector('input[type="url"]')
    expect(input).toBeTruthy()
    expect(input.type).toBe('url')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(input, 'https://www.bilibili.com/video/BV1zz411c7mF/')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    })
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await flush()
    })
    expect(mocks.update).toHaveBeenCalled()
    const mut = mocks.update.mock.calls[0][0]
    const S = { routines: [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025' }, { id: '0047' }] }] }
    mut(S)
    expect(S.routines[0].ex.every(e => e.videoUrl === 'https://www.bilibili.com/video/BV1zz411c7mF/')).toBe(true)
  })

  it('expands a plan to give one exercise its own video, leaving the others alone', async () => {
    mocks.routines = [{
      id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 4, reps: 8 }, { id: '0047', sets: 3, reps: 10 }]
    }]
    mocks.plugin = { discover: vi.fn().mockResolvedValue({ found: false, reason: 'timeout' }) }
    mocks.probe.mockResolvedValue(null)
    await mount()

    // Collapsed by default: only the routine-level field is shown.
    expect(host.querySelectorAll('input[type="url"]').length).toBe(1)
    const expand = [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Set a video for each exercise')
    expect(expand).toBeTruthy()
    await act(async () => { expand.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush() })

    // Now the routine default plus one field per exercise.
    const inputs = host.querySelectorAll('input[type="url"]')
    expect(inputs.length).toBe(3)

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const secondEx = inputs[2]
    await act(async () => {
      setter.call(secondEx, 'https://youtu.be/dQw4w9WgXcQ')
      secondEx.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    })
    await act(async () => {
      secondEx.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await flush()
    })
    const lastCall = mocks.update.mock.calls.at(-1)[0]
    const S = { routines: [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025' }, { id: '0047' }] }] }
    lastCall(S)
    expect(S.routines[0].ex[1].videoUrl).toBe('https://youtu.be/dQw4w9WgXcQ')
    expect(S.routines[0].ex[0].videoUrl).toBeUndefined()
  })
})
