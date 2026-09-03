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
| **Field** | A user-made group of workspaces. Identified by `fieldId`. Membership lives on the workspace (`Workspace.fieldId`); every pen starts in the default field, and the sidebar shows one field at a time. |
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
| **Field** | A group of pens you put together | `fields[id]` |
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
- ❌ "flock" for a *group* of pens → ✅ **field** (still: the flock is all of them)
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

### Folding, and the fields pens stand in

A pen **folds** to one line — its name and one dot per sheep
(`SheepDot.tsx`, `Workspace.collapsed`). The dots are not decoration: the
reason to look at this list is to see that something wants you, and a fold
that hid a bleating sheep to save four rows would have saved the wrong four.
They read the same `sheepStateOf()` as the pane bar and the pasture, so the
sidebar cannot disagree with the pane. `SheepStatus` is not reused at that
size — it is a 44×38 animal whose posture and glyph are the whole point, and
none of that survives at 6px.

A **field** is a group of pens, and grouping is **manual**. Three rules:

- **One field to begin with**, holding every pen (`DEFAULT_FIELD_ID`). You make
  more from the selector and move pens across from a pen's own menu. An
  earlier cut derived a field per repository from each pane's `gitRoot` —
  clever, and wrong: a grouping nobody asked for is one you then have to undo,
  and it named a field after whichever checkout happened to hold the git
  common dir. `dropDerivedFields` clears those on load; the pens are untouched
  and land in the default field.
- **Assignment is the migration.** `assignFields` runs inside
  `renderSessions`: any pen without a `fieldId` — never had one, or its field
  was deleted out from under it — gets the default one. A pen saved before
  fields existed is the same case as a pen created a second ago, so there is
  no migration step to get wrong. It runs every two seconds against every pen,
  so it returns the objects it was given when there is nothing to place, and
  the caller skips the write.
- **Membership lives on the pen.** `workspaceOrder` stays the only list of
  pens; a field's pens are `pensInField()`, filtered out of it. There is no
  second ordering to drift.

The sidebar shows **one field at a time**, chosen in `FieldSelector` — which
*is* the band above the list (`FlockBand`), not a second row under it: two rows
of chrome above a list is one too many in a sidebar whose whole job is the
list.

**The shown field lives in the URL**, not in preferences:
`#<workspaceId>[/zen:<sessionId>][/f:<fieldId>]`. Two tabs standing in two
different fields is the point, and one shared storage key would have the second
tab drag the first; a refresh keeps each tab where it was, and a link carries
the field with it. On restore the field is applied *after* the workspace —
`setCurrentSessionId` pulls the sidebar to the active pen's field, which is
right for a jump and wrong for a restore, where the URL is authoritative for
both. This is
not the All/Active/Favourites toggle coming back: that hid pens by a rule you
had to remember, while the selector names the field on screen, carries the
bleating count of every *other* field beside it, and `setCurrentSessionId`
pulls the sidebar to the field of whatever you select — so a ⌘K jump can never
land you on a pane the list is not showing. Moving a pen between fields is in
the pen's own menu, because with one field on screen there is no other field
to drag it onto.

Deleting a field never closes a pen: its pens fall back to the default field.
A field is a label on the ground.

### The pasture (sidebar footer)

`FlockGrass` draws the grass strip and `FlockSheep` puts a 🐑 in it for
**every pane that is bleating, and nothing else** — read from `useFlockSheep()`
and filtered to that one state.

It held one animal per pane before, in whatever state that pane was in, which
made it a second copy of the pen list: the same twenty sheep whether or not
anything wanted you, so the one that did was lost among them. The pasture now
answers one question — *who wants me?* — and answers it by being **empty grass**
when the answer is nobody. Every other count is still on the footer line above
it. A sheep in the strip therefore always hops and puffs a "baa"; there are no
grazing, unread or idle animals down there any more.

**Clicking a sheep goes to its pane** — the pen, then the pane inside it, since
switching pens alone lands you on whichever pane that pen last had focused and
not the one that called you. `FlockStrip` / `FlockFooter` take the caller's own
`onConnect` so the strip knows nothing about hash syncing, last-session
preferences or closing the mobile sheet; without it the sheep stay decoration.

