#!/usr/bin/env bash
set -e

UI_PORT=4444
BACKEND_PORT=4445
BACKEND_HOST=localhost
UI_ONLY=0
KEEP_DAEMON=0
FRESH_DAEMON=0

usage() {
  cat <<'USAGE'
Usage: ./dev.sh [options]

  --ui-only              Start only the Vite dev server, no backend. Use when a
                         backend is already running — another worktree, another
                         machine, or one you started by hand.
  --keep-daemon          Always reuse the running PTY daemon, even when its
                         code is out of date. Never closes sessions.
  --fresh-daemon         Always replace the running PTY daemon. Closes every
                         open session.

By default the daemon is replaced only when the code it is running differs
from the daemon sources on disk — compared by hash, not by timestamp — so an
ordinary restart keeps your sessions and a daemon change still takes effect.
  --ui-port <port>       Vite dev server port (default: 4444)
  --backend-port <port>  Backend API/WebSocket port (default: 4445)
  --backend-host <host>  Host Vite proxies /api and /ws to (default: localhost)
  -h, --help             Show this help

The ports are passed to Vite as SHEEPIT_UI_PORT / SHEEPIT_BACKEND_PORT /
SHEEPIT_BACKEND_HOST, which ui/vite.config.js reads — so a bare `npx vite`
honours them too.

Examples:
  ./dev.sh
      Backend on 4445, UI on 4444.

  ./dev.sh --ui-port 5544 --backend-port 5545
      A second worktree alongside the first, no port collisions.

  ./dev.sh --ui-only --backend-port 4445
      UI only, proxying to the backend already running on 4445.

  ./dev.sh --ui-only --backend-host 100.105.74.117
      UI only, against a backend on another machine.
USAGE
}

# Reject a flag whose value is missing or is itself a flag, so
# `--ui-port --ui-only` fails loudly instead of silently taking "--ui-only"
# as a port number.
need_value() {
  # $2 is the caller's next argv entry, already defaulted to "" when absent —
  # so test the value itself rather than $#, which is always 2 in here.
  case "${2-}" in
    ''|-*) echo "✗ $1 requires a value" >&2; exit 1 ;;
  esac
}

need_port() {
  case "$2" in
    ''|*[!0-9]*) echo "✗ $1 must be a number, got '$2'" >&2; exit 1 ;;
  esac
  if [ "$2" -lt 1 ] || [ "$2" -gt 65535 ]; then
    echo "✗ $1 must be between 1 and 65535, got '$2'" >&2
    exit 1
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ui-only)      UI_ONLY=1; shift ;;
    --keep-daemon)  KEEP_DAEMON=1; shift ;;
    --fresh-daemon) FRESH_DAEMON=1; shift ;;
    --ui-port)      need_value "$1" "${2-}"; need_port "$1" "$2"; UI_PORT="$2"; shift 2 ;;
    --backend-port) need_value "$1" "${2-}"; need_port "$1" "$2"; BACKEND_PORT="$2"; shift 2 ;;
    --backend-host) need_value "$1" "${2-}"; BACKEND_HOST="$2"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              echo "✗ Unknown option: $1" >&2; echo >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$UI_ONLY" -eq 0 ] && [ "$UI_PORT" -eq "$BACKEND_PORT" ]; then
  echo "✗ --ui-port and --backend-port are both $UI_PORT; they must differ." >&2
  exit 1
fi

# ── PTY daemon ───────────────────────────────────────────────────────────────
#
# The daemon deliberately outlives dev.sh: it ignores SIGHUP/SIGTERM/SIGINT so
# Ctrl+C here does not take every shell down with it. That is what makes your
# sessions survive a restart, and it is worth keeping.
#
# The cost is that a change to pty-daemon.ts is otherwise silently ignored —
# the server restarts, reconnects to the daemon already listening, and keeps
# running whatever code that process started with, however many days ago.
#
# So: replace the daemon only when it is actually running stale code. An
# ordinary restart keeps every session; editing or pulling daemon code costs
# you the sessions once, at the point where the alternative is running code
# that is not the code on disk. --keep-daemon and --fresh-daemon force it.
DAEMON_DIR="$HOME/.config/sheepit"
DAEMON_SOCK="$DAEMON_DIR/pty-daemon.sock"
DAEMON_PID_FILE="$DAEMON_DIR/pty-daemon.pid"
# Written by the proxy at startup: a hash of the code it is actually running.
DAEMON_FINGERPRINT_FILE="$DAEMON_DIR/pty-daemon.fingerprint"
# Only the proxy's own code counts. Server sources are hot-reloaded by tsx
# watch and must not trigger a session-closing restart.
DAEMON_SOURCES="src/pty-daemon.ts src/paths.ts"

sha16() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi
}

# Hash of the daemon sources on disk, in the same order and form the proxy
# hashes itself.
source_fingerprint() {
  # shellcheck disable=SC2086
  cat $DAEMON_SOURCES 2>/dev/null | sha16 | cut -c1-16
}

