// The Apple Watch link, the page's side (native: ios/App/App/WatchBridgePlugin.swift, the watch
// app: ios/App/Watch).
//
// Phone → watch: while a workout runs, a snapshot of it (each exercise by name, its sets with
// weight, reps and done, the rest, where you are) goes to the watch whenever it changes. The watch
// then runs the session on its own: the phone's page sleeps once the phone is locked in a pocket.
//
// Watch → phone: what happened on the watch comes back as small events ({ id, type: 'setDone',
// wid, exId, entryIdx, setIdx, w, r, at }). They are applied through the workout screen's own
// actions (bindWatchActions), the same ones a tap on the phone runs (rest timer, the high-water
// mark, the end-of-workout sheet), never a second copy of them. Each event is applied once, by its
// id, and only then acknowledged, which takes it out of the native queue; until the workout screen
// is there to apply it, it waits in that queue.
//
// The iPhone app only. Without a paired watch with the app on it, nothing is sent and nothing
// arrives: the phone behaves exactly as before.
import { MOBILE, nativePlatform } from './mobile.js'
import { EXIDX, gifSrc, figureOf, isAssisted } from './exercises.js'
import { packId, packDrawingId } from './anim-quality.js'
import { getState as animPacks } from './anim-packs.js'
import { getLang, baseLang, onLangChange } from './i18n.js'
import { modeOf, setLabel, lastEntryFor, effectiveRoutineIds, isBw, isPerSide, EFFORT, effortOf } from './history.js'
import { isWarmupRow, isSideSet, syncSideAggregate } from './workout-model.js'
import { bestSetFor } from './exercise-history.js'
import { weightIncrement } from './progression.js'
import { sessionHistory } from './backfill.js'
import { buildCombinedEntries, deriveSessionName } from './session-merge.js'
import { todayISO, exerciseNameText } from './format.js'
import { sanitizeHr } from './heart-rate.js'
import { readWatchPrefs, settingsForWatch, writeWatchStatus, onWatchPrefs } from './watch-settings.js'
import { plannedType } from './health-connect.js'

export const SNAPSHOT_VERSION = 1
const APPLIED_KEY = 'gym_watch_applied'
const APPLIED_MAX = 300
const SEND_DEBOUNCE_MS = 400
const SNAPSHOT_RETRY_MS = 700
const MAX_SNAPSHOT_RETRIES = 3
export const OPEN_RETRY_MS = 1000
const CONFLICT_KEY = 'gym_watch_conflict'
const ABANDONED_KEY = 'gym_watch_abandoned'
const CONFLICT_FOR_MS = 12 * 3600e3
const ABANDONED_MAX = 5
// Routines the watch can start besides today's: enough to choose from, small enough to send.
const READY_MAX = 8

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
// A body weight from the watch that holds up (kg or lb, whatever the profile uses).
const okBw = v => { const n = num(v); return n != null && n > 0 && n < 700 }
// One side of a per-side set, from the watch: 'L', 'R', or none (the whole set).
const sideOf = v => (v === 'L' || v === 'R' ? v : null)
// What a tick of a hold (`sec`) or of one side carries besides the numbers; nothing for a plain set.
const extraOf = ev => ({ ...(num(ev.sec) != null ? { sec: num(ev.sec) } : {}), ...(sideOf(ev.side) ? { side: sideOf(ev.side) } : {}), ...effortFrom(ev) })
// The effort the watch logged on a set: { rpe } or { rir } on the half-point grid, inside the
// phone's own scale (lib/history.js EFFORT); nothing for none, or for a number that does not hold up.
export function effortFrom (ev) {
  for (const k of ['rpe', 'rir']) {
    const v = num(ev?.[k])
    if (v == null) continue
    const e = EFFORT[k]
    const snapped = Math.round(v * 2) / 2
    return snapped >= (k === 'rpe' ? 1 : e.min) && snapped <= e.max ? { [k]: snapped } : {}
  }
  return {}
}

/* ---------- the snapshot ---------- */

// The best set before today, per exercise and mode, for the watch's PRs at the finish. Worked out
// once per history (S.workouts), not on every tick of the running session.
let bestCache = { workouts: null, map: new Map() }
function bestFor (S, id, mode) {
  if (mode !== 'reps' && mode !== 'time') return null
  if (bestCache.workouts !== S?.workouts) bestCache = { workouts: S?.workouts, map: new Map() }
  const key = id + '|' + mode
  if (!bestCache.map.has(key)) {
    let b = null
    try { b = bestSetFor(S, id, mode)?.set || null } catch { b = null }
    bestCache.map.set(key, b ? (mode === 'time' ? { sec: num(b.sec), w: num(b.w) } : { w: num(b.w), r: num(b.r) }) : null)
  }
  return bestCache.map.get(key)
}

const stepOf = (cfg, S) => { try { return num(weightIncrement(cfg, S?.unit === 'lb' ? 'lb' : 'kg')) } catch { return null } }

const sideRow = v => ({ w: num(v?.w), r: num(v?.r), done: v?.done === true })

// One set as the watch shows it. A per-side set (a unilateral exercise) carries its two sides,
// each ticked on its own; `done` is both.
function watchSet (s) {
  return {
    w: num(s.w), r: num(s.r), sec: num(s.sec), done: !!s.done, warmup: !!isWarmupRow(s),
    // when it was ticked: of two ticks of the same set (phone and watch), the later wins
    ...(num(s.at) ? { at: num(s.at) } : {}),
    ...(isSideSet(s) ? { sides: { L: sideRow(s.sides.L), R: sideRow(s.sides.R) } } : {}),
  }
}

// One exercise as the watch shows it. Only optional fields were added over time (bodyweight,
// perSide, group, best, assisted), so an older watch app reads a newer phone's snapshot.
function watchEntry (e, H, S) {
  const ex = EXIDX[e.id]
  const target = e.target || {}
  const cfg = { ...target, id: e.id }
  const mode = modeOf(cfg)
  let last = null
  try {
    const l = H ? lastEntryFor(H, e.id, e.rid) : null
    if (l && Array.isArray(l.sets) && l.sets.length) last = l.sets.map(s => setLabel(e.id, s, l.target)).join(', ')
  } catch { last = null }
  const best = S ? bestFor(S, e.id, mode) : null
  return {
    // A string always: the watch reads the whole snapshot or nothing (WatchCore Model.swift), and
    // one id that came in as a number (an import) would leave it with nothing at all.
    id: String(e.id),
    // Title-cased as on the phone; the watch has no CSS to do it (lib/format.js exerciseNameText).
    name: ex ? exerciseNameText(ex) : String(target.name || e.name || e.id),
    mode,
    restSec: num(target.restSec),
    last,
    sets: (e.sets || []).map(watchSet),
    ...(isBw(cfg) ? { bodyweight: true } : {}),
    ...(isPerSide(cfg) ? { perSide: true } : {}),
    // a superset: the exercises next to each other with the same group, done in turns
    ...(e.sg ? { group: String(e.sg) } : {}),
    ...(best ? { best } : {}),
    ...(mode === 'reps' && isAssisted(e.id) ? { assisted: true } : {}),
    // the step the weight moves in, as on the phone (this exercise's own, else its plates' default)
    ...(mode === 'reps' && stepOf(cfg, S) ? { step: stepOf(cfg, S) } : {}),
  }
}