**A sheep calls you by its pane's name.** The footer line above says how many
are bleating; the name tag answers the other half — which one. Only one sheep
says a name at a time (`MAX_CALLING`): the strip is ~250px and a tag is up to
118px of it. The rest carry their name in a `title` and an `aria-label`, which
is reachable now that a sheep is a button. The tag breathes rather than
blinking out — a label legible for one second in four is one you have to sit
and wait for. Rules:

- The sheep are pure CSS animation over a real emoji glyph — **no image
  requests**, nothing to load, and it stays correct on a LAN with no internet
  route. The grass under them is canvas, drawn by the same `grass.ts` the pens
  use, so the ground the flock walks on is the ground inside a pen. It was SVG
  with its own blade shape and its own alpha, and the two fields six pixels
  apart did not look like the same field.
- Blade and lane positions come from a fixed integer hash, never `Math.random`.
  A field that reshuffles itself every time a session goes busy is a
  distraction, not decoration.
- The strip is `pointer-events: none`; the animals opt back in
  (`.flock-sheep-hit`) and nothing else does. The band must never eat a click
  meant for the last pen card above it. A sheep's hit target is padding plus a
  matching negative margin — 14px of emoji is not a click target, and growing
  the box must not move the animal.
- Hover lights the ground under a sheep rather than the sheep: its opacity and
  filter are set per theme and its transform belongs to the hop animation, so
  a hover touching any of the three would fight one of them.
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
same deterministic hash as the posts and from the same `grass.ts` as the
sidebar's pasture strip, so one never moves when a sheep goes busy and both
fields look like one field. None of it animates (unlike the strip, where the
sheep do). Keep the
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
(agent mark, git handle, PR) │ what it is showing (the view switch) │
what you can do to it (mic, zen, close). The agent mark is drawn as a *mark*,
not a chip — no fill, no border, same weight as the git icon beside it — and
mic, zen and close share one `.pane-bar-btn` style so the right end reads as
one row of controls. The **branch name is deliberately not here** —
it was the only arbitrary-length string on the bar, so it set the width of
everything and squeezed the title, which matters more. The git icon still
carries the dirty state in its colour and opens the popover with the branch,
its ahead/behind counts and the rest; the sidebar's pen card keeps the branch
too. CPU / memory / URL-count readouts were deliberately removed. The process
list (with kill) is still a real tool, so it keeps one small `ListTree` handle
that appears only when there is something behind it — don't reintroduce the
inline readouts. The list of every URL seen in the pane hung off that same
handle and is **gone**: it was built by scanning output in the browser, which
is the one thing nothing does any more (see [Nothing reads the
terminal](#nothing-reads-the-terminal-as-text)).

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

## Session names

A name is written once and read a hundred times, at a glance, in a list of
twenty panes. Two things follow, and both are enforced in `ai.ts`.

**It is named after the subject, from the last three exchanges.** The bridge
keeps `MAX_TURN_HISTORY` exchanges per session (`appendAgentTurn`, persisted as
`turns`) and the namer sends all of them, oldest first, older ones trimmed
harder. One turn was not enough: the newest is usually a follow-up — "now do
the same for codex", "check that log" — which on its own reads as a different
task, so a session that spent an hour on one subject got renamed after
whatever was asked last.

**It never contains an identifier.** No PR or issue numbers, no `#123`, no
ticket keys. A number says nothing about the work and the bar already shows the
PR. The prompt asks for this, `normalizeAssignedName` enforces it (stripping
the labelled form first, so `review pr #3672` becomes `review` and not `review
pr`), and the PR number is no longer passed in the session context at all —
it carried no topic and its only effect on a name was to end up inside it.

Only the **writer** strips ids. `looksLikeAssignedName` stays permissive, or
every name written before that rule freezes its pane — which is the whole
subject of the section below.

### The writer and the reader are one definition

Ownership of an AI-assigned name lives only in memory, so after a restart the
namer works out which names are its own from their *shape*
(`looksLikeAssignedName`). That makes the shape test and the write path two
halves of one contract: **anything the writer stores, the reader must claim.**

They drifted, and the cost was total. A name outside the overlap was written
once and then disowned at the next restart — `isRenameable()` said no, the
sweep skipped it with a silent `continue`, and that pane could never be
renamed again. Four gaps, all of them hit real sessions: an underscore or a
dot (`rrf cross_encoder benchmark`, `compare 0.9.1 pr regression`), a capital
letter, more than six words, and the 61–80 character band where the writer's
cap was 80 and the reader's 60.

`normalizeAssignedName()` closes it from the writing side — it is total, and
its output always satisfies `looksLikeAssignedName()`, which is asserted in
`ai.test.ts`. Widening the charset to accept `_` and `.` closes it from the
other side, and is what un-freezes sessions already stuck.

If you change either limit, change the other, and keep the invariant test
green. A name the namer cannot recognise is one it can never fix — the same
failure `stripNameDecoration` exists for, which arrived as a session called
`` `pytest` ``.

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

Codex reports the whole turn correctly — `UserPromptSubmit` with the prompt,
tool pings, and `Stop` with the response. The only thing genuinely missing is
`waiting`, for the reason above. Do not read a short sample of the trace as a
missing event: `Stop` fires once per turn against hundreds of tool pings, so
an idle minute looks exactly like a broken hook.

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
is for. Two columns carry what the hooks brought rather than what they were:
`turn` (the exchange sessions are named from) and `refs` (the PR/issue the
pane bar shows). Both are otherwise invisible, and a blank column is the whole
explanation for a pane that lights up correctly but is never named, or never
shows its PR.

## Nothing reads the terminal as text

Two things used to be derived by reading the output as prose. Both are gone,
and the rule now is: **the terminal is bytes to render, not a source of
facts.** What an agent is doing, what it was asked, and what it touched all
arrive through its hooks; everything else the server needs it asks the OS or
git for.

What is left on the byte stream is *protocol*, and that stays: OSC 7 (the
shell reporting its cwd), OSC 9 / 777 / 99 (the app raising a notification →
bleating), OSC 9;4 progress, and the DEC private modes that have to survive a
reconnect. Those are applications reporting in a defined format, which is a
different thing from guessing.

### PR and issue references

`src/pr-refs.ts` is the only extractor, and it is fed only by hooks:

- **`post.sh`** greps the tool payload on stdin and forwards what it finds as
  `refs` on the ping it was sending anyway. It is **gated on the payload
  mentioning `gh pr` / `gh issue`** — otherwise reading or writing any file
  that happens to contain a PR link (a changelog, a test fixture) would
  relabel the pane. Bounded to 64 KB, one `grep`, `head -c` before it: this
  runs per tool call, on the agent's critical path.
- **`report-state.mjs`** already sends the prompt and the reply for naming.
  The server reads those too, and only there does it accept the bare `#123`
  form — in a tool *result* that shape is more often a colour, a comment or a
  line number than a pull request.

The result is merged per session (newest first, capped at `MAX_REFS`) and
**persisted**: a PR is mentioned once, when it is opened or checked out, and
the pane has to keep showing it long after that turn ended. It rides to the
client on the session object as `prRefs`.

The bar shows the most recently touched reference, not the highest-numbered
one — a session that has just checked out #3672 is about #3672 whatever else
it read. `gh pr view` still runs (`/api/git/:id/github`) and is still the only
source of *state* and *check results*, but it answers for the **branch**, so
those decorations are painted only when its number and the reference agree.
That split is the whole point: a session on `main`, or on a local checkout of
someone else's PR, has no branch PR at all and used to show nothing.

### Searching the flock

`⌘K` asks one question — *which sheep is working on this?* — and `src/search.ts`
answers it in two halves.

The **facts** come from memory and cost nothing: the pane's name, cwd, branch,
the PR references its hooks reported, and its last few exchanges. This is what
makes the motivating case work. A pane called "check PR 1251 CI", sitting on a
branch named `retain-extraction-mode-docs`, is the pane working on PR 3993 —
nothing in its name or its branch says so, and `prRefs` does.

The **transcripts** come from ripgrep over the agents' own JSONL: Claude's
`~/.claude/projects/<slug>/<uuid>.jsonl` and Codex's
`~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`. One run over every pane's
file rather than one per pane — measured at 30–90 ms for 102 MB across 24 panes,
which is what makes searching on every keystroke reasonable.

Rules that are easy to get wrong:

- **The terminal is still not read.** Scrollback is bytes to render; this reads
  what the agents recorded. Adding the ring buffer here would undo the section
  above.
- **Only conversation counts.** `transcriptLineText` keeps `user` and
  `assistant` rows and drops everything else — Claude's `attachment`, `system`
  and tool-result rows, Codex's `developer` rows carrying the skills preamble.
  Without that, a search for "skills" matches every Codex pane on a preamble
  nobody wrote. Sidechain rows are dropped too: a subagent's exchange belongs
  to the subagent.
- **Per-file cap, not per-run** (`-m 25`). Most matched lines are the ones just
  described, so a small cap would let discarded lines hide the real match
  further down the file.
- **The transcript path is untrusted.** It arrives from a hook, on an endpoint
  anything local can post to, and ends up being opened — so
  `isSearchableTranscript` resolves it and requires it under one of the two
  roots. Codex reports no path at all, only a session id; its rollout filename
  ends in that id, which is how `findCodexRollout` finds it, and the answer is
  cached back onto the session so the directory walk is paid once.
- **Three groups, one row per pane in each.** Results are split into what the
  pane *is* (`PR · branch · name`), what **you said**, and what **the agent
  said** — "I asked this pane about 3993" and "this pane told me 3993 is
  merged" are different answers that send you to different things to do next.
  Within a group it is still one row per pane: the question is which sheep, so
  four reasons in one group are one answer. `matchFactsAll` returns every
  candidate and `bestPerGroup` picks the winner in each; the client sorts into
  section order once, where the cursor's array is built, so ↑/↓ walks down the
  screen rather than around it.
- **A snippet must contain what you searched for.** Two ways it did not:
  ripgrep matches the raw JSONL row, so a hit can land in a uuid or a tool
  result rather than in what anyone said (`containsPattern` drops those — a
  snippet visibly missing the term reads as a wrong answer); and a window
  centred on the first term missed the rest, so `snippetAround` anchors on the
  **rarest** term and falls back to two fragments when they are too far apart.
  "pane bar" used to centre on the first of a hundred "pane"s — inside
  "panel" — and never reach "bar".
- **The row's own timestamp**, not the pane's last activity: a pane can be busy
  right now on something it discussed yesterday, and which of those you are
  looking at is the difference between the right answer and a stale one. Both
  agents stamp every transcript row, and `AgentTurn` already carried an `at`.
  A name or a branch has no "when" and shows none.
- **The server says what to highlight.** For `pr 3993` the pattern is the
  number alone, and lighting up the query's words instead paints half of every
  "prompt" in the snippet.
- A snippet is only ever returned **for an explicit query**. That is the
  difference from the hook trace, which shows that a turn carried a prompt and
  never what the prompt said.

Ranking: an exact PR reference beats the name, which beats the branch and cwd,
which beat turn text, which beats a transcript hit. Within the conversation, a
**user** message outranks an assistant one — what you asked describes the work,
while the agent may be quoting the question back or explaining why it did not
do it.

### The unread signal

There is no `preview` message any more. The server used to decode 8 KB of
every session's ring once a second, strip the escapes and publish the last two
lines; nothing ever rendered that text, and its only remaining job was to
notice that a background pane had *changed* so it could be marked unread. A
shell repainting a progress bar is not news. `publishActivity` publishes the
busy flag instead, and only when it flips — which is a map lookup per session
rather than a decode. The sweep still has to exist because `isSessionBusy`
goes false on its own when a report goes stale, and nobody would otherwise
tell the client about a transition made of time passing.

One consequence, on purpose: **a plain shell pane no longer lights up when it
prints something.** Unread now means an agent finished a turn, or the app rang
the bell. A pane with no reporter in it is quiet, which is the same trade the
busy flag already made (see `isSessionBusy`).

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
