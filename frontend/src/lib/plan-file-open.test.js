import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { startPlanFileInbox } from './plan-file-open.js'

const raw = readFileSync(new URL('./fixtures/opengym-week-2026-10-31-to-11-06.json', import.meta.url), 'utf8')
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function setup(queue = [], sheets = []) {
  const ui = createStore(() => ({ sheets }))
  let changed
  const remove = vi.fn()
  const plugin = {
    addListener: vi.fn(async (_, fn) => { changed = fn; return { remove } }),
    getPending: vi.fn(async () => queue[0] || {}),
    acknowledge: vi.fn(async ({ id }) => { const i = queue.findIndex(x => x.id === id); if (i >= 0) queue.splice(i, 1) }),
  }
  const show = vi.fn(() => ui.setState({ sheets: [{ id: 'import-preview' }] }))
  const unreadable = vi.fn()
  const stop = startPlanFileInbox({ plugin, ui, unit: () => 'kg', show, unreadable })
  return { plugin, ui, show, unreadable, stop, remove, open: item => { queue.push(item); changed() } }
}

describe('iOS opened plan files', () => {
  it('offers a 171-block delivery received before the WebView started, without merging it', async () => {
    const h = setup([{ id: 'cold', text: raw }])
    await settle()
    expect(h.show).toHaveBeenCalledOnce()
    expect(h.show.mock.calls[0][0]).toMatchObject({ routineCount: 9, exerciseCount: 171, scheduledDays: 7, dropped: 0 })
    expect(h.plugin.acknowledge).toHaveBeenCalledWith({ id: 'cold' })
    h.stop()
  })
  it('handles a document opened while already running', async () => {
    const h = setup(); await settle()
    h.open({ id: 'warm', text: raw }); await settle()
    expect(h.show).toHaveBeenCalledOnce()
    h.stop()
  })
  it('waits for an existing sheet and serializes two file previews', async () => {
    const h = setup([{ id: 'first', text: raw }, { id: 'second', text: raw }], [{ id: 'settings' }])
    await settle(); expect(h.show).not.toHaveBeenCalled()
    h.ui.setState({ sheets: [] }); await settle()
    expect(h.show).toHaveBeenCalledOnce()
    h.ui.setState({ sheets: [] }); await settle()
    expect(h.show).toHaveBeenCalledTimes(2)
    h.stop()
  })
  it('rejects unrelated JSON, malformed JSON and native read errors without opening a preview', async () => {
    const h = setup([{ id: 'other', text: '{"password":"not-a-plan"}' }, { id: 'bad', text: '{' }, { id: 'read', error: true }])
    await settle()
    expect(h.show).not.toHaveBeenCalled()
    expect(h.unreadable).toHaveBeenCalledTimes(3)
    expect(h.plugin.acknowledge).toHaveBeenCalledTimes(3)
    h.stop()
  })
  it('cleans up listeners and leaves an unoffered file for the next mount', async () => {
    const h = setup([{ id: 'cold', text: raw }])
    h.stop(); await settle()
    expect(h.remove).toHaveBeenCalledOnce()
    expect(h.show).not.toHaveBeenCalled()
    expect(h.plugin.acknowledge).not.toHaveBeenCalled()
  })
})
