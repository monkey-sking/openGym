/* The local relay's `online` is the extension's open stream, not a promise made by the phone.
   A workout screen that says "connected" while no computer is listening is worse than one that
   says it is offline: the pause buttons then look broken instead of absent. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRelay } from './local-server.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => {
  resolve(`http://127.0.0.1:${server.address().port}`)
}))

const close = async server => {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}

test('state reports no clients, a live extension, the linked phone, and stale phone app accurately', async () => {
  let clock = 1_000
  const relay = createRelay({ now: () => clock, phoneAppStaleMs: 6000 })
  const base = await listen(relay.server)
  const controller = new AbortController()
  try {
    const initialResponse = await fetch(`${base}/health`)
    const initial = await initialResponse.json()
    assert.equal(initialResponse.headers.get('cache-control'), 'no-store')
    assert.equal(initial.extensionConnected, false)
    assert.equal(initial.phoneAppConnected, false)
    assert.equal(initial.phoneConnected, false)

    const started = await (await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', source: 'app', sessionId: 's-42' })
    })).json()
    assert.equal(started.sessionId, 's-42')
    const phoneOnly = await (await fetch(`${base}/health`)).json()
    assert.equal(phoneOnly.phoneAppConnected, true)
    assert.equal(phoneOnly.extensionConnected, false)
    assert.equal(phoneOnly.phoneConnected, false, 'a phone command alone is not a live two-way connection')

    const stream = await fetch(`${base}/stream`, { signal: controller.signal })
    const reader = stream.body.getReader()
    await reader.read()
    const allThree = await (await fetch(`${base}/health`)).json()
    assert.equal(allThree.extensionConnected, true)
    assert.equal(allThree.phoneAppConnected, true)
    assert.equal(allThree.phoneConnected, true)

    await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'end', source: 'app', sessionId: null })
    })
    const ended = await (await fetch(`${base}/health`)).json()
    assert.equal(ended.sessionId, null)
    assert.equal(ended.phoneAppConnected, true)
    assert.equal(ended.phoneConnected, false)

    clock += 6001
    const stale = await (await fetch(`${base}/health`)).json()
    assert.equal(stale.phoneAppConnected, false)
    assert.equal(stale.phoneConnected, false)
  } finally {
    controller.abort()
    await close(relay.server)
  }
})

test('video-sync state responses are never cached by the browser or WebView', async () => {
  const relay = createRelay()
  const base = await listen(relay.server)
  try {
    for (const path of ['/state', '/api/video-sync/state']) {
      const response = await fetch(base + path)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
  } finally {
    await close(relay.server)
  }
})

test('a phone start is not online until the extension holds the stream', async () => {
  const relay = createRelay()
  const base = await listen(relay.server)
  try {
    const started = await (await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', source: 'app', sessionId: 's-42' })
    })).json()
    assert.equal(started.online, false, 'no extension is connected')

    const controller = new AbortController()
    const stream = await fetch(`${base}/stream`, { signal: controller.signal })
    assert.equal(stream.status, 200)
    const reader = stream.body.getReader()
    await reader.read()
    assert.equal((await (await fetch(`${base}/state`)).json()).online, true, 'the open stream is the desktop listening')

    controller.abort()
    let online = true
    for (let i = 0; i < 40 && online; i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      online = (await (await fetch(`${base}/state`)).json()).online
    }
    assert.equal(online, false, 'a closed stream takes the computer offline again')
  } finally {
    await close(relay.server)
  }
})

test('each relay process has its own epoch, so a restart can reuse seq 1', () => {
  const first = createRelay()
  const restarted = createRelay()
  const started = first.handleCommand({ action: 'start', source: 'app', sessionId: 's-42', play: true })
  assert.equal(started.seq, 1)
  assert.equal(started.play, true)
  assert.equal(typeof started.epoch, 'string')
  assert.notEqual(started.epoch, restarted.getState().epoch)
  assert.equal(restarted.getState().seq, 0)
})

test('the relay keeps playback intent and the video the app named', () => {
  const relay = createRelay()
  const video = 'https://www.bilibili.com/video/BV1ab411c7mE'
  const start = relay.handleCommand({ action: 'start', source: 'app', sessionId: 's-1', videoUrl: video, play: true })
  assert.equal(start.play, true)
  assert.equal(start.videoUrl, video)

  const attach = relay.handleCommand({ action: 'start', source: 'app', sessionId: 's-1', videoUrl: video })
  assert.equal(attach.play, null, 'a reload leaves playback alone')
  assert.equal(attach.videoUrl, video)

  const paused = relay.handleCommand({ action: 'start', source: 'app', sessionId: 's-1', videoUrl: video, play: false })
  assert.equal(paused.play, false, 'an explicit paused start is kept')
  const resume = relay.handleCommand({ action: 'resume', source: 'app', sessionId: 's-1', play: false })
  assert.equal(resume.play, null, 'only start carries playback intent')
  assert.equal(resume.videoUrl, null, 'an app command without a URL does not inherit one')

  relay.handleCommand({ action: 'start', source: 'app', sessionId: 's-1', videoUrl: video })
  const browser = relay.handleCommand({ action: 'pause', source: 'video' })
  assert.equal(browser.videoUrl, video, 'a browser event keeps the video the app named')

  const end = relay.handleCommand({ action: 'end', source: 'app' })
  assert.equal(end.sessionId, null)
  assert.equal(end.videoUrl, null)
})

test("relay generates and verifies 4-character pairing code", async t => {
  const { server } = createRelay()
  t.after(() => server.close())
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port

  // 1. Get code
  const codeRes = await fetch(`http://127.0.0.1:${port}/pair/code`)
  assert.equal(codeRes.status, 200)
  const codeData = await codeRes.json()
  assert.equal(codeData.ok, true)
  assert.match(codeData.code, /^[2-9A-Z]{4}$/)
  assert.ok(codeData.port > 0)

  // 2. Verify code
  const verifyRes = await fetch(`http://127.0.0.1:${port}/pair/verify?code=${codeData.code}`)
  assert.equal(verifyRes.status, 200)
  const verifyData = await verifyRes.json()
  assert.equal(verifyData.ok, true)
  assert.equal(verifyData.code, codeData.code)

  // 3. Verify bad code
  const badRes = await fetch(`http://127.0.0.1:${port}/pair/verify?code=WRONG`)
  assert.equal(badRes.status, 404)
})
