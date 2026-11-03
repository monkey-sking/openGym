// @vitest-environment happy-dom
// The phone's side of "open on the watch": a workout started on the phone opens the watch app
// (WatchBridge.openOnWatch, HealthKit's startWatchApp), and Apple Health on the watch follows the
// phone's Apple Health switch.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const health = vi.hoisted(() => ({ on: false, listeners: new Set() }))
vi.mock('./health-sync.js', () => ({
  loadHealth: async () => ({ on: health.on }),
  onHealthChange: cb => { health.listeners.add(cb); return () => health.listeners.delete(cb) },
}))

import { shouldOpenOnWatch, startWatchSync, startWatchLink, applyEvents, bindWatchActions, bindWatchAppActions, drainWatchEvents, _setWatchPluginForTest, _resetWatchSync, OPEN_ON_WATCH_WINDOW_MS, OPEN_RETRY_MS } from './watch-sync.js'
import { WATCH_DEFAULTS, writeWatchPrefs } from './watch-settings.js'

const now = 1_800_000_000_000
const live = (over = {}) => ({ id: 'w-9', start: now - 1000, entries: [], ...over })

beforeEach(() => { localStorage.clear(); _resetWatchSync(); health.on = false; health.listeners.clear() })

describe('which workouts open the watch app', () => {
  const prefs = { ...WATCH_DEFAULTS }
  it('a new one started here a moment ago', () => {
    expect(shouldOpenOnWatch(null, live(), { prefs, now })).toBe(true)
    expect(shouldOpenOnWatch(live({ id: 'old' }), live(), { prefs, now })).toBe(true)
  })
  it('not the same one again, nor none', () => {
    expect(shouldOpenOnWatch(live(), live({ cur: 2 }), { prefs, now })).toBe(false)
    expect(shouldOpenOnWatch(live(), null, { prefs, now })).toBe(false)
  })
  it('not one restored at launch or synced in long after its start, nor a backfill', () => {
    expect(shouldOpenOnWatch(null, live({ start: now - OPEN_ON_WATCH_WINDOW_MS - 1 }), { prefs, now })).toBe(false)
    expect(shouldOpenOnWatch(null, live({ start: undefined }), { prefs, now })).toBe(false)
    expect(shouldOpenOnWatch(null, live({ backfill: { durationMin: 60 } }), { prefs, now })).toBe(false)
  })
  it('not with the switch off, or with the watch off altogether', () => {
    expect(shouldOpenOnWatch(null, live(), { prefs: { ...prefs, autoShow: false }, now })).toBe(false)
    expect(shouldOpenOnWatch(null, live(), { prefs: { ...prefs, enabled: false }, now })).toBe(false)
  })
  it('not one the watch started itself', () => {
    const start = vi.fn()
    bindWatchAppActions({ start, patchSet: vi.fn() })
    applyEvents([{ id: 'e1', type: 'start', wid: 'w-9', at: now, routineIds: [] }], () => ({ S: { active: null } }))
    expect(start).toHaveBeenCalled()
    expect(shouldOpenOnWatch(null, live(), { prefs, now })).toBe(false)
    expect(shouldOpenOnWatch(null, live({ id: 'w-other' }), { prefs, now })).toBe(true)
  })
})

describe('a repeated catalogue chapter', () => {
  it('is ticked at its entryIdx, not at the first chapter with the same exercise', () => {
    const S = {
      active: {
        id: 'w-dup',
        entries: [
          { id: '0025', sets: [{ done: false }] },
          { id: '0025', sets: [{ done: false }] },
        ],
      },
    }
    const setDone = vi.fn()
    bindWatchActions({ setDone, finish: vi.fn() })
    expect(applyEvents([
      { id: 'dup-1', type: 'setDone', wid: 'w-dup', exId: '0025', entryIdx: 1, setIdx: 0, w: 60, r: 8, at: 1 },
    ], () => ({ S }))).toEqual(['dup-1'])
    expect(setDone).toHaveBeenCalledWith(1, 0, expect.objectContaining({ w: 60, r: 8, at: 1 }))
  })
})

