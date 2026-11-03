import { describe, expect, it } from 'vitest'
import { clockText, elapsedMs, isPaused, pauseActive, pausedMsAt, resumeActive, trainedEnd } from './workout-pause.js'

const START = 1_000_000
const at = s => START + s * 1000

describe('a paused workout', () => {
  it('freezes the clock and keeps the pause out of training time', () => {
    const a = pauseActive({ start: START, entries: [] }, at(60))
    expect(isPaused(a)).toBe(true)
    expect(a.pauseRev).toBe(1)
    expect(elapsedMs(a, at(60))).toBe(60_000)
    expect(elapsedMs(a, at(300))).toBe(60_000)
  })

  it('adds the stretch to pausedMs on resume and carries on from there', () => {
    const paused = pauseActive({ start: START }, at(60))
    const a = resumeActive(paused, at(120))
    expect(isPaused(a)).toBe(false)
    expect(a.pausedMs).toBe(60_000)
    expect(a.pauseRev).toBe(2)
    expect(elapsedMs(a, at(180))).toBe(120_000)
  })

  it('counts a second pause on top of the first', () => {
    let a = resumeActive(pauseActive({ start: START }, at(60)), at(120))
    a = pauseActive(a, at(180))
    expect(pausedMsAt(a, at(200))).toBe(80_000)
    a = resumeActive(a, at(240))
    expect(a.pausedMs).toBe(120_000)
    expect(elapsedMs(a, at(300))).toBe(180_000)
  })

  it('ignores a pause while paused and a resume while running', () => {
    const paused = pauseActive({ start: START }, at(60))
    expect(pauseActive(paused, at(90))).toBe(paused)
    const running = { start: START }
    expect(resumeActive(running, at(90))).toBe(running)
  })

  it('records a finished session without the paused stretch', () => {
    const a = resumeActive(pauseActive({ start: START }, at(60)), at(180))
    expect(trainedEnd(a, at(240))).toBe(at(120))
  })

  it('a session never paused is untouched', () => {
    const a = { start: START }
    expect(pausedMsAt(a, at(30))).toBe(0)
    expect(trainedEnd(a, at(30))).toBe(at(30))
    expect(elapsedMs(a, at(30))).toBe(30_000)
  })

  it('prints the clock the way the header does', () => {
    expect(clockText(0)).toBe('0:00')
    expect(clockText(65_000)).toBe('1:05')
    expect(clockText(3_600_000)).toBe('60:00')
  })
})
