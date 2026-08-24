# sheepit — notes for Claude

The project was called **vipershell** until the rebrand. Everything — code,
paths, env vars, storage keys, the npm package and the GitHub repository — is
sheepit now. The only file that still knows the old name is the one-shot
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

`FlockGrass` draws the grass strip and `FlockSheep` puts one 🐑 per pen in it,
walking. A sheep's behaviour mirrors its pen: bleating sheep hop and puff a
"baa", grazing sheep keep their heads down, idle sheep plod. Rules:

- Both are pure CSS animation over a real emoji glyph — **no image requests**,
  nothing to load, and it stays correct on a LAN with no internet route.
- Blade and lane positions come from a fixed integer hash, never `Math.random`.
  A field that reshuffles itself every time a session goes busy is a
  distraction, not decoration.
- The strip is `pointer-events: none` end to end. It must never eat a click
  meant for the last pen card above it.
- Everything stops under `prefers-reduced-motion: reduce` — the flock stays,
  the movement goes.
- The light theme swaps the sheep's knock-back for a drop-shadow outline;
  a white sheep on a pale field is otherwise invisible.
- `FlockChrome` exports the band, the strip and the footer. The desktop sidebar
  and the mobile Pens sheet both use them, and the mobile header carries a
  `slim` strip as its bottom edge — the flock has to be visible on a phone
  without opening a sheet.

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

A pane's header and its footer bar are the two halves of one frame, so they
share `--pane-chrome` / `--pane-chrome-active` rather than each inventing a
gradient. The light-theme variants live on the tokens, which is why neither
component branches on `theme` in JS any more.

The footer bar carries **identity, not telemetry**: agent chip, branch, PR, and
the cwd flush right. CPU / memory / URL-count readouts were deliberately
removed. The process list (with kill) and the detected-link list are still
real tools, so they keep one small `ListTree` handle that appears only when
there is something behind it — don't reintroduce the inline readouts.

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