/**
 * What the watch can start by itself, the phone asleep: today's planned session and a few other
 * routines, each with its exercises built exactly as starting it on the phone builds them
 * (buildCombinedEntries, as sheets.jsx beginWorkout does).
 */
export function buildReady (S, today = todayISO()) {
  let H = null
  try { H = sessionHistory(S) } catch { H = null }
  // One routine that cannot be built is left out, not the whole list with it.
  const session = ids => {
    try {
      const { entries, routineIds, routines } = buildCombinedEntries(S, ids)
      if (!routines.length) return null
      const healthType = plannedType(entries)
      return {
        routineIds: routineIds.map(String),
        name: String(deriveSessionName(routines.map(r => r.name)) || ''),
        entries: entries.filter(e => e && e.id != null).map(e => watchEntry(e, H, S)),
        // Apple Health's workout type on the watch: a run is a run (#799)
        ...(healthType ? { healthType } : {}),
      }
    } catch { return null }
  }
  let todayIds = []
  try { todayIds = effectiveRoutineIds({ ...S, routines: S.routines || [], week: S.week || {}, dayPlan: S.dayPlan || {} }, today, today) || [] } catch { todayIds = [] }
  const planned = todayIds.length ? session(todayIds) : null
  const others = (S.routines || []).filter(r => r && !todayIds.includes(r.id)).slice(0, READY_MAX).map(r => session([r.id])).filter(Boolean)
  return { today: planned, others }
}

/** What the watch needs to run the session: plain data, no media (licence: text only). */
export function buildSnapshot(S, { timer = null, work = null, ready = null } = {}) {
  const A = S && S.active
  const unit = S && S.unit === 'lb' ? 'lb' : 'kg'
  const restSec = num(S && S.restSec) || 0
  if (!A || !Array.isArray(A.entries)) return { v: SNAPSHOT_VERSION, unit, restSec, active: null, ready }
  let H = null
  try { H = sessionHistory(S) } catch { H = null }
  const healthType = plannedType(A.entries)
  return {
    v: SNAPSHOT_VERSION,
    unit,
    restSec,
    ready,
    active: {
      id: A.id || null,
      name: A.name || '',
      // when it started (ms), for the watch's summary at the finish
      ...(num(A.start) ? { start: num(A.start) } : {}),
      unit,
      cur: Math.max(0, Math.min(A.entries.length - 1, A.cur || 0)),
      restSec: num(S.restSec) || 0,
      // a rest running on the phone, so the watch counts down the same one
      rest: timer && !timer.paused && !timer.ready && num(timer.endsAt) ? { endsAt: timer.endsAt } : null,
      // A timed set on the phone. Display only on the watch: the phone owns the set and logs it,
      // so the watch must never run its own auto-complete hold from this snapshot. A pause keeps
      // the frozen remainder so a watch opened after the pause still shows the number people use.
      work: watchWork(work),
      // A pause travels with its revision: the watch keeps its own just-tapped pause until a
      // snapshot at least as new arrives, and a phone resume (a higher revision) always wins.
      ...(num(A.pausedAt) ? { pausedAt: num(A.pausedAt) } : {}),
      ...(num(A.pausedMs) ? { pausedMs: num(A.pausedMs) } : {}),
      ...(num(A.pauseRev) ? { pauseRev: num(A.pauseRev) } : {}),
      ...(A.pausedBy ? { pausedBy: String(A.pausedBy) } : {}),
      entries: A.entries.filter(e => e && e.id != null).map(e => watchEntry(e, H, S)),
      // Apple Health's workout type on the watch: a run is a run (#799)
      ...(healthType ? { healthType } : {}),
    },
  }
}

function watchWork (work) {
  if (!work || work.ready) return null
  const details = {
    ...(num(work.total) ? { total: num(work.total) } : {}),
    ...(work.label ? { label: String(work.label) } : {}),
  }
  if (work.paused) {
    const remaining = num(work.left)
    return remaining == null ? null : { remainingSec: Math.max(0, remaining), ...details }
  }
  return num(work.endsAt) ? { endsAt: num(work.endsAt), ...details } : null
}

/**
 * The running workout's animations for the watch, from what this phone itself shows for each
 * exercise: the smallest downloaded animation pack of the figure (240 px, `packId` + `drawing`, read
 * through Background Assets on the phone) when there is one, else the app's built-in clip (`path` inside the app package:
 * the 180 px animated WebP of the store build, an MP4 loop in other builds). The native side makes
 * each into a small GIF and sends it as a file; the watch deletes them when the workout ends.
 * Nothing is ever fetched from anywhere.
 */