// A store as small as zustand's: getState, setState, subscribe((s, prev)).
function store(initial) {
  let st = initial
  const subs = new Set()
  return {
    getState: () => st,
    setState: patch => { const prev = st; st = { ...st, ...patch }; subs.forEach(fn => fn(st, prev)) },
    subscribe: fn => { subs.add(fn); return () => subs.delete(fn) },
  }
}

function bridge({ activated = true, paired = true, installed = true } = {}) {
  return {
    status: vi.fn(async () => ({ supported: true, activated, paired, installed })),
    sendSnapshot: vi.fn(async () => ({ sent: true })),
    sendClips: vi.fn(async () => ({})),
    openOnWatch: vi.fn(async () => ({ ok: true })),
    drain: vi.fn(async () => ({ events: [] })),
    ack: vi.fn(async () => ({})),
    addListener: vi.fn(async () => ({ remove: () => {} })),
  }
}

describe('startWatchSync', () => {
  const S0 = { unit: 'kg', restSec: 90, workouts: [], routines: [], active: null }
  const ui = store({ timer: null })

  it('flushes the snapshot before opening the watch app, then deduplicates its workout id', async () => {
    vi.useFakeTimers()
    try {
      let releaseSnapshot
      const b = bridge()
      b.sendSnapshot.mockImplementation(async () => {
        await new Promise(resolve => { releaseSnapshot = resolve })
        return { sent: true }
      })
      const heard = {}
      b.addListener.mockImplementation(async (name, fn) => { heard[name] = fn; return { remove: () => {} } })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      st.setState({ S: { ...S0, active: live({ start: Date.now() }) } })
      st.setState({ S: { ...S0, active: live({ start: Date.now(), cur: 1 }) } })
      await vi.advanceTimersByTimeAsync(0)
      expect(b.sendSnapshot).toHaveBeenCalled()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      releaseSnapshot()
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)
      expect(b.openOnWatch).toHaveBeenCalledWith({ type: undefined })   // nothing in it yet: strength training
      heard.watchState?.({ activated: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('queues a workout started while the link is still activating, and sends its snapshot before opening', async () => {
    vi.useFakeTimers()
    try {
      let releaseStatus
      const b = bridge()
      b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const started = startWatchSync({ useStore: st, useUI: ui })
      await vi.advanceTimersByTimeAsync(0)
      expect(b.status).toHaveBeenCalled()

      st.setState({ S: { ...S0, active: live({ id: 'w-early', start: Date.now() }) } })
      releaseStatus({ supported: true, activated: true, paired: true, installed: true })
      const stop = await started
      await vi.runAllTimersAsync()

      expect(b.sendSnapshot).toHaveBeenCalled()
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)
      expect(b.sendSnapshot.mock.invocationCallOrder[0]).toBeLessThan(b.openOnWatch.mock.invocationCallOrder[0])
      expect(JSON.parse(b.sendSnapshot.mock.calls[0][0].json).active.id).toBe('w-early')
      stop()
    } finally { vi.useRealTimers() }
  })

  it('does not open a workout that was already restored before the link finished activating', async () => {
    vi.useFakeTimers()
    try {
      let releaseStatus
      const b = bridge()
      b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
      _setWatchPluginForTest(b)
      const st = store({ S: { ...S0, active: live({ id: 'w-restored', start: Date.now() }) } })
      const started = startWatchSync({ useStore: st, useUI: ui })
      await vi.advanceTimersByTimeAsync(0)

      st.setState({ S: { ...S0, active: live({ id: 'w-restored', start: now - 1000, cur: 1 }) } })
      releaseStatus({ supported: true, activated: true, paired: true, installed: true })
      const stop = await started
      await vi.runAllTimersAsync()

      expect(b.sendSnapshot).toHaveBeenCalled()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  it('does not open a workout restored when hydration becomes ready during activation', async () => {
    vi.useFakeTimers()
    try {
      let releaseStatus
      const b = bridge()
      b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
      _setWatchPluginForTest(b)
      const st = store({ S: S0, ready: false })
      const started = startWatchSync({ useStore: st, useUI: ui })
      await vi.advanceTimersByTimeAsync(0)

      st.setState({ S: { ...S0, active: live({ id: 'w-restored', start: Date.now() - 30000 }) }, ready: true })
      releaseStatus({ supported: true, activated: true, paired: true, installed: true })
      const stop = await started
      await vi.runAllTimersAsync()

      expect(b.sendSnapshot).toHaveBeenCalled()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  it('does not open a workout restored when hydration becomes ready after activation', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      _setWatchPluginForTest(b)
      const st = store({ S: S0, ready: false })
      const stop = await startWatchSync({ useStore: st, useUI: ui })

      st.setState({ S: { ...S0, active: live({ id: 'w-restored', start: Date.now() - 30000 }) }, ready: true })
      await vi.runAllTimersAsync()

      expect(b.sendSnapshot).toHaveBeenCalled()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  it('does not open a workout restored while hydration is still not ready', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      _setWatchPluginForTest(b)
      const st = store({ S: S0, ready: false })
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      const statusCalls = b.status.mock.calls.length

      // useStore publishes the restored session and finishBoot's ready flag separately.
      st.setState({ S: { ...S0, active: live({ id: 'w-restored-split', start: Date.now() - 30000 }) } })
      await vi.advanceTimersByTimeAsync(OPEN_RETRY_MS)
      // Queueing it as a phone Start would begin an open attempt, which first asks status().
      // Hydration is still false, so the restored session must not enter that queue at all.
      expect(b.status).toHaveBeenCalledTimes(statusCalls)
      expect(b.openOnWatch).not.toHaveBeenCalled()
      st.setState({ ready: true })
      await vi.runAllTimersAsync()

      expect(b.sendSnapshot).toHaveBeenCalled()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  it('opens a real start after hydration is ready', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      _setWatchPluginForTest(b)
      const st = store({ S: S0, ready: false })
      const stop = await startWatchSync({ useStore: st, useUI: ui })

      st.setState({ S: S0, ready: true })
      await vi.runAllTimersAsync()
      st.setState({ S: { ...S0, active: live({ id: 'w-after-ready', start: Date.now() }) } })
      await vi.runAllTimersAsync()

      expect(b.openOnWatch).toHaveBeenCalledTimes(1)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('opens only the workout that replaced one started during activation', async () => {
    vi.useFakeTimers()
    try {
      let releaseStatus
      const b = bridge()
      b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const started = startWatchSync({ useStore: st, useUI: ui })
      await vi.advanceTimersByTimeAsync(0)

      st.setState({ S: { ...S0, active: live({ id: 'w-old', start: Date.now() }) } })
      const entries = [{ id: '0685', target: { mode: 'cardio', min: 30 }, sets: [{ min: 30, speed: 10 }] }]
      st.setState({ S: { ...S0, active: live({ id: 'w-new', start: Date.now(), entries }) } })
      releaseStatus({ supported: true, activated: true, paired: true, installed: true })
      const stop = await started
      await vi.runAllTimersAsync()

      expect(b.openOnWatch).toHaveBeenCalledTimes(1)
      expect(b.openOnWatch).toHaveBeenCalledWith({ type: 'running' })
      expect(JSON.parse(b.sendSnapshot.mock.calls.at(-1)[0].json).active.id).toBe('w-new')
      stop()
    } finally { vi.useRealTimers() }
  })

  it('drops a workout that ended while the link was still activating', async () => {
    vi.useFakeTimers()
    try {
      let releaseStatus
      const b = bridge()
      b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const started = startWatchSync({ useStore: st, useUI: ui })
      await vi.advanceTimersByTimeAsync(0)

      st.setState({ S: { ...S0, active: live({ id: 'w-gone', start: Date.now() }) } })
      st.setState({ S: { ...S0, active: null } })
      releaseStatus({ supported: true, activated: true, paired: true, installed: true })
      const stop = await started
      await vi.runAllTimersAsync()

      expect(b.sendSnapshot).toHaveBeenCalled()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  it('does not bypass the auto-show switch for a workout started during activation', async () => {
    vi.useFakeTimers()
    try {
      writeWatchPrefs({ autoShow: false })
      let releaseStatus
      const b = bridge()
      b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const started = startWatchSync({ useStore: st, useUI: ui })
      await vi.advanceTimersByTimeAsync(0)

      st.setState({ S: { ...S0, active: live({ id: 'w-quiet', start: Date.now() }) } })
      releaseStatus({ supported: true, activated: true, paired: true, installed: true })
      const stop = await started
      await vi.runAllTimersAsync()

      expect(b.sendSnapshot).toHaveBeenCalled()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  it('retries a transient start failure by itself, without a foreground wake', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      b.openOnWatch.mockResolvedValueOnce({ ok: false, reason: 'start_failed' }).mockResolvedValueOnce({ ok: true })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })

      st.setState({ S: { ...S0, active: live({ id: 'w-retry', start: Date.now() }) } })
      await vi.advanceTimersByTimeAsync(0)
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(OPEN_RETRY_MS)
      expect(b.openOnWatch).toHaveBeenCalledTimes(2)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('keeps a link wake-up that arrives while an open is in flight', async () => {
    vi.useFakeTimers()
    try {
      const heard = {}
      let releaseOpen
      const b = bridge()
      b.addListener.mockImplementation(async (name, fn) => { heard[name] = fn; return { remove: () => {} } })
      b.openOnWatch.mockImplementationOnce(() => new Promise(resolve => { releaseOpen = resolve })).mockResolvedValueOnce({ ok: true })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })

      st.setState({ S: { ...S0, active: live({ id: 'w-wake', start: Date.now() }) } })
      await vi.advanceTimersByTimeAsync(0)
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)

      heard.watchState?.({ activated: true })
      await vi.advanceTimersByTimeAsync(0)
      releaseOpen({ ok: false, reason: 'activation_timeout' })
      await vi.runAllTimersAsync()

      expect(b.openOnWatch).toHaveBeenCalledTimes(2)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('does not open when auto-show is switched off while the snapshot is in flight', async () => {
    vi.useFakeTimers()
    try {
      let releaseSnapshot
      const b = bridge()
      b.sendSnapshot.mockImplementationOnce(() => new Promise(resolve => {
        releaseSnapshot = () => resolve({ sent: true })
      }))
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })

      st.setState({ S: { ...S0, active: live({ id: 'w-late-switch', start: Date.now() }) } })
      await vi.advanceTimersByTimeAsync(0)
      expect(b.sendSnapshot).toHaveBeenCalledTimes(1)

      writeWatchPrefs({ autoShow: false })
      releaseSnapshot()
      await vi.runAllTimersAsync()

      expect(b.openOnWatch).not.toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  it('does not send after stop while a foreground wake is still checking the link', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      await vi.runAllTimersAsync()
      const before = b.sendSnapshot.mock.calls.length

      st.setState({ S: { ...S0, unit: 'lb' } })

      let releaseStatus
      b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(b.status).toHaveBeenCalledTimes(2)

      stop()
      releaseStatus({ supported: true, activated: true, paired: true, installed: true })
      await vi.runAllTimersAsync()

      expect(b.sendSnapshot).toHaveBeenCalledTimes(before)
      expect(b.openOnWatch).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('stops a scheduled open retry', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      b.openOnWatch.mockResolvedValue({ ok: false, reason: 'start_failed' })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })

      st.setState({ S: { ...S0, active: live({ id: 'w-stop', start: Date.now() }) } })
      await vi.advanceTimersByTimeAsync(0)
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)

      stop()
      await vi.advanceTimersByTimeAsync(OPEN_RETRY_MS * 4)
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('opens the watch app as a run for a run (#799)', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      const entries = [{ id: '0685', target: { mode: 'cardio', min: 30 }, sets: [{ min: 30, speed: 10 }] }]
      st.setState({ S: { ...S0, active: live({ start: Date.now(), entries }) } })
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).toHaveBeenCalledWith({ type: 'running' })
      stop()
    } finally { vi.useRealTimers() }
  })

  it('leaves the watch alone without an activated link, the app on it, or with the switch off', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge({ activated: false })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      st.setState({ S: { ...S0, active: live({ start: Date.now() }) } })
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      stop()

      const b2 = bridge({ installed: false })
      _setWatchPluginForTest(b2)
      const st2 = store({ S: S0 })
      const stop2 = await startWatchSync({ useStore: st2, useUI: ui })
      st2.setState({ S: { ...S0, active: live({ id: 'w-10', start: Date.now() }) } })
      await vi.runAllTimersAsync()
      expect(b2.openOnWatch).not.toHaveBeenCalled()
      stop2()

      const b3 = bridge()
      _setWatchPluginForTest(b3)
      writeWatchPrefs({ autoShow: false })
      const st3 = store({ S: S0 })
      const stop3 = await startWatchSync({ useStore: st3, useUI: ui })
      st3.setState({ S: { ...S0, active: live({ id: 'w-11', start: Date.now() }) } })
      await vi.runAllTimersAsync()
      expect(b3.openOnWatch).not.toHaveBeenCalled()
      stop3()
    } finally { vi.useRealTimers() }
  })

  // Data safety: an empty copy at launch (storage evicted, the file mirror not read back yet) must
  // not tell the watch its workout is over, nor drain its queue against nothing.
  it('sends nothing and drains nothing before the store has its copy back', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      _setWatchPluginForTest(b)
      const st = store({ S: S0, ready: false })
      _setWatchPluginForTest(b, () => st.getState())
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).not.toHaveBeenCalled()
      expect(b.drain).not.toHaveBeenCalled()
      st.setState({ S: { ...S0, active: live({ start: Date.now() - 3600e3 }) }, ready: true })
      await vi.runAllTimersAsync()
      expect(b.drain).toHaveBeenCalled()
      expect(JSON.parse(b.sendSnapshot.mock.calls.at(-1)[0].json).active.id).toBe('w-9')
      stop()
    } finally { vi.useRealTimers() }
  })

  // The link came up (WCSession activated) while the first status() was on its way: that
  // watchState event had no listener yet. The watch heard nothing until the app was reopened.
  it('sends to the watch when the link comes up during startup, before anyone listened', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      b.status.mockResolvedValueOnce({ activated: false, paired: false, installed: false })
      _setWatchPluginForTest(b)
      const stop = await startWatchSync({ useStore: store({ S: S0 }), useUI: ui })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  it('keeps a start pending until the link activates, then flushes the snapshot and opens', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      const heard = {}
      const inactive = { supported: true, activated: false, paired: true, installed: true }
      b.status.mockResolvedValue(inactive)
      b.addListener.mockImplementation(async (name, fn) => { heard[name] = fn; return { remove: () => {} } })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      st.setState({ S: { ...S0, active: live({ start: Date.now() }) } })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).not.toHaveBeenCalled()
      expect(b.openOnWatch).not.toHaveBeenCalled()

      b.status.mockResolvedValue({ supported: true, activated: true, paired: true, installed: true })
      heard.watchState({ activated: true })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).toHaveBeenCalled()
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('keeps a native open failure pending, reports its reason, and retries on foreground', async () => {
    vi.useFakeTimers()
    try {
      const errors = []
      const b = bridge()
      b.openOnWatch.mockResolvedValueOnce({
        ok: false,
        reason: 'not_activated',
        message: 'The WatchConnectivity session is not activated yet',
      })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui, onWatchError: error => errors.push(error) })
      st.setState({ S: { ...S0, active: live({ start: Date.now() }) } })
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)
      expect(errors).toContainEqual({
        stage: 'open',
        workoutId: 'w-9',
        reason: 'not_activated',
        message: 'The WatchConnectivity session is not activated yet',
      })

      document.dispatchEvent(new Event('visibilitychange'))
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).toHaveBeenCalledTimes(2)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('reports activation_timeout and stops after three native attempts for one workout', async () => {
    vi.useFakeTimers()
    try {
      const errors = []
      const b = bridge()
      b.openOnWatch.mockResolvedValue({
        ok: false,
        reason: 'activation_timeout',
        message: 'The WatchConnectivity session did not activate',
      })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui, onWatchError: error => errors.push(error) })
      st.setState({ S: { ...S0, active: live({ start: Date.now() }) } })
      await vi.runAllTimersAsync()

      for (let i = 0; i < 4; i++) {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.runAllTimersAsync()
      }

      expect(b.openOnWatch).toHaveBeenCalledTimes(3)
      expect(errors.filter(e => e.stage === 'open' && e.workoutId === 'w-9' && e.reason === 'activation_timeout')).toHaveLength(3)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('continues with a new workout when an older workout request fails in flight', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      let failOldOpen
      b.openOnWatch
        .mockImplementationOnce(async () => await new Promise(resolve => { failOldOpen = resolve }))
        .mockResolvedValueOnce({ ok: true })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })

      st.setState({ S: { ...S0, active: live({ id: 'old', start: Date.now() }) } })
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)

      const entries = [{ id: '0685', target: { mode: 'cardio', min: 30 }, sets: [{ min: 30, speed: 10 }] }]
      st.setState({ S: { ...S0, active: live({ id: 'new', start: Date.now(), entries }) } })
      failOldOpen({ ok: false, reason: 'start_failed', message: 'old workout failed' })
      await vi.runAllTimersAsync()

      expect(b.openOnWatch).toHaveBeenCalledTimes(2)
      expect(b.openOnWatch).toHaveBeenLastCalledWith({ type: 'running' })
      stop()
    } finally { vi.useRealTimers() }
  })

  it('gives each workout its own three-attempt budget, including automatic retries', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      b.openOnWatch.mockResolvedValue({ ok: false, reason: 'start_failed' })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })

      st.setState({ S: { ...S0, active: live({ id: 'old', start: Date.now() }) } })
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).toHaveBeenCalledTimes(3)

      for (let i = 0; i < 4; i++) {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.runAllTimersAsync()
      }
      expect(b.openOnWatch).toHaveBeenCalledTimes(3)

      st.setState({ S: { ...S0, active: live({ id: 'new', start: Date.now() }) } })
      await vi.advanceTimersByTimeAsync(0)
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).toHaveBeenCalledTimes(6)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('does not open after a refused snapshot, and retries both on foreground', async () => {
    vi.useFakeTimers()
    try {
      const errors = []
      const b = bridge()
      b.sendSnapshot.mockResolvedValueOnce({ sent: false, reason: 'not_activated', message: 'link is starting' })
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui, onWatchError: error => errors.push(error) })
      st.setState({ S: { ...S0, active: live({ start: Date.now() }) } })
      await vi.runAllTimersAsync()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      expect(errors).toContainEqual({
        stage: 'snapshot',
        workoutId: null,
        reason: 'not_activated',
        message: 'link is starting',
      })

      document.dispatchEvent(new Event('visibilitychange'))
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).toHaveBeenCalledTimes(2)
      expect(b.openOnWatch).toHaveBeenCalledTimes(1)
      stop()
    } finally { vi.useRealTimers() }
  })

  // A watch app installed or reinstalled while the phone app runs starts with nothing: the same
  // snapshot goes again (the native side stamps it, so iOS delivers it although it is unchanged).
  it('sends the same snapshot again when the watch link changes', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      const heard = {}
      b.addListener = vi.fn(async (name, fn) => { heard[name] = fn; return { remove: () => {} } })
      _setWatchPluginForTest(b)
      const stop = await startWatchSync({ useStore: store({ S: S0 }), useUI: ui })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).toHaveBeenCalledTimes(1)
      heard.watchState({ installed: true })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).toHaveBeenCalledTimes(2)
      expect(b.sendSnapshot.mock.calls[1][0].json).toBe(b.sendSnapshot.mock.calls[0][0].json)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('keeps a startup conflict queued until it can resend the phone workout', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      const conflict = { id: 'watch-start-1', type: 'start', wid: 'watch-1', at: now, routineIds: [] }
      b.drain.mockResolvedValue({ events: [conflict] })
      // The first authoritative snapshot does not reach the watch. Its conflict start must stay
      // queued until the watch-event path has resent the phone workout successfully.
      b.sendSnapshot
        .mockResolvedValueOnce({ sent: false, reason: 'not_activated' })
        .mockResolvedValue({ sent: true })
      const heard = {}
      b.addListener = vi.fn(async (name, fn) => { heard[name] = fn; return { remove: () => {} } })
      _setWatchPluginForTest(b)
      const phone = live({ id: 'phone-1' })
      const stop = await startWatchSync({ useStore: store({ S: { ...S0, active: phone } }), useUI: ui })
      await vi.runAllTimersAsync()

      expect(b.drain).toHaveBeenCalledTimes(1)
      expect(b.ack).not.toHaveBeenCalled()
      expect(b.sendSnapshot).toHaveBeenCalledTimes(1)

      // The failed startup send left the conflict queued. The watch-event path drains it (kept, not
      // acked) and resends the phone's authoritative snapshot, which names the watch workout as
      // discarded.
      heard.watchEvent({})
      await vi.runAllTimersAsync()

      expect(b.sendSnapshot).toHaveBeenCalledTimes(2)
      expect(JSON.parse(b.sendSnapshot.mock.calls.at(-1)[0].json).active.id).toBe('phone-1')
      expect(JSON.parse(b.sendSnapshot.mock.calls.at(-1)[0].json).discarded).toContain('watch-1')
      expect(b.ack).not.toHaveBeenCalled()

      // Now that the watch has been told which workout is authoritative, the next drain can ack.
      heard.watchEvent({})
      await drainWatchEvents()
      await vi.runAllTimersAsync()
      expect(b.ack).toHaveBeenCalledWith({ ids: [conflict.id] })
      stop()
    } finally { vi.useRealTimers() }
  })

  it('tells the watch the phone\'s Apple Health switch, and again when it changes', async () => {
    vi.useFakeTimers()
    try {
      health.on = true
      const b = bridge()
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      await vi.runAllTimersAsync()
      const sent = () => JSON.parse(b.sendSnapshot.mock.calls.at(-1)[0].json).settings
      expect(sent().health).toBe(true)
      health.listeners.forEach(fn => fn({ on: false }))
      await vi.runAllTimersAsync()
      expect(sent().health).toBe(false)
      stop()
    } finally { vi.useRealTimers() }
  })
})

