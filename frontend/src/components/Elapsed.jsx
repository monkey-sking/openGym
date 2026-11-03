import { useEffect, useState } from 'react'
import { clockText, elapsedMs, isPaused } from '../lib/workout-pause.js'

// A session's running time, "12:34" since `start`. Its own little component so the only thing
// that re-renders every second is this text: the workout header and the tab bar's Resume button
// both show it. A paused session reads frozen (lib/workout-pause.js): the effect stops its
// interval, and the store's pause/resume is what starts it again.
export default function Elapsed({ start, active }) {
  const a = active || { start }
  const [t, setT] = useState(() => clockText(elapsedMs(a)))
  useEffect(() => {
    const tick = () => setT(clockText(elapsedMs(a)))
    tick()
    if (isPaused(a)) return
    // Hidden (another app, the screen locked), nobody reads it: no re-render a second, and the
    // count is right again the moment the page shows.
    const onTick = () => { if (!document.hidden) tick() }
    const iv = setInterval(onTick, 1000)
    document.addEventListener('visibilitychange', onTick)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onTick) }
  }, [a.start, a.pausedAt, a.pausedMs])
  return <span>{t}</span>
}
