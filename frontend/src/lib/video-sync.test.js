// @vitest-environment happy-dom
// The app's half of "the workout and the video pause together": what it posts when the athlete
// pauses, what it does with the computer's pause, and the cases where it must do nothing (its own
// command coming back, a resume the athlete did not ask for, a stale sequence number).
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./api.js', () => ({ api: vi.fn(() => Promise.resolve({ ok: true })) }))

import { startVideoSync, videoSyncSessionId, videoSyncUrl, videoSyncPos, extractVideoUrl, parseVideoStartSec, discoverVideoSyncRelay, verifyPairingCode, _resetVideoSyncDiscoveryForTests, entryVideoUrl, entryVideoTime, fmtVideoTime } from './video-sync.js'
import { registerCustom } from './exercises.js'
import { isPaused, pauseActive, resumeActive } from './workout-pause.js'
import { videoPlanBundle } from './video-plan.js'
import { buildPlanBundle, mergePlan, parsePlan } from './plan-share.js'
import { buildCombinedEntries } from './session-merge.js'

const BV = 'https://www.bilibili.com/video/BV1xx411c7mD/'
const BV2 = 'https://www.bilibili.com/video/BV1yy411c7mE/'
const SESSION = 's-1'

// The video plan's custom exercises carry the link (lib/video-plan.js); EXIDX is where the app
// looks an entry's exercise up.
registerCustom([
  { id: 'v1', n: 'Warm-up', url: BV },
  { id: 'v2', n: 'Main', url: BV2 },
  { id: 'v3', n: 'Notes', url: 'https://example.com/notes' }
])

const session = (over = {}) => ({
  id: SESSION,
  start: 1_800_000_000_000,
  cur: 0,
  entries: [{ id: 'v1' }, { id: 'v2' }],
  ...over
})

// A store as small as zustand's, with the two session calls the real one has.
function store (active) {
  let st
  const subs = new Set()
  const api = {
    getState: () => st,
    setState (patch) {
      const prev = st
      st = { ...st, ...patch }
      subs.forEach(fn => fn(st, prev))
    },
    subscribe (fn) { subs.add(fn); return () => subs.delete(fn) },
    pauseWorkout (by = 'app') {
      const A = st.S.active
      if (!A || A.backfill || A.editingWorkoutId || isPaused(A)) return false
      const next = { ...pauseActive(A), pausedBy: by }
      api.setState({ S: { ...st.S, active: next } })
      return true
    },
    resumeWorkout (by = 'app') {
      const A = st.S.active
      if (!A || !isPaused(A)) return false
      if (by === 'video' && A.pausedBy !== 'video') return false
      api.setState({ S: { ...st.S, active: { ...resumeActive(A), pausedBy: null } } })
      return true
    }
  }
  st = { S: { active }, pauseWorkout: api.pauseWorkout, resumeWorkout: api.resumeWorkout }
  return api
}

const ui = () => {
  const subs = new Set()
  const state = { timer: null, work: null, pauseWork: vi.fn(), resumeWork: vi.fn(), setVideoSync: vi.fn(p => Object.assign(state.videoSync, p)), videoSync: { online: false, offset: 0 } }
  return {
    getState: () => state,
    setState: patch => {
      const prev = { ...state }
      Object.assign(state, patch)
      subs.forEach(fn => fn(state, prev))
    },
    subscribe: fn => { subs.add(fn); return () => subs.delete(fn) },
    state
  }
}

const blank = () => ({ seq: 0, action: null, source: null, sessionId: null, videoUrl: null, pos: null, offset: 0, force: false, online: true, at: 1 })

let calls
let state
let request
let useStore
let useUI
let stop

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  state = blank()
  request = vi.fn(async (path, opts) => {
    calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null })
    return state
  })
  useStore = store(session())
  useUI = ui()
  stop = null
})

afterEach(async () => {
  stop?.()
  stop = null
  vi.useRealTimers()
})

const start = async () => {
  stop = await startVideoSync({ useStore, useUI, request, poll: 1500 })
  await vi.advanceTimersByTimeAsync(1)
}
const commands = () => calls.filter(c => c.path === '/api/video-sync/command').map(c => c.body)
const poll = ms => vi.advanceTimersByTimeAsync(ms)


const mobileMocks = vi.hoisted(() => ({
  MOBILE: true,
  platform: 'ios',
  discover: vi.fn(),
  registerPairCode: vi.fn(),
  registered: 0
}))

