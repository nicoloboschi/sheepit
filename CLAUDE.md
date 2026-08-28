# sheepit — notes for Claude

The project was called **vipershell** until the rebrand. Everything — code,
paths, env vars, storage keys, the npm package and the GitHub repository — is
sheepit now.

The npm package is **`@nicoloboschi/sheepit`**, scoped because the bare
`sheepit` name belongs to an unrelated package published in 2023. The `bin` is
still `sheepit`, so the scope only appears in an install line — `npx
@nicoloboschi/sheepit`, then `sheepit` forever after. Don't "fix" the scope
away without checking the registry first. The only file that still knows the old name is the one-shot
migration script; see [Legacy names](#legacy-names-dont-rename-just-document).

## Glossary (authoritative — use these terms)

When talking about features, writing comments, or naming variables, use these
terms consistently. The code has some legacy field names (`gridStates`,
`currentSessionId`) that don't match the glossary — document, don't rename,
unless the surrounding code is already being rewritten.

| Term | Meaning |
|---|---|
| **Session** | A backend PTY process. 1:1 with a pane. Identified by `sessionId`. Never use "session" to refer to a sidebar row. |
| **Pane** | A single terminal rendered in the UI. Backed by exactly one session. Has a `paneIndex` (0-based within its workspace). `TerminalCell` renders one pane. |
| **Workspace** | A sidebar row. A collection of 1–4 panes sharing a layout, name, and last-command. Identified by `workspaceId`, which equals the `sessionId` of the workspace's **root pane**. |
| **Root pane** | The pane at `paneIndex === 0`. Its session id *is* the workspace id. Anchor: closing it closes the whole workspace; currently not movable between workspaces. Surfaced in code as `isGridRoot`. |
| **Layout** | Shape of a workspace: `single` / `horizontal` / `vertical` / `three` / `quad`. Type alias: `GridLayout`. |
| **Active pane** | The focused pane inside the active workspace. Drives the Git/Files/Search tabs. Stored as `gridStates[workspaceId].activeCell`. |
| **Active workspace** | The workspace shown in the main area (sidebar selection). Stored as `currentSessionId` (legacy name; really means this). |

### The flock — user-facing vocabulary

The UI talks about sessions the way a shepherd talks about sheep. These words
appear in **UI strings only**; the code keeps the glossary names above. The
mapping lives in `ui/src/flock.ts`, which is where the counts come from too.

| UI word | Means | Store field |
|---|---|---|
| **Sheep** | A pane — one terminal, backed by one session | `workspaces[id].cells[n]` |
| **Pen** | A workspace — one sidebar row, holding 1–4 sheep | `workspaces[id]` |
| **The flock** | Every pen together (the sidebar heading) | `workspaceOrder` |
| **Bleating** | A sheep waiting for your input | `sessionNeedsAttention[sessionId]` |
| **Grazing** | A sheep with a command still running | `sessionBusy[sessionId]` |

**The plural of sheep is "sheep".** Never "sheeps" — `3 sheep`, `1 sheep`.
`plural()` in `flock.ts` defaults to adding an s, so counts of sheep go
through `sheepCount()` instead of each call site remembering to pass the
plural twice.

A pen is the enclosure, not the animals: it keeps its name, layout and
position whether or not anything is running in it, which is why closing a pen
closes what it holds. The flock is every pen together — so pens live *inside*
the flock, and a pen is never itself called a flock.

A sheep that is neither bleating nor grazing is just standing there — but that
still splits in two, because "finished, and you have read it" and "finished,
and you have not" are different things to a shepherd with twenty pens open.
The activity dot carries all four:

| dot | means |
|---|---|
| teal, pulsing | bleating — wants your input |
| meadow, steady | grazing — a command is running |
| amber, filled | idle, with output you have not read (`sessionHasUnseen`) |
| hollow ring | idle, and you have seen it |

The two live states take precedence: a sheep that is still working shows that
it is working, unread or not. Bleating wins over grazing when both would apply, so the two
counts never double-count a pane.

Write `sheep`/`pen` in UI copy and `pane`/`workspace` in code — including on
the wire, where the server and its API keep the plain names. A comment
explaining a UI string may use either, whichever makes the sentence clearer.

### Terms to avoid
- ❌ "primary session" / "primary pane" → ✅ **root pane**
- ❌ "grid" as a user-facing noun (in UI strings, comments, or docs) → ✅ **workspace** (or **pen** in UI copy)
- ❌ "split" as a noun → ✅ **pane** (or "non-root pane" when the distinction matters)
- ❌ "session" to mean "sidebar row" → ✅ **workspace**
- ❌ "sheeps" → ✅ **sheep** (its own plural)
- ❌ "flock" for a single workspace → ✅ **pen** (the flock is all of them)
- ❌ "vipershell" in anything a user reads → ✅ **sheepit**

### Legacy field names — don't rename, just document
- `gridStates` in the store = the per-workspace state map (keyed by `workspaceId`).
- `gridId` in component props = `workspaceId`. Both names are acceptable in code; prefer `workspaceId` in new code.
- `currentSessionId` in the store = the **active workspace id** (which is the root pane's session id — same thing).
- `splitSessionIds` in the store = session ids of non-root panes that must stay hidden from the sidebar.

## Brand palette — pasture colors

The brand color is a **meadow → moss gradient**: the greens of a field at
dusk on near-black olive surfaces. Green is now the brand *and* carries
"success" / "addition" / "healthy" — the two roles share `#9CBC7F`. What
distinguishes a state is the second colour: **amber** for wants-attention and
warnings, **terracotta** for errors and deletions.

Do not reintroduce blue or teal as a brand color. The remaining cool tone,
`--bleating`, is a moss teal used for one thing only: a pane that is waiting on
you.

### Tokens

```
Primary gradient (default):
  linear-gradient(135deg, #9cbc7f 0%, #6fa98c 100%)
    start: #9cbc7f   (meadow)
    end:   #6fa98c   (moss)

Hover / brighter variant (the base is light, so hover goes UP, not down):
  linear-gradient(135deg, #b0ce93 0%, #83bc9f 100%)

Light tint (10% alpha) — used for soft backgrounds:
  rgba(156, 188, 127, 0.1) → rgba(111, 169, 140, 0.1)

Dark surface gradient (control-plane backdrop):
  linear-gradient(135deg, #151a13 0%, #10130f 100%)
```

The light theme runs the same gradient in a deeper moss (`#4e7a3b` → `#2f6b55`)
because the meadow tones vanish against a pale page. It also flips
`--primary-foreground` to white; in dark it is the near-black `#0b0d0a`, since
the gradient fill itself is the light surface there.

### CSS variables (defined in `ui/src/style.css`)

| var                        | value                                       | use for                          |
|----------------------------|---------------------------------------------|----------------------------------|
| `--primary`                | `#9cbc7f`                                   | solid brand (borders, text, fg)  |
| `--primary-end`            | `#6fa98c`                                   | gradient end / secondary accent  |
| `--primary-foreground`     | `#0b0d0a` (dark) / `#ffffff` (light)        | text **on** a gradient fill      |
| `--primary-gradient`       | `linear-gradient(135deg, #9cbc7f, #6fa98c)` | buttons, filled surfaces         |
| `--primary-gradient-hover` | `linear-gradient(135deg, #b0ce93, #83bc9f)` | hover state for the above        |
| `--primary-tint`           | 10% alpha version of the gradient           | soft backgrounds                 |
| `--dark-surface-gradient`  | `linear-gradient(135deg, #151a13, #10130f)` | control-plane backdrops          |
| `--ring`                   | `#9cbc7f`                                   | focus outlines                   |
| `--success`                | `#9CBC7F`                                   | healthy / additions / clean tree |
| `--warning`                | `#D9B84A`                                   | amber — dirty tree, unseen output|
| `--destructive`            | `#E0907B`                                   | terracotta — errors, deletions   |
| `--bleating`               | `#8EBFA2`                                   | **only** for "wants your input"  |
| `--grazing`                | `#9CBC7F`                                   | running; also the grass strip    |

### The pasture (sidebar footer)

`FlockGrass` draws the grass strip and `FlockSheep` puts one 🐑 in it per
**real sheep** — one per pane, in the state that pane is actually in, read from
`useFlockSheep()`. It used to be one per *pen* with moods handed out from the
aggregate counts, so no animal in the strip corresponded to anything you could
go and look at. A sheep's behaviour is its pane's state: bleating sheep hop and
puff a "baa", grazing sheep keep their heads down, unread sheep plod with an
amber mark, idle sheep just plod.

**A bleating sheep calls you by its pane's name.** The footer line above says
how many are bleating; the name tag answers the other half — which one. Only
one sheep says a name at a time (`MAX_CALLING`): the strip is ~250px and a tag
is up to 118px of it. The tag breathes rather than blinking out — a label
legible for one second in four is one you have to sit and wait for. Rules:

- Both are pure CSS animation over a real emoji glyph — **no image requests**,
  nothing to load, and it stays correct on a LAN with no internet route.
- Blade and lane positions come from a fixed integer hash, never `Math.random`.
  A field that reshuffles itself every time a session goes busy is a
  distraction, not decoration.
- The strip is `pointer-events: none` end to end. It must never eat a click
  meant for the last pen card above it. That is also why a calling sheep's
  name is drawn rather than left to a tooltip: there is nothing to hover.
- The turn-around flip lives on `.flock-sheep-facing`, not on the sheep
  wrapper. As a transform on the whole sheep it also mirrored the name tag,
  and a sheep calling you in mirror writing is not calling you.
- Sheep near either end carry `flock-sheep-at-start` / `-at-end`, which folds
  both the name tag and the "baa" inward so neither is clipped by the sidebar.
- Everything stops under `prefers-reduced-motion: reduce` — the flock stays,
  the movement goes.
- The light theme swaps the sheep's knock-back for a drop-shadow outline;
  a white sheep on a pale field is otherwise invisible.
- `FlockChrome` exports the band, the strip and the footer. The desktop sidebar
  and the mobile Pens sheet both use them, and the mobile header carries a
  `slim` strip as its bottom edge — the flock has to be visible on a phone
  without opening a sheet.

### Fences and pens, on both sides

`PenFence` paints the fence on a canvas — rails that sag between their posts,
a grain hairline down each post, per-post jitter from the same deterministic
hash `FlockGrass` uses, and a real gap in the top rail with two taller
gateposts. CSS gradients can only give straight rails and evenly spaced ticks,
which reads as a border with marks on it.

It draws in two places, from one component:

- around each **pen** in the sidebar (`.pen-body`), wrapping the pane grid
  only — the pen's name, star and row menu sit *above* the fence. A name
  inside the enclosure cost a row of pen the sheep needed.
- around the **workspace** in the main area (`.workspace-pen`), because the
  workspace is the pen you are standing in. Same wood, wider gate
  (`gate={44}`; the sidebar's 17 reads as a nick at that width). Skipped on
  mobile, where the grid is one full-screen pane and a fence would only cost
  rows.

Both draw **grass** on the same canvas: scattered faintly over the whole pen
floor, then a dense saturated strip along the front edge. **Pane cards must
stay opaque** (`--accent`, not an alpha over it) — the grass is behind them,
and a translucent card puts the whole field behind every line of text. The
bottom padding on `.pen-body` / `.workspace-pen` is deeper than the other
three sides for the same reason: that is the clear ground the front strip
grows in, and with an even inset the cards sat straight on top of it. The cards and panes
paint on top, so what you see is the field showing through the gutters, the
margins and the gap under the last card — which is what makes an enclosure
read as ground rather than as a box with a border. The blades come from the
same deterministic hash as the posts, so one never moves when a sheep goes
busy, and none of it animates (unlike the sidebar's pasture strip). Keep the
front strip's alpha high: `--grazing` and `--fence` are both olive, and a
washed-out blade beside a rail just reads as more fence.

The workspace's **interior** rails are the resize separators, and those are
CSS on purpose: an interior rail that sagged would look wrong, straight and
evenly spaced is what gradients are good at, and a canvas cannot know where
the user has dragged a split to. Hover or drag still swaps the wood for the
brand gradient so a handle keeps announcing itself as a handle.

### Icons

- **Browser / PWA / apple-touch** (`ui/public/icon-*.png`, `favicon-*.png`):
  the real 🐑 emoji, rasterised onto the dark pasture plate with a grass line.
  Regenerate by rendering the glyph and compositing — an emoji-in-SVG `data:`
  favicon depends on the OS emoji font being reachable from the favicon
  rasteriser, which is not true everywhere.
- **Android** (`ic_stat_sheepit.xml`, `ic_launcher_fg.xml`): the drawn
  `SheepIcon` glyph, not the emoji. A notification small icon is a *silhouette*
  — only its alpha survives — so it has to be line art, and the launcher stays
  consistent with it.
- **In-app** (`ui/src/components/SheepIcon.tsx`): a terminal window wearing a
  fleece. Used where the mark needs to take `currentColor` (settings menu,
  connect screen). The sidebar wordmark uses the emoji instead.

### Pane chrome

A pane has **one** chrome bar, at the top. It used to have two — a header and
a footer under the terminal, ~34px and ~36px, each carrying a single line —
and they were merged. Terminal content is tall and narrow, so vertical rows
are the scarce resource: in a quad that merge handed ~72px of height back.
`--pane-chrome` / `--pane-chrome-active` still carry the gradient, and the
light-theme variants live on the tokens, so nothing branches on `theme` in JS.

The bar carries **identity, not telemetry**, in three ruled groups. The
**sheep leads it** — status is what you scan a wall of panes for, and the
agent's logo is not, since you already know what you started. Then the name
with the cwd as its subtitle. Then, flush right: what the pane is connected to
(agent mark, git handle, PR, links) │ what it is showing (the view switch) │
what you can do to it (mic, zen, close). The agent mark is drawn as a *mark*,
not a chip — no fill, no border, same weight as the git icon beside it — and
mic, zen and close share one `.pane-bar-btn` style so the right end reads as
one row of controls. The **branch name is deliberately not here** —
it was the only arbitrary-length string on the bar, so it set the width of
everything and squeezed the title, which matters more. The git icon still
carries the dirty state in its colour and opens the popover with the branch,
its ahead/behind counts and the rest; the sidebar's pen card keeps the branch
too. CPU / memory / URL-count readouts were deliberately removed. The
process list (with kill) and the detected-link list are still real tools, so
they keep one small `ListTree` handle that appears only when there is
something behind it — don't reintroduce the inline readouts.

**It is two lines tall at every width** — not from wrapping, but because the
name carries the path as its subtitle (`.pane-bar-title-block`). That stable
height is what lets the view switch sit up on the main row with the actions
rather than being pushed to a row of its own. `.pane-bar-actions` takes
`margin-left: auto`, so the bar always ends exactly on the zen and close
buttons however long the name or branch run.

**Nothing in the bar may change size with selection.** It used to grow 30px →
34px and the sheep 36px → 42px when a pane became active, which resized the
terminal underneath — and xterm's fit does not reliably follow a few pixels, so
the bottom row of output ended up clipped behind the pane's edge. Selection is
carried by background, border and ring only. If you add a control here, give it
the same height in both states.

Renaming is **inline**: the title is a button that becomes an input in place,
same size and position, committing on Enter or blur and cancelling on Escape.
The 280px popover that used to hold that one field is gone.

The class names say `pane-bar-*`, not `pane-footer-*`; there is no footer to
name any more.

### Zen mode

Zen insets the pane by **24px**, not the 40px it used to. It exists to read
one pane, so most of the window should be pane — but it still has to read as
an overlay floating over the grid rather than a mode that replaced it. 40px
was too much backdrop (~11% of a 1440px screen's width); 12px was too little
to see it was an overlay at all. `.pane-zen` also trims the terminal's own
padding — in a grid that inset keeps a pane's text off its neighbours, and
alone on screen there is no neighbour to keep it off.

### Rules of thumb

- **Solid brand color** → `var(--primary)` (`#9cbc7f`).
- **Filled buttons / hero surfaces** → `background: var(--primary-gradient)`,
  `var(--primary-gradient-hover)` on hover, and `color: var(--primary-foreground)`
  for the text — never a literal `#fff`, which disappears on the light fill.
- **Soft tinted backgrounds** → `var(--primary-tint)`.
- **Surfaces** are olive-tinted near-blacks, not neutral greys:
  `#0b0d0a` page, `#111411` card, `#181c16` sidebar/popover, `#232820` accent.
- **ANSI palette** (`ui/src/theme.ts`) is tuned to the same pasture range —
  sage green, amber yellow, terracotta red, muted mauve. Editing it restyles a
  running Claude/Codex session without sending it any bytes.
- **Vendor marks stay vendor-coloured**: `ClaudeIcon` keeps `#CC785C`, and the
  file-type colours in `FilesPane` keep their language colours. Those are other
  people's brands, not ours.

## Agent hooks — the two agents do not share a vocabulary

`plugin/hooks/hooks.json` is one file loaded by **both** Claude Code and
Codex, and each silently ignores event names it does not know. That tolerance
is what makes one file work; it is also what makes a mis-named event
undetectable, because a hook that was never wired and a hook that failed look
identical from a pane — both reporters exit 0 and print nothing by design.

The events are **not** the same set:

| moment | Claude Code | Codex |
|---|---|---|
| turn starts | `UserPromptSubmit` | `UserPromptSubmit` |
| still working | `PreToolUse` / `PostToolUse` | `PreToolUse` / `PostToolUse` |
| turn ends | `Stop` | `Stop` |
| **waiting on you** | `Notification` | `PermissionRequest` — **not wired yet**, see below |
| session starts / cleared | `SessionStart` (`startup`, `clear`) | `SessionStart` (`startup`, `resume`, `clear`, `compact`) |
| session ends | `SessionEnd` | `SessionEnd` |

Codex has **no `Notification` event at all**. Its full set is `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`,
`SubagentStop`, `Stop`, `Interrupt`. So the plugin reports `waiting` for
Claude and never once for Codex — the pane goes from grazing straight to
nothing while the agent sits on an approval prompt.

**`PermissionRequest` is deliberately not wired yet.** It is the right event,
but it is not a passive notification the way `Notification` is: Codex reads
the hook's *decision* from it, an exit code of 2 denies the request, and
invalid JSON on stdout is an error. A reporter on that hook sits directly in
front of the approval prompt the user is waiting to see. If it is wired, it
must go through `post.sh` rather than `report-state.mjs` — a fixed body needs
no payload parsing, so there is nothing to buy with a node spawn, and there
the rule that every path exits 0 and prints nothing stops being politeness and
becomes the thing that keeps it from answering a permission question nobody
asked it. Verify it against the hook trace on a real approval before trusting
it.

`post.sh` carries a fixed body, so it cannot be handed the caller's name —
hooks.json is one file and said `"source":"claude"` for both agents. It works
out which agent it is from the plugin root instead (`~/.claude` vs `~/.codex`).
Without that the trace reported Codex's tool pings as Claude's, which is worse
than leaving them unlabelled: the trace is where you go to ask "is Codex
reporting at all", and it answered no while Codex was reporting fine.

Observed, and not yet explained: **Codex fires `UserPromptSubmit` but has not
been seen to fire `Stop`.** So a Codex pane is named — from the prompt alone,
which is enough — but keeps the name the prompt implied rather than one that
knows how the turn went, and stays grazing until `AGENT_STATE_TTL_MS` expires
rather than settling when it finishes. Check the trace before assuming this is
still true.

### Never delete a plugin directory a session is using

Codex has no in-place upgrade for a local marketplace, so `installIntoCodex`
does remove-then-add — and `codex plugin remove` deletes the whole
version-keyed cache directory. Every **already running** Codex session
resolved `CLAUDE_PLUGIN_ROOT` to that directory when it started and uses that
path for its whole life, so deleting it does not downgrade those sessions, it
makes every hook in them fail. `sh` cannot find `post.sh`, and post.sh is on
`PreToolUse`/`PostToolUse` — so the error lands on **every tool call the agent
makes**, in the TUI, and a routine version bump reads to the user as sheepit
breaking every open Codex pane.

`restoreCodexVersionDir()` puts the deleted directory back, holding the new
code. That restores the property Claude Code has for free — it keeps old
version directories, which is the assumption `syncPluginScriptsIntoCaches` is
built on — and a running session gets the fixed scripts rather than merely
surviving. Bump the plugin version freely; do not remove a cache directory
without putting it back.

### Codex trusts hooks by hash

Codex will not run a hook command it has not been told to trust. `config.toml`
grows a `[hooks.state."<plugin>:hooks/hooks.json:<event>:<i>:<j>"]` table per
hook with a `trusted_hash`, and an entry that is missing or stale means that
hook is skipped — silently, like everything else on this path. So the list of
those tables is a second, independent answer to "is this hook live", and the
event missing from it is the one that is not running.

It also means a new event needs a Codex restart *and* the user's approval
before it fires for the first time. Adding one and seeing nothing in the trace
is expected on the first run; seeing nothing on the second is a bug.

### The hook trace

`src/hook-trace.ts` keeps every hook that reached the server for **one hour**,
in memory, and Settings → Agent Plugin renders it. It records at the *edge*,
in the request handlers, not in `DirectBridge` — a report rejected for an
unknown session never reaches the bridge, and `setAgentState`'s log only fires
when the state actually moved, so neither the rejections nor the refreshes
were visible anywhere before.

Read it for the **gaps**. A wired-but-broken hook is a red row; an event the
agent never fires is no row at all, and that absence is what the table above
is for.

## The PTY proxy — keep it empty

`src/pty-daemon.ts` holds every session's PTY master fd. That single fact sets
the rule: **a session lives exactly as long as that process.** Not because of
the `kill()` loop in its `exit` handler — SIGKILL it so no handler can run and
the shells still die, because closing the master hangs up the slave. Whoever
holds the fd owns the lifetime.

So every reason to redeploy that file is a reason someone loses their shells,
mid-build, mid-agent-run. It ignores SIGHUP/SIGTERM/SIGINT precisely so a
Ctrl+C in dev.sh cannot take the flock down with it.

It is therefore **a byte-mover and nothing else**: spawn, write, resize, kill,
subscribe, rekey, list. It does not parse escape sequences, track cwd, warm
pools, name sessions, or know what an agent is. Those all live in the server,
which restarts freely and reads whatever it needs off the same byte stream.

This is not hypothetical tidiness. A daemon here once served **nine-day-old
code** across many restarts, because the features that kept changing had been
written into it. OSC 7 cwd detection and the warm-shell pool were the last two;
both moved to `direct-bridge.ts`, and the proxy went 483 → 376 lines.

- **`PROTOCOL_VERSION`** in `pty-daemon.ts` and **`PROXY_PROTOCOL`** in
  `direct-bridge.ts` must match. The server warns at startup when they don't,
  because the proxy it just reached may predate the build. Bump it only when
  the message shape genuinely changes — needing to bump it means sessions die.
- **`rekey` is identity, not policy.** The server pre-spawns shells under
  `pool-N` ids and renames one when it becomes a session. Routing ids is the
  proxy's job; deciding when to rename is not.
- If you are about to add something here, add it to the server instead. If it
  truly cannot go there, you are about to cost every user every session — say
  so in the PR.

## Legacy names — don't rename, just document

Nothing in the shipped product carries the old name any more. `src/paths.ts`
returns one fixed path per directory, with no compatibility fallbacks: a config
directory that varied with filesystem state would let one server strand
another server's PTY daemon and every shell it holds.

The single exception is `scripts/migrate-from-vipershell.sh`, the one-shot
cutover for a machine that ran the old build — it moves both directories,
re-keys `preferences.json`, and uninstalls the old agent plugin. It is the only
file that should know the old name; delete it once nobody is upgrading from
vipershell any more.

### The preference-key namespace

`ui/src/preferences.ts` writes `sheepit:*` keys and `src/api.ts` validates the
same prefix before persisting them to the server-side profile. **They must be
changed together** — the UI's storage calls are proxied through that endpoint,
so a prefix mismatch silently drops every write.
