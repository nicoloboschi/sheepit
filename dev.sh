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
