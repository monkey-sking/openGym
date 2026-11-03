#!/bin/zsh
# Removes only the user login item created by the installer. A relay started by hand is untouched.
set -euo pipefail

LABEL="ai.opengym.video-sync-relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

answer="$(osascript -e 'display dialog "Remove the openGym video sync login item?\n\nThis does not remove Node.js, Chrome, or your workout data." buttons {"Cancel", "Remove"} default button "Remove" with title "openGym video sync"' 2>/dev/null || true)"
if [[ "$answer" != *"button returned:Remove"* ]]; then
  exit 0
fi

/bin/launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

osascript -e 'display dialog "The openGym video sync login item was removed." buttons {"OK"} default button "OK" with title "openGym video sync"' >/dev/null 2>&1 || true
