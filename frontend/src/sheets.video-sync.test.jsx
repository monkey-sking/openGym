// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useUI } from './store/useUI.js'
import { videoSyncSheet } from './sheets.jsx'

const mounted = []
function mountTopSheet() {
  const sheet = useUI.getState().sheets.at(-1)
  if (!sheet) return null
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}

describe('videoSyncSheet opens sheet with status and controls', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useUI.setState({ sheets: [], toasts: [], videoSync: { offset: 0, nudge: vi.fn() } })
    document.body.innerHTML = ''
  })

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach(root => root.unmount())
    })
  })

  it('renders video sync sheet with title and buttons', () => {
    act(() => videoSyncSheet())
    const host = mountTopSheet()
    expect(host.querySelector('h3')?.textContent).toBe('Video sync')
    const buttons = [...host.querySelectorAll('button')].map(b => b.textContent.trim())
    expect(buttons).toContain('Done')
    expect(buttons).toContain('+1s')
    expect(buttons).toContain('-1s')
    expect(buttons).toContain('Reset')
  })

  it('calls nudge when timeline buttons are clicked', () => {
    const nudge = vi.fn()
    useUI.setState({ videoSync: { offset: 2, nudge } })
    act(() => videoSyncSheet())
    const host = mountTopSheet()
    const plus5 = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === '+5s')
    expect(plus5).not.toBeNull()
    act(() => plus5.click())
    expect(nudge).toHaveBeenCalledWith(5)
  })
})