vi.mock('./mobile.js', () => ({
  get MOBILE() { return mobileMocks.MOBILE },
  nativePlatform: () => Promise.resolve(mobileMocks.platform)
}))

vi.mock('@capacitor/core', () => ({
  registerPlugin: name => {
    mobileMocks.registered++
    if (name === 'VideoSyncDiscovery') {
      return {
        discover: (...args) => mobileMocks.discover(...args),
        registerPairCode: (...args) => mobileMocks.registerPairCode(...args)
      }
    }
    return {}
  }
}))

describe('what the app tells the computer', () => {
  it('names the chapter\'s video when the session starts', async () => {
    await start()
    expect(commands()[0]).toMatchObject({ action: 'start', source: 'app', sessionId: SESSION, videoUrl: BV })
    expect(commands()[0].play).toBeUndefined()
    expect(commands()[1]).toMatchObject({ action: 'seek', source: 'app', sessionId: SESSION, videoUrl: BV, force: false })
    expect(useUI.state.setVideoSync).toHaveBeenCalledWith({ online: true })
  })

  it('holds a timed or chaptered exercise paused when active work has not started', async () => {
    await start()
    // A fresh workout whose first exercise has vstart or timed mode
    useStore.setState({
      S: {
        ...useStore.getState().S,
        active: session({
          id: 's-timed',
          entries: [{ id: 'v1', target: { vstart: 0, mode: 'time', sec: 30 } }]
        })
      }
    })
    expect(commands().at(-1)).toMatchObject({ action: 'start', sessionId: 's-timed', play: false })
  })

  it('syncs resume and pause with phone work countdown timer', async () => {
    await start()
    useStore.setState({
      S: {
        ...useStore.getState().S,
        active: session({
          id: 's-timed-sync',
          entries: [{ id: 'v1', target: { vstart: 10, mode: 'time', sec: 30 } }]
        })
      }
    })
    // Start work countdown on phone
    useUI.setState({ work: { total: 30, left: 30, endsAt: Date.now() + 30000, paused: false } })
    expect(commands().at(-1)).toMatchObject({ action: 'resume', sessionId: 's-timed-sync', force: true })

    // Pause work countdown on phone
    useUI.setState({ work: { total: 30, left: 25, endsAt: Date.now() + 25000, paused: true } })
    expect(commands().at(-1)).toMatchObject({ action: 'pause', sessionId: 's-timed-sync' })

    // Resume work countdown on phone
    useUI.setState({ work: { total: 30, left: 25, endsAt: Date.now() + 25000, paused: false } })
    expect(commands().at(-1)).toMatchObject({ action: 'resume', sessionId: 's-timed-sync', force: true })

    // End work countdown on phone
    useUI.setState({ work: null })
    expect(commands().at(-1)).toMatchObject({ action: 'pause', sessionId: 's-timed-sync' })
  })

  it('does not send periodic drift checks when chaptered exercise is not actively ticking', async () => {
    await start()
    useStore.setState({
      S: {
        ...useStore.getState().S,
        active: session({
          id: 's-idle-chapter',
          entries: [{ id: 'v-ch', target: { vstart: 0, mode: 'time', sec: 30 } }]
        })
      }
    })
    const before = commands().filter(c => c.sessionId === 's-idle-chapter' && c.action === 'seek' && !c.force).length
    await poll(3000)
    const after = commands().filter(c => c.sessionId === 's-idle-chapter' && c.action === 'seek' && !c.force).length
    expect(after).toBe(before)
  })

  it('starts playback for a fresh workout, not for a reload or a paused session', async () => {
    await start()
    expect(commands()[0].play).toBeUndefined()

    useStore.setState({ S: { ...useStore.getState().S, active: session({ id: 's-2' }) } })
    expect(commands().at(-1)).toMatchObject({ action: 'start', sessionId: 's-2', play: true })

    useStore.setState({ S: { ...useStore.getState().S, active: session({ id: 's-3', pausedAt: 1_800_000_001_000 }) } })
    expect(commands().at(-1)).toMatchObject({ action: 'start', sessionId: 's-3', play: false })
  })

  it('sends pause and resume for the athlete\'s own tap', async () => {
    await start()
    useStore.getState().pauseWorkout('app')
    expect(commands().at(-1)).toMatchObject({ action: 'pause', source: 'app', sessionId: SESSION, videoUrl: BV })
    useStore.getState().resumeWorkout('app')
    expect(commands().at(-1)).toMatchObject({ action: 'resume', source: 'app', sessionId: SESSION })
  })

  it('sends pause for a pause made on the watch, and resume when the watch resumes', async () => {
    await start()
    // A watch pause is not a video pause, so it must reach the computer like a phone tap does.
    useStore.getState().pauseWorkout('watch')
    expect(commands().at(-1)).toMatchObject({ action: 'pause', source: 'app', sessionId: SESSION, videoUrl: BV })
    useStore.getState().resumeWorkout('watch')
    expect(commands().at(-1)).toMatchObject({ action: 'resume', source: 'app', sessionId: SESSION })
  })

  it('retargets the extension when the chapter moves to another video', async () => {
    await start()
    const A = useStore.getState().S.active
    useStore.setState({ S: { active: { ...A, cur: 1 } } })
    await vi.advanceTimersByTimeAsync(0)
    const sent = commands()
    const startAt = sent.findLastIndex(c => c.action === 'start' && c.videoUrl === BV2)
    expect(startAt).toBeGreaterThan(-1)
    expect(sent[startAt].play).toBeUndefined()
    expect(sent[startAt + 1]).toMatchObject({ action: 'seek', source: 'app', sessionId: SESSION, videoUrl: BV2, force: true })
    expect(sent.slice(startAt + 1).some(c => c.videoUrl === BV)).toBe(false, 'the old tab is not seeked after the retarget')
  })

  it('checks the timeline again after 5 seconds without forcing a jump', async () => {
    await start()
    const before = commands().filter(c => c.action === 'seek').length
    await poll(6000)
    const seeks = commands().filter(c => c.action === 'seek')
    expect(seeks.length).toBeGreaterThan(before)
    expect(seeks.at(-1)).toMatchObject({ action: 'seek', source: 'app', sessionId: SESSION, videoUrl: BV, force: false })
  })

  it('does not move the video timeline while the workout is paused', async () => {
    await start()
    useStore.getState().pauseWorkout('app')
    const before = commands().filter(c => c.action === 'seek').length
    await poll(6000)
    expect(commands().filter(c => c.action === 'seek')).toHaveLength(before)
  })

  it('sends one end when Finish runs before the session is removed', async () => {
    await start()
    await useUI.state.videoSync.end()
    expect(commands().at(-1)).toMatchObject({ action: 'end', source: 'app', sessionId: SESSION, videoUrl: BV })
    useStore.setState({ S: { active: null } })
    expect(commands().filter(c => c.action === 'end')).toHaveLength(1)
  })

  it('ends the session and says the computer is gone when the workout does', async () => {
    await start()
    useStore.setState({ S: { active: null } })
    expect(commands().at(-1)).toMatchObject({ action: 'end', source: 'app', sessionId: SESSION })
    expect(useUI.state.setVideoSync).toHaveBeenLastCalledWith({ online: false })
    // Nothing is polled for a session that is not running.
    const before = calls.filter(c => c.path === '/api/video-sync/state').length
    await poll(6000)
    expect(calls.filter(c => c.path === '/api/video-sync/state')).toHaveLength(before)
  })
})

