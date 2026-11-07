import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Window } from '../../frontend/node_modules/happy-dom/lib/index.js'

const source = fs.readFileSync(new URL('./content.js', import.meta.url), 'utf8')
let window
let restoreInterval

afterEach(() => {
  restoreInterval?.()
  restoreInterval = null
  window?.close()
  window = null
  delete globalThis.__openGymVideoSync
})

async function loadVideo (currentTime, { paused = true, held = false } = {}) {
  window = new Window({ url: 'https://www.bilibili.com/video/BV1xx411c7mD/' })
  globalThis.window = window
  globalThis.document = window.document
  globalThis.location = window.location
  globalThis.HTMLVideoElement = window.HTMLVideoElement
  globalThis.MutationObserver = window.MutationObserver

  let listener
  const sent = []
  globalThis.chrome = {
    runtime: {
      sendMessage: async message => {
        sent.push(message)
        if (message?.type === 'og:hold?') return { held }
        return { ok: true }
      },
      onMessage: { addListener: fn => { listener = fn } }
    }
  }

  const interval = globalThis.setInterval
  globalThis.setInterval = () => 0
  restoreInterval = () => { globalThis.setInterval = interval }

  const video = document.createElement('video')
  Object.defineProperties(video, {
    duration: { value: 120, configurable: true },
    readyState: { value: 2, configurable: true },
    ended: { value: false, configurable: true },
    paused: { value: paused, writable: true, configurable: true },
    currentTime: { value: currentTime, writable: true, configurable: true }
  })
  video.play = async () => { video.paused = false }
  video.pause = () => { video.paused = true }
  video.getBoundingClientRect = () => ({ width: 640, height: 360 })
  document.body.append(video)
  ;(0, eval)(source)

  const command = async cmd => new Promise(resolve => {
    listener({ type: 'og:command', ...cmd }, null, resolve)
  })
  command.hold = value => new Promise(resolve => {
    listener({ type: 'og:hold', held: value }, null, resolve)
  })
  command.sent = sent
  command.video = video
  return command
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('leaves currentTime alone when the clocks are within the soft-sync threshold', async () => {
  const command = await loadVideo(100)
  const result = await command({ action: 'seek', pos: 101.4, offset: 0, force: false })
  assert.equal(result.seeked, false)
  assert.equal(document.querySelector('video').currentTime, 100)
})

test('snaps when the clocks differ by more than 1.5 seconds', async () => {
  const command = await loadVideo(100)
  const result = await command({ action: 'seek', pos: 102, offset: 0, force: false })
  assert.equal(result.seeked, true)
  assert.equal(document.querySelector('video').currentTime, 102)
})

test('manual nudges and chapter boundaries can force an exact seek', async () => {
  const command = await loadVideo(100)
  const result = await command({ action: 'seek', pos: 103, offset: -1, force: true })
  assert.equal(result.seeked, true)
  assert.equal(document.querySelector('video').currentTime, 102)
})

test('a resume puts the video back on the workout clock before it plays', async () => {
  const command = await loadVideo(100)
  const result = await command({ action: 'resume', pos: 103, offset: -1, force: true })
  assert.equal(result.ok, true)
  assert.equal(result.seeked, true)
  assert.equal(result.target, 102)
  assert.equal(result.paused, false)
  assert.equal(document.querySelector('video').currentTime, 102)
})

test('a resume without a forced position leaves the video where it is', async () => {
  const command = await loadVideo(100)
  const result = await command({ action: 'resume' })
  assert.equal(result.ok, true)
  assert.equal(result.seeked, undefined)
  assert.equal(document.querySelector('video').currentTime, 100)
  assert.equal(result.paused, false)
})

test('a page opened held pauses its first playable video instead of autoplaying', async () => {
  const command = await loadVideo(0, { paused: false, held: true })
  await tick()
  assert.equal(command.video.paused, true, 'the autoplay was stopped as soon as the video could play')
  assert.equal(command.sent.some(message => message.type === 'og:hold?'), true)
})

test('an autoplay attempt while held is paused again', async () => {
  const command = await loadVideo(0)
  await command.hold(true)
  assert.equal(command.video.paused, true)

  command.video.paused = false
  command.video.dispatchEvent(new window.Event('play'))
  await tick()

  assert.equal(command.video.paused, true, 'the hold still wins over a new play request')
})

test('an explicit resume clears the hold and plays, and does not re-pause later', async () => {
  const command = await loadVideo(0, { paused: false })
  await command.hold(true)
  assert.equal(command.video.paused, true)

  const result = await command({ action: 'resume' })
  assert.equal(result.ok, true)
  assert.equal(command.video.paused, false)

  command.video.dispatchEvent(new window.Event('play'))
  await tick()
  assert.equal(command.video.paused, false, 'the cleared hold cannot leak into a normal resume')
})
