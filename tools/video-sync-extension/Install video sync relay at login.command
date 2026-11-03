#!/bin/zsh
# Auditable, user-level installer. It does not run during development builds.
# Double-click, review the confirmation, and macOS starts the relay at login.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
START="$SCRIPT_DIR/Start video sync relay.command"
LABEL="ai.opengym.video-sync-relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/openGym"
NODE_BIN="$(OPEN_GYM_NODE_CHECK_ONLY=1 "$START" || true)"

if [[ -z "$NODE_BIN" ]]; then
  osascript -e 'display dialog "Install Node.js 18 or newer before installing automatic startup." buttons {"Close"} default button "Close" with title "openGym video sync"' >/dev/null 2>&1 || true
  exit 2
fi

answer="$(osascript -e 'display dialog "Install a user login item for the openGym video sync relay?\n\nWrites:\n~/Library/LaunchAgents/ai.opengym.video-sync-relay.plist\nLogs:\n~/Library/Logs/openGym/\n\nNo administrator password or Chrome settings are changed." buttons {"Cancel", "Install"} default button "Install" with title "openGym video sync"' 2>/dev/null || true)"
if [[ "$answer" != *"button returned:Install"* ]]; then
  exit 0
fi

xml_escape () {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  print -rn -- "$value"
}

PLIST_START="$(xml_escape "$START")"
PLIST_SCRIPT_DIR="$(xml_escape "$SCRIPT_DIR")"
PLIST_HOME="$(xml_escape "$HOME")"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$PLIST_START</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PLIST_SCRIPT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:$PLIST_HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/video-sync-relay.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/video-sync-relay.error.log</string>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$PLIST" >/dev/null
/bin/launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$(id -u)" "$PLIST"
/bin/launchctl kickstart -k "gui/$(id -u)/$LABEL"

osascript -e 'display dialog "openGym video sync will now start at login. Use Uninstall video sync relay at login.command to remove it." buttons {"OK"} default button "OK" with title "openGym video sync"' >/dev/null 2>&1 || true
