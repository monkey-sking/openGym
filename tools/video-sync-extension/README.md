# openGym video sync (Chrome extension)

Pauses the follow-along video on the computer when the workout pauses, and pauses the workout
when the video does. The app's half is `frontend/src/lib/video-sync.js`; this folder is the half
that talks to the `<video>` element.

## Direct phone-to-Chrome setup: Chrome extension + 4-character pairing code

The ordinary-user path requires zero terminal commands, zero computer helper servers,
and zero manual IP addresses:

1. **Install the extension**: install from Chrome Web Store (or load unpacked in developer mode).
2. **Open the extension popup**: a prominent **4-character pairing code** is displayed
   (e.g., `A3K9`, generated and persisted locally in the extension).
3. **Pair in openGym on iPhone**: open the app on your phone → **Settings → Video sync → Quick pair with Chrome**.
4. **Enter code and tap Pair**: the iPhone hosts the LAN relay server directly (`_opengym._tcp.` on port `8787`) and registers the pairing code; the Chrome extension automatically discovers the phone on the same Wi-Fi and connects.

Advanced users can click "Advanced / Manual IP" in the popup to enter the phone's LAN IP directly if corporate/guest Wi-Fi blocks local discovery.

Chrome grants access to the server host on Save. The extension reads the `gymsid` /
`__Host-gymsid` session cookie for that host and sends it as a bearer token, which is the same
credential the phone's API requests use.

## Connection states

The app and extension show these connection states separately:

- **Relay not running / unreachable**: the relay process is absent, the two devices are on
  different networks, or the address is wrong. On a localhost address, the extension badge is
  amber `OFF`, not a red error.
- **Relay running; Chrome extension not connected**: `/health` answered, but
  `extensionConnected` is false. Enable or reload the extension in this Chrome profile.
- **Chrome extension connected; waiting for a phone workout**: the extension holds the stream,
  but `phoneConnected` is false because no recent phone workout is active.
- **Connected**: relay, extension stream and an active phone workout are all present.
- **Chrome permission needed / not signed in / server error**: these are not the same as a
  stopped relay and are shown as distinct red badge/title states.

The app's Video sync settings page refreshes the three connection facts every 3 seconds. If
discovery finds a new Wi-Fi address, it uses it for the current session without silently
replacing a saved address; press **Search** to save the new address.

## Automatic recovery and retry limits

When an open stream closes, the extension retries with bounded exponential backoff (1 second
initially, 30 seconds maximum, with jitter). Chrome's one-minute service-worker alarm also
reconnects after suspension. The relay's `/state`, `/health` and video-sync state responses are
not cacheable, so the app does not keep reporting a stale connection.

Chrome cannot start a computer app by itself, so the helper must be opened once from the app's
setup button. If that first automatic setup fails, opening it again retries. In Chrome, allow the
relay host when asked. On iPhone, allow **Settings → Privacy & Security → Local Network** once and
keep both devices on the same Wi-Fi.

The `.command` scripts and `local-server.mjs` are retained only as developer fallbacks. They are
not the normal-user installation path.

The local build is ad-hoc signed for local testing. It is not Developer ID signed or notarized,
and is not publicly packaged or published; another Mac may show a Gatekeeper warning until a
signed and notarized release is produced.

## What it controls

The tab holding the video for the running workout: the app names the video when the session and
each chapter start (`videoUrl` in `POST /api/video-sync/command`), and the extension prefers the
tab with the same Bilibili `BV…` (and `p=`) or YouTube `v=` key. If exactly one open tab matches,
the extension binds it. If several match, or none can be identified, it sends no command rather
than guessing from the active, audible or last-playing tab.

It controls play/pause and keeps the named timeline within five seconds of the workout. Small
differences are left alone to avoid stutter; larger differences and chapter changes seek to the
target. Volume is never changed. A fresh workout starts the named video, while an explicitly
paused start holds it paused until an explicit resume. Pausing at the end of a video is the video
finishing, and is not sent to the app.

## Limits

- Chrome can suspend an extension's service worker; the one-minute alarm reconnects the stream,
  and because every message is the current state (not a queue), a reconnect applies the newest
  pause or resume rather than replaying old ones.
- A tab opened before the extension was installed has no content script; the first command
  injects it.
- Autoplay policy can refuse `play()` on a video that was never played in this tab. The popup says
  so; start the video once by hand after a fresh page load.
