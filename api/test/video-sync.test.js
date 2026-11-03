/* The desktop video link (docs/dev/VIDEO_SYNC.md): a snapshot per profile that carries the
   session, the command and the video the app pointed the extension at.

   - `videoUrl` travels with `start`/`pause`, survives a command from the browser (which names no
     URL), and is cleared by `end` along with the session.
   - the same command twice is answered with the same seq: a retrying client must not wake a
     player that already stopped.
   - `online` is the extension's open stream, so the workout screen knows whether a computer is
     listening. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const UID = 'u_vs_1';
const SID = 's-42';
const VIDEO = 'https://www.bilibili.com/video/BV1xx411c7mD/';

const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const as = () => ({ Authorization: 'Bearer ' + mint(UID), 'Content-Type': 'application/json' });

let child;
let api;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-video-sync-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: UID, name: 'Athlete', created: new Date().toISOString() }],
    creds: [], subs: [], invites: []
  }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  api = `http://127.0.0.1:${await boundPort(child, () => log)}`;
});

after(() => {
  child?.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const command = body => fetch(`${api}/api/video-sync/command`, {
  method: 'POST', headers: as(), body: JSON.stringify(body)
});
const state = async () => {
  const r = await fetch(`${api}/api/video-sync/state`, { headers: as() });
  assert.equal(r.status, 200);
  return r.json();
};

test('the command carries the session and the video the app named', async () => {
  const r = await command({ action: 'start', source: 'app', sessionId: SID, videoUrl: VIDEO });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(typeof s.epoch, 'string');
  assert.ok(s.epoch.length > 0);
  assert.deepEqual(
    { ...s, epoch: 'epoch', at: 0 },
    { epoch: 'epoch', seq: 1, action: 'start', source: 'app', sessionId: SID, videoUrl: VIDEO, pos: null, offset: 0, force: false, play: null, at: 0, online: false }
  );
});

test('the same command twice does not advance the sequence', async () => {
  const again = await (await command({ action: 'start', source: 'app', sessionId: SID, videoUrl: VIDEO })).json();
  assert.equal(again.seq, 1);
});

test('an app command without a URL does not inherit the previous video', async () => {
  const moved = await (await command({ action: 'pause', source: 'app', sessionId: SID })).json();
  assert.equal(moved.seq, 2);
  assert.equal(moved.videoUrl, null, 'the app names the session video on every command');
});

test('a command from the browser is attributed to it and keeps the video', async () => {
  await command({ action: 'start', source: 'app', sessionId: SID, videoUrl: VIDEO });
  const s = await (await command({ action: 'resume', source: 'video', sessionId: SID })).json();
  assert.equal(s.source, 'video');
  assert.equal(s.videoUrl, VIDEO);
});

test('a non-http video URL is refused rather than stored', async () => {
  const s = await (await command({ action: 'start', source: 'app', sessionId: SID, videoUrl: 'javascript:alert(1)' })).json();
  // Refused: the app named no usable video, so the old one is cleared rather than kept.
  assert.equal(s.videoUrl, null);
});

test('an unknown action is a bad request', async () => {
  const r = await command({ action: 'bogus', source: 'app', sessionId: SID });
  assert.equal(r.status, 400);
});

test('seek carries the video position and manual alignment offset', async () => {
  await command({ action: 'start', source: 'app', sessionId: SID, videoUrl: VIDEO });
  const r = await command({ action: 'seek', source: 'app', sessionId: SID, videoUrl: VIDEO, pos: 125, offset: -5, force: true });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.action, 'seek');
  assert.equal(s.pos, 125);
  assert.equal(s.offset, -5);
  assert.equal(s.force, true, 'a chapter boundary keeps its forced seek');
  assert.equal(s.videoUrl, VIDEO);
});

test('a browser command keeps the alignment offset the athlete set', async () => {
  const p = await (await command({ action: 'pause', source: 'video', sessionId: SID })).json();
  assert.equal(p.offset, -5, 'a pause from the tab carries no offset of its own');
  assert.equal(p.force, false, 'and no forced seek either');
});

test('a start carries its playback intent, and an attach carries none', async () => {
  const play = await (await command({ action: 'start', source: 'app', sessionId: SID, videoUrl: VIDEO, play: true })).json();
  assert.equal(play.play, true);
  const paused = await (await command({ action: 'start', source: 'app', sessionId: SID, videoUrl: VIDEO, play: false })).json();
  assert.equal(paused.play, false, 'an explicit paused start is a new command');
  assert.ok(paused.seq > play.seq);
  const attach = await (await command({ action: 'start', source: 'app', sessionId: SID, videoUrl: VIDEO })).json();
  assert.equal(attach.play, null, 'a reload or retarget leaves playback alone');
  assert.ok(attach.seq > paused.seq);
});

test('the epoch is stable for this server process', async () => {
  const a = await state();
  const b = await state();
  assert.equal(a.epoch, b.epoch);
});

test('end closes the session and forgets the video', async () => {
  const s = await (await command({ action: 'end', source: 'app', sessionId: SID })).json();
  assert.equal(s.sessionId, null);
  assert.equal(s.videoUrl, null);
  assert.equal((await state()).action, 'end');
});

test('an open stream makes the computer online for the app', async () => {
  const controller = new AbortController();
  const r = await fetch(`${api}/api/video-sync/stream`, {
    headers: { ...as(), Accept: 'text/event-stream' }, signal: controller.signal
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  // The first frame announces the retry delay, the next one the current state.
  let text = '';
  for (let i = 0; i < 4 && !text.includes('data: '); i++) {
    const chunk = await reader.read();
    text += new TextDecoder().decode(chunk.value);
  }
  assert.match(text, /^retry: 3000\n\ndata: /);
  assert.equal((await state()).online, true, 'the open stream is the desktop listening');

  controller.abort();
  let online = true;
  for (let i = 0; i < 40 && online; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    online = (await state()).online;
  }
  assert.equal(online, false, 'a closed stream takes the computer offline again');
});
