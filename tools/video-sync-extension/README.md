# openGym video sync (Chrome extension)

Pauses the follow-along video on the computer when the workout pauses, and pauses the workout
when the video does. The app's half is `frontend/src/lib/video-sync.js`; this folder is the half
that talks to the `<video>` element.

## Set up the Mac helper

The normal path is one action: open **openGym → Settings → Video sync** and press
**Set up Mac helper**, then open the downloaded app once.

On its first launch, the helper installs itself for the current user at
`~/Applications/openGym Video Sync.app`, adds the user LaunchAgent
`~/Library/LaunchAgents/ai.opengym.video-sync-relay.plist`, and starts with that user at sign-in.
It stays in the menu bar. No Terminal, Node.js, account, or administrator password is involved.
macOS may ask once to confirm opening an app downloaded from the internet; that is the only
security confirmation required.

The menu-bar menu still exposes **Start When I Sign In**, **Restart Relay**, connection help, and
**Uninstall openGym Video Sync…** for diagnosis or opt-out. These are not setup steps ordinary
users need to understand.

The repository does not contain a hosted installer. A release build must set
`VITE_VIDEO_SYNC_MAC_HELPER_URL` to the stable HTTPS URL of the helper zip. The local build is
ad-hoc signed, so it is suitable for development, not public distribution.

## Install the Chrome extension once

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → choose this folder (`tools/video-sync-extension`).
3. Open the extension, enter the openGym server's address (`https://…`, the same site the app is
   served from) and **Save**.
4. Sign in to that server in this Chrome profile. The extension reuses that session; it has no
   password of its own.

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