export const WATCH_PACK_PX = 240
export function clipsFor (S, packs = animPacks().packs || {}) {
  const A = S && S.active
  if (!A || !Array.isArray(A.entries)) return []
  const figure = figureOf(S)
  const pid = packId(WATCH_PACK_PX, figure)
  const pack = packs[pid] && packs[pid].state === 'ready' ? pid : null
  const out = [], seen = new Set()
  for (const e of A.entries) {
    const ex = e && EXIDX[e.id]
    if (!ex || seen.has(e.id) || !ex.gif) continue
    seen.add(e.id)
    const drawing = packDrawingId(ex, figure)
    // a pack's files are read through Background Assets on the phone, never by a path
    if (pack && drawing && /^[A-Za-z0-9_-]+$/.test(drawing)) { out.push({ exId: e.id, packId: pack, drawing }); continue }
    const path = gifSrc(ex, figure)
    if (!/\.(webp|mp4|gif)$/i.test(path) || /^[a-z]+:|^\//i.test(path) || path.includes('..')) continue
    out.push({ exId: e.id, path })
  }
  return out
}

/* ---------- applying the watch's events ---------- */

let handlers = null      // the workout screen's: setDone, finish, discard
let appHandlers = null   // the app's: start
const readApplied = () => { try { return JSON.parse(localStorage.getItem(APPLIED_KEY)) || [] } catch { return [] } }
const writeApplied = ids => { try { localStorage.setItem(APPLIED_KEY, JSON.stringify(ids.slice(-APPLIED_MAX))) } catch { /* the queue's ack is what counts */ } }

/** The entry an event means: by position when it still holds that exercise, else by the exercise. */
function entryIndexOf (A, ev) {
  if (A.entries[ev.entryIdx] && A.entries[ev.entryIdx].id === ev.exId) return ev.entryIdx
  return A.entries.findIndex(e => e.id === ev.exId)
}

/**
 * Applies the events not applied yet, in order. Returns the ids that are done with: applied now,
 * applied before, or about a workout that is not running any more. An event whose actions are not
 * there yet (a set before the workout screen is open) stops the run: it and everything after it
 * stay queued, in order, for the next drain.
 *
 *   start   { routineIds, wid, at }  the app starts that session with the watch's id and start
 *   setDone { wid, exId, entryIdx, setIdx, w, r, at, rpe?|rir? }   the workout screen's own tick
 *   finish  { wid, at }              the workout screen's own Finish and save
 *   discard { wid, at }              the workout screen's own Discard (confirmed on the watch)
 *   pause / resume { wid, at }       the workout screen's own pause/resume (the watch's button)
 *   setHr   { wid, exId, entryIdx, setIdx, hr?, restHr? }   heart rate on a set (lib/heart-rate.js)
 *
 * A tick for a workout already saved (finished on the phone while the watch was away) is written
 * into that saved workout, stamped so the next sync keeps it. A tick while the workout screen is
 * not open opens it (appHandlers.openWorkout), and the queue drains once it is there. Of two
 * changes of the same set, the later one (`at`) wins.
 */
export function applyEvents (events, getState) {
  if (!Array.isArray(events)) return []
  const applied = readApplied()
  const done = []
  for (const ev of events) {
    if (!ev || typeof ev.id !== 'string') continue
    if (applied.includes(ev.id)) { done.push(ev.id); continue }
    // The phone won this conflict. Keep the events until the watch has received the snapshot that
    // names its local workout as discarded; then they are safe to acknowledge.
    if (ev.wid && abandonedFor().includes(ev.wid)) {
      applied.push(ev.id)
      done.push(ev.id)
      continue
    }
    // Still waiting for that snapshot: apply nothing from the conflicting workout, including later
    // ticks and its finish, and leave all of it in the native queue for the next drain.
    if (ev.wid && readConflict()?.wid === ev.wid) continue
    const S = getState()?.S
    const A = S?.active
    const ours = A && Array.isArray(A.entries) && (!ev.wid || ev.wid === A.id)
    // A workout finished on the phone while the watch was away: its later ticks still count.
    const saved = !ours && ev.wid && Array.isArray(S?.workouts) ? S.workouts.find(w => w && w.id === ev.wid) : null
    if (ev.type === 'start') {
      if (!A) {
        if (!appHandlers) break
        // Started at the wrist: the watch app is open already, nothing to open there (startWatchSync).
        if (ev.wid) startedOnWatch.add(ev.wid)
        appHandlers.start(Array.isArray(ev.routineIds) ? ev.routineIds : [], { id: ev.wid || null, start: num(ev.at), ...(okBw(ev.bw) ? { bw: num(ev.bw) } : {}) })
      } else if (ev.wid && ev.wid !== A.id) {
        // Two workouts started while the link was unavailable: the phone's remains authoritative.
        // Persist the conflict before trying to send: a failed or skipped resend must survive a
        // reload and make the watch drop its unconfirmed local workout instead of keeping it.
        rememberConflict(ev, A.id)
        if (appHandlers?.resendSnapshot) {
          try { Promise.resolve(appHandlers.resendSnapshot()).catch(() => {}) } catch { /* keep it queued */ }
        }
        continue
      }
      // A start for the workout already running here is only an idempotent acknowledgement.
    } else if (ev.type === 'setDone' && saved) {
      if (!appHandlers) break
      const fields = { done: true, ...(num(ev.w) != null ? { w: num(ev.w) } : {}), ...(num(ev.r) != null ? { r: num(ev.r) } : {}), ...(num(ev.sec) != null ? { sec: num(ev.sec) } : {}), ...(num(ev.at) ? { at: num(ev.at) } : {}), ...effortFrom(ev) }
      const hr = sanitizeHr(ev.hr)
      if (hr) fields.hr = hr
      appHandlers.patchSet({ wid: ev.wid, exId: ev.exId, entryIdx: ev.entryIdx, setIdx: ev.setIdx, ...(sideOf(ev.side) ? { side: sideOf(ev.side) } : {}) }, fields, { ifNewer: num(ev.at) })
    } else if (ev.type === 'setDone' && ours) {
      if (!handlers) {
        // The tick is the workout screen's to apply: open it, and the queue drains when it binds.
        if (appHandlers?.openWorkout) appHandlers.openWorkout()
        break
      }
      const idx = entryIndexOf(A, ev)
      const set = idx >= 0 ? A.entries[idx].sets?.[ev.setIdx] : null
      if (set) handlers.setDone(idx, ev.setIdx, { w: num(ev.w), r: num(ev.r), at: num(ev.at), hr: sanitizeHr(ev.hr), ...extraOf(ev) })
    } else if (ev.type === 'weighIn') {
      // The weigh-in the watch asks for before a workout it starts: a body weight entry on its
      // day, as the phone's own check-in makes one (today's replaces today's).
      if (okBw(ev.w)) {
        if (!appHandlers?.weighIn) break
        appHandlers.weighIn({ w: num(ev.w), at: num(ev.at) || Date.now() })
      }
    } else if (ev.type === 'healthDeleted') {
      // The watch took its copies of deleted workouts out of Apple Health: the phone's own removal
      // (which kept retrying the ones it could not delete) runs again and now finds them gone.
      if (appHandlers?.healthDeleted) appHandlers.healthDeleted(Array.isArray(ev.ids) ? ev.ids.filter(x => typeof x === 'string') : [])
    } else if (ev.type === 'watchStatus') {
      // What the watch says about itself, for Settings → Apple Watch. Never queued behind anything.
      writeWatchStatus(ev)
    } else if (ev.type === 'setHr') {
      // The rest's heart rate comes once the rest is over, maybe after the workout was saved:
      // a field on that set, wherever the set is now. Nothing for a reading that does not hold up.
      const fields = {}
      const hr = sanitizeHr(ev.hr), restHr = sanitizeHr(ev.restHr)
      if (hr) fields.hr = hr
      if (restHr) fields.restHr = restHr
      if (Object.keys(fields).length) {
        if (!appHandlers) break
        appHandlers.patchSet({ wid: ev.wid, exId: ev.exId, entryIdx: ev.entryIdx, setIdx: ev.setIdx }, fields)
      }
    } else if ((ev.type === 'finish' || ev.type === 'discard') && ours) {
      if (!handlers) {
        if (appHandlers?.openWorkout) appHandlers.openWorkout()
        break
      }
      if (ev.type === 'finish') handlers.finish()
      else handlers.discard?.()
    } else if ((ev.type === 'pause' || ev.type === 'resume') && ours) {
      if (!handlers) {
        if (appHandlers?.openWorkout) appHandlers.openWorkout()
        break
      }
      // A watch event older than the phone's last pause or resume is already history. The same
      // revision still applies: the watch may have acted before the phone's snapshot reached it,
      // and that event is what lets the next resume through after a lost snapshot.
      const rev = num(ev.pauseRev)
      const phoneRev = num(A.pauseRev)
      if (rev == null || phoneRev == null || rev >= phoneRev) {
        if (ev.type === 'pause') handlers.pause?.()
        else handlers.resume?.()
      }
    }
    // Applied, or meaningless now (another workout, a set that is gone): either way it is done.
    applied.push(ev.id)
    done.push(ev.id)
  }
  writeApplied(applied)
  return done
}

/** The app's own actions, for what needs no screen (starting a session, a set's heart rate). */
export function bindWatchAppActions (h) {
  appHandlers = h
  drainWatchEvents()
  return () => { if (appHandlers === h) appHandlers = null }
}

/* ---------- the native plugin ---------- */

let pluginP = null
// Inside an object: a Capacitor plugin proxy answers `then`, so a promise must never resolve with
// the bare proxy (lib/rest-alert.js, the Coach hang #42).
const watchPlugin = () => pluginP || (pluginP = (async () => {
  if (!MOBILE || (await nativePlatform()) !== 'ios') return null
  const { registerPlugin } = await import('@capacitor/core')
  return { WatchBridge: registerPlugin('WatchBridge') }
})().catch(() => null))

let getStateRef = null
let draining = null
// The store has its copy back (boot's finishBoot: the file mirror, the server's pull). Before that,
// S can be the empty copy a WebView whose storage was evicted starts with: a tick would find no
// workout, count as meaningless and be acknowledged away, and a "start" would begin a new session
// over it. A store without the flag (a test's) counts as ready.
const storeReady = () => getStateRef?.()?.ready !== false

/**
 * Takes what the watch sent from the native queue, applies it, and acknowledges what is done, but
 * only once the change is on disk (the store's saveNow): the queue is the event's last copy.
 */
export function drainWatchEvents () {
  if (draining) return draining
  draining = (async () => {
    try {
      const p = await watchPlugin()
      if (!p || !getStateRef || !storeReady()) return []
      const { events = [] } = (await p.WatchBridge.drain()) || {}
      const done = applyEvents(events, getStateRef)
      if (done.length) await getStateRef()?.saveNow?.()
      if (done.length) await p.WatchBridge.ack({ ids: done })
      return done
    } catch { return [] } finally { draining = null }
  })()
  return draining
}

/** The workout screen hands over its own actions while it is mounted. Returns the unbind. */
export function bindWatchActions (h) {
  handlers = h
  drainWatchEvents()
  return () => { if (handlers === h) handlers = null }
}

/**
 * Started once by the app. Sends a snapshot whenever the workout or its rest changes (debounced,
 * and only what differs from the last one sent), drains the queue when the app comes back.
 */
// Workouts the watch started, so the phone doesn't open the watch app for them again.
const startedOnWatch = new Set()
/** How long after its start a workout that turns up still opens the watch app (not one restored on launch). */
export const OPEN_ON_WATCH_WINDOW_MS = 2 * 60 * 1000

/**
 * Whether a workout that just appeared on the phone opens the watch app (Settings → Apple Watch,
 * "Open on the watch"): a new live session started here a moment ago, not one the watch started,
 * not a backfilled past one, and not one that came back with the app's saved state.
 */
export function shouldOpenOnWatch (prev, next, { prefs = readWatchPrefs(), now = Date.now(), fromWatch = startedOnWatch } = {}) {
  if (!next || !next.id || (prev && prev.id === next.id)) return false
  if (!prefs.enabled || !prefs.autoShow || next.backfill || fromWatch.has(next.id)) return false
  const start = Number(next.start)
  return Number.isFinite(start) && start > 0 && Math.abs(now - start) <= OPEN_ON_WATCH_WINDOW_MS
}

// The application context has a size limit (about 65 KB); a snapshot over it is refused, and then
// the watch would never hear of the workout. Kept well under it, with room for the settings.
export const SNAPSHOT_MAX_BYTES = 48 * 1024
const bytesOf = v => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)).length

