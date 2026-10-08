# sheepit — notes for Claude

Rules and traps, not history. The *why* behind most of these lives in the git
log and in comments next to the code.

The project was called **vipershell**. Everything is sheepit now. The npm
package is **`@nicoloboschi/sheepit`** (scoped because bare `sheepit` is taken
by an unrelated package); the `bin` is still `sheepit`. Don't drop the scope
without checking the registry. The only file that knows the old name is
`scripts/migrate-from-vipershell.sh`.

## Glossary — use these terms

| Term | Meaning |
|---|---|
| **Session** | A backend PTY process. 1:1 with a pane. `sessionId`. Never a sidebar row. |
| **Pane** | One terminal in the UI, backed by one session. `paneIndex` within its workspace. Rendered by `TerminalCell`. |
| **Workspace** | A sidebar row: an ordered, unbounded list of panes, showing exactly one. Synthetic `workspaceId`, never a session id. |
| **Field** | A user-made group of workspaces. Membership lives on the workspace (`Workspace.fieldId`). |
| **Shown / active pane** | The one pane of a workspace on screen: `workspaces[id].cells[activeCell]`. Drives Git/Files/Search. |
| **Active workspace** | The workspace in the main area. Stored as `currentSessionId` (legacy name). |

### UI words (the flock)

UI strings say sheep/pen; code (and the wire) says pane/workspace. Mapping and
counts live in `ui/src/flock.ts`.

| UI word | Means | Store |
|---|---|---|
| **Sheep** | a pane | `workspaces[id].cells[n]` |
| **Pen** | a workspace | `workspaces[id]` |
| **Field** | a group of pens | `fields[id]` |
| **The flock** | every pen (sidebar heading) | `workspaceOrder` |
| **Bleating** | waiting for your input | `sessionNeedsAttention[sessionId]` |
| **Grazing** | a command is running | `sessionBusy[sessionId]` |

- Plural of sheep is **sheep**. Count via `sheepCount()`, not `plural()`.
- A pen is the enclosure: it keeps its name and place whether or not anything
  runs in it. Closing a pen closes its sheep.

