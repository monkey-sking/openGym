# The workout and the video pause together

Following a video on the computer while training from the phone is two clocks that drift apart:
the athlete stops for a phone call, pauses the workout, and the video runs on (or pauses the video
and the session's clock keeps counting). **Pausing either one now pauses the other**, and resuming
either one resumes the other.

## Normal setup: Plan A (Chrome Web Store extension + 4-character pairing code)

The ordinary-user path requires zero terminal commands, zero Node.js installations,
and zero manual IP addresses:

1. **Install the Chrome extension** from Chrome Web Store (or load unpacked in developer mode).
2. **Click the extension icon** in Chrome: it displays a prominent **4-character pairing code**
   (e.g., `A3K9`, case-insensitive, excludes ambiguous characters like 0/O/1/I/L).
3. **Open openGym on phone**: go to **Settings → Video sync → Quick pair with Chrome**.
4. **Type the 4-character code** and tap **Pair**: the phone tests local network candidates
   announced by the computer's relay and automatically binds the connection.

Advanced users can still unfold "Advanced / Manual IP" to inspect or override the exact address.

### Pairing protocol

- The relay generates a short code valid for 10 minutes via `/pair/code`.
- The phone submits the code to `/pair/verify?code=...` across candidate LAN IPs announced
  by Bonjour discovery or default subnet probing.
- Verification binds the phone, registers its presence, and returns the canonical target URL.

## Mac helper / standalone relay (optional background service)

For users who want the video relay always running in the background without keeping Chrome
open in the foreground, the native helper app at `~/Applications/openGym Video Sync.app`
remains available as an optional convenience relay, listening on the same protocol port.
It installs a lightweight user LaunchAgent `ai.opengym.video-sync-relay.plist`.
Ordinary users using the Chrome extension do not need this helper.

## Developer relay fallbacks

- Native helper source: `tools/video-sync-extension/macos/`; build it with
  `tools/video-sync-extension/macos/build-helper.sh`.
- Zero-dependency Node relay: `node tools/video-sync-extension/local-server.mjs`.
- `.command` scripts are development diagnostics, not the ordinary-user installation path.

If both the phone and extension already point to a hosted openGym server, that server may be used
instead of the local helper.

The halves:

- `frontend/src/lib/video-sync.js` — the app. Posts what the athlete did, polls what the computer
  did, and applies it through the same store calls the on-screen Pause button uses.
- `tools/video-sync-extension/local-server.mjs` — lightweight local relay HTTP/SSE server.
- `api/server.js` (`video-sync` routes) — optional server-side snapshot endpoint.
- `tools/video-sync-extension/` — a Chrome MV3 extension. Holds the server's SSE stream and drives
  the tab's `<video>`; reports a pause or play the athlete made by hand.

## Soft Sync & Timeline Nudging (5-Second Threshold)

- **No stutter / micro-stutters**: Normal playback lets the video run smoothly.
- When difference between phone workout position and video current time is within **5 seconds**, the extension leaves `currentTime` untouched.
- When difference exceeds 5 seconds, it smoothly snaps to target.
- **Chapter transitions**: Forcing seek (`force: true`) accurately jumps to the exact start of the new chapter. A rest between chapters lets the video run on while the workout clock waits, so the next chapter usually needs a small rewind; without `force` a rewind under 5 s is skipped and those gaps add up chapter after chapter. The server and relay both carry `force` through to the extension for this reason.
- **Manual Micro-adjustments (Nudge)**:
  - Phone UI provides `-5s / -1s / Reset / +1s / +5s` adjustment buttons.
  - Immediately adjusts the target timeline and syncs to the video.

## One state, not a queue

Every accepted command gets the next `seq` and replaces the last one. The server or relay also
names its process with an `epoch`: after a restart its number starts again at 1, so both sides
reset what they compare against when the epoch changes instead of treating the new state as old.
Within one epoch they act on a state only when its `seq` is newer than the last they applied, so a
retried POST, a command made during a reconnect, or a pause the athlete undid a moment later cannot
move a workout that has already moved on. A dropped connection is therefore harmless: the next
frame carries the current state.

`source` (`app` / `video`) is what keeps the two ends from echoing each other: a command that
came from the video is not sent back out as the athlete's, and `pausedBy` on the running session
remembers who paused it.

## The session clock and the set timer

The pause is the existing one: `store/useStore.js` `pauseWorkout`/`resumeWorkout`
(`lib/workout-pause.js`) freezes the session clock, and `useUI.pauseWork`/`resumeWork` freezes a
timed hold whose countdown is running. A rest that is already over has nothing to hold; a rest
that is running is paused with `pauseRest`.

Rules that keep it from fighting the athlete:

- A video **resume** lifts only a pause the video made. A pause the athlete chose is theirs to
  end, and a tab that starts playing on its own must not end it.
- A video **pause** pauses the session whichever side paused it before — `pauseWorkout` is a
  no-op on a session that is already paused.
- Pausing a timed hold freezes `left` and stops the tick, so the chapter cannot run out behind a
  paused session. Resuming moves `endsAt` out by the pause, and an early *Done* logs the time
  actually held (`total - left`), not wall clock.
- A command names the session it belongs to. A late pause from a workout that ended a second ago
  is dropped instead of pausing the next one.

## Which tab

The app names the video: every chapter imported from a follow-along video carries the source link
as `videoUrl` (`lib/video-plan.js`), including a chapter mapped to a catalogue exercise. The
session start puts it on the entry and its target, so `videoSyncUrl` sends it with `start`, and
again whenever the session moves to another chapter's video. A plan written before that field
existed still falls back to the custom exercise's link. The extension prefers the tab already
bound to this workout. When that tab is gone it rebinds only if exactly one open tab matches the
named video's key (Bilibili `BV…` and `p=`, YouTube `v=`, or the Vimeo numeric id). Two or more
matching tabs are ambiguous: no command is sent and the popup says so. It never falls back to the
active, audible or last-playing tab, and with no video it can name it ignores page events and
sends no command.

The video's play state is the only playback it decides: play/pause, plus the soft-sync seek above.
A fresh workout sends `play: true`, so it starts the named video even if its tab was already open
and paused. An explicit paused start sends `play: false`, opens or binds that tab without playing,
and holds it paused until an explicit resume. Reloading the app mid-session and retargeting a
chapter send no play intent, so the extension only attaches or retargets and leaves playback
unchanged. Volume is never touched. Reaching the end of the video is the video finishing, not the
athlete stopping it, so it is not sent to the app.

## Installing the extension

`chrome://extensions` → Developer mode → Load unpacked → `tools/video-sync-extension`. Enter the
openGym server's address in the popup and Save; Chrome asks for that host there, and the extension
reuses the `gymsid` / `__Host-gymsid` session cookie of the same origin as a bearer token.
This is a developer-install extension, not a store listing.

## Limits

- Chrome suspends an extension's service worker. A one-minute `chrome.alarms` watchdog and the
  server's 20 s ping bring the stream back; because the protocol is a snapshot, the reconnect
  applies the newest state rather than replaying old commands.
- A tab opened before the extension was installed has no content script; the first command
  injects it.
- Autoplay policy can refuse `play()` on a video that has never played in this tab. Press play
  once by hand after a fresh page load.
- The server has to be reachable from the computer (the same origin the phone uses). A server that
  is only on the phone's loopback cannot be reached this way.

## Tests

- `frontend/src/lib/video-sync.test.js` — start/pause/resume/end, a fresh start carrying play
  intent, the video's pause and resume applied through the store, the athlete's own pause not
  being lifted by the video, stale `seq` dropped, a new epoch accepted, and the chapter
  retargeting the extension.
- `frontend/src/store/useUI.pause.test.js` — the timed hold frozen and resumed, and the early
  finish logging the time actually held.
- `api/test/video-sync.test.js` — `videoUrl` and play intent carried, kept across a video-side
  command, cleared by an app command that names no usable video and by `end`, duplicate commands
  deduped, a non-http URL refused, `force` and the athlete's `offset` preserved, the epoch stable
  for one process, and `online` reflecting an open stream.
- `tools/video-sync-extension/*.test.mjs` — the extension's key matching (including Vimeo), bound
  tab preference, ambiguous-tab refusal, persistent hold for open tabs, ignoring events
  from another video tab, play intent, soft-sync threshold, forced seeks, epoch/seq reset after a
  restart, reconnect handling, and the relay reporting `online` only while an extension holds the
  stream.
