import { parsePlan } from './plan-share.js'

// Pull after listening: a file opened before the WebView loaded is still in the native inbox.
// Other sheets (including another file's preview) stay in front until the user dismisses them.
export function startPlanFileInbox({ plugin, ui, unit, show, unreadable }) {
  let stopped = false, busy = false, again = false, listener
  const offered = new Set()
  const drain = async () => {
    if (busy) { again = true; return }
    if (stopped || ui.getState().sheets.length) return
    busy = true
    try {
      do {
        again = false
        const item = await plugin.getPending()
        if (stopped || ui.getState().sheets.length || !item?.id) break
        if (!offered.has(item.id)) {
          offered.add(item.id)
          try {
            if (item.error || typeof item.text !== 'string') throw new Error('unreadable')
            show(parsePlan(item.text, unit()))
          } catch (e) { unreadable(e) }
        }
        await plugin.acknowledge({ id: item.id })
      } while (!stopped && !ui.getState().sheets.length)
    } catch {
      again = false // Wait for another open, rather than retrying a broken bridge in a loop.
    } finally {
      busy = false
      if (again && !stopped && !ui.getState().sheets.length) void drain()
    }
  }
  const unsubscribe = ui.subscribe((next, prev) => {
    if (prev.sheets.length && !next.sheets.length) void drain()
  })
  void (async () => {
    try {
      listener = await plugin.addListener('pendingChanged', drain)
      if (stopped) { await listener.remove(); return }
      await drain()
    } catch { /* Older app builds have no document inbox. */ }
  })()
  return () => { stopped = true; unsubscribe(); void listener?.remove() }
}
