#!/usr/bin/env bash
set -e

UI_PORT=4444
BACKEND_PORT=4445
BACKEND_HOST=localhost
UI_ONLY=0

usage() {
  cat <<'USAGE'
Usage: ./dev.sh [options]

  --ui-only              Start only the Vite dev server, no backend. Use when a
                         backend is already running — another worktree, another
                         machine, or one you started by hand.
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