/**
 * The snapshot made small enough to send, dropping first what matters least: the "last time" lines
 * of the routines the watch could start, then those routines but today's, then today's own "last
 * time" lines and records, then the "last time" of the running workout, then what is ready
 * altogether. The running workout's sets are never cut: without them the watch has nothing to do.
 */
export function fitSnapshot (snap, max = SNAPSHOT_MAX_BYTES) {
  if (bytesOf(snap) <= max) return snap
  const out = JSON.parse(JSON.stringify(snap))
  const strip = (entries, ...keys) => { for (const e of entries || []) for (const k of keys) delete e[k] }
  const steps = [
    () => { for (const r of out.ready?.others || []) strip(r.entries, 'last', 'best') },
    () => { if (out.ready) out.ready.others = (out.ready.others || []).slice(0, 3) },
    () => { if (out.ready) out.ready.others = [] },
    () => { if (out.ready?.today) strip(out.ready.today.entries, 'last', 'best') },
    () => { if (out.active) strip(out.active.entries, 'last') },
    () => { out.ready = null },
    () => { if (out.active) strip(out.active.entries, 'best') },
  ]
  for (const step of steps) {
    step()
    if (bytesOf(out) <= max) return out
  }
  return out
}

// How many deleted workouts the watch is told about at most (the newest deletions).
export const HEALTH_GONE_MAX = 60

/**
 * The Apple Health sync ids of workouts deleted in openGym (S.deleted, newest first), for the watch
 * to take its own copies out of Health: a workout the watch app saved is the watch's, and the phone
 * may not delete it, nor the heart rate and calories saved with it (lib/health-connect.js goneIds
 * names the same ids for the phone's own copies).
 */
export function healthGoneFor (S, max = HEALTH_GONE_MAX) {
  const del = S?.deleted && typeof S.deleted === 'object' && S.deleted.workouts && typeof S.deleted.workouts === 'object' ? S.deleted.workouts : {}
  return Object.entries(del)
    .filter(([, at]) => Number(at) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, max)
    .map(([id]) => 'opengym-w-' + id)
}

// Workouts discarded on the phone (#776), newest last: the snapshot names them for a while, so a
// watch running one ends its Apple Health workout without saving it. Gone from the snapshot it
// looks the same as a finished one. In localStorage, not S: a fact about this phone and its
// watch, and it has to outlive the reload of "Discard the running workout" (ErrorBoundary).
const DISCARDED_KEY = 'gym_watch_discarded'
const DISCARDED_MAX = 5
// Long enough for a watch out of range (or asleep in a bag) to hear it.
export const DISCARDED_FOR_MS = 12 * 3600e3
const readDiscarded = () => {
  try { const v = JSON.parse(localStorage.getItem(DISCARDED_KEY)); return Array.isArray(v) ? v.filter(x => x && typeof x.id === 'string' && Number(x.at) > 0) : [] } catch { return [] }
}

/** The running workout `wid` is being discarded: call before it leaves S.active. */
export function markDiscarded (wid, now = Date.now()) {
  if (!wid || typeof wid !== 'string') return
  const list = [...readDiscarded().filter(x => x.id !== wid), { id: wid, at: now }].slice(-DISCARDED_MAX)
  try { localStorage.setItem(DISCARDED_KEY, JSON.stringify(list)) } catch { /* the watch then saves it, as before */ }
}

/** The ids of the workouts discarded here lately, oldest first. */
export function discardedFor (now = Date.now()) {
  return readDiscarded().filter(x => now - Number(x.at) < DISCARDED_FOR_MS).map(x => x.id)
}

