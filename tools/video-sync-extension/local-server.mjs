// Zero-dependency local video sync relay for openGym.
//
// Runs on the computer (Mac/Windows/Linux) where the video is playing.
// Connects the phone (via Wi-Fi LAN HTTP) and the Chrome extension (via localhost SSE/HTTP)
// without requiring an external server or account login.
//
// Endpoints:
//   GET  /state          Returns current snapshot { epoch, seq, action, source, sessionId, videoUrl, pos, offset, force, play, online, at }
//   POST /command        Receives commands from phone or extension, broadcasts to SSE clients
//   GET  /stream         SSE event stream for Chrome extension (or web clients)
//   GET  /health         Connection facts and LAN addresses for discovery/diagnostics

import http from 'node:http'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createPairingRegistry } from './pairing.mjs'

export const PORT = Number(process.env.OPEN_GYM_SYNC_PORT) || 8787
export const PHONE_APP_STALE_MS = 6000

export function createRelay({ now = Date.now, phoneAppStaleMs = PHONE_APP_STALE_MS } = {}) {
  const pairing = createPairingRegistry({ now })
  // Each relay process numbers its own commands. The phone and extension use this to tell a
  // restarted relay's seq 1 from the seq 87 they had already applied.
  const epoch = randomUUID()
  let state = {
    epoch,
    seq: 0,
    action: null,
    source: null,
    sessionId: null,
    videoUrl: null,
    pos: null,
    offset: 0,
    force: false,
    play: null,
    online: false,
    at: Date.now()
  }
  const sseClients = new Set()
  let lastAppAt = 0

  const markAppSeen = () => { lastAppAt = now() }
  const appIsPresent = () => lastAppAt > 0 && now() - lastAppAt <= phoneAppStaleMs

  function connectionInfo() {
    const extensionConnected = sseClients.size > 0
    const phoneAppConnected = appIsPresent()
    return {
      version: 1,
      clients: sseClients.size,
      extensionConnected,
      phoneAppConnected,
      phoneConnected: phoneAppConnected && extensionConnected && !!state.sessionId,
      lastAppAt: lastAppAt || null,
      sessionId: state.sessionId,
      action: state.action,
      stateAt: state.at
    }
  }

  function getLanIps() {
    const interfaces = os.networkInterfaces()
    const ips = []
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push(iface.address)
        }
      }
    }
    return ips
  }

  function broadcast(st) {
    const payload = `data: ${JSON.stringify(st)}\n\n`
    for (const res of sseClients) {
      try { res.write(payload) } catch { /* client disconnected */ }
    }
  }

  function handleCommand(body) {
    if (!body || typeof body !== 'object') return state
    const { action, source, sessionId, videoUrl, pos, offset, force } = body
    if (source === 'app') markAppSeen()
    const nextSeq = state.seq + 1
    // Online is an observation, not a promise: only the extension holding the stream makes it
    // true. A phone's `start` must not announce a computer that never connected (the workout
    // screen would then claim sync is live while nothing is listening).
    const isOnline = sseClients.size > 0
    const namedUrl = typeof videoUrl === 'string' && /^https?:\/\//i.test(videoUrl) ? videoUrl : null
    state = {
      epoch,
      seq: nextSeq,
      action: action || null,
      source: source || 'unknown',
      // `end` names no workout; keeping the old one would let a late event resume the next one.
      sessionId: action === 'end' ? null : (sessionId || state.sessionId),
      // The app owns the named video; a browser event without one keeps what the app named.
      videoUrl: action === 'end' ? null : source === 'video' ? (namedUrl || state.videoUrl) : namedUrl,
      pos: typeof pos === 'number' && Number.isFinite(pos) ? pos : null,
      offset: typeof offset === 'number' && Number.isFinite(offset) ? offset : (state.offset || 0),
      force: !!force,
      // A fresh start plays (true), an attach leaves playback alone (null), an explicit paused
      // start holds it paused (false). Only start carries an intent.
      play: action === 'start' && typeof body.play === 'boolean' ? body.play : null,
      online: isOnline,
      at: Date.now()
    }
    broadcast(state)
    return state
  }

  const server = http.createServer((req, res) => {
    // Open CORS headers for phone App (Capacitor localhost) and extension
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && pathname === '/pair/code') {
      const ips = getLanIps()
      const record = pairing.register({ ips, port: PORT, url: `http://127.0.0.1:${PORT}` })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, code: record.code, expiresAt: record.expiresAt, ips, port: PORT }))
      return
    }

    if (req.method === 'GET' && pathname === '/pair/verify') {
      const code = url.searchParams.get('code')
      const record = pairing.lookup(code)
      if (!record) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'invalid or expired pairing code' }))
        return
      }
      pairing.bind(code)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, code: record.code, ips: record.ips, port: record.port, url: record.url }))
      return
    }

    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      })
      res.end(JSON.stringify({ ok: true, ips: getLanIps(), ...connectionInfo() }))
      return
    }

    if (req.method === 'GET' && (pathname === '/state' || pathname === '/api/video-sync/state')) {
      markAppSeen()
      const info = connectionInfo()
      const current = { ...state, online: info.extensionConnected, ...info }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      })
      res.end(JSON.stringify(current))
      return
    }

    if (req.method === 'GET' && (pathname === '/stream' || pathname === '/api/video-sync/stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      })
      sseClients.add(res)
      // Send initial snapshot
      res.write(`data: ${JSON.stringify({ ...state, online: true })}\n\n`)
      // Keep alive heartbeat every 20s
      const pingTimer = setInterval(() => {
        try { res.write(': ping\n\n') } catch { clearInterval(pingTimer) }
      }, 20000)
      req.on('close', () => {
        clearInterval(pingTimer)
        sseClients.delete(res)
      })
      return
    }

    if (req.method === 'POST' && (pathname === '/command' || pathname === '/api/video-sync/command')) {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const next = handleCommand(parsed)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(next))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  return { server, getLanIps, getState: () => state, handleCommand, pairing }
}

