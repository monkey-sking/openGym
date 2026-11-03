#!/bin/zsh
# Double-click this file to run the openGym video-sync relay on this Mac.
# Leave the Terminal window open while you train; closing it stops the relay.
set -u
SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 1

find_node () {
  local found
  found="$(command -v node 2>/dev/null || true)"
  if [[ -n "$found" && -x "$found" ]]; then
    print -r -- "$found"
    return
  fi

  local candidate
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/bin/node" \
    "$HOME/.asdf/shims/node"
  do
    if [[ -x "$candidate" ]]; then
      print -r -- "$candidate"
      return
    fi
  done

  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    local nvm_node
    nvm_node="$(zsh -lc 'source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; nvm use --silent default >/dev/null 2>&1; command -v node' 2>/dev/null || true)"
    if [[ -n "$nvm_node" && -x "$nvm_node" ]]; then
      print -r -- "$nvm_node"
      return
    fi
  fi

  local latest
  latest="$(print -l "$HOME"/.nvm/versions/node/*/bin/node(N) 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$latest" && -x "$latest" ]]; then
    print -r -- "$latest"
    return
  fi
  latest="$(print -l "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node(N) 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$latest" && -x "$latest" ]]; then
    print -r -- "$latest"
  fi
}

NODE_BIN="$(find_node)"
if [[ "${OPEN_GYM_NODE_CHECK_ONLY:-}" == "1" ]]; then
  [[ -n "$NODE_BIN" ]] && print -r -- "$NODE_BIN"
  [[ -n "$NODE_BIN" ]] && exit 0
  exit 2
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "openGym video sync needs Node.js 18 or newer."
  echo "Install Node.js, then double-click this file again."
  if [[ -t 0 ]]; then
    answer="$(osascript -e 'display dialog "openGym video sync needs Node.js 18 or newer. Open the Node.js download page?" buttons {"Close", "Open Node.js download"} default button "Open Node.js download" with title "openGym video sync"' 2>/dev/null || true)"
    [[ "$answer" == *"button returned:Open Node.js download"* ]] && open "https://nodejs.org/en/download"
  fi
  exit 2
fi

NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 18 ]]; then
  echo "openGym video sync needs Node.js 18 or newer (found ${NODE_VERSION:-unknown})."
  echo "Install a current Node.js, then double-click this file again."
  if [[ -t 0 ]]; then
    answer="$(osascript -e 'display dialog "openGym video sync needs Node.js 18 or newer. Open the Node.js download page?" buttons {"Close", "Open Node.js download"} default button "Open Node.js download" with title "openGym video sync"' 2>/dev/null || true)"
    [[ "$answer" == *"button returned:Open Node.js download"* ]] && open "https://nodejs.org/en/download"
  fi
  exit 2
fi

PORT="${OPEN_GYM_SYNC_PORT:-8787}"
if /usr/bin/nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
  if /usr/bin/curl --fail --silent --show-error --max-time 1 "http://127.0.0.1:$PORT/health" | /usr/bin/grep -q '"ok":true'; then
    echo "The openGym video sync relay is already running at http://127.0.0.1:$PORT"
    if [[ -t 0 ]]; then
      open "http://127.0.0.1:$PORT"
    fi
    exit 0
  fi
  echo "Port $PORT is already used by another program."
  echo "Close that program or restart with OPEN_GYM_SYNC_PORT=8790."
  exit 1
fi

echo "openGym video sync relay"
echo "Keep this window open while you train. Close it to stop."
echo
exec "$NODE_BIN" local-server.mjs
