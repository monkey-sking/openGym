// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../sheets.jsx', () => ({
  videoSyncSheet: vi.fn(),
}))

import VideoPill from './VideoPill.jsx'
import { useUI } from '../store/useUI.js'
import { videoSyncSheet } from '../sheets.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host, root

beforeEach(() => {
  vi.clearAllMocks()
  useUI.setState({ videoSync: { online: false } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async el => {
  await act(async () => {
    root.render(el)
  })
}

describe('VideoPill component', () => {
  it('renders nothing when entry has no video', async () => {
    await render(<VideoPill entry={{ id: 'bench_press' }} />)
    expect(host.firstChild).toBeNull()
  })

  it('renders formatted timestamp when entry has start time', async () => {
    const entry = {
      id: 'plank',
      videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD/?t=195',
    }
    await render(<VideoPill entry={entry} />)
    const button = host.querySelector('button.video-pill')
    expect(button).not.toBeNull()
    expect(button.textContent).toContain('3:15')
    expect(button.classList.contains('active')).toBe(false)
  })

  it('defaults to 0:00 when video URL has no timestamp', async () => {
    const entry = {
      id: 'squat',
      videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    }
    await render(<VideoPill entry={entry} />)
    const button = host.querySelector('button.video-pill')
    expect(button).not.toBeNull()
    expect(button.textContent).toContain('0:00')
  })

  it('shows active class and glowing dot when isCurrent and online', async () => {
    useUI.setState({ videoSync: { online: true } })
    const entry = {
      id: 'pushup',
      vstart: 45,
      videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    }
    await render(<VideoPill entry={entry} isCurrent={true} />)
    const button = host.querySelector('button.video-pill')
    expect(button).not.toBeNull()
    expect(button.textContent).toContain('0:45')
    expect(button.classList.contains('active')).toBe(true)
    expect(host.querySelector('.video-pill-dot')).not.toBeNull()
  })

  it('does not show active class when online is true but isCurrent is false', async () => {
    useUI.setState({ videoSync: { online: true } })
    const entry = {
      id: 'pushup',
      vstart: 45,
      videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    }
    await render(<VideoPill entry={entry} isCurrent={false} />)
    const button = host.querySelector('button.video-pill')
    expect(button).not.toBeNull()
    expect(button.classList.contains('active')).toBe(false)
    expect(host.querySelector('.video-pill-dot')).toBeNull()
  })

  it('triggers custom onClick or falls back to videoSyncSheet and stops propagation', async () => {
    const customClick = vi.fn()
    const parentClick = vi.fn()
    const entry = {
      id: 'squat',
      videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    }
    await render(
      <div onClick={parentClick}>
        <VideoPill entry={entry} onClick={customClick} />
      </div>
    )
    const button = host.querySelector('button.video-pill')

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(customClick).toHaveBeenCalledTimes(1)
    expect(parentClick).not.toHaveBeenCalled()

    // Test fallback to videoSyncSheet
    await render(<VideoPill entry={entry} />)
    const btn2 = host.querySelector('button.video-pill')
    act(() => {
      btn2.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(videoSyncSheet).toHaveBeenCalledTimes(1)
  })
})