Avoid: "root/primary pane", "grid"/"layout"/"quad"/"split the pen"/"zen" (none
exist), "session" for a sidebar row, "sheeps", "flock" for one pen or for a
group (that's a field), "vipershell" anywhere a user reads, counting the dog
as a sheep (the dog is a pane, never a sheep).

### Legacy names — document, don't rename

- `gridId` prop = `workspaceId` (prefer the latter in new code).
- `currentSessionId` = active workspace id (a `ws-…` id).
- `activeCell` = index of the shown pane.
- `TerminalGrid` renders one pane.
- Pane view state `split` = the Files tool.

## Activity states

Four states, one source: `sheepStateOf()`. Pane bar, pen card, fold dots and
pasture all read it, so they can't disagree. Bleating beats grazing beats
unread beats idle; counts never double-count.

| state | dot | pen-card mark | card tint |
|---|---|---|---|
| bleating | red, pulsing | raised red hand, waving | red (strongest) |
| grazing | amber, steady | amber spinner | amber (weakest) |
| unread (`sessionHasUnseen`) | green, filled | green sheep, hopping | green |
| idle | hollow ring | wool sheep lying down, static | none |

- Only the unread sheep animates in a card. The idle `zzz` drifts **only** in
  the pane bar (`.pane-header .sheep-idle`). **Never scope an infinite
  animation to a selector that matches once per pane** — it once meant 100+
  animations running for nothing.
- Everything stops under `prefers-reduced-motion: reduce`.
- **Typing marks a pane read; selecting does not.** `clearUnseen` is called
  from `sendInput` for real keystrokes only (not focus/mouse reports, CPR,
  arrows).
- Unread means an agent finished a turn or the app rang the bell. A plain
  shell printing output does not light up.

## Brand palette

Meadow → moss gradient on near-black olive surfaces. Green is brand *and*
success (`#9CBC7F`). Amber = attention/warning, terracotta = error/deletion,
red = bleating only. **No blue or teal as a brand colour.**

| var (in `ui/src/style.css`) | value | use |
|---|---|---|
| `--primary` | `#9cbc7f` | solid brand |
| `--primary-end` | `#6fa98c` | gradient end |
| `--primary-foreground` | `#0b0d0a` dark / `#fff` light | text on a gradient fill |
| `--primary-gradient` | `135deg, #9cbc7f → #6fa98c` | buttons, filled surfaces |
| `--primary-gradient-hover` | `135deg, #b0ce93 → #83bc9f` | hover goes *up* |
| `--primary-tint` | gradient at 10% alpha | soft backgrounds |
| `--dark-surface-gradient` | `135deg, #151a13 → #10130f` | control-plane backdrops |
| `--ring` | `#9cbc7f` | focus outlines |
| `--chrome` / `--chrome-line` | `#15171a` dark / `#eef0f3` light; ~7–10% hairline | sidebar + top bars |
| `--success` | `#9CBC7F` | healthy, additions |
| `--warning` | `#D9B84A` | dirty tree, unseen output |
| `--destructive` | `#E0907B` | errors, deletions |
| `--bleating` | `#E2584A` | **only** "wants your input" |
| `--grazing` | `#9CBC7F` | the grass (not the running mark) |

Light theme runs the gradient deeper (`#4e7a3b → #2f6b55`).

Rules of thumb:
- Text on a gradient fill uses `var(--primary-foreground)`, never literal `#fff`.
- Surfaces: `#0b0d0a` page, `#111411` card, `#181c16` popover, `#232820` accent.
- **Chrome is neutral graphite**, not green: sidebar, workspace bar, mobile
  header, pane bar. Green must *say* something to appear.
- Selection is a **lift, not a hue**. Selected pen = lift + fence lit + solid
  brand rail on the left. Focused pane card = lift + brand rail
  (`.pane-card-active::after`). No coloured fills for selection.
- ANSI palette is in `ui/src/theme.ts`, tuned to the same range.
- Vendor marks keep vendor colours (`ClaudeIcon` `#CC785C`, language colours
  in `FilesPane`).

### Icons

- Browser/PWA (`ui/public/icon-*.png`, `favicon-*.png`): real 🐑 emoji
  rasterised onto the dark plate. Don't use an emoji-in-SVG favicon.
- Android (`ic_stat_sheepit.xml`, `ic_launcher_fg.xml`): drawn line-art
  `SheepIcon` (notification icons are alpha-only silhouettes).
- In-app `SheepIcon.tsx` takes `currentColor`. The sidebar wordmark uses the emoji.

## Sidebar

### Pens, folding, fields

- A pen **folds** to one line: its name plus one `SheepDot` per sheep
  (`Workspace.collapsed`). The dots must still show a bleating sheep.
- **Fields are manual.** One default field (`DEFAULT_FIELD_ID`) to start;
  users create more and move pens from a pen's menu. `dropDerivedFields`
  clears old auto-derived fields on load.
- `assignFields` runs inside `renderSessions`: any pen without a valid
  `fieldId` goes to the default field. It must return the same objects when
  nothing changed, so the caller skips the write.
- `workspaceOrder` is the only list of pens; a field's pens come from
  `pensInField()`. No second ordering.
- Deleting a field never closes a pen; its pens fall back to the default.
- The sidebar shows one field, chosen in `FieldSelector` (which *is* the
  `FlockBand`). It shows other fields' bleating counts.
  `setCurrentSessionId` pulls the sidebar to the selected pen's field.

### The URL

`#<workspaceId>[/p:<sessionId>][/f:<fieldId>][/b:<page>]`

- Field is per tab, in the URL, not in preferences. On restore apply the field
  *after* the workspace (the URL wins over the pull-to-field).
- `/p:` names the shown pane. `/b:` is the active pane's browser page,
  percent-encoded, always last.

### The pasture (sidebar footer)

`FlockGrass` draws the grass; `FlockSheep` shows a 🐑 **only for bleating
panes**. Empty grass means nobody needs you.

- Clicking a sheep goes to its pen *and* that pane. Strip/footer take the
  caller's `onConnect`.
- Only one sheep shows its name tag at a time (`MAX_CALLING`); the rest carry
  it in `title` / `aria-label`.
- Pure CSS over the emoji glyph, no image requests. Grass is canvas from
  `grass.ts`, the same code the pens use.
- Positions come from a fixed integer hash, never `Math.random`.
- Strip is `pointer-events: none`; only `.flock-sheep-hit` opts back in. Hit
  area is padding + matching negative margin.
- Hover lights the ground, not the sheep (the sheep's transform belongs to the hop).
- The flip lives on `.flock-sheep-facing`, not the wrapper (else the tag mirrors).
- Edge sheep get `flock-sheep-at-start` / `-at-end` so tags aren't clipped.
- Light theme uses a drop-shadow outline on the sheep.
- `FlockChrome` exports band, strip and footer for desktop sidebar, mobile
  Pens sheet, and a `slim` strip under the mobile header.

### Fences (`PenFence`)

Canvas, not CSS: sagging rails, post grain, deterministic jitter, a gate.

- Sidebar pen (`.pen-body`): fence around the pane cards only; name and menu
  sit above it.
- Main area (`.workspace-pen`): **grass only** (`rails={false}`). Skipped on
  mobile.
- Grass: faint over the floor, dense strip along the front. Keep the front
  strip's alpha high. Nothing animates.
- **Pane cards must be opaque** (`--accent`, not alpha). Bottom padding is
  deeper than the sides (that's where the grass grows).
- Horizontal padding on `.pen-body` is fence geometry — don't trim it.
- Both resize observers coalesce into one frame; reading layout while dirty is
  what costs, not the grass strokes.

### The pen card

A pen is a list of pane cards (`.pane-grid-list`), **two per row**, fixed (not
`auto-fill`). A pen with one sheep spans both columns (`:only-child`); an odd
last card stays half width.

A card is ~46px, two rows:
1. the name, up to two lines
2. info row: agent mark, context count, time, status mark (last item in the row)

- Context count is brand green, bright; name is foreground; time is quieter.
- Zero context draws a dim en-dash (`.pane-card-ctx-empty`), exact count in
  `title`. Test is `!== undefined` — absent means no agent, draw nothing.
- Each card is `container-type: inline-size`. Below 128px the time drops.
  Agent mark, context count and status mark never drop. Row height never changes.
- **Not on the card, on purpose:** PR (pane bar only), dirty dot (git icon in
  pane bar), cwd row (pane bar subtitle; full path in `title`).

## Pane chrome

One bar, at the top. Order: **sheep** → name with cwd subtitle → flush right:
connections (agent mark, git icon, PR) │ tools toggle │ actions (mic, close,
shared `.pane-bar-btn`).

- Always two lines tall (`.pane-bar-title-block`). `.pane-bar-actions` has
  `margin-left: auto`.
- **Nothing in the bar may change size with selection** — it resizes the
  terminal and clips the last row.
- No branch name in the bar (git icon colour = dirty state; popover has branch).
- No CPU/memory/URL readouts. The process list keeps one `ListTree` handle,
  shown only when there's something to show.
- Rename is inline: title button becomes an input; Enter/blur commits, Escape cancels.
- Class names are `pane-bar-*`.
- Light-theme variants live on the tokens; nothing branches on `theme` in JS.

## One pane on screen

A pen holds any number of sheep and shows one. No grid, layout, separators or
zen.

- **Nothing above the pane.** The sidebar is the switcher; ⌘↑/↓ walks sheep.
- **Every sheep in the shown pen stays mounted**, hidden ones under
  `display: none`. At most a dozen pens are mounted.
- `isOnScreen` in the store is the one test for "on screen";
  `updateActivity`, `sessionAttention`, `markUnseen` go through it.
- Becoming the shown pane is a resize (refit + tell the PTY), keyed on
  `isActive`. Its two rAF ids live in a **ref**, not a shared slot.
- No selected ring/glow/dimming. Only the file-drop outline remains.
- "Add sheep" (`onAddSheep`) is one button in the workspace bar. It claims the
  new session for the pen *before* asking for the session list.

### What a pane can show

The terminal is never hidden. One toggle in the bar shows/hides the tools;
tools are tabs on a vertical rail (`ToolRail`, `TOOL_TABS`), restored via
`lastToolRef`.

| state | beside the terminal |
|---|---|
| `terminal` | nothing |
| `split-github` | PRs and issues (first on the rail) |
| `working` | working tree |
| `log` | commit log |
| `split` | files |
| `split-preview` | browser |
| `split-terminals` | this pane's shells (last) |

All splits share one divider and one stored width. `isSplit` is the only
predicate. Old persisted values (`files`, `preview`, `diff`, `github`) are
migrated in `readPaneView`.

### Side terminals

Up to `MAX_SIDE_TERMINALS` = 4 shells per pane, in its directory.

- A side terminal is `isHeadless` + `sideOf: <owner id>`. No `sideOf` = global
  scratch shell. Panel filters `isHeadless && !sideOf`; a pane's split filters
  `sideOf === me`. `sideOf` is persisted.
- The client sends `side_of`, no path; the server picks the owner's cwd.
- `restart` carries `side_of`, closes first, then counts the cap.
- `closeSession` collects a pane's side terminals before the kill and closes
  them after.

### Global scratch terminals

`TerminalsDialog` (a `FloatingPanel`) holds up to `MAX_HEADLESS` = 4 shells
that belong to no pane, tiled by `TerminalTiles` (1 full, 2 side by side, 3 as
one-over-two, 4 as 2×2). No draggable separators; don't bring back
`react-resizable-panels`.

- Cap is enforced server-side in `create_session`; UI's constant is a mirror.
- `restart` names its target and runs server-side in one step.
- Panel holds no state: it's `sessions.filter(isHeadless)`.

### A tile is not a pane

`TerminalCell` with `tile` (both side and global terminals):
- No tools, no rail, terminal only.
- Persists no view in `sheepit:pane-views`.
- Never claims global active-pane slots: the ⌘←/→ cycle,
  `activeTerminalSend`, and mount-time focus are gated on `isActive && !tile`.
- `gridId` is `__headless__:<id>`, matching no workspace. Code reading a pen
  from it must handle the miss.

## Session names (`ai.ts`)

- **The agent's own title is the name.** Claude Code writes an `ai-title` row
  each turn; `readAgentTitle` reads the last one from the transcript tail.
- Codex and Pi write no title. Name them from the first prompt
  (`readOpeningPrompt`, head of file, one 256KB read, skip slash commands).
- A `/clear`ed pane is named `-` until retitled. `looksLikeAssignedName`
  claims `-` explicitly.
- No model call names anything.
- `normalizeAssignedName` only enforces the shape: charset, six words, 60
  chars, starts with a letter. It does **not** strip PR numbers, uuids, etc.
- **Writer and reader are one contract**: anything `normalizeAssignedName`
  outputs, `looksLikeAssignedName` must accept (asserted in `ai.test.ts`).
  Change both limits together. A name the reader can't claim is never renamed again.
- Turns (`appendAgentTurn`) are kept for ⌘K and the hook trace, not naming.

### Context size (`readContextTokens`)

Read from the transcript tail, shown on the card as `ctxTokens` / `ctxLimit`.

- **Claude Code:** `input + cache_read + cache_creation` (cache is nearly all of it).
- **Codex:** `event_msg` with payload `token_count`,
  `info.last_token_usage.input_tokens` (not `total_token_usage`). Window from
  `info.model_context_window`. Fallback: old `token_usage_record` rows.
- **Pi:** `usage.input + cacheRead + cacheWrite`. `usage.cost.total` is shown
  as Cost; absent = not reported.
- Show a percentage only when the agent reports its window (Codex). Claude and
  Pi never do — **never guess a window**; absent `ctxLimit` means unknown. Don't
  build on the `cost-state` / `[1m]` model key.
- Stat the file first; re-read the tail only if mtime moved.
- `ctxTokens` and `ctxLimit` must be in the store's equality allowlist
  (`sameSession`) *and* in `countChangedField`, or the value freezes.

## Agents

| | Claude Code | Codex | Pi | Hermes |
|---|---|---|---|---|
| transcript | `~/.claude/projects/<slug>/<uuid>.jsonl` | `~/.codex/sessions/Y/M/D/rollout-*-<id>.jsonl` | `~/.pi/agent/sessions/<slug>/<ts>_<id>.jsonl` | none (SQLite) |
| found by | hook gives path | hook gives id; filename ends in it | cwd (`findPiSession`) | — |
| reporter | hooks plugin | hooks plugin | extension `plugin/pi/sheepit.js` | none |
| title | `ai-title` | opening prompt | opening prompt | — |
| window size | never | `model_context_window` | never | — |
| resume after reboot | `claude --dangerously-skip-permissions -c` | no | `pi -c` | no |

- `resolveAgentTranscript` is the one chokepoint for every reader (Agent tab,
  card context, ⌘K, the dog). Pi discovery is cached 10s, not for life. Match
  Pi's slug on letters and digits only.
- Claude's project slug uses the **resolved** path (`/tmp/x` →
  `-private-tmp-x`). Don't rebuild slugs from cwd.
- Only `-c` flags that mean "last conversation *in this directory*" go in
  `AGENT_RESUME_COMMANDS` (`direct-bridge.ts`). Codex/Hermes resume the latest
  on the machine — wrong work.
- Codex field names: turns end on `task_complete`, effort is
  `turn_context.effort`, sandbox is `{"type":...}`, branch is
  `session_meta.git.branch`.
- Hermes: detected and drawn, nothing to read. `AgentKind` has no `hermes`.

### Agent hooks

`plugin/hooks/hooks.json` is loaded by both Claude Code and Codex; each
silently ignores unknown events. A never-wired hook and a failing hook look
the same — verify against the hook trace.

| moment | Claude Code | Codex |
|---|---|---|
| turn starts | `UserPromptSubmit` | `UserPromptSubmit` |
| working | `PreToolUse` / `PostToolUse` | same |
| turn ends | `Stop` | `Stop` |
| waiting on you | `Notification` (see below) | `PermissionRequest` |
| session start / clear | `SessionStart` | `SessionStart` |
| session end | `SessionEnd` | `SessionEnd` |

- **`Notification` is two events.** "Claude needs your permission…" =
  bleating. "Claude is waiting for your input" = finished, **idle**.
  `report-state.mjs` downgrades the second (`NOT_BLOCKED`); tested in
  `src/__tests__/report-state.test.ts`.
- **The bell (OSC 9) is not attention** for any pane that has ever reported
  a hook state (`handleNotification`). Panes with no reporter still bleat on it.
- **`PermissionRequest` goes through `post.sh` with a fixed body.** Codex reads
  the hook's decision; exit 2 denies, bad stdout is an error. Every path must
  exit 0 and print nothing. Needs a Codex restart and trust approval.
- `post.sh` infers `source` from the plugin root (`~/.claude` vs `~/.codex`).
- `Stop` fires once per turn among hundreds of tool pings; a short trace
  sample isn't proof it's missing.

### Pi extension

`plugin/pi/sheepit.js` reports as `source: "pi"`. Events: `turn_start`,
`message_end`, `tool_execution_start/end`, `ui_prompt_start/end` (waiting),
`agent_settled` (not `agent_end`), `session_start` (`reason: "new"` = clear),
`session_shutdown`.

- Never await anything (fire-and-forget POSTs).
- Wrap every handler; always return `undefined` (asserted in `pi-extension.test.ts`).
- Installed by copying to `~/.pi/agent/extensions/sheepit.js`
  (`installIntoPi`); version is a first-line comment. Loaded once at startup.
- **Don't load it twice** (`--extension` plus the installed copy = every state
  reported twice).

### Codex plugin cache

- `installIntoCodex` removes then adds, which deletes the version cache dir
  running sessions use. `restoreCodexVersionDir()` puts it back. Never remove
  a cache dir without restoring it.
- Codex runs only hooks trusted by hash (`[hooks.state."…"]` in
  `config.toml`). A new event needs restart + approval.

### Hook trace

`src/hook-trace.ts`: every hook that reached the server, one hour, in memory;
shown in Settings → Agent Plugin. Recorded in the request handlers, not
`DirectBridge`. Read it for gaps.

## Nothing reads the terminal as text

The terminal is bytes to render. Facts come from hooks, the OS, or git. Kept
on the byte stream: OSC 7 (cwd), OSC 9/777/99 (notifications), OSC 9;4
(progress), DEC private modes.

- **PR/issue refs** (`src/pr-refs.ts`) come only from hooks. `post.sh` greps
  the tool payload only when it mentions `gh pr` / `gh issue` (64KB cap).
  Bare `#123` is accepted only from prompts/replies. Merged per session,
  newest first, capped at `MAX_REFS`, persisted, sent as `prRefs`. The bar
  shows the most recent one. No "PR of this branch" lookup.
- No `preview` message; `publishActivity` publishes the busy flag only when it flips.

### ⌘K search (`src/search.ts`)

- Facts from memory (name, cwd, branch, `prRefs`, recent turns) + ripgrep
  over agent transcripts (one run over all files).
- Never read scrollback.
- `transcriptLineText` keeps only user/assistant conversation; drops
  attachments, system, tool results, Codex developer rows, sidechains.
- Per-file cap `-m 25`.
- Transcript paths are untrusted: `isSearchableTranscript` requires them under
  a known root.
- Three groups (what the pane is / what you said / what the agent said), one
  row per pane per group (`matchFactsAll`, `bestPerGroup`). Client sorts once.
- Snippets must contain the match (`containsPattern`); `snippetAround`
  anchors on the rarest term. Use the row's own timestamp. Server says what to highlight.
- Rank: exact PR ref > name > branch/cwd > turn text > transcript; user
  message > assistant.

## Measuring the UI (`ui/src/perf.ts`)

The only thing that measures the UI. Nothing else calls `performance.now()`,
creates a `PerformanceObserver`, or counts frames. On in every build.

- `perf.span(name)` (returns the end fn), `perf.count(name)`,
  `perf.commit(id, ms)` from the two `<Profiler>`s (`sidebar`, `pane`), plus
  long-animation-frame attribution.
- Snapshots post to `POST /api/perf` every 10s (timer, not rAF); server keeps
  one hour in memory.

```
curl -s 'localhost:4445/api/perf?spans=1&shell=electron&minutes=10' | python3 -m json.tool
curl -X DELETE localhost:4445/api/perf     # before measuring a fix
```

- Filters: `?minutes=`, `?shell=electron|browser`, `?page=`. **Always narrow
  to one page.** Check `holding` (nodes, pens, sheep) before comparing.
- Dev numbers are inflated (dev React + StrictMode double render). Quote
  shapes, not dev milliseconds. `commit:*` works in production builds too.
- Ignore freshly loaded pages and occluded windows (throttled to ~1/min).
  `ident:noPrev` marks cold-start rebuilds. `commit:split` nests inside `commit:pane`.
- `scripts/perf.py` gates the ceilings.
- Fast Refresh doesn't establish a new `memo` boundary; reload first.

### Performance rules that must hold

- **Identity is the signal.** `sameSession()` keeps a session object when its
  allowlisted fields match; `nextWorkspaces` does the same for pens. Don't
  rebuild these wholesale. A field added to `sameSession` must also go in
  `countChangedField` (`ident:field:<name>`).
- Don't compare fields nothing renders (e.g. `cpuPercent`, `memMb`) — give a
  readout its own narrow subscription instead.
- `SessionItem`, `PaneCard`, `TerminalGrid`, `TerminalCell` are `memo()`d.
  **Never pass them an inline lambda/object** — callbacks take an index and
  are `useCallback`s.
- `TerminalCell` holds its split element in a `useMemo`; dependencies are
  listed explicitly. An inline lambda there silently turns it off.
- A component subscribing to a clock (`useSharedTick`) or to
  `sessionLastEvent` must be the smallest thing that changes (`PaneAge`).
- Busy-flag timers flush into one store write per turn (0ms flush).
- `display: none` stops painting, not rendering. Don't mount what isn't shown
  (sidebar is not mounted on phones).
- `NativeBrowserSurface`: no timers; `IntersectionObserver` for visibility; rAF
  only while following; box and hit-test are gated after ten still frames and
  800ms without input. Plain typing doesn't count as input.
- Clicks still re-render every dnd-kit consumer (context change). `memo` won't
  fix that; next step is isolating `DndContext` or stable `items` arrays.
- `content-visibility: auto` on pens breaks dnd-kit measuring; don't add it speculatively.
- `bootstrap()` retries `initializePreferences()`; never proceed without the profile.
- Known unfixed bug: `last_activity` is the server start time after a restart.

## Terminal rendering

- **Font change needs `WebglAddon.clearTextureAtlas()`** (`webglRef`);
  `term.refresh()` isn't enough. Without WebGL, fall back to `refresh()`.
  Size changes need nothing. "Works after reload" is this bug's signature.
- `TERMINAL_LINE_HEIGHT` is **1** (in `theme.ts`), used by `TerminalCell`,
  `TerminalPane`, `MobileKeybar` fallbacks. The Appearance preview uses CSS
  `line-height: normal`. Constructor option: needs a new `Terminal`.

## Native view — Claude Code drawn by sheepit

A pane button swaps the TUI for a conversation view of **the same running
session**: input is typed into the PTY (`DirectBridge.sendInput`), output is
the transcript tailed (`src/claude-native.ts`). No stream-json fork.

- Liveness comes only from the pane's busy flag.
- `AskUserQuestion` / `ExitPlanMode` drawn by `ChoiceBlock`, read-only (no
  answering from here).
- `/` menu (`src/slash-commands.ts`, `useSlashCommands`): user/project/plugin
  skills from disk (plugin ones as `plugin:skill`), built-ins static. Handle
  YAML block-scalar descriptions. Opens only when `/` is first and there is no space.
- TUI dialogs (permission, trust, `/resume` picker) aren't in the transcript;
  don't guess at them.
- Send = bracketed paste, then Enter as a separate write. Interrupt = Escape.
- Re-ask the transcript path every poll; a change emits `reset`.
- Only non-sidechain user/assistant rows; drop `<...>`-wrapped notices. Keep
  partial trailing lines for the next read.
- Echo the sent message until the real row arrives (matched on text).
- `.nat-list > *` gets `flex-shrink: 0`.
- Tool call = ruled line with brand-green left rail.
- `--nat-size` on `.nat-pane`: 14.5px, 16px below 768px.
- Agent output is Markdown (react-markdown + remark-gfm, `.md-preview`);
  `white-space: normal` on it; `.nat-text` max 74ch; `li > p { margin: 0 }`.
  User messages are plain text.
- `clearAgentSession` on `/clear` drops the pane's agent ref.
- Terminal stays mounted while hidden. Mode is app-wide and device-local
  (`sheepit:pane-mode` in localStorage, in `DEVICE_LOCAL`), synced via
  `subscribePaneMode`. Mobile key bar hidden in this mode. Claude Code only.

## GitHub view

All via the signed-in `gh` on the server.

- Linked refs use `gh api graphql` (`issueOrPullRequest`,
  `includeClosedPrs: true`); `gh … --json` has no such fields.
- Kind in `/gh/:kind/:num` is a hint. Probe `gh pr view N` first, fall back
  to `gh issue view N` (it answers for both, so never first). Reply carries
  the real kind.
- `null` = failed (show reason, Retry), `[]` = genuinely empty. **Never cache
  a failure.** Errors carry `{ error }` with gh's first stderr line.
- **Never ask a list for `statusCheckRollup`** (10x slower; fails on closed PRs).
- Cache keyed on `owner/repo` (`repoSlug()`), not cwd. No-remote falls back to cwd.
- Watched lists (`watchedLists`, `WATCH_MS` 5 min) refresh every
  `GH_FRESH_MS` (30s); `warmItems` preloads new/changed/pending rows, 4 at a
  time. Logs tagged `[gh]`. Cache is in memory.
- Client cache in `GithubPane.tsx` is per repo; every answer carries `repo`;
  `?repo=` wins.

## Files

- `FileView` is lazy. Use `prism-async-light` via the **deep ESM path**, never
  the `react-syntax-highlighter` barrel. CodeMirror lives in `CodeEditor.tsx`
  behind `lazy()`. Extension→language map is `ui/src/lang.ts`.
- `.csv`/`.tsv` render via `CsvTable` (`ui/src/csv.ts` parser, delimiter from
  header, 2000-row cap).

## Browser

### Ports

`/fs/:sessionId/ports` lists listeners (pane's own first) and keeps only those
that answer HTTP (any status), 500ms probes in parallel, cached 15s. sheepit's
own port is dropped.

### Browser pane

- Terminal URL clicks open in the pane (`handleWebLink`, both `WebLinksAddon`
  and OSC 8). Modifier clicks and non-http(s) go outside. `navSeq` counts openings.
- Chromium is required (Chrome/Brave/Edge/Chromium or `SHEEPIT_BROWSER`). No
  iframe or proxy fallback.
- Browser history drives window Back/Forward via `/b:`; only the active pane's
  page; `requestBrowserUrl` carries a sequence number. `browserUrls` holds
  only panes showing a browser.
- Last page per pane in `sheepit:pane-url:<sessionId>` (its own key).
- Loading bar from main-frame `Page.frameStartedLoading/StoppedLoading`.
- Screenshot: `Page.captureScreenshot` PNG to `~/.config/sheepit/screenshots`,
  **path** goes on the clipboard (`execCommand` fallback for plain http).
- Local `.html` via `/api/fs/raw?as=html` on `127.0.0.1:<serverPort>`
  (`/api/browser/status` gives the port).

### Desktop app (Electron)

Browser half is a native `WebContentsView` over the pane box
(`NativeBrowserSurface`, `window.sheepitDesktop` from `electron/preload.cjs`).

- `PreviewPane` picks native when available, streamed otherwise.
- UI owns placement; reports box each frame, `null` when hidden.
- Hide the view when anything overlaps it (grid hit test). Don't do per-overlay hiding.
- `main.cjs` closes an owner's views when its page navigates or dies.
- `APP_SHORTCUTS` (⌘K, ⌘N, ⌘↑, ⌘↓) are taken back from a focused page and
  replayed. New global shortcuts must be added there.
- No title bar: drag on `.sidebar-header` and `.workspace-bar`; that CSS is
  injected by the preload under `.desktop-app`. New controls in those bars
  need no-drag.
- Profile `persist:sheepit-browser`.
- External links go through `ui/src/openExternal.ts` → `shell.openExternal`.
  Main window's `setWindowOpenHandler` denies all `window.open` and hands
  http/https/mailto to the OS. The pane's own view loads `_blank` in the pane.
- Dev: window loads Vite on 4444; only `electron/` changes need a relaunch.
  `./dev.sh --desktop` waits for both ports. `scripts/brand-dev-electron.sh`
  patches the dev Electron bundle's name/icon and re-signs ad hoc.

### Live (streamed) browser (`live-browser.ts`)

- Uses the machine's Chromium; persistent own profile (`browserProfileDir()`
  in `live-browser.ts`, **not** `paths.ts`).
- Always headless. UA overridden per page to plain `Chrome/…`.
  `SHEEPIT_BROWSER_HEADFUL=1` for one-off sign-ins. A leftover browser of the
  wrong kind is closed (`Browser.close`) and replaced.
- Each view gets its own window (`Target.createTarget({newWindow: true})`) +
  `Emulation.setFocusEmulationEnabled`, or only one pane casts.
- `sweep()` every 30s: close a page out of sight for `VIEW_TTL_MS` (10 min;
  pane sends `alive` every 30s while visible), close pages no view owns (skip
  while `opening`).
- Activate a target once before casting (`activate()`); don't send
  `Target.activateTarget` otherwise.
- `browser.json` records pid + port for re-attach / orphan cleanup.
- Input uses CDP `Input.*`: key code = event's own `keyCode`; `keyDown` when
  there's text, `rawKeyDown` otherwise.
- **Never send a lone modifier key.** Any CDP command can make Chrome steal
  macOS focus and kill a composition (`@` = ⌥ò on Italian).
- Keyboard goes into a hidden `.live-browser-key-sink` textarea; `mousedown`
  on the pane is `preventDefault`ed. Composed text goes via
  `Input.insertText` and is `preventDefault`ed; other keys are forwarded.
  Keys captured on `window` in capture phase only while focused.
- Copy/cut/paste handled in the pane (read the page selection / the local
  clipboard), never forwarded.
- Cursor reported by injected `CURSOR_REPORTER`; client allowlists cursor keywords (no `url()`).
- Socket reconnects with backoff and reopens the last URL. Frames ride
  `/ws/browser`; both sockets are `noServer` behind one `upgrade` listener.
  **Never add a second path-bound `WebSocketServer`.**
- Anyone who reaches sheepit can drive this browser. Don't add another way in.

## reps (scheduled agent jobs)

`RepsDialog` (top-bar button, a `FloatingPanel`) shows
[reps](https://github.com/nicoloboschi/reps) jobs, their runs, each run's
summary and output, plus Run now and Open worktree (a new pen in the job's
worktree, or its folder when it has no repo).

- `src/reps.ts` (`/api/reps`) is a pass-through to the CLI's `--json`
  (`list`, `runs <job>`, `logs <job> --run <id>`). **Don't read `~/.reps`
  directly** — what a run status means is reps' to define. Need more data?
  Add it to the CLI in `~/dev/reps`.
- The binary is found on PATH, then `~/.local/bin` (`REPS_BIN` overrides);
  launchd and Electron start the server with a bare PATH.
- Job names and run ids are checked against `SAFE_ID` (no leading `-`).
- Run now spawns `reps run` detached; reps' own lock refuses a second run.

## Android app (`ui/android`, Capacitor)

- Update banner: `GET /download/version` → `{available, version}`; compare
  full version incl. commit (`1.15.0+<sha>`). Android only, only when
  different; dismissal per version.
- `/download` serves the APK straight from Gradle output
  (`src/download.ts`), `application/vnd.android.package-archive`, versioned
  filename. Check content type, not status (SPA fallback answers 200).
- `npm run android` (`--build`, `--debug`). Version comes from `package.json`
  in `app/build.gradle` (`versionCode = major*10000 + minor*100 + patch`).
- Release build fails without signing. Keystore `~/.sheepit/android-release.jks`
  via gitignored `keystore.properties`. **Back it up.**
- `webContentsDebuggingEnabled` is on; debug with `adb forward tcp:9333
  localabstract:webview_devtools_remote_<pid>` + CDP.
- Phones: sidebar not mounted; open on terminal alone; don't read or write
  `sheepit:pane-views`. Breakpoint is `isNarrowScreen()` / `NARROW_QUERY` in
  `ui/src/platform.ts` (matches Tailwind `md:`).
- Next startup lever: lazy-load dnd-kit (disabled on mobile anyway).

### Remote access and auth

Anything that reaches sheepit has a shell as this user.

- Auth is sheepit's own (`src/auth.ts`, `config.password` / `SHEEPIT_PASSWORD`),
  not the tunnel's — a WebView can't authenticate a WebSocket.
  HTTP: `Authorization: Basic <any>:<password>`. WebSocket: `?k=<password>`.
  401 carries `WWW-Authenticate`.
- Exempt only direct loopback **without** `x-forwarded-for`.
- Fetch interceptor must cover both bare `/api/...` and `apiUrl()`-absolute
  URLs, and add `ngrok-skip-browser-warning` (else ngrok returns its HTML
  page with 200).
- Tunnel: launchd `~/Library/LaunchAgents/dev.sheepit.ngrok.plist` running
  `ngrok start sheepit` (needs `HOME` and `PATH`).
- **Never expose sheepit through a tunnel without auth.**

## PTY daemon — keep it empty

`src/pty-daemon.ts` holds every PTY master fd; sessions live exactly as long
as it does. It ignores SIGHUP/SIGTERM/SIGINT.

- It's a byte-mover: spawn, write, resize, kill, subscribe, rekey, list.
  Anything else goes in the server (`direct-bridge.ts`). Adding to it costs
  every user every session — say so in the PR.
- `PROTOCOL_VERSION` (daemon) must match `PROXY_PROTOCOL` (`direct-bridge.ts`).
  Bump only when the message shape changes.
- `rekey` renames `pool-N` ids; policy stays in the server.
- `dev.sh` hashes `DAEMON_SOURCES` = `pty-daemon.ts` + `src/daemon-paths.ts`
  (only `configDir`). **Keep `daemon-paths.ts` tiny**; new paths go in
  `paths.ts`.
- A stale daemon holding shells is kept; replace deliberately with
  `./dev.sh --fresh-daemon`.
- Restored sessions whose daemon died get a fresh shell + replayed ring, then
  the agent resume command (`AGENT_RESUME_COMMANDS`, `aiResumeAgents`). The
  write waits for quiet output (`RESUME_SETTLE_MS`, `RESUME_DEADLINE_MS`);
  pane exit or any typing cancels it.

## Preferences

- `ui/src/preferences.ts` writes `sheepit:*` keys; `src/api.ts` validates the
  same prefix. Change together.
- Device-local keys are listed in `DEVICE_LOCAL`.
- **One key per pen**: `sheepit:pen:<workspaceId>`, plus `sheepit:flock`
  (order + fields). `writeWorkspaces` diffs and sends only changed pens. The
  old `sheepit:workspaces` blob is frozen as a rollback; never read it.
- `PATCH /api/preferences` broadcasts the patch on `__sessions__`;
  `subscribePreferences` re-reads pen/flock keys. Ignore own echo (`origin`),
  never overwrite keys `pending` or `inFlight`, reconnect resyncs values only
  (never infers deletions).
- `dedupePens`: a session belongs to one pen; the bigger pen wins, ties by order.
- Daily snapshot `preferences.json.<date>.bak` (14 kept) plus 5 rolling backups.
- New state two browsers can edit gets its own key, not a shared blob.