if (process.argv[1] && process.argv[1].endsWith('local-server.mjs')) {
  const { spawn } = await import('node:child_process')
  const { server, getLanIps } = createRelay()

  let bonjourProc = null
  function startBonjour(port) {
    if (process.platform !== 'darwin') return
    try {
      bonjourProc = spawn('/usr/bin/dns-sd', ['-R', 'openGym Video Sync', '_opengym._tcp', 'local.', String(port)], {
        stdio: 'ignore'
      })
      bonjourProc.on('error', () => { bonjourProc = null })
    } catch {
      bonjourProc = null
    }
  }

  function stopBonjour() {
    if (bonjourProc) {
      try { bonjourProc.kill('SIGTERM') } catch {}
      bonjourProc = null
    }
  }

  process.on('SIGINT', () => { stopBonjour(); process.exit(0) })
  process.on('SIGTERM', () => { stopBonjour(); process.exit(0) })
  process.on('exit', () => stopBonjour())

  server.listen(PORT, '0.0.0.0', () => {
    startBonjour(PORT)
    const ips = getLanIps()
    console.log(`\n========================================`)
    console.log(` openGym Video Sync Local Server`)
    console.log(`========================================`)
    console.log(`\nRunning at:`)
    console.log(` - Local:    http://127.0.0.1:${PORT}`)
    for (const ip of ips) {
      console.log(` - Wi-Fi:    http://${ip}:${PORT}`)
    }
    console.log(` - Bonjour:  _opengym._tcp. (automatic discovery on iPhone)`)
    console.log(`\nHow to use:`)
    console.log(` 1. In Chrome extension popup: enter http://127.0.0.1:${PORT}`)
    console.log(` 2. On iPhone: open Workout ⋯ menu -> Video sync -> automatically discovered!`)
    console.log(` 3. Play video in Chrome, start workout on phone.`)
    console.log(`========================================\n`)
  })
}
