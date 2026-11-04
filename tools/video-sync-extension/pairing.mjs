// Pairing code helper for openGym video sync.
// Generates and verifies 4-character human-friendly codes (uppercase alphanumeric, excluding ambiguous characters: 0, O, 1, I, L)
// Codes expire after a TTL (default 10 minutes) and map to the host's LAN IPs/port or relay endpoints.

import { randomBytes } from 'node:crypto'

export const PAIRING_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000 // 10 minutes

export function generatePairCode(length = 4) {
  const bytes = randomBytes(length)
  let code = ''
  for (let i = 0; i < length; i++) {
    code += PAIRING_CHARS[bytes[i] % PAIRING_CHARS.length]
  }
  return code
}

export function normalizePairCode(raw) {
  if (typeof raw !== 'string') return ''
  let code = raw.trim().toUpperCase()
    .replace(/0/g, 'O')
    .replace(/[IL]/g, '1')
    .replace(/[^2-9A-Z]/g, '')
  return code.slice(0, 8)
}

export function createPairingRegistry({ ttlMs = DEFAULT_PAIRING_TTL_MS, now = Date.now } = {}) {
  const entries = new Map()

  function cleanExpired() {
    const currentTime = now()
    for (const [key, val] of entries.entries()) {
      if (val.expiresAt <= currentTime) {
        entries.delete(key)
      }
    }
  }

  function register({ ips = [], port = 8787, url = null, code = null } = {}) {
    cleanExpired()
    let selectedCode = code ? normalizePairCode(code) : ''
    if (!selectedCode || entries.has(selectedCode)) {
      let attempts = 0
      do {
        selectedCode = generatePairCode(4)
        attempts++
      } while (entries.has(selectedCode) && attempts < 100)
    }

    const currentTime = now()
    const record = {
      code: selectedCode,
      createdAt: currentTime,
      expiresAt: currentTime + ttlMs,
      ips: Array.isArray(ips) ? ips : [],
      port: Number(port) || 8787,
      url: typeof url === 'string' && url ? url : null,
      bound: false
    }
    entries.set(selectedCode, record)
    return record
  }

  function lookup(rawCode) {
    cleanExpired()
    const code = normalizePairCode(rawCode)
    if (!code) return null
    const record = entries.get(code)
    if (!record) return null
    if (record.expiresAt <= now()) {
      entries.delete(code)
      return null
    }
    return { ...record }
  }

  function bind(rawCode) {
    const record = lookup(rawCode)
    if (!record) return null
    record.bound = true
    entries.set(record.code, record)
    return record
  }

  function count() {
    cleanExpired()
    return entries.size
  }

  return {
    register,
    lookup,
    bind,
    count
  }
}
