// @vitest-environment happy-dom
import React, { act } from 'react'
import { readFileSync } from 'node:fs'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { planImportSheet } from './sheets.jsx'
import { startPlanFileInbox } from './lib/plan-file-open.js'

it('opens the real file in the existing preview and imports only after explicit confirmation', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const previous = useStore.getState().S
  useStore.setState({ S: { ...previous, routines: [], customEx: [], week: {} } })
  useUI.setState({ sheets: [] })
  const text = readFileSync('./src/lib/fixtures/opengym-week-2026-10-31-to-11-06.json', 'utf8')
  let item = { id: 'external-file', text }
  const plugin = {
    addListener: async () => ({ remove: () => {} }),
    getPending: async () => item,
    acknowledge: async () => { item = {} },
  }
  const unreadable = vi.fn()
  const stop = startPlanFileInbox({ plugin, ui: useUI, unit: () => 'kg', show: planImportSheet, unreadable })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve() })
    expect(unreadable).not.toHaveBeenCalled()
    expect(useStore.getState().S.routines).toHaveLength(0)
    const sheet = useUI.getState().sheets.at(-1)
    act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
    expect(host.textContent).toContain('9 routines')
    expect(host.textContent).toContain('171 exercises')
    expect(host.textContent).toContain('scheduled on 7 days')
    act(() => host.querySelector('[role="switch"]').click())
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Add to my plan').click())
    expect(useStore.getState().S.routines).toHaveLength(9)
    expect(useStore.getState().S.customEx).toHaveLength(0)
    expect(Object.keys(useStore.getState().S.week)).toHaveLength(7)
  } finally {
    stop()
    act(() => root.unmount())
    host.remove()
    useStore.setState({ S: previous })
    useUI.setState({ sheets: [] })
  }
})