/** The watch started `wid` while the phone was running another workout. */
function readConflict (now = Date.now()) {
  try {
    const v = JSON.parse(localStorage.getItem(CONFLICT_KEY))
    if (!v || typeof v.wid !== 'string' || !(Number(v.at) > 0) || now - Number(v.at) >= CONFLICT_FOR_MS) {
      if (v) localStorage.removeItem(CONFLICT_KEY)
      return null
    }
    return v
  } catch { return null }
}

function rememberConflict (ev, phoneWid, now = Date.now()) {
  const v = {
    wid: String(ev.wid),
    ...(typeof ev.id === 'string' ? { startId: ev.id } : {}),
    ...(phoneWid ? { phoneWid: String(phoneWid) } : {}),
    at: now,
  }
  try { localStorage.setItem(CONFLICT_KEY, JSON.stringify(v)) } catch { /* retried by the queued event */ }
}

/** Workouts the watch has been told to abandon; their remaining events can now be acknowledged. */
function readAbandoned (now = Date.now()) {
  try {
    const v = JSON.parse(localStorage.getItem(ABANDONED_KEY))
    return Array.isArray(v) ? v.filter(x => x && typeof x.id === 'string' && Number(x.at) > 0 && now - Number(x.at) < CONFLICT_FOR_MS) : []
  } catch { return [] }
}

function abandonedFor (now = Date.now()) {
  return readAbandoned(now).map(x => x.id)
}

function abandonWatchWorkout (wid, now = Date.now()) {
  if (!wid) return
  const list = [...readAbandoned(now).filter(x => x.id !== wid), { id: wid, at: now }].slice(-ABANDONED_MAX)
  try { localStorage.setItem(ABANDONED_KEY, JSON.stringify(list)) } catch { /* the next forced send retries */ }
  const conflict = readConflict(now)
  if (conflict?.wid === wid) {
    try { localStorage.removeItem(CONFLICT_KEY) } catch { /* harmless: a newer conflict replaces it */ }
  }
}

/**
 * What the watch takes from the app beyond its own settings: the app's language (the watch shows
 * its words in it, whatever the watch itself is set to), and whether a workout starts with the
 * weigh-in (Settings → During a workout) with the last body weight to start the crown from.
 */
export function watchExtras (S) {
  let lang = 'en'
  try { lang = baseLang(getLang()) || 'en' } catch { lang = 'en' }
  const bw = Array.isArray(S?.bodyweight) && S.bodyweight.length ? S.bodyweight[S.bodyweight.length - 1] : null
  return {
    lang,
    weighIn: S?.weighIn !== false,
    ...(bw && num(bw.w) ? { lastBw: num(bw.w) } : {}),
    // the effort scale the profile logs ('rpe' or 'rir'): the watch's set page offers it then
    ...(EFFORT[effortOf(S)] ? { effort: effortOf(S) } : {}),
  }
}

