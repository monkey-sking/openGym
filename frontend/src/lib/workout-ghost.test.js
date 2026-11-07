import { describe, it, expect } from 'vitest'
import { ghostValueOf, autoFillGhostSet } from './workout-ghost.js'

describe('workout-ghost', () => {
  it('reads ghost values from previous set in the same workout', () => {
    const entry = {
      id: 'barbell_bench_press',
      target: { mode: 'reps', reps: 8, weight: 60 },
      sets: [
        { w: 70, r: 10, done: true },
        { w: null, r: 0, done: false },
      ],
    }

    expect(ghostValueOf(entry, 1, 'w')).toBe(70)
    expect(ghostValueOf(entry, 1, 'r')).toBe(10)
  })

  it('falls back to target when no previous set exists', () => {
    const entry = {
      id: 'barbell_bench_press',
      target: { mode: 'reps', reps: 12, weight: 50 },
      sets: [
        { w: null, r: null, done: false },
      ],
    }

    expect(ghostValueOf(entry, 0, 'w')).toBe(50)
    expect(ghostValueOf(entry, 0, 'r')).toBe(12)
  })

  it('supports per-side ghost values', () => {
    const entry = {
      id: 'dumbbell_lunge',
      target: { mode: 'reps', reps: 10, weight: 16 },
      sets: [
        { done: true, sides: { L: { w: 18, r: 8, done: true }, R: { w: 18, r: 8, done: true } } },
        { done: false, sides: { L: { w: 0, r: 0, done: false }, R: { w: 0, r: 0, done: false } } },
      ],
    }

    expect(ghostValueOf(entry, 1, 'w', null, 'L')).toBe(18)
    expect(ghostValueOf(entry, 1, 'r', null, 'L')).toBe(8)
  })

  it('auto-fills empty set on checkmark tap', () => {
    const entry = {
      id: 'barbell_squat',
      target: { mode: 'reps', reps: 5, weight: 100 },
      sets: [
        { w: 105, r: 5, done: true },
        { w: null, r: 0, done: false },
      ],
    }

    const changed = autoFillGhostSet(entry, 1)
    expect(changed).toBe(true)
    expect(entry.sets[1].w).toBe(105)
    expect(entry.sets[1].r).toBe(5)
  })

  it('does not overwrite existing values in autoFillGhostSet', () => {
    const entry = {
      id: 'barbell_squat',
      target: { mode: 'reps', reps: 5, weight: 100 },
      sets: [
        { w: 105, r: 5, done: true },
        { w: 110, r: 3, done: false },
      ],
    }

    const changed = autoFillGhostSet(entry, 1)
    expect(changed).toBe(false)
    expect(entry.sets[1].w).toBe(110)
    expect(entry.sets[1].r).toBe(3)
  })

  it('auto-fills timed holds and cardio', () => {
    const timedEntry = {
      id: 'plank',
      target: { mode: 'time', sec: 60 },
      sets: [{ sec: null, done: false }],
    }
    autoFillGhostSet(timedEntry, 0)
    expect(timedEntry.sets[0].sec).toBe(60)

    const cardioEntry = {
      id: 'treadmill',
      target: { mode: 'cardio', min: 25, speed: 9.5 },
      sets: [{ min: null, speed: null, done: false }],
    }
    autoFillGhostSet(cardioEntry, 0)
    expect(cardioEntry.sets[0].min).toBe(25)
    expect(cardioEntry.sets[0].speed).toBe(9.5)
  })
})
