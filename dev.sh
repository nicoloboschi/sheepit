#!/usr/bin/env bash
set -e

UI_PORT=4444
BACKEND_PORT=4445
BACKEND_HOST=localhost
UI_ONLY=0
KEEP_DAEMON=0

usage() {
  cat <<'USAGE'
Usage: ./dev.sh [options]

  --ui-only              Start only the Vite dev server, no backend. Use when a
                         backend is already running — another worktree, another
                         machine, or one you started by hand.
  --keep-daemon          Reuse the running PTY daemon instead of replacing it.
                         Keeps existing sessions alive, at the cost of running
                         whatever pty-daemon.ts code that daemon started with.
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
# Ctrl+C here does not take every shell down with it. The cost is that a change
# to pty-daemon.ts is silently ignored — the server restarts, reconnects to the
# daemon already listening, and you keep running whatever code that process
# started with, however many days ago.
#
# Dev wants the opposite default: always run the code on disk. --keep-daemon
# opts back into reuse when keeping sessions matters more.
#
# Kill first, then remove the files. Unlinking the socket while the daemon is
# still alive orphans it — it ignores every signal, has no idle timeout, and
# its only clean exit is a socket message it can no longer receive, so it sits
# there holding its PTYs forever while the next daemon binds a fresh socket.
DAEMON_DIR="$HOME/.config/sheepit"
DAEMON_SOCK="$DAEMON_DIR/pty-daemon.sock"
DAEMON_PID_FILE="$DAEMON_DIR/pty-daemon.pid"

reset_daemon() {
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
    echo "  Replacing PTY daemon (pid $daemon_pid) — open sessions will be closed."
    # SIGKILL because the daemon ignores the catchable signals by design.
    kill -9 "$daemon_pid" 2>/dev/null || true
    i=0
    while kill -0 "$daemon_pid" 2>/dev/null && [ "$i" -lt 25 ]; do
      sleep 0.2
      i=$((i + 1))
    done
  fi

  rm -f "$DAEMON_SOCK" "$DAEMON_PID_FILE"
}

if [ "$UI_ONLY" -eq 0 ] && [ "$KEEP_DAEMON" -eq 0 ]; then
  reset_daemon
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
