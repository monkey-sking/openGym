// A paused session: the clock stops, and the time it stood still is not training time.
//
// The pause rides on `S.active` only once the athlete pauses, so a session that was never paused
// keeps the shape every older build wrote — and every reader of `start` (the watch's snapshot,
// the history's duration) keeps working without knowing this file exists.
//
// `pausedAt` is the moment the clock stopped (null/absent while running); `pausedMs` is the
// total of the pauses already ended. A session paused now counts `pausedMs` alone, which is what
// keeps the frozen clock frozen instead of counting the pause up.

export const isPaused = a => !!a?.pausedAt

const num = v => (Number(v) > 0 ? Number(v) : 0)

/** How long the session has stood still: the finished pauses plus the one running now. */
export function pausedMsAt(active, now = Date.now()) {
  const held = num(active?.pausedMs)
  return isPaused(active) ? held + Math.max(0, now - active.pausedAt) : held
}

/** Training time: wall clock since `start` minus every paused stretch. */
export function elapsedMs(active, now = Date.now()) {
  const start = num(active?.start)
  if (!start) return 0
  const until = isPaused(active) ? active.pausedAt : now
  return Math.max(0, until - start - num(active?.pausedMs))
}

/** The session with its clock stopped. Pausing a paused session changes nothing. */
export function pauseActive(active, now = Date.now()) {
  if (!active || isPaused(active)) return active
  return { ...active, pausedAt: now, pauseRev: num(active.pauseRev) + 1 }
}

/** The session running again, with the stretch just ended added to `pausedMs`. */
export function resumeActive(active, now = Date.now()) {
  if (!isPaused(active)) return active
  return { ...active, pausedAt: null, pausedMs: num(active.pausedMs) + Math.max(0, now - active.pausedAt), pauseRev: num(active.pauseRev) + 1 }
}

/** The end a finished session is recorded with, pulled back by the time it stood still. */
export function trainedEnd(active, end) {
  if (!active) return end
  const held = pausedMsAt(active, end)
  return held > 0 ? Math.max(num(active.start) || end, end - held) : end
}

/** "12:34" for a millisecond count, the same shape Elapsed and the tab bar print. */
export function clockText(ms) {
  const s = Math.max(0, Math.floor(num(ms) / 1000))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}