// The app (App.jsx) hands the queue its actions through startWatchLink. WCSession activation and
// the first status can take seconds, or end in an error: a workout started at the wrist must be
// applied anyway (real device: the watch's Start did nothing on the phone while the link started).
describe('startWatchLink', () => {
  const S0 = { unit: 'kg', restSec: 90, workouts: [], routines: [], active: null }
  const ui = store({ timer: null })

  it('drains a queued watch start as soon as hydration becomes ready, while status is still pending', async () => {
    let releaseStatus
    const b = bridge()
    b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
    b.drain.mockResolvedValue({ events: [{ id: 's-ready', type: 'start', wid: 'watch-ready', at: now, routineIds: ['r-ready'] }] })
    _setWatchPluginForTest(b)
    const st = store({ S: S0, ready: false })
    const start = vi.fn()
    const stop = startWatchLink({ useStore: st, useUI: ui, actions: { start, patchSet: vi.fn() } })
    try {
      await vi.waitFor(() => expect(b.status).toHaveBeenCalledTimes(1))
      expect(b.drain).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()

      // useStore publishes the restored S first and finishBoot's ready flag separately.
      // The watch's queued Start must run now, without waiting for the pending status call.
      st.setState({ ready: true })
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))

      expect(start).toHaveBeenCalledWith(['r-ready'], expect.objectContaining({ id: 'watch-ready', start: now }))
      expect(b.ack).toHaveBeenCalledWith({ ids: ['s-ready'] })
      expect(b.openOnWatch).not.toHaveBeenCalled()
      expect(b.status).toHaveBeenCalledTimes(1)
    } finally {
      releaseStatus({ supported: true, activated: true, paired: true, installed: true })
      stop()
    }
  })

  it('can stop while status is pending and ignores its late startup result', async () => {
    vi.useFakeTimers()
    try {
      let releaseStatus
      const b = bridge()
      b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
      b.drain.mockResolvedValue({ events: [{ id: 's-late', type: 'start', wid: 'watch-late', at: now, routineIds: [] }] })
      _setWatchPluginForTest(b)
      const st = store({ S: S0, ready: false })
      const start = vi.fn()
      const stop = startWatchLink({ useStore: st, useUI: ui, actions: { start, patchSet: vi.fn() } })

      expect(typeof stop).toBe('function')
      await vi.advanceTimersByTimeAsync(0)
      expect(b.status).toHaveBeenCalledTimes(1)
      stop()

      // Hydration and the native status both arrive after unmount. Neither may resume the link.
      st.setState({ ready: true })
      releaseStatus({ supported: true, activated: true, paired: true, installed: true })
      await vi.runAllTimersAsync()

      expect(b.status).toHaveBeenCalledTimes(1)
      expect(b.drain).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      expect(b.sendSnapshot).not.toHaveBeenCalled()
      expect(b.openOnWatch).not.toHaveBeenCalled()
      expect(b.ack).not.toHaveBeenCalled()
      expect(b.addListener).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('applies a workout started at the wrist while the first status is still on its way', async () => {
    let releaseStatus
    const b = bridge()
    b.status.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
    b.drain.mockResolvedValue({ events: [{ id: 's-1', type: 'start', wid: 'watch-1', at: now, routineIds: ['r1'] }] })
    _setWatchPluginForTest(b)
    const start = vi.fn()
    const stop = startWatchLink({ useStore: store({ S: S0 }), useUI: ui, actions: { start, patchSet: vi.fn() } })
    await vi.waitFor(() => expect(start).toHaveBeenCalled())
    expect(start).toHaveBeenCalledWith(['r1'], expect.objectContaining({ id: 'watch-1', start: now }))
    expect(b.ack).toHaveBeenCalledWith({ ids: ['s-1'] })
    releaseStatus({ supported: true, activated: true, paired: true, installed: true })
    await vi.waitFor(() => expect(b.addListener).toHaveBeenCalledWith('watchEvent', expect.any(Function)))
    stop()
  })

  it('keeps the watch actions bound when the event listener cannot be registered', async () => {
    const errors = []
    const b = bridge()
    b.addListener.mockImplementation(async name => {
      if (name === 'watchEvent') throw new Error('no listener')
      return { remove: () => {} }
    })
    b.drain.mockResolvedValue({ events: [{ id: 's-2', type: 'start', wid: 'watch-2', at: now, routineIds: [] }] })
    _setWatchPluginForTest(b)
    const start = vi.fn()
    const stop = startWatchLink({
      useStore: store({ S: S0 }),
      useUI: ui,
      actions: { start, patchSet: vi.fn() },
      onWatchError: error => errors.push(error),
    })
    await vi.waitFor(() => expect(errors).toContainEqual(expect.objectContaining({
      stage: 'listener',
      reason: 'watch_event_listener_failed',
    })))
    expect(start).toHaveBeenCalledWith([], expect.objectContaining({ id: 'watch-2' }))
    stop()
  })
})
