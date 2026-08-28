#!/bin/sh
#
# A one-line POST to sheepit, for hook events whose body is fixed.
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
# Usage: post.sh <endpoint-suffix> <json-body>
#   post.sh agent-state '{"state":"busy","source":"claude","event":"PreToolUse"}'
#   post.sh cleared      '{}'
#
# Both callers today are events where the hook matcher has already decided what
# happened, so there is nothing to parse and no reason to pay for a runtime.
#
# Rule inherited from report-state.mjs and just as important here: never break
# the agent, and never print anything. Every path exits 0.

URL="${SHEEPIT_URL:-}"
if [ -z "$URL" ]; then
  # server.json is one small object; sed beats spawning a JSON parser.
  URL=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "${HOME}/.config/sheepit/server.json" 2>/dev/null)
fi
[ -n "$URL" ] || exit 0

SID="${SHEEPIT_SESSION_ID:-}"

# A pane created before sheepit seeded SHEEPIT_SESSION_ID has no id in its
# environment, and restarting the agent does not add one — the variable belongs
# to the pane's shell, not to the agent inside it. An earlier version simply
# gave up here, which meant every hook in this script silently did nothing on
# any pane older than the variable. That is not a graceful degradation, it is
# the feature being off with no way to tell.
#
# So fall back to what report-state.mjs does: walk our ancestry and ask the
# server which session owns one of those pids. It costs a dozen `ps` calls and
# a round trip, so the answer is cached per agent process — paid once for the
# life of the agent, not once per tool call.
if [ -z "$SID" ]; then
  CACHE="${TMPDIR:-/tmp}/sheepit-sid-$PPID"
  if [ -r "$CACHE" ]; then
    SID=$(cat "$CACHE" 2>/dev/null)
  else
    pid=$PPID; pids=""; i=0
    while [ "$i" -lt 12 ] && [ "${pid:-0}" -gt 1 ]; do
      pids="${pids}${pids:+,}$pid"
      pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
      [ -n "$pid" ] || break
      i=$((i + 1))
    done
    [ -n "$pids" ] || exit 0
    SID=$(curl -s -m 2 -X POST -H 'Content-Type: application/json' \
            -d "{\"pids\":[$pids]}" "${URL%/}/api/sessions/resolve" 2>/dev/null \
          | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    [ -n "$SID" ] && printf '%s' "$SID" > "$CACHE" 2>/dev/null
  fi
fi
[ -n "$SID" ] || exit 0

# Which agent is calling.
#
# hooks.json is one file loaded by both agents, so the body it hands us cannot
# name the caller and says "claude" in both. That made Codex's tool-call pings
# arrive labelled as Claude's, which is worse than an unlabelled ping: the hook
# trace is the one place you go to ask "is Codex reporting at all", and it was
# answering no while Codex was reporting perfectly well.
#
# The agent is legible from the plugin root it handed us -- Claude Code caches
# under ~/.claude, Codex under ~/.codex -- so this costs a case statement and
# no subprocess. Done here rather than in hooks.json on purpose: the command
# line is unchanged, so this reaches sessions that are ALREADY RUNNING via
# syncPluginScriptsIntoCaches, and needs neither a version bump nor Codex
# re-trusting a changed hook.
#
# The replacement is deliberately of one exact literal, not a general rewrite:
# both call sites are fixed strings in hooks.json, and a `sed` would cost more
# than the request it is labelling.
BODY="${2:-\{\}}"
case "${CLAUDE_PLUGIN_ROOT:-}" in
  */.codex/*)
    NEEDLE='"source":"claude"'
    case "$BODY" in
      *"$NEEDLE"*) BODY="${BODY%%"$NEEDLE"*}\"source\":\"codex\"${BODY#*"$NEEDLE"}" ;;
    esac
    ;;
esac

# Backgrounded and detached: the agent waits for this script, not for the
# request. A server that is down, restarting or slow costs the turn nothing.
curl -s -m 2 -o /dev/null -X POST \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  "${URL%/}/api/sessions/${SID}/${1:-agent-state}" \
  >/dev/null 2>&1 &

exit 0