describe('what a pause on the computer does', () => {
  it('pauses the session and the timed hold with it', async () => {
    await start()
    state = { ...blank(), seq: 5, action: 'pause', source: 'video', sessionId: SESSION, online: true }
    await poll(1500)
    expect(isPaused(useStore.getState().S.active)).toBe(true)
    expect(useStore.getState().S.active.pausedBy).toBe('video')
    expect(useUI.state.pauseWork).toHaveBeenCalledTimes(1)
    // The change the app just made is not sent back as the athlete's.
    expect(commands().filter(c => c.action === 'pause')).toHaveLength(0)
  })

  it('resumes what the video paused', async () => {
    await start()
    state = { ...blank(), seq: 5, action: 'pause', source: 'video', sessionId: SESSION, online: true }
    await poll(1500)
    state = { ...blank(), seq: 6, action: 'resume', source: 'video', sessionId: SESSION, online: true }
    await poll(1500)
    expect(isPaused(useStore.getState().S.active)).toBe(false)
    expect(useUI.state.resumeWork).toHaveBeenCalledTimes(1)
  })

  it('leaves a pause the athlete chose alone, and ignores a sequence it already applied', async () => {
    await start()
    useStore.getState().pauseWorkout('app')
    state = { ...blank(), seq: 5, action: 'resume', source: 'video', sessionId: SESSION, online: true }
    await poll(1500)
    expect(isPaused(useStore.getState().S.active)).toBe(true)
    expect(useUI.state.resumeWork).not.toHaveBeenCalled()

    // The athlete resumes; the same old pause comes back on the next poll (a retry, or a frame
    // from before the reconnect) and must not freeze the workout again.
    useStore.getState().resumeWorkout('app')
    state = { ...blank(), seq: 5, action: 'pause', source: 'video', sessionId: SESSION, online: true }
    await poll(1500)
    expect(isPaused(useStore.getState().S.active)).toBe(false)
  })

  it('accepts seq 1 again after the server or relay restarts with a new epoch', async () => {
    await start()
    state = { ...blank(), epoch: 'old', seq: 9, action: 'pause', source: 'app', sessionId: SESSION }
    await poll(1500)

    state = { ...blank(), epoch: 'restarted', seq: 1, action: 'pause', source: 'video', sessionId: SESSION }
    await poll(1500)
    expect(isPaused(useStore.getState().S.active)).toBe(true)
    expect(useStore.getState().S.active.pausedBy).toBe('video')
  })

  it('drops a command that names another workout', async () => {
    await start()
    state = { ...blank(), seq: 5, action: 'pause', source: 'video', sessionId: 's-old', online: true }
    await poll(1500)
    expect(isPaused(useStore.getState().S.active)).toBe(false)
  })

  it('nudge adjustments update offset and send force seek command', async () => {
    await start()
    const nudge = useUI.state.videoSync.nudge
    expect(typeof nudge).toBe('function')
    nudge(5)
    expect(useUI.state.videoSync.offset).toBe(5)
    const lastCmd = commands().at(-1)
    expect(lastCmd).toMatchObject({ action: 'seek', offset: 5, force: true })
    nudge(-1)
    expect(useUI.state.videoSync.offset).toBe(4)
    nudge(0)
    expect(useUI.state.videoSync.offset).toBe(0)
  })

  it('reads the computer\'s state again when the app comes back to the screen', async () => {
    await start()
    state = { ...blank(), seq: 9, action: 'pause', source: 'video', sessionId: SESSION, online: true }
    document.dispatchEvent(new Event('visibilitychange'))
    await poll(1)
    expect(isPaused(useStore.getState().S.active)).toBe(true)
  })
})

