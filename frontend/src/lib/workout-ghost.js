// Ghost values (reference values for workout sets):
// When a set row's inputs are empty, this module provides the previous set or planned target
// as a ghost value for placeholder display and single-tap checkmark auto-fill.

import { lastEntryFor } from './history.js'

/**
 * Returns the ghost reference value for a specific field in a set row.
 * Searches:
 * 1. Preceding sets in the current entry (i - 1 down to 0)
 * 2. Planned target on the entry
 * 3. Most recent session from history if available
 */
export function ghostValueOf(entry, setIdx, field, S = null, side = null) {
  if (!entry || setIdx == null) return null

  // 1. Check preceding sets in this workout entry
  const sets = entry.sets || []
  for (let j = setIdx - 1; j >= 0; j--) {
    const s = sets[j]
    if (!s) continue
    if (side && s.sides && s.sides[side]) {
      const val = s.sides[side][field]
      if (val != null && val !== '' && (field === 'r' ? val > 0 : true)) return val
    }
    const val = s[field]
    if (val != null && val !== '' && (field === 'r' ? val > 0 : true)) return val
  }

  // 2. Check target / planned values on the entry
  const target = entry.target || {}
  const planned = entry.planned || {}
  if (field === 'r') {
    const r = target.reps ?? planned.reps ?? target.repsMin
    if (typeof r === 'number' && r > 0) return r
  }
  if (field === 'w') {
    const w = target.weight ?? target.w ?? planned.weight
    if (typeof w === 'number') return w
  }
  if (field === 'sec') {
    const sec = target.sec ?? planned.sec
    if (typeof sec === 'number' && sec > 0) return sec
  }
  if (field === 'min') {
    const min = target.min ?? planned.min
    if (typeof min === 'number' && min > 0) return min
  }
  if (field === 'speed') {
    const speed = target.speed ?? planned.speed
    if (typeof speed === 'number' && speed > 0) return speed
  }

  // 3. Fall back to previous history if state S is provided
  if (S && entry.id) {
    const last = lastEntryFor(S, entry.id)
    if (last && last.sets && last.sets.length > 0) {
      const row = last.sets[setIdx] || last.sets[last.sets.length - 1]
      if (row && row[field] != null && (field === 'r' ? row[field] > 0 : true)) {
        return row[field]
      }
    }
  }

  return null
}

/**
 * When marking a set done, auto-fills missing / empty fields with their ghost reference values.
 * Returns true if any field was updated.
 */
export function autoFillGhostSet(entry, setIdx, side = null, S = null) {
  if (!entry?.sets?.[setIdx]) return false
  const set = entry.sets[setIdx]
  let filled = false

  if (side) {
    if (!set.sides) set.sides = {}
    if (!set.sides[side]) set.sides[side] = { w: 0, r: 0, done: false }
    const sd = set.sides[side]
    if (sd.r == null || sd.r === 0 || sd.r === '') {
      const ghostR = ghostValueOf(entry, setIdx, 'r', S, side)
      if (ghostR > 0) { sd.r = ghostR; filled = true }
    }
    if (sd.w == null || sd.w === '') {
      const ghostW = ghostValueOf(entry, setIdx, 'w', S, side)
      if (ghostW != null) { sd.w = ghostW; filled = true }
    }
    return filled
  }

  const mode = entry.target?.mode || 'reps'
  if (mode === 'cardio') {
    if (set.min == null || set.min === 0 || set.min === '') {
      const ghostMin = ghostValueOf(entry, setIdx, 'min', S)
      if (ghostMin > 0) { set.min = ghostMin; filled = true }
    }
    if (set.speed == null || set.speed === 0 || set.speed === '') {
      const ghostSpeed = ghostValueOf(entry, setIdx, 'speed', S)
      if (ghostSpeed > 0) { set.speed = ghostSpeed; filled = true }
    }
  } else if (mode === 'time') {
    if (set.sec == null || set.sec === 0 || set.sec === '') {
      const ghostSec = ghostValueOf(entry, setIdx, 'sec', S)
      if (ghostSec > 0) { set.sec = ghostSec; filled = true }
    }
  } else {
    // reps mode
    if (set.r == null || set.r === 0 || set.r === '') {
      const ghostR = ghostValueOf(entry, setIdx, 'r', S)
      if (ghostR > 0) { set.r = ghostR; filled = true }
    }
    if (set.w == null || set.w === '') {
      const ghostW = ghostValueOf(entry, setIdx, 'w', S)
      if (ghostW != null) { set.w = ghostW; filled = true }
    }
  }
  return filled
}
