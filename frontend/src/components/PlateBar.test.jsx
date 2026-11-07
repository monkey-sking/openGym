/** @vitest-environment happy-dom */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import PlateBar, { plateVisual } from './PlateBar.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('PlateBar', () => {
  let host, root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => { root.unmount() })
      root = null
    }
    host?.remove()
  })

  it('calculates Olympic standard colors correctly', () => {
    expect(plateVisual(20, 'kg').bg).toBe('#1971c2') // Blue
    expect(plateVisual(15, 'kg').bg).toBe('#f59f00') // Yellow
    expect(plateVisual(10, 'kg').bg).toBe('#2f9e44') // Green
    expect(plateVisual(45, 'lb').bg).toBe('#1971c2') // Blue
    expect(plateVisual(25, 'lb').bg).toBe('#2f9e44') // Green
  })

  it('renders nothing when plates array is empty', async () => {
    await act(async () => {
      root.render(<PlateBar plates={[]} unit="kg" />)
    })
    expect(host.querySelector('.plate-bar')).toBeNull()
  })

  it('renders collar and plate discs', async () => {
    await act(async () => {
      root.render(<PlateBar plates={[20, 10, 2.5]} unit="kg" />)
    })
    const bar = host.querySelector('.plate-bar')
    expect(bar).toBeTruthy()
    expect(bar.querySelector('.plate-collar')).toBeTruthy()
    const discs = bar.querySelectorAll('.plate-disc')
    expect(discs.length).toBe(3)
    expect(discs[0].getAttribute('title')).toBe('20 kg')
    expect(discs[1].getAttribute('title')).toBe('10 kg')
    expect(discs[2].getAttribute('title')).toBe('2.5 kg')
  })
})
