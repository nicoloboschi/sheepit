#!/usr/bin/env bash
#
# One-time cutover from the vipershell layout to the sheepit one.
#
#   ~/.config/vipershell            ->  ~/.config/sheepit
#   ~/.vipershell                   ->  ~/.sheepit
#   preferences.json  vipershell:*  ->  sheepit:*
#   agent plugin      vipershell@vipershell  uninstalled (sheepit@sheepit
#                     is installed by the server on its next start)
#
# Live shells survive this. The PTY daemon is reached through a unix socket
# *inside* the config directory, and a socket is bound by inode, not by path —
# so the daemon keeps serving through a rename of its parent and the next
# sheepit server reconnects to the very same process.
#
# Stop the server first (the daemon ignores SIGTERM and stays up on its own).
# Run with --dry-run to see the plan without touching anything.
#
set -euo pipefail

DRY=0
[ "${1-}" = "--dry-run" ] && DRY=1

OLD_CONFIG="$HOME/.config/vipershell"
NEW_CONFIG="$HOME/.config/sheepit"
OLD_STATE="$HOME/.vipershell"
NEW_STATE="$HOME/.sheepit"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then say "would run: $*"; else "$@"; fi; }

[ "$DRY" = 1 ] && printf '\n\033[2m-- dry run: nothing will be changed --\033[0m\n'

# ── Refuse to merge two layouts ─────────────────────────────────────────────
# Renaming onto an existing directory would nest one inside the other, and two
# directories each claiming the same daemon PID is the one shape the lookup
# cannot resolve. Bail rather than guess.
step "Checking for a clean cutover"
fail=0
for pair in "$OLD_CONFIG:$NEW_CONFIG" "$OLD_STATE:$NEW_STATE"; do
  old="${pair%%:*}"; new="${pair##*:}"
  if [ -e "$new" ]; then
    say "✗ $new already exists — move or remove it first"
    fail=1
  elif [ ! -e "$old" ]; then
    say "· $old not present, nothing to move"
  else
    say "✓ $old -> $new"
  fi
done
[ "$fail" = 1 ] && { printf '\nAborted, nothing changed.\n'; exit 1; }

# ── Report the daemon we are about to carry across ──────────────────────────
step "PTY daemon"
PIDFILE="$OLD_CONFIG/pty-daemon.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  say "pid $(cat "$PIDFILE") is alive — it will keep serving through the move"
  if [ -f "$OLD_CONFIG/direct-sessions.json" ]; then
    say "holding $(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$OLD_CONFIG/direct-sessions.json" 2>/dev/null || echo '?') sessions"
  fi
else
  say "no live daemon — nothing to preserve, the move is trivial"
fi

# ── Move ────────────────────────────────────────────────────────────────────
step "Moving directories"
moved() { [ "$DRY" = 1 ] || say "$*"; }
[ -e "$OLD_CONFIG" ] && { run mv "$OLD_CONFIG" "$NEW_CONFIG"; moved "moved config"; }
[ -e "$OLD_STATE" ]  && { run mv "$OLD_STATE"  "$NEW_STATE";  moved "moved state"; }

# ── Re-key the stored preferences ───────────────────────────────────────────
# Every key is namespaced by product name, and the server now only accepts
# `sheepit*`. Rewrite the prefix in place, keeping a backup, so saved
# workspaces / layouts / theme survive the rename.
step "Re-keying preferences.json"
PREFS="$NEW_CONFIG/preferences.json"
[ "$DRY" = 1 ] && PREFS="$OLD_CONFIG/preferences.json"
if [ -f "$PREFS" ]; then
  DRY="$DRY" PREFS="$PREFS" python3 <<'PY'
import json, os, shutil

prefs = os.environ['PREFS']
dry = os.environ['DRY'] == '1'
with open(prefs) as fh:
    data = json.load(fh)

# The file is either {"values": {...}} or a bare key->value map, depending on
# which build wrote it last. Re-key whichever shape we find.
container = data['values'] if isinstance(data, dict) and 'values' in data else data

renamed, kept = {}, 0
for key, value in container.items():
    if key.startswith('vipershell'):
        renamed['sheepit' + key[len('vipershell'):]] = value
    else:
        renamed[key] = value
        kept += 1

print(f'  {len(renamed) - kept} keys re-keyed, {kept} left alone')
if dry:
    print('  would rewrite', prefs)
else:
    shutil.copy2(prefs, prefs + '.pre-sheepit.bak')
    if isinstance(data, dict) and 'values' in data:
        data['values'] = renamed
    else:
        data = renamed
    tmp = prefs + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(data, fh)
    os.replace(tmp, prefs)          # atomic; never a half-written profile
    print('  rewrote', prefs)
    print('  backup at', prefs + '.pre-sheepit.bak')
PY
else
  say "no preferences.json, skipping"
fi

# ── Retire the old agent plugin ─────────────────────────────────────────────
# The state-reporting plugin is installed into Claude Code and Codex under the
# old marketplace name. The new server installs `sheepit@sheepit` on its next
# start; left alone, `vipershell@vipershell` would keep firing its hooks on
# every agent turn, look for a server directory that no longer exists, and
# exit — harmless, but it is real latency on every turn for nothing.
step "Retiring the vipershell agent plugin"
OLD_PLUGIN='vipershell@vipershell'
if command -v claude >/dev/null 2>&1 &&
   grep -q "$OLD_PLUGIN" "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null; then
  say "Claude Code: removing $OLD_PLUGIN"
  run claude plugin uninstall "$OLD_PLUGIN" || say "  (uninstall failed — remove it by hand with: claude plugin uninstall $OLD_PLUGIN)"
  run claude plugin marketplace remove vipershell || true
else
  say "Claude Code: $OLD_PLUGIN not installed"
fi
if command -v codex >/dev/null 2>&1 &&
   grep -q "plugins.\"$OLD_PLUGIN\"" "$HOME/.codex/config.toml" 2>/dev/null; then
  say "Codex: removing $OLD_PLUGIN"
  run codex plugin remove "$OLD_PLUGIN" || say "  (remove failed — remove it by hand with: codex plugin remove $OLD_PLUGIN)"
else
  say "Codex: $OLD_PLUGIN not installed"
fi

step "Done"
if [ "$DRY" = 1 ]; then
  say "dry run only — re-run without --dry-run to apply"
else
  say "start sheepit; it should reattach to every session that was running"
fi
