// @vitest-environment happy-dom
// The pre-workout check on the start screen (views/Workout.jsx): with Apple Health off the Apple
// Watch measures nothing at all, so the state is named — and can still be fixed — before the
// workout starts, not after it is over with no heart rate in the log.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  health: { status: 'available', platform: 'ios', on: false },
  watch: { paired: true, installed: true },
}))

vi.mock('../lib/health-sync.js', async orig => ({
  ...(await orig()),
  healthStatus: () => Promise.resolve({ status: h.health.status, platform: h.health.platform, granted: true }),
  loadHealth: () => Promise.resolve({ on: h.health.on }),
  onHealthChange: () => () => {},
}))
vi.mock('../lib/watch-sync.js', async orig => ({
  ...(await orig()),
  watchStatus: () => Promise.resolve(h.watch),
}))
vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), chime: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})), beacon: vi.fn(), appBase: () => '/' }))

import Workout from './Workout.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = v => JSON.parse(JSON.stringify(v))
let root, container

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
const text = () => container.textContent
const button = label => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === label)

beforeEach(() => {
  localStorage.clear()
  h.health = { status: 'available', platform: 'ios', on: false }
  h.watch = { paired: true, installed: true }
  const S = clone(DEF)
  S.active = null
  useStore.setState({ S, user: null })
  useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null, swipeHint: null })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  useUI.getState().stopRest()
})

const mount = async () => { act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>)); await settle() }

describe('the check before a workout starts', () => {
  it('says Apple Health is off, and offers to open it, while it is still off', async () => {
    await mount()
    expect(text()).toContain('Your workouts in Apple Health')
    expect(text()).toContain('Turn on Apple Health and the watch measures your heart rate for every set.')
    expect(button('Open Apple Health')).toBeTruthy()
  })

  it('is out of the way once Apple Health is on and the watch has the app', async () => {
    h.health.on = true
    await mount()
    expect(text()).not.toContain('Your workouts in Apple Health')
  })

  it('names the watch app when the phone is paired but it is not installed there', async () => {
    h.health.on = true
    h.watch = { paired: true, installed: false }
    await mount()
    expect(text()).toContain('openGym is not on your Apple Watch yet. Install it in the Watch app.')
  })

  it('keeps a phone without Apple Health, and an Android one, quiet', async () => {
    h.health.status = 'unsupported'
    await mount()
    expect(text()).not.toContain('Your workouts in Apple Health')

    act(() => root.unmount()); container.remove()
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    h.health = { status: 'available', platform: 'android', on: false }
    h.watch = { paired: false, installed: false }
    await mount()
    expect(text()).not.toContain('Your workouts in Apple Health')   // the watch app is the iPhone's: Health Connect has its own switch
  })

  it('stays away for a week once it is set aside', async () => {
    await mount()
    act(() => { button('Not now').click() })
    await settle()
    expect(text()).not.toContain('Your workouts in Apple Health')
    expect(Number(localStorage.getItem('gym_preflight_snooze'))).toBeGreaterThan(0)
  })
})
