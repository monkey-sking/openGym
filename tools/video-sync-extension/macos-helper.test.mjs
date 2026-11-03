import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const buildScript = join(root, 'macos', 'build-helper.sh')
const app = join(root, 'build', 'openGym Video Sync.app')
const executable = join(app, 'Contents', 'MacOS', 'openGymVideoSync')
const buildInputs = [
  join(root, 'macos', 'main.swift'),
  join(root, 'macos', 'Info.plist'),
  buildScript
]

function buildHelperIfNeeded() {
  const executableIsCurrent = existsSync(executable) &&
    buildInputs.every(input => statSync(executable).mtimeMs >= statSync(input).mtimeMs)
  if (executableIsCurrent) return
  const moduleCache = join(os.tmpdir(), 'opengym-video-sync-test-module-cache')
  const tempHome = join(os.tmpdir(), 'opengym-video-sync-test-home')
  mkdirSync(moduleCache, { recursive: true })
  mkdirSync(tempHome, { recursive: true })
  const result = spawnSync('zsh', [buildScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tempHome,
      CLANG_MODULE_CACHE_PATH: moduleCache
    }
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

function collectLines(child) {
  let buffer = ''
  let stderr = ''
  const lines = []
  const waiters = new Set()

  const check = () => {
    for (const waiter of [...waiters]) {
      for (let index = waiter.from; index < lines.length; index++) {
        const match = lines[index].match(waiter.pattern)
        if (!match) continue
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
        waiter.resolve(match)
        break
      }
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, newline).replace(/\r$/, ''))
      buffer = buffer.slice(newline + 1)
    }
    check()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })

  child.on('exit', (code, signal) => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.reject(new Error(
        `helper exited before ${waiter.pattern} (code=${code}, signal=${signal})\n${stderr}`
      ))
    }
  })

  return {
    lines,
    stderr: () => stderr,
    waitFor(pattern, { from = 0, timeout = 6000 } = {}) {
      return new Promise((resolve, reject) => {
        const waiter = { pattern, from, resolve, reject, timer: null }
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(
            `timed out waiting for ${pattern}; output=${JSON.stringify(lines)}\n${stderr}`
          ))
        }, timeout)
        waiters.add(waiter)
        check()
      })
    }
  }
}

function startHelper(args) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  return { child, output: collectLines(child) }
}

async function stopHelper(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), 2500))
  if (await Promise.race([exited.then(() => 'exited'), timeout]) === 'timeout') {
    child.kill('SIGKILL')
    await once(child, 'exit').catch(() => {})
  }
}

async function startRelay(args = ['--port', '0']) {
  const helper = startHelper(['--relay-test', ...args])
  const match = await helper.output.waitFor(/^READY (\d+)$/, { timeout: 8000 })
  const port = Number(match[1])
  return { ...helper, port, base: `http://127.0.0.1:${port}` }
}

async function waitForHealth(base, predicate, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout
  let lastHealth = null
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/health`).catch(() => null)
    if (response?.ok) {
      lastHealth = await response.json().catch(() => null)
      if (lastHealth && predicate(lastHealth)) return lastHealth
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for relay health; last=${JSON.stringify(lastHealth)}`)
}

function createSSEParser(reader) {
  const decoder = new TextDecoder()
  let buffer = ''

  return async function nextEvent({ timeout = 3000 } = {}) {
    const deadline = Date.now() + timeout
    while (true) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (data) return JSON.parse(data)
        continue
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('timed out waiting for SSE event')
      let timer
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out waiting for SSE event')), remaining)
        })
      ]).finally(() => clearTimeout(timer))
      if (result.done) throw new Error('SSE stream ended unexpectedly')
      buffer += decoder.decode(result.value, { stream: true })
    }
  }
}

before(buildHelperIfNeeded)