export async function startWatchSync ({ useStore, useUI, onWatchError = null, signal = null }) {
  getStateRef = () => useStore.getState()
  // WCSession activation can take long enough for a workout to start. Watch the store from here,
  // before any wait, so that start is not lost; it is queued once the link is ready.
  let earlyOpen = null
  let stopped = false
  let onStoreChange = null
  const resources = new Set()
  const keep = cleanup => {
    if (typeof cleanup !== 'function') return () => {}
    if (stopped) { try { cleanup() } catch { /* already gone */ } return () => {} }
    resources.add(cleanup)
    return () => {
      if (!resources.delete(cleanup)) return
      try { cleanup() } catch { /* already gone */ }
    }
  }
  const stopResources = () => {
    for (const cleanup of [...resources].reverse()) {
      resources.delete(cleanup)
      try { cleanup() } catch { /* already gone */ }
    }
    signal?.removeEventListener('abort', onAbort)
  }
  let stopSync = () => {
    stopped = true
    onStoreChange = null
    stopResources()
  }
  const onAbort = () => stopSync()
  if (signal?.aborted) return stopSync
  signal?.addEventListener('abort', onAbort, { once: true })
  keep(useStore.subscribe((s, prev) => {
    if (stopped) return
    if (onStoreChange) { onStoreChange(s, prev); return }
    // Before boot has restored the saved state, a running workout is not a Start at the phone.
    if (s.ready === false) { earlyOpen = null; return }
    // ready:false -> true is the app restoring its saved state, not a workout the athlete started.
    // Boot can publish that flag separately from the restored S while status() is still pending:
    // now that the store is safe to apply, take what the watch queued instead of waiting for status.
    if (prev?.ready === false && s.ready === true) {
      earlyOpen = null
      drainWatchEvents()
      return
    }
    if (s.S === prev.S) return
    const next = s.S?.active
    if (shouldOpenOnWatch(prev.S?.active, next)) earlyOpen = next?.id || null
    else if (earlyOpen && next?.id !== earlyOpen) earlyOpen = null
  }))
  const p = await watchPlugin()
  if (stopped) return stopSync
  if (!p) { stopSync(); return stopSync }
  let lastSent = null, lastClips = null, tm = null
  let sendChain = Promise.resolve({ ok: true, sent: false, alreadySent: false })
  let forcedResend = null
  // The ready sessions only change with the plan, the log or the day: built again only then.
  let readyKey = null, ready = null
  const readyFor = S => {
    const key = [S.routines, S.week, S.dayPlan, S.workouts, S.exWeights, S.unit, todayISO()]
    if (!readyKey || key.some((v, i) => v !== readyKey[i])) {
      readyKey = key
      try { ready = buildReady(S) } catch { ready = null }
    }
    return ready
  }
  // WCSession starts asynchronously, so paired + installed is not enough: using the link before it
  // is activated makes both sends and startWatchApp fail. Asked at start, when the link changes,
  // and when the app comes back, not on every workout change.
  let linked = false
  const statusReason = st => {
    if (!st || st.supported === false) return 'unsupported'
    if (st.activated !== true) return 'not_activated'
    if (st.paired !== true) return 'not_paired'
    if (st.installed !== true) return 'not_installed'
    return null
  }
  const checkLink = async () => {
    const was = linked
    try {
      const status = await p.WatchBridge.status()
      if (stopped) return { ok: false, status: null, reason: 'stopped' }
      const reason = statusReason(status)
      linked = !reason
      return { ok: linked, status, reason }
    } catch (error) {
      linked = false
      return { ok: false, status: null, reason: 'status_failed', message: String(error?.message || error || '') }
    } finally {
      // A watch that is new here (the app just installed on it, or reinstalled): it has nothing yet,
      // so the snapshot goes again even when it is the same as the last one sent.
      if (!stopped && linked && !was) lastSent = null
    }
  }
  await checkLink()
  if (stopped) return stopSync
  // Apple Health on the watch follows the phone's own Apple Health switch (Settings → Data).
  let healthOn = false
  try {
    const hs = await import('./health-sync.js')
    if (stopped) return stopSync
    healthOn = !!(await hs.loadHealth())?.on
    if (stopped) return stopSync
    keep(hs.onHealthChange(h => { if (!!h?.on !== healthOn) { healthOn = !!h?.on; schedule() } }))
  } catch { /* no Apple Health here: the watch measures nothing */ }
  if (stopped) return stopSync
  const reportWatchError = error => {
    const detail = {
      stage: String(error?.stage || 'unknown'),
      workoutId: typeof error?.workoutId === 'string' ? error.workoutId : null,
      reason: String(error?.reason || 'unknown'),
      ...(error?.message ? { message: String(error.message) } : {}),
    }
    try { onWatchError?.(detail) } catch { /* a reporter does not break the sync */ }
    // A structured outlet for the app's diagnostics even when startWatchSync's caller did not pass
    // a callback (the workout screen's in-progress start must not be interrupted by a watch error).
    try { globalThis.dispatchEvent?.(new CustomEvent('opengym:watch-error', { detail })) } catch { /* no DOM events here */ }
    return detail
  }
  const send = async () => {
    tm = null
    if (stopped) return { ok: false, stage: 'snapshot', reason: 'stopped' }
    // Not before the store has its copy: an empty one would tell the watch its workout is over.
    if (!linked) {
      retrySnapshot()
      return { ok: false, stage: 'snapshot', reason: 'not_linked' }
    }
    if (!storeReady()) {
      retrySnapshot()
      return { ok: false, stage: 'snapshot', reason: 'store_not_ready' }
    }
    let snapshotSent = false
    try {
      const S = useStore.getState().S
      const prefs = readWatchPrefs()
      // Settings → Apple Watch: off, the watch is told there is nothing (no workout, nothing ready).
      const snap = prefs.enabled
        ? buildSnapshot(S, {
            timer: useUI.getState().timer,
            work: useUI.getState().work,
            ready: readyFor(S),
          })
        : { v: SNAPSHOT_VERSION, unit: S.unit === 'lb' ? 'lb' : 'kg', active: null, ready: null }
      snap.settings = { ...settingsForWatch(prefs, healthOn), ...watchExtras(S) }
      // With Apple Health on: the deleted workouts, so the watch removes the copies it saved.
      if (healthOn) { const gone = healthGoneFor(S); if (gone.length) snap.healthGone = gone }
      // Discarded here: the watch drops its Apple Health workout instead of saving it (#776).
      const conflict = readConflict()
      const discarded = [...new Set([...discardedFor(), ...abandonedFor(), ...(conflict ? [conflict.wid] : [])])]
      if (discarded.length) snap.discarded = discarded
      const json = JSON.stringify(fitSnapshot(snap))
      if (json !== lastSent) {
        const r = await p.WatchBridge.sendSnapshot({ json })
        if (!r || r.sent !== true) {
          const failure = {
            ok: false,
            stage: 'snapshot',
            reason: r?.reason || (r?.error ? 'update_failed' : 'snapshot_not_sent'),
            ...(r?.error || r?.message ? { message: String(r.error || r.message) } : {}),
          }
          reportWatchError(failure)
          retrySnapshot()
          return failure
        }
        lastSent = json
        snapshotSent = true
        // The native link accepted the snapshot that names the watch's local workout. From now on
        // its remaining events are obsolete and may be acknowledged on the next drain.
        if (conflict?.wid) abandonWatchWorkout(conflict.wid)
      }
      snapshotSucceeded()
      // The workout's animations, once per workout and exercise (the native side remembers).
      const clips = prefs.enabled ? clipsFor(S) : []
      const key = S.active ? S.active.id + '|' + clips.map(c => c.exId).join(',') : ''
      if (clips.length && key !== lastClips) {
        try {
          await p.WatchBridge.sendClips({ wid: S.active.id, clips })
          lastClips = key
        } catch { /* the snapshot, which starts the workout, already went */ }
      } else if (!S.active && lastClips) {
        // The workout is over: animations still on their way to the watch are not wanted any more.
        lastClips = null
        try { await p.WatchBridge.dropClips?.() } catch { /* no clips to drop */ }
      }
      return { ok: true, stage: 'snapshot', sent: snapshotSent, alreadySent: !snapshotSent }
    } catch (error) {
      const failure = { ok: false, stage: 'snapshot', reason: 'send_failed', message: String(error?.message || error || '') }
      reportWatchError(failure)
      retrySnapshot()
      return failure
    }
  }
  // All snapshot sends go through one chain. A flush waits for a debounced send already in flight,
  // then sends the current state itself; startWatchApp runs only after that promise has resolved.
  const enqueueSend = () => {
    if (stopped) return Promise.resolve({ ok: false, stage: 'snapshot', reason: 'stopped' })
    clearSnapshotRetry()
    clearTimeout(tm)
    tm = null
    const run = sendChain.then(send, send)
    sendChain = run.catch(error => ({
      ok: false,
      stage: 'snapshot',
      reason: 'send_failed',
      message: String(error?.message || error || ''),
    }))
    return run
  }
  // A dropped WatchConnectivity update must not leave a countdown missing until the next state
  // change. Retry a few times with a widening gap; a successful snapshot resets the budget.
  let snapshotRetryTimer = null
  let snapshotRetryCount = 0
  const clearSnapshotRetry = () => {
    if (snapshotRetryTimer != null) {
      clearTimeout(snapshotRetryTimer)
      snapshotRetryTimer = null
    }
  }
  const snapshotSucceeded = () => {
    snapshotRetryCount = 0
    clearSnapshotRetry()
  }
  const retrySnapshot = () => {
    if (stopped || snapshotRetryTimer != null || snapshotRetryCount >= MAX_SNAPSHOT_RETRIES) return
    const delay = SNAPSHOT_RETRY_MS * (snapshotRetryCount + 1)
    snapshotRetryCount += 1
    snapshotRetryTimer = setTimeout(async () => {
      snapshotRetryTimer = null
      if (stopped) return
      const state = await checkLink()
      if (stopped) return
      if (state.ok) enqueueSend()
      else retrySnapshot()
    }, delay)
  }
  const flushSnapshot = async () => {
    clearTimeout(tm)
    tm = null
    await sendChain
    return enqueueSend()
  }
  // Unlike the debounced schedule, this must produce a native send even when the current snapshot
  // bytes equal lastSent. Concurrent conflict reports share the same attempt.
  const resendSnapshot = () => {
    if (forcedResend) return forcedResend
    forcedResend = (async () => {
      const state = await checkLink()
      if (stopped) return { ok: false, stage: 'snapshot', reason: 'stopped' }
      if (!state.ok) {
        return { ok: false, stage: 'snapshot', reason: state.reason, ...(state.message ? { message: state.message } : {}) }
      }
      lastSent = null
      return flushSnapshot()
    })().finally(() => { forcedResend = null })
    return forcedResend
  }
  const schedule = () => { if (stopped || !linked) return; clearTimeout(tm); tm = setTimeout(() => { enqueueSend() }, SEND_DEBOUNCE_MS) }

  // One pending open per workout. Only a native { ok: true } marks its id done; a transient
  // start_failed is retried on its own, and any failure stays pending for the next
  // watchState/foreground wake-up, up to a small per-workout budget. The old workout is replaced
  // if a new one starts before the link recovers, so a stale start cannot open the watch later or
  // consume the new workout's retries.
  let pendingOpen = null
  let openInFlight = null
  let openAgain = false
  let openRetryTimer = null
  const opened = new Set()
  const openAttempts = new Map()
  const maxOpenAttempts = 3
  const clearOpenRetry = () => { if (openRetryTimer != null) { clearTimeout(openRetryTimer); openRetryTimer = null } }
  const clearPending = id => { if (pendingOpen?.id === id) { pendingOpen = null; clearOpenRetry() } }
  const retryOpen = id => {
    clearOpenRetry()
    if (pendingOpen?.id !== id) return
    openRetryTimer = setTimeout(() => {
      openRetryTimer = null
      if (!stopped && pendingOpen?.id === id) Promise.resolve().then(processPendingOpen)
    }, OPEN_RETRY_MS)
  }
  const openOne = async target => {
    if (stopped) { clearPending(target.id); return false }
    if ((openAttempts.get(target.id) || 0) >= maxOpenAttempts) {
      clearPending(target.id)
      return false
    }
    const state = await checkLink()
    if (stopped) { clearPending(target.id); return false }
    if (!state.ok) {
      if (state.reason !== 'not_activated') reportWatchError({ stage: 'link', workoutId: target.id, reason: state.reason, message: state.message })
      return false
    }
    const current = useStore.getState().S?.active
    if (!current || current.id !== target.id) {
      clearPending(target.id)
      return false
    }
    const prefs = readWatchPrefs()
    if (!prefs.enabled || !prefs.autoShow) {
      clearPending(target.id)
      return false
    }
    const flushed = await flushSnapshot()
    if (!flushed.ok) return false
    // A later state change may have replaced/settled this request while the send was in flight.
    if (pendingOpen?.id !== target.id || opened.has(target.id)) return false
    const stillCurrent = useStore.getState().S?.active
    if (!stillCurrent || stillCurrent.id !== target.id) {
      clearPending(target.id)
      return false
    }
    // Settings can be switched off while the snapshot is on its way; re-read them at the open.
    const openingPrefs = readWatchPrefs()
    if (stopped || !openingPrefs.enabled || !openingPrefs.autoShow) {
      clearPending(target.id)
      return false
    }
    const attempts = openAttempts.get(target.id) || 0
    if (attempts >= maxOpenAttempts) {
      clearPending(target.id)
      return false
    }
    openAttempts.set(target.id, attempts + 1)
    try {
      const result = await p.WatchBridge.openOnWatch({
        type: plannedType(stillCurrent.entries) || undefined,
      })
      if (result?.ok !== true) {
        reportWatchError({
          stage: 'open',
          workoutId: target.id,
          reason: result?.reason || 'start_failed',
          message: result?.message,
        })
        if ((openAttempts.get(target.id) || 0) >= maxOpenAttempts) clearPending(target.id)
        else if ((result?.reason || 'start_failed') === 'start_failed') retryOpen(target.id)
        return false
      }
    } catch (error) {
      reportWatchError({
        stage: 'open',
        workoutId: target.id,
        reason: 'native_error',
        message: String(error?.message || error || ''),
      })
      if ((openAttempts.get(target.id) || 0) >= maxOpenAttempts) clearPending(target.id)
      return false
    }
    opened.add(target.id)
    clearPending(target.id)
    return true
  }
  const processPendingOpen = () => {
    if (stopped) return Promise.resolve(false)
    if (openInFlight) {
      // A wake-up (the link finished activating, the app came forward) while the first attempt is
      // still waiting must not be lost: run again when that attempt settles, even if it failed.
      if (pendingOpen) openAgain = true
      return openInFlight
    }
    if (!pendingOpen) return Promise.resolve(true)
    openInFlight = (async () => {
      try {
        while (pendingOpen) {
          if (stopped) return false
          const target = pendingOpen
          if (opened.has(target.id)) { pendingOpen = null; continue }
          if (!(await openOne(target))) {
            // A newer workout replaced the request while this attempt was waiting: try that one.
            if (pendingOpen && pendingOpen.id !== target.id) continue
            return false
          }
        }
        return true
      } finally {
        openInFlight = null
        if (!stopped && openAgain) { openAgain = false; Promise.resolve().then(processPendingOpen) }
      }
    })()
    return openInFlight
  }
  const queueOpen = active => {
    if (stopped || !storeReady()) return
    if (!active?.id || opened.has(active.id)) return
    if (pendingOpen?.id !== active.id) clearOpenRetry()
    pendingOpen = { id: active.id }
    if (openInFlight) { openAgain = true; return }
    Promise.resolve().then(processPendingOpen)
  }
  const reconcileLink = async ({ resend = false } = {}) => {
    if (stopped) return { ok: false, status: null, reason: 'stopped' }
    if (resend) {
      const result = await resendSnapshot()
      if (stopped) return { ok: false, status: null, reason: 'stopped' }
      if (!result?.ok) return { ok: false, status: null, reason: result?.reason || 'snapshot_not_sent', message: result?.message }
      await processPendingOpen()
      return { ok: true }
    }
    const state = await checkLink()
    if (stopped) return { ok: false, status: null, reason: 'stopped' }
    if (!state.ok) return state
    schedule()
    await processPendingOpen()
    return state
  }
  // A failed conflict resend leaves both the marker and the native events in place. Every wake-up
  // that can restore the link retries it; otherwise an isolated failure would strand the watch.
  const wake = async () => {
    if (stopped) return
    await drainWatchEvents()
    if (readConflict()) await resendSnapshot()
    else await reconcileLink()
  }
  onStoreChange = (s, prev) => {
    const hydrated = prev?.ready === false && s.ready === true
    if (hydrated && pendingOpen) clearPending(pendingOpen.id)
    // Boot done: what the watch sent meanwhile is applied now, and the watch hears the real state.
    if (s.ready && !prev.ready) { wake(); schedule() }
    if (s.S === prev.S) return
    if (hydrated) { schedule(); return }
    if (pendingOpen && s.S?.active?.id !== pendingOpen.id) clearPending(pendingOpen.id)
    schedule()
    // A workout started on the phone: queue the watch launch even while WCSession is still starting;
    // the pending open is retried when the link is ready or the app returns to the foreground.
    if (shouldOpenOnWatch(prev.S?.active, s.S?.active)) queueOpen(s.S.active)
  }
  // The rest and work timers as the watch needs them change when they start, stop, resume or pause,
  // not every second. Their snapshots carry only endsAt; the watch's native countdown ticks itself.
  const restOf = t => (t ? `${t.endsAt}|${!!t.paused}|${!!t.ready}` : '')
  const workOf = w => (w ? `${w.endsAt}|${!!w.paused}|${w.total || 0}|${w.label || ''}` : '')
  keep(useUI.subscribe((s, prev) => {
    if (restOf(s.timer) !== restOf(prev.timer) || workOf(s.work) !== workOf(prev.work)) schedule()
  }))
  keep(onWatchPrefs(() => schedule()))
  // The watch speaks the app's language, not its own system's: told again when it changes (the
  // exercise names in the snapshot change with it too).
  try { keep(onLangChange(() => schedule())) } catch { /* a test without i18n */ }
  const sub = await Promise.resolve(p.WatchBridge.addListener('watchEvent', () => {
    Promise.resolve(drainWatchEvents()).then(() => { if (readConflict()) resendSnapshot() }).catch(() => {})
  })).catch(error => {
    // One listener missing is not a dead link: the queue is still drained on every wake-up.
    reportWatchError({ stage: 'listener', reason: 'watch_event_listener_failed', message: String(error?.message || error || '') })
    return null
  })
  keep(() => sub?.remove?.())
  if (stopped) return stopSync
  // The link itself changed (the session finished activating after launch, a watch was paired, the
  // app was installed on it): asked again, and the snapshot sent when there is a watch now.
  // Sent again even when unchanged: a reinstalled watch app starts with nothing.
  const subLink = await Promise.resolve(p.WatchBridge.addListener('watchState', () => { reconcileLink({ resend: true }) })).catch(() => null)
  keep(() => subLink?.remove?.())
  if (stopped) return stopSync
  const onVisible = () => { if (document.visibilityState === 'visible') wake() }
  document.addEventListener('visibilitychange', onVisible)
  keep(() => document.removeEventListener('visibilitychange', onVisible))
  if (MOBILE) {
    try {
      const { App } = await import('@capacitor/app')
      if (stopped) return stopSync
      const appState = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) wake()
      })
      keep(() => appState?.remove?.())
      if (stopped) return stopSync
    } catch { /* no Capacitor App plugin: visibilitychange still covers the foreground */ }
  }
  // Asked once more now that the listeners are there: the link may have come up (watchState) while
  // the first answer above was on its way, and that event had no one to hear it. Without this the
  // watch heard nothing until the app went to the background and came back.
  if (!linked) await checkLink()
  if (stopped) return stopSync
  const pendingAtStart = earlyOpen
  earlyOpen = null
  if (pendingAtStart && useStore.getState().S?.active?.id === pendingAtStart) queueOpen({ id: pendingAtStart })
  schedule()
  drainWatchEvents()
  stopSync = () => {
    stopped = true
    onStoreChange = null
    clearTimeout(tm); clearSnapshotRetry(); clearOpenRetry(); openAgain = false; pendingOpen = null
    stopResources()
  }
  // A forced resend is needed when the watch reports a conflicting start: its local snapshot has
  // not been confirmed by the phone yet, so the watch must be told which workout is authoritative.
  stopSync.resendSnapshot = resendSnapshot
  return stopSync
}