describe('what counts as a session and a video', () => {
  it('a backfill, an edit and a session without a start are not live', () => {
    expect(videoSyncSessionId(session())).toBe(SESSION)
    expect(videoSyncSessionId(null)).toBe(null)
    expect(videoSyncSessionId(session({ start: 0 }))).toBe(null)
    expect(videoSyncSessionId(session({ backfill: { durationMin: 30 } }))).toBe(null)
    expect(videoSyncSessionId(session({ editingWorkoutId: 'w1' }))).toBe(null)
  })

  it('names only a chapter that links to a video', () => {
    expect(videoSyncUrl(session())).toBe(BV)
    expect(videoSyncUrl(session({ cur: 2 }))).toBe(null)
    expect(videoSyncUrl(session({ cur: 9 }))).toBe(null)
    expect(videoSyncUrl(null)).toBe(null)
  })

  it('prefers the block’s own source video to the exercise’s link', () => {
    expect(videoSyncUrl(session({ entries: [{ id: 'v1', videoUrl: BV2 }] }))).toBe(BV2)
    expect(videoSyncUrl(session({ entries: [{ id: 'v1', target: { videoUrl: BV2 } }] }))).toBe(BV2)
    expect(videoSyncUrl(session({ entries: [{ id: 'v1', videoUrl: 'javascript:alert(1)' }] }))).toBe(BV)
  })

  it('reads a video link written in the exercise note, and a catalogue default as a last resort', () => {
    // A bare link is picked up as-is; free text is scanned for the first video link.
    expect(videoSyncUrl(session({ entries: [{ id: 'v3', note: 'watch the setup: ' + BV }] }))).toBe(BV)
    expect(videoSyncUrl(session({ entries: [{ id: 'v3', target: { note: 'see ' + BV2 + ' first' } }] }))).toBe(BV2)
    // A catalogue exercise now carries its default tutorial video, so a plain bench-press chapter
    // still names a video for the extension (handover item 2/4).
    expect(videoSyncUrl(session({ entries: [{ id: '0025' }] }))).toMatch(/^https:\/\//)
    // A non-video link in a note is not a video, and falls through to nothing here (no catalogue id).
    expect(videoSyncUrl(session({ entries: [{ id: 'v3', note: 'see https://example.com/notes' }] }))).toBe(null)
  })

  it('never lets a javascript: or data: link pose as a video', () => {
    expect(extractVideoUrl('javascript:alert(1)')).toBe(null)
    expect(extractVideoUrl('data:text/html,<video>')).toBe(null)
    expect(videoSyncUrl(session({ entries: [{ id: 'v1', videoUrl: 'javascript:alert(1)' }] }))).toBe(BV)
  })

  it('keeps the block’s own source video over the note link', () => {
    expect(videoSyncUrl(session({ entries: [{ id: 'v1', videoUrl: BV2, note: 'also ' + BV }] }))).toBe(BV2)
  })

  it('keeps a catalogue-mapped chapter on its source video through import, export and start', () => {
    const URL1 = 'https://www.bilibili.com/video/BV1followal0ng/'
    const video = {
      bvid: 'BV1xx411c7mD',
      url: URL1,
      title: 'Follow along',
      uploader: 'Coach',
      sec: 120,
      part: '',
      parts: 1,
      chapters: [
        { name: 'Kettlebell Swing', start: 0, end: 60, sec: 60 },
        { name: 'Dumbbell Curl', start: 60, end: 120, sec: 60 }
      ]
    }
    const parsed = parsePlan(videoPlanBundle(video, { iso: '2026-11-02' }), 'kg')
    const state = { unit: 'kg', routines: [], customEx: [], week: {} }
    const { ids } = mergePlan(state, parsed)
    const entries = buildCombinedEntries(state, ids).entries

    // The chapters map to the catalogue, so the old custom-exercise link is not there to read.
    expect(entries.map(e => e.id)).toEqual(['0549', '0294'])
    expect(entries.map(e => e.videoUrl)).toEqual([URL1, URL1])
    expect(entries.map(e => e.target.videoUrl)).toEqual([URL1, URL1])
    expect(entries.map(e => e.target.vstart)).toEqual([0, 60])
    const A = { id: 's-video', start: 1_800_000_000_000, cur: 0, entries }
    expect(videoSyncUrl(A)).toBe(URL1)
    A.cur = 1
    expect(videoSyncUrl(A)).toBe(URL1)

    // A shared plan keeps the source target too, so the next import still names that video.
    const shared = buildPlanBundle(state, 'Shared').routines[0].ex
    expect(shared.map(e => e.videoUrl)).toEqual([URL1, URL1])
    expect(shared.map(e => e.vstart)).toEqual([0, 60])
  })
})

describe('extractVideoUrl', () => {
  it('returns a direct video URL and scans free text for the first video link', () => {
    expect(extractVideoUrl(BV)).toBe(BV)
    expect(extractVideoUrl('  ' + BV2 + '  ')).toBe(BV2)
    expect(extractVideoUrl('warm up here https://example.com/x then ' + BV)).toBe(BV)
    expect(extractVideoUrl('nothing to see')).toBe(null)
    expect(extractVideoUrl('')).toBe(null)
    expect(extractVideoUrl(null)).toBe(null)
    expect(extractVideoUrl(42)).toBe(null)
  })

  it('refuses a non-video link and a scheme that is not http(s)', () => {
    expect(extractVideoUrl('https://example.com/notes')).toBe(null)
    expect(extractVideoUrl('javascript:alert(1)')).toBe(null)
    expect(extractVideoUrl('ftp://example.com/a.mp4')).toBe(null)
  })
})

describe('parseVideoStartSec', () => {
  it('reads plain seconds from ?t=, &t=, ?start=, &start= and #t=', () => {
    expect(parseVideoStartSec('https://www.bilibili.com/video/BV1xx?t=85')).toBe(85)
    expect(parseVideoStartSec('https://www.youtube.com/watch?v=abc&t=85s')).toBe(85)
    expect(parseVideoStartSec('https://x.test/v?start=42')).toBe(42)
    expect(parseVideoStartSec('https://x.test/v&start=42.5')).toBe(43)
    expect(parseVideoStartSec('https://x.test/v#t=30')).toBe(30)
    expect(parseVideoStartSec('https://x.test/v#t=1:25')).toBe(85)
  })

  it('reads h/m/s and clock forms, and returns null when no start is named', () => {
    expect(parseVideoStartSec('https://y.test/w?t=1m25s')).toBe(85)
    expect(parseVideoStartSec('https://y.test/w?t=1h2m3s')).toBe(3723)
    expect(parseVideoStartSec('https://y.test/w?t=45s')).toBe(45)
    expect(parseVideoStartSec('https://y.test/w?t=01:25')).toBe(85)
    expect(parseVideoStartSec('https://y.test/w')).toBe(null)
    expect(parseVideoStartSec('https://y.test/w?p=2')).toBe(null)
    expect(parseVideoStartSec('')).toBe(null)
    expect(parseVideoStartSec(null)).toBe(null)
  })
})

describe('videoSyncPos uses a start second written into the video link', () => {
  it('starts at the link’s ?t= when there is no vstart or note clock', () => {
    const active = {
      id: 's-urlstart',
      start: 1_800_000_000_000,
      cur: 0,
      entries: [{ id: 'v1', note: 'watch ' + BV + '?t=85' }]
    }
    expect(videoSyncPos(active, null)).toBe(85)
  })

  it('lets an explicit vstart win over the link’s ?t=', () => {
    const active = {
      id: 's-urlstart2',
      start: 1_800_000_000_000,
      cur: 0,
      entries: [{ id: 'v1', vstart: 10, note: BV + '?t=85' }]
    }
    expect(videoSyncPos(active, null)).toBe(10)
  })
})

describe('videoSyncPos accurate chapter calculation', () => {
  it('does not reuse a previous chapter hold when the same exercise appears twice', () => {
    const active = session({ cur: 1, entries: [
      { id: 'v1', target: { vstart: 0 } },
      { id: 'v1', target: { vstart: 60 } },
    ] })
    expect(videoSyncPos(active, { owner: { idx: 0, id: 'v1' }, total: 60, left: 40 })).toBe(60)
    expect(videoSyncPos(active, { owner: { idx: 1, id: 'v1' }, total: 60, left: 40 })).toBe(80)
    expect(videoSyncPos(active, { owner: { id: 'v1' }, total: 60, left: 40 })).toBe(60)
  })

  it('uses current chapter vstart plus intra-chapter hold elapsed seconds', () => {
    const session = {
      id: 's-test',
      start: Date.now() - 100_000,
      cur: 1,
      entries: [
        { id: 'v1', target: { vstart: 0, sec: 60 }, sets: [{ sec: 60, done: true }] },
        { id: 'v2', target: { vstart: 60, sec: 120 }, sets: [{ sec: 120, done: false }] }
      ]
    }
    // No active hold yet (at chapter boundary) -> exactly chapter vstart (60)
    expect(videoSyncPos(session, null)).toBe(60)

    // 15 seconds into holding chapter 2 (total 120, left 105) -> 60 + 15 = 75
    const activeHold = { owner: { idx: 1 }, total: 120, left: 105 }
    expect(videoSyncPos(session, activeHold)).toBe(75)
  })

  it('keeps the chapter position frozen while its timed hold is paused', () => {
    const session = {
      id: 's-paused-hold',
      start: Date.now() - 100_000,
      cur: 1,
      entries: [
        { id: 'v1', target: { vstart: 0, sec: 60 }, sets: [{ sec: 60, done: true }] },
        { id: 'v2', target: { vstart: 60, sec: 120 }, sets: [{ sec: 120, done: false }] }
      ]
    }
    const pausedHold = { owner: { idx: 1 }, total: 120, left: 105, paused: true }
    expect(videoSyncPos(session, pausedHold)).toBe(75)
    expect(videoSyncPos(session, pausedHold)).toBe(75)
  })

  it('falls back to overall session elapsed seconds when no explicit chapter start is given', () => {
    const session = {
      id: 's-test-fallback',
      start: Date.now() - 30_000,
      cur: 0,
      entries: [{ id: 'v1', sets: [{ sec: 300, done: false }] }]
    }
    const pos = videoSyncPos(session)
    expect(pos).toBeGreaterThanOrEqual(29)
    expect(pos).toBeLessThanOrEqual(31)
  })
})


describe('discoverVideoSyncRelay over Wi-Fi', () => {
  beforeEach(() => {
    _resetVideoSyncDiscoveryForTests()
    mobileMocks.MOBILE = true
    mobileMocks.platform = 'ios'
    mobileMocks.discover.mockReset()
  })

  it('resolves http://host:port when discovered on iOS', async () => {
    mobileMocks.discover.mockResolvedValueOnce({
      found: true,
      name: 'openGym Video Sync',
      host: '192.168.1.100',
      port: 8787
    })
    const url = await discoverVideoSyncRelay({ timeout: 1000 })
    expect(url).toBe('http://192.168.1.100:8787')
    expect(mobileMocks.discover).toHaveBeenCalledWith({ timeout: 1000 })
  })

  it('returns null when not found or timeout', async () => {
    mobileMocks.discover.mockResolvedValueOnce({ found: false })
    const url = await discoverVideoSyncRelay()
    expect(url).toBeNull()
  })

  it('returns null on non-mobile or non-iOS platform', async () => {
    mobileMocks.platform = 'android'
    expect(await discoverVideoSyncRelay()).toBeNull()
    mobileMocks.MOBILE = false
    expect(await discoverVideoSyncRelay()).toBeNull()
    expect(mobileMocks.discover).not.toHaveBeenCalled()
  })

  it('returns null on malformed response or invalid port', async () => {
    mobileMocks.discover.mockResolvedValueOnce({ found: true, host: '192.168.1.5', port: 0 })
    expect(await discoverVideoSyncRelay()).toBeNull()
    _resetVideoSyncDiscoveryForTests()
    mobileMocks.discover.mockResolvedValueOnce({ found: true, host: '', port: 8787 })
    expect(await discoverVideoSyncRelay()).toBeNull()
  })

  it('returns null on native exception without throwing', async () => {
    mobileMocks.discover.mockRejectedValueOnce(new Error('native failure'))
    expect(await discoverVideoSyncRelay()).toBeNull()
  })

  it('registers the pairing code on the phone-hosted LAN server via VideoSyncDiscovery.registerPairCode', async () => {
    mobileMocks.registerPairCode.mockReset()
    mobileMocks.registerPairCode.mockResolvedValueOnce({
      ok: true,
      code: '7FEK',
      host: '192.168.31.88',
      port: 8787,
      url: 'http://192.168.31.88:8787',
      localUrl: 'http://127.0.0.1:8787'
    })
    const url = await verifyPairingCode('7fek')
    expect(url).toBe('http://192.168.31.88:8787')
    expect(mobileMocks.registerPairCode).toHaveBeenCalledWith({ code: '7FEK' })
  })
})

describe('entryVideoUrl, entryVideoTime, and fmtVideoTime helpers', () => {
  it('entryVideoUrl resolves url from videoUrl, note or catalogue', () => {
    expect(entryVideoUrl({ videoUrl: BV })).toBe(BV)
    expect(entryVideoUrl({ note: 'see ' + BV })).toBe(BV)
    expect(entryVideoUrl({ target: { videoUrl: BV2 } })).toBe(BV2)
    expect(entryVideoUrl({})).toBe(null)
    expect(entryVideoUrl(null)).toBe(null)
  })

  it('entryVideoTime resolves start seconds across vstart, note clock and URL ?t=', () => {
    expect(entryVideoTime({ target: { vstart: 120 } })).toBe(120)
    expect(entryVideoTime({ vstart: 45 })).toBe(45)
    expect(entryVideoTime({ note: 'chapter 02:15 start' })).toBe(135)
    expect(entryVideoTime({ videoUrl: BV + '?t=90' })).toBe(90)
    expect(entryVideoTime({ videoUrl: BV })).toBe(null)
    expect(entryVideoTime({})).toBe(null)
    expect(entryVideoTime(null)).toBe(null)
  })

  it('fmtVideoTime formats seconds cleanly into mm:ss and hh:mm:ss', () => {
    expect(fmtVideoTime(0)).toBe('0:00')
    expect(fmtVideoTime(5)).toBe('0:05')
    expect(fmtVideoTime(75)).toBe('1:15')
    expect(fmtVideoTime(195)).toBe('3:15')
    expect(fmtVideoTime(3600)).toBe('1:00:00')
    expect(fmtVideoTime(3665)).toBe('1:01:05')
    expect(fmtVideoTime(null)).toBe(null)
    expect(fmtVideoTime(undefined)).toBe(null)
    expect(fmtVideoTime(NaN)).toBe(null)
  })
})
