#!/bin/sh
#
# "This agent is working" — the one report that runs on every tool call.
#
# The other four events (UserPromptSubmit / Stop / Notification / SessionEnd)
# go through report-state.mjs, which parses the hook payload and reads the
# transcript. That is fine a handful of times per turn. It is NOT fine per
# tool call: `node -e ''` costs ~25ms on a loaded machine and a tool-heavy
# turn makes a hundred of them, so the reporter would add seconds of latency
# to the thing it is only supposed to be watching.
#
# So this one is POSIX sh (~7ms) and never blocks on the network: the POST is
# backgrounded and its result ignored. Debouncing lives on the server, which
# no-ops an unchanged state — a stamp file here would have saved the ~2ms
# request while leaving the interpreter spawn, which is 98% of the cost.
#
# Usage: busy-ping.sh <source> <event>
#
# Rule inherited from report-state.mjs and just as important here: never break
# the agent, and never print anything. Every path exits 0.

# No session id means either a pane that predates sheepit seeding it, or an
# agent running outside sheepit entirely. Resolving it needs a process-tree
# walk and an HTTP round trip, which is exactly the cost this script exists to
# avoid — those panes keep the slower reporter on the other four events.
[ -n "${SHEEPIT_SESSION_ID:-}" ] || exit 0

URL="${SHEEPIT_URL:-}"
if [ -z "$URL" ]; then
  # server.json is one small object; sed beats spawning a JSON parser.
  URL=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "${HOME}/.config/sheepit/server.json" 2>/dev/null)
fi
[ -n "$URL" ] || exit 0

# Backgrounded and detached: the agent waits for this script, not for the
# request. A server that is down, restarting or slow costs the turn nothing.
curl -s -m 2 -o /dev/null -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"state\":\"busy\",\"source\":\"${1:-agent}\",\"event\":\"${2:-tool}\"}" \
  "${URL%/}/api/sessions/${SHEEPIT_SESSION_ID}/agent-state" \
  >/dev/null 2>&1 &

exit 0