/**
 * The app's side of the link in one call: what the queue needs is bound as soon as the link
 * starts, not after WCSession has activated (or failed to).
 *
 * A workout started at the wrist is applied while the first status is still on its way, and a
 * link that throws while starting cannot leave the watch's ticks unhandled. The stop is returned
 * immediately, even while the first status is pending, and releases the bound actions with it.
 */
export function startWatchLink ({ useStore, useUI, actions = {}, onWatchError = null }) {
  // Called first: it hands the queue the store's getter before its own first wait, so the drain
  // in bindWatchAppActions below can apply what the watch sent meanwhile.
  const lifecycle = new AbortController()
  let stop = null, stopped = false
  const starting = startWatchSync({ useStore, useUI, onWatchError, signal: lifecycle.signal })
  const unbind = bindWatchAppActions({
    ...actions,
    // Filled in when the link is up: a conflict found before that stays queued for the next wake.
    resendSnapshot: (...args) => stop?.resendSnapshot?.(...args),
  })
  starting.then(fn => {
    if (stopped) fn()
    else stop = fn
  }).catch(() => { /* the caller's immediate stop still releases the bound actions */ })
  return () => {
    if (stopped) return
    stopped = true
    lifecycle.abort()
    stop?.()
    unbind()
  }
}

// Test seams.
export function _setWatchPluginForTest (plugin, getState) { pluginP = Promise.resolve(plugin ? { WatchBridge: plugin } : null); getStateRef = getState || null }
export function _resetWatchSync () { startedOnWatch.clear(); handlers = null; appHandlers = null; pluginP = null; getStateRef = null; draining = null }