# True when the running proxy is not running the code on disk. This is an
# exact comparison on purpose: the previous version inferred it from file
# mtimes against process start time, and a pull, a touch, a second worktree or
# a clock skew all lie about that -- while guessing wrong closes every session.
daemon_is_stale() {
  running=$(cat "$DAEMON_FINGERPRINT_FILE" 2>/dev/null || true)
  disk=$(source_fingerprint)

  # No fingerprint at all means a proxy from before it recorded one, which is
  # by definition older than what is on disk.
  if [ -z "$running" ]; then
    echo "  PTY daemon predates code fingerprinting."
    return 0
  fi
  # Anything we cannot compute counts as current: the safe answer is the one
  # that keeps your sessions.
  if [ -z "$disk" ]; then
    echo "  Cannot hash daemon sources from $(pwd) — assuming the daemon is current."
    return 1
  fi
  [ "$running" != "$disk" ]
}

# $1: 1 to replace unconditionally, 0 to replace only when stale.
reset_daemon() {
  force=$1
  [ -e "$DAEMON_SOCK" ] || [ -f "$DAEMON_PID_FILE" ] || return 0

  daemon_pid=""
  if [ -f "$DAEMON_PID_FILE" ]; then
    daemon_pid=$(cat "$DAEMON_PID_FILE" 2>/dev/null || true)
  fi
  # A socket with no readable pid file still has an owner worth finding, so we
  # replace it rather than leaking it.
  if [ -z "$daemon_pid" ] && [ -e "$DAEMON_SOCK" ] && command -v lsof >/dev/null 2>&1; then
    daemon_pid=$(lsof -t "$DAEMON_SOCK" 2>/dev/null | head -1)
  fi
  case "$daemon_pid" in
    ''|*[!0-9]*) daemon_pid="" ;;
  esac

  if [ -n "$daemon_pid" ] && kill -0 "$daemon_pid" 2>/dev/null; then
    if [ "$force" -eq 0 ] && ! daemon_is_stale "$daemon_pid"; then
      echo "  PTY daemon (pid $daemon_pid) is current [${running:-?}] — reusing it, sessions kept."
      return 0
    fi
    if [ "$force" -eq 0 ]; then
      echo "  Replacing PTY daemon (pid $daemon_pid): running [${running:-none}] but disk is [${disk:-?}]."
    else
      echo "  Replacing PTY daemon (pid $daemon_pid) (--fresh-daemon)."
    fi
    echo "  Open sessions will be closed."
    # SIGKILL because the daemon ignores the catchable signals by design.
    kill -9 "$daemon_pid" 2>/dev/null || true
    i=0
    while kill -0 "$daemon_pid" 2>/dev/null && [ "$i" -lt 25 ]; do
      sleep 0.2
      i=$((i + 1))
    done
  fi

  # Only reached when the daemon is gone (or was already), so this never
  # unlinks a socket out from under a live daemon — doing that orphans it
  # permanently: it ignores every signal, has no idle timeout, and its only
  # clean exit is a socket message it could no longer receive.
  rm -f "$DAEMON_SOCK" "$DAEMON_PID_FILE" "$DAEMON_FINGERPRINT_FILE"
}

if [ "$UI_ONLY" -eq 0 ] && [ "$KEEP_DAEMON" -eq 0 ]; then
  reset_daemon "$FRESH_DAEMON"
fi

# Install UI deps if needed
if [ ! -d ui/node_modules ]; then
  echo "Installing UI dependencies..."
  (cd ui && npm install)
fi

# Backend deps are only needed when we actually start the backend — a UI-only
# run should not pay for node-pty compiling from source.
if [ "$UI_ONLY" -eq 0 ] && [ ! -d node_modules ]; then
  echo "Installing backend dependencies..."
  npm install
fi

# ── Ports ────────────────────────────────────────────────────────────────────
#
# Whatever is still holding 4444/4445 — a dev.sh whose terminal was closed, a
# backend a crash left behind, a second worktree started by mistake — gets
# taken out, so a restart never fails with EADDRINUSE.
#
# What must *not* get taken out is the flock. The PTY daemon and the session
# shells it owns are the whole point of the daemon outliving dev.sh, so they
# are protected by pid: a listener that turns out to be one of them is
# reported, not killed. Anything a session merely *launched* (a stale dev.sh
# parked in a pane, and the servers under it) is fair game — killing it is
# exactly what was asked for, and the pane it ran in survives it.
#
# Only LISTEN holders are considered. An *established* connection to 4444 is a
# browser tab; reclaiming a port is not a reason to kill the user's browser.

port_listeners() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u
}

# The daemon and its direct children — i.e. one process per live session.
# Deeper descendants are whatever the user ran *inside* a pane, which is not
# the session and is not protected.
protected_pids() {
  d=$(cat "$DAEMON_PID_FILE" 2>/dev/null || true)
  case "$d" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$d" 2>/dev/null || return 0
  echo "$d"
  pgrep -P "$d" 2>/dev/null || true
}

# This dev.sh and everything above it: never kill the shell we were started
# from, nor ourselves.
self_pids() {
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
    echo "$p"
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
}

PROTECTED_PIDS=$(protected_pids | tr '\n' ' ')
SELF_PIDS=$(self_pids | tr '\n' ' ')