test('native relay keeps the extension HTTP/SSE protocol and connection health', async () => {
  const relay = await startRelay()
  const controller = new AbortController()
  try {
    const healthResponse = await fetch(`${relay.base}/health`)
    const health = await healthResponse.json()
    assert.equal(healthResponse.status, 200)
    assert.equal(healthResponse.headers.get('cache-control'), 'no-store')
    assert.equal(health.ok, true)
    assert.equal(health.relayKind, 'mac-menu-bar')
    assert.equal(health.extensionConnected, false)
    assert.equal(health.phoneConnected, false)
    assert.ok(Array.isArray(health.ips))
    assert.deepEqual(health.bonjourService, {
      name: 'openGym Video Sync',
      type: '_opengym._tcp.',
      domain: 'local.'
    })

    const discoveredHealth = await waitForHealth(
      relay.base,
      value => value.bonjourPublished === true
    )
    assert.equal(discoveredHealth.bonjourPublished, true)

    const initialResponse = await fetch(`${relay.base}/api/video-sync/state`)
    const initialState = await initialResponse.json()
    assert.equal(initialResponse.headers.get('cache-control'), 'no-store')
    assert.match(initialState.epoch, /^[0-9a-f-]{36}$/)
    assert.equal(initialState.seq, 0)
    assert.equal(initialState.sessionId, null)

    const stream = await fetch(`${relay.base}/api/video-sync/stream`, {
      signal: controller.signal
    })
    assert.equal(stream.status, 200)
    assert.match(stream.headers.get('content-type'), /^text\/event-stream/)
    assert.equal(stream.headers.get('cache-control'), 'no-cache, no-transform')
    const nextEvent = createSSEParser(stream.body.getReader())
    const first = await nextEvent()
    assert.equal(first.epoch, initialState.epoch)
    assert.equal(first.seq, 0)
    assert.equal(first.online, true)

    const commandResponse = await fetch(`${relay.base}/api/video-sync/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        source: 'app',
        sessionId: 'native-test-session',
        videoUrl: 'https://www.bilibili.com/video/BV1ab411c7mE',
        play: true,
        pos: 12.5,
        offset: 0
      })
    })
    const command = await commandResponse.json()
    assert.equal(commandResponse.status, 200)
    assert.equal(command.epoch, initialState.epoch)
    assert.equal(command.seq, 1)
    assert.equal(command.sessionId, 'native-test-session')
    assert.equal(command.videoUrl, 'https://www.bilibili.com/video/BV1ab411c7mE')
    assert.equal(command.play, true)

    const broadcast = await nextEvent()
    assert.equal(broadcast.seq, 1)
    assert.equal(broadcast.action, 'start')
    assert.equal(broadcast.sessionId, 'native-test-session')

    const connected = await (await fetch(`${relay.base}/health`)).json()
    assert.equal(connected.extensionConnected, true)
    assert.equal(connected.phoneAppConnected, true)
    assert.equal(connected.phoneConnected, true)
    assert.equal(connected.sessionId, 'native-test-session')

    const options = await fetch(`${relay.base}/command`, { method: 'OPTIONS' })
    assert.equal(options.status, 204)
    assert.equal(options.headers.get('access-control-allow-origin'), '*')
  } finally {
    controller.abort()
    await stopHelper(relay.child)
  }
})

test('occupied port reports a retry and recovers when the port becomes available', async () => {
  const blocker = net.createServer()
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, resolve)
  })
  const port = blocker.address().port
  const relay = startHelper([
    '--relay-test',
    '--port', String(port),
    '--retry-ms', '150'
  ])

  try {
    await relay.output.waitFor(/^RETRY /, { timeout: 6000 })
    await new Promise(resolve => blocker.close(resolve))
    const ready = await relay.output.waitFor(/^READY (\d+)$/, {
      from: relay.output.lines.findIndex(line => line.startsWith('RETRY ')) + 1,
      timeout: 6000
    })
    assert.equal(Number(ready[1]), port)
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.relayKind, 'mac-menu-bar')
  } finally {
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve))
    await stopHelper(relay.child)
  }
})

test('automatic user setup stays inside a temporary home and starts the copied app at sign-in', () => {
  const home = mkdtempSync(join(os.tmpdir(), 'opengym-video-sync-install-'))
  try {
    const result = spawnSync(executable, [
      '--install-test',
      '--home', home,
      '--app-path', app
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const installed = JSON.parse(result.stdout.trim())
    assert.equal(installed.ok, true)

    const expectedApp = join(home, 'Applications', 'openGym Video Sync.app')
    const expectedPlist = join(home, 'Library', 'LaunchAgents', 'ai.opengym.video-sync-relay.plist')
    const expectedProgram = join(
      expectedApp,
      'Contents',
      'MacOS',
      'openGymVideoSync'
    )
    assert.equal(installed.installedApp, expectedApp)
    assert.equal(installed.plist, expectedPlist)
    assert.equal(installed.program, expectedProgram)
    assert.ok(existsSync(expectedProgram))
    assert.ok(existsSync(expectedPlist))

    const launchProgram = execFileSync('/usr/bin/plutil', [
      '-extract', 'ProgramArguments.0', 'raw', expectedPlist
    ], { encoding: 'utf8' }).trim()
    assert.equal(launchProgram, expectedProgram)
    const runAtLoad = execFileSync('/usr/bin/plutil', [
      '-extract', 'RunAtLoad', 'raw', expectedPlist
    ], { encoding: 'utf8' }).trim()
    assert.equal(runAtLoad, 'true')
    const bundleID = execFileSync('/usr/bin/plutil', [
      '-extract', 'CFBundleIdentifier', 'raw',
      join(expectedApp, 'Contents', 'Info.plist')
    ], { encoding: 'utf8' }).trim()
    assert.equal(bundleID, 'ai.opengym.video-sync')

    const removed = spawnSync(executable, [
      '--uninstall-test',
      '--home', home
    ], { encoding: 'utf8' })
    assert.equal(removed.status, 0, removed.stderr)
    assert.equal(JSON.parse(removed.stdout.trim()).ok, true)
    assert.equal(existsSync(expectedPlist), false)
    assert.ok(existsSync(expectedApp), 'disabling login startup leaves the app installed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('normal launch completes user setup automatically without an opt-in prompt', () => {
  const source = readFileSync(join(root, 'macos', 'main.swift'), 'utf8')
  const automaticSetup = source.slice(
    source.indexOf('private func completeAutomaticSetupIfNeeded()'),
    source.indexOf('@objc private func toggleLoginItem')
  )

  assert.match(source, /applicationDidFinishLaunching[\s\S]*completeAutomaticSetupIfNeeded\(\)/)
  assert.match(automaticSetup, /HelperInstaller\.installUserSetup\(\s*from: Bundle\.main\.bundleURL/)
  assert.match(automaticSetup, /automaticSetupCompleteKey/)
  assert.doesNotMatch(source, /Turn On at Login|Not Now|offerLoginSetupIfNeeded/)
})

test('complete uninstall removes only the copied helper and its login item', () => {
  const home = mkdtempSync(join(os.tmpdir(), 'opengym-video-sync-uninstall-'))
  try {
    const installed = spawnSync(executable, [
      '--install-test',
      '--home', home,
      '--app-path', app
    ], { encoding: 'utf8' })
    assert.equal(installed.status, 0, installed.stderr)

    const expectedApp = join(home, 'Applications', 'openGym Video Sync.app')
    const expectedPlist = join(home, 'Library', 'LaunchAgents', 'ai.opengym.video-sync-relay.plist')
    assert.ok(existsSync(expectedApp))
    assert.ok(existsSync(expectedPlist))

    const removed = spawnSync(executable, [
      '--uninstall-helper-test',
      '--home', home
    ], { encoding: 'utf8' })
    assert.equal(removed.status, 0, removed.stderr)
    const result = JSON.parse(removed.stdout.trim())
    assert.equal(result.ok, true)
    assert.equal(result.loginItemRemoved, true)
    assert.equal(result.appRemoved, true)
    assert.equal(existsSync(expectedPlist), false)
    assert.equal(existsSync(expectedApp), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installer refuses to overwrite an unrelated app at the destination', () => {
  const home = mkdtempSync(join(os.tmpdir(), 'opengym-video-sync-conflict-'))
  try {
    const destination = join(home, 'Applications', 'openGym Video Sync.app')
    const contents = join(destination, 'Contents')
    mkdirSync(contents, { recursive: true })
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>example.unrelated</string>
<key>CFBundleExecutable</key><string>Unrelated</string>
</dict></plist>
`)
    const sentinel = join(destination, 'keep-me.txt')
    writeFileSync(sentinel, 'user file')

    const result = spawnSync(executable, [
      '--install-test',
      '--home', home,
      '--app-path', app
    ], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /left untouched/)
    assert.equal(readFileSync(sentinel, 'utf8'), 'user file')
    assert.equal(existsSync(
      join(home, 'Library', 'LaunchAgents', 'ai.opengym.video-sync-relay.plist')
    ), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