/**
 * Writes `fields` (heart rate) onto one set: in the running session when it is that workout, else in
 * the saved workout of that id, which is then stamped as edited so the next sync keeps the change
 * (lib/sync-merge.js: of two copies of a workout the one edited last wins). Only these optional
 * fields are ever added; nothing is removed or renamed.
 */
export function patchSetIn (s, { wid, exId, entryIdx, setIdx, side = null }, fields, stamp, { ifNewer = null, recount = null } = {}) {
  // One side of a per-side set: that side takes the numbers and the tick, the row's own w/r/done
  // follow from both sides (lib/workout-model.js syncSideAggregate).
  const write = (set, f) => {
    if (side && isSideSet(set)) {
      const { w, r, done, rpe, rir, ...rest } = f
      const one = { ...set.sides[side] }
      if (w != null) one.w = w
      if (r != null) one.r = r
      if (done) one.done = true
      // a side's effort is that side's (the row's follows from both, as on the phone)
      if (rpe != null) one.rpe = rpe
      if (rir != null) one.rir = rir
      set.sides = { ...set.sides, [side]: one }
      const agg = syncSideAggregate(set)
      for (const k of Object.keys(set)) if (!(k in agg)) delete set[k]
      Object.assign(set, agg, rest)
    } else Object.assign(set, f)
  }
  const find = w => {
    if (!w || !Array.isArray(w.entries)) return null
    const i = w.entries[entryIdx] && w.entries[entryIdx].id === exId ? entryIdx : w.entries.findIndex(e => e && e.id === exId)
    return i >= 0 ? w.entries[i].sets?.[setIdx] || null : null
  }
  if (s.active && s.active.id === wid) {
    const set = find(s.active)
    if (set) write(set, fields)
    return !!set
  }
  const w = (s.workouts || []).find(x => x && x.id === wid)
  const set = find(w)
  if (!set) return false
  // Two changes of the same set: the later one wins (a tick from the watch older than an edit
  // made on the phone since keeps the phone's numbers; its heart rate still lands).
  let f = fields
  if (ifNewer != null && set.done && Number(set.at) > ifNewer) {
    f = {}
    if (fields.hr) f.hr = fields.hr
    if (fields.restHr) f.restHr = fields.restHr
    // the watch's effort still lands on a set that has none
    if (set.rpe == null && set.rir == null) Object.assign(f, effortFrom(fields))
    if (!Object.keys(f).length) return false
  }
  write(set, f)
  if (recount) recount(w)
  if (stamp) stamp(w)
  return true
}

/** Whether a watch is paired and has the app, for Settings → Apple Watch. */
export async function watchStatus () {
  const p = await watchPlugin()
  if (!p) return { paired: false, installed: false }
  try {
    const st = await p.WatchBridge.status()
    // `activated` false: the link is still starting (right after launch), paired/installed not known yet.
    return { paired: !!st?.paired, installed: !!st?.installed, activated: st?.activated !== false }
  } catch { return { paired: false, installed: false } }
}