in_list() {
  for x in $2; do
    if [ "$x" = "$1" ]; then return 0; fi
  done
  return 1
}

pcmd() { ps -o command= -p "$1" 2>/dev/null | cut -c1-72; }

# A parent worth killing along with the listener: kill only the server and
# `tsx watch` or `npm exec` respawns it a second later, and the port is gone
# again. Anything that is not one of these supervisors ends the chain.
is_supervisor() {
  case "$(ps -o command= -p "$1" 2>/dev/null)" in
    *tsx*|*vite*|*"npm exec"*|*"npm run"*|*dev.sh*) return 0 ;;
    *) return 1 ;;
  esac
}

# The listener plus its supervisor ancestors, outermost first, so the thing
# that would restart it dies before it can.
kill_chain() {
  chain="$1"
  p="$1"
  while :; do
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null || break
    if in_list "$p" "$PROTECTED_PIDS"; then break; fi
    if in_list "$p" "$SELF_PIDS"; then break; fi
    if ! is_supervisor "$p"; then break; fi
    chain="$p $chain"
  done
  echo "$chain"
}

# $1 port, $2 label. Exits non-zero only when the port is still held after
# both signals, or when the holder is a session we refuse to kill.
free_port() {
  port=$1
  label=$2
  pids=$(port_listeners "$port")
  [ -n "$pids" ] || return 0

  if ! command -v lsof >/dev/null 2>&1; then
    echo "  No lsof — cannot check who holds $port."
    return 0
  fi

  for pid in $pids; do
    if in_list "$pid" "$SELF_PIDS"; then continue; fi
    if in_list "$pid" "$PROTECTED_PIDS"; then
      echo "✗ Port $port ($label) is held by a sheepit session (pid $pid):" >&2
      echo "    $(pcmd "$pid")" >&2
      echo "  Refusing to kill it — that would close open shells. Use --${label}-port to pick another port." >&2
      exit 1
    fi
    chain=$(kill_chain "$pid")
    echo "  Port $port ($label) held by pid $pid — killing $(echo "$chain" | wc -w | tr -d ' ') process(es):"
    for victim in $chain; do
      echo "    $victim  $(pcmd "$victim")"
      kill "$victim" 2>/dev/null || true
    done
  done

  # TERM first, SIGKILL for whatever ignores it.
  i=0
  while [ -n "$(port_listeners "$port")" ] && [ "$i" -lt 15 ]; do
    sleep 0.2
    i=$((i + 1))
  done
  for pid in $(port_listeners "$port"); do
    if in_list "$pid" "$SELF_PIDS" || in_list "$pid" "$PROTECTED_PIDS"; then continue; fi
    for victim in $(kill_chain "$pid"); do
      kill -9 "$victim" 2>/dev/null || true
    done
  done
  i=0
  while [ -n "$(port_listeners "$port")" ] && [ "$i" -lt 15 ]; do
    sleep 0.2
    i=$((i + 1))
  done

  remaining=$(port_listeners "$port")
  if [ -n "$remaining" ]; then
    echo "✗ Port $port ($label) is still held after SIGKILL by: $remaining" >&2
    for pid in $remaining; do echo "    $pid  $(pcmd "$pid")" >&2; done
    exit 1
  fi
}

free_port "$UI_PORT" ui
if [ "$UI_ONLY" -eq 0 ]; then
  # Under --ui-only the backend on this port is deliberately someone else's —
  # another worktree, another machine, or one started by hand. Leave it alone.
  free_port "$BACKEND_PORT" backend
fi

cleanup() {
  echo "Shutting down..."
  kill ${BACKEND_PID:-} ${VITE_PID:-} 2>/dev/null || true
  wait ${BACKEND_PID:-} ${VITE_PID:-} 2>/dev/null || true
}
trap cleanup INT TERM

# Read by ui/vite.config.js for its own port and the /api + /ws proxy target.
export SHEEPIT_UI_PORT="$UI_PORT"
export SHEEPIT_BACKEND_PORT="$BACKEND_PORT"
export SHEEPIT_BACKEND_HOST="$BACKEND_HOST"

if [ "$UI_ONLY" -eq 0 ]; then
  # Backend (API + WebSocket)
  # --ignore to prevent unnecessary restarts that kill active PTY sessions
  NODE_ENV=development npx tsx watch --clear-screen=false --ignore 'ui/**' --ignore 'bench/**' --ignore '*.md' --ignore 'branding-preview.html' src/index.ts --port "$BACKEND_PORT" --log-level debug &
  BACKEND_PID=$!
fi

# Vite dev server (UI + HMR, proxies /api and /ws to the backend).
# Subshell so the cd does not leak into this script's working directory.
(cd ui && npx vite --host 0.0.0.0 --port "$UI_PORT") &
VITE_PID=$!

echo ""
echo "  sheepit dev:"
echo "    UI:      http://localhost:$UI_PORT"
if [ "$UI_ONLY" -eq 1 ]; then
  echo "    Backend: not started (--ui-only), proxying to http://$BACKEND_HOST:$BACKEND_PORT"
else
  echo "    Backend: http://localhost:$BACKEND_PORT"
fi
echo ""

wait
