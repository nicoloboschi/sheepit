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
| **Workspace** | A sidebar row. An ordered, **unbounded** collection of panes sharing a name — of which it shows exactly **one** at a time. Identified by a synthetic `workspaceId` that is never any session's id. |
| **Field** | A user-made group of workspaces. Identified by `fieldId`. Membership lives on the workspace (`Workspace.fieldId`); every pen starts in the default field, and the sidebar shows one field at a time. |
| **Shown pane** | The one pane of a workspace that is on screen. `workspaces[id].cells[activeCell]`. Every other pane in the pen is as much in the background as a pane in any other pen — see [One pane on screen](#one-pane-on-screen). |
| **Active pane** | Same thing as the shown pane: with one pane on screen, focused and shown cannot differ. Drives the Git/Files/Search tabs. |
| **Active workspace** | The workspace shown in the main area (sidebar selection). Stored as `currentSessionId` (legacy name; really means this). |

### The flock — user-facing vocabulary

The UI talks about sessions the way a shepherd talks about sheep. These words
appear in **UI strings only**; the code keeps the glossary names above. The
mapping lives in `ui/src/flock.ts`, which is where the counts come from too.

| UI word | Means | Store field |
|---|---|---|
| **Sheep** | A pane — one terminal, backed by one session | `workspaces[id].cells[n]` |
| **Pen** | A workspace — one sidebar row, holding any number of sheep and showing one | `workspaces[id]` |
| **Field** | A group of pens you put together | `fields[id]` |
| **The flock** | Every pen together (the sidebar heading) | `workspaceOrder` |
| **Bleating** | A sheep waiting for your input | `sessionNeedsAttention[sessionId]` |
| **Grazing** | A sheep with a command still running | `sessionBusy[sessionId]` |

**The plural of sheep is "sheep".** Never "sheeps" — `3 sheep`, `1 sheep`.
`plural()` in `flock.ts` defaults to adding an s, so counts of sheep go
through `sheepCount()` instead of each call site remembering to pass the
plural twice.

A pen is the enclosure, not the animals: it keeps its name and its position
whether or not anything is running in it, which is why closing a pen closes
what it holds. The flock is every pen together — so pens live *inside*
the flock, and a pen is never itself called a flock.

A sheep that is neither bleating nor grazing is just standing there — but that
still splits in two, because "finished, and you have read it" and "finished,
and you have not" are different things to a shepherd with twenty pens open.
The activity dot carries all four:

| dot | means |
|---|---|
| red, pulsing | bleating — wants your input |
| amber, steady | grazing — a command is running |
| green, filled | idle, with output you have not read (`sessionHasUnseen`) |
| hollow ring | idle, and you have seen it |

**A sheep is only drawn for the two states that are doing nothing.** In a pen
card, bleating is a **raised red hand** and grazing is an **amber spinner**;
the animal appears for unread (green, hopping) and idle (wool, lying down). One
of those two is a *request* and the other is *progress*, and a hand and a
spinner say both in the vocabulary every other piece of software on the machine
uses — where a 28px sheep said them by bobbing its head three pixels. See
`SheepStatus.tsx`, which keeps its name and now draws three different things.

The two live states take precedence: a sheep that is still working shows that
it is working, unread or not. Bleating wins over grazing when both would apply, so the two
counts never double-count a pane.

**An idle sheep's `zzz` only drifts in the pane bar.** Everywhere else — every
pane card in every pen — it is drawn as three static strokes at falling opacity.
Idle is the commonest state there is, so animating it per card meant a hundred
infinite animations running at once for a signal that means *nothing is
happening*; see [Measuring the UI](#measuring-the-ui--one-place-always-on). The
glyph is the signal and it is unchanged; only the motion is scoped.

Write `sheep`/`pen` in UI copy and `pane`/`workspace` in code — including on
the wire, where the server and its API keep the plain names. A comment
explaining a UI string may use either, whichever makes the sentence clearer.

### Terms to avoid
- ❌ "root pane" / "primary pane" → ✅ **pane** (every pane in a pen is equal; there is no anchor)
- ❌ "grid" as a user-facing noun (in UI strings, comments, or docs) → ✅ **workspace** (or **pen** in UI copy)
- ❌ "layout" / "quad" / "split the pen" → ✅ nothing; a pen has no shape (see [One pane on screen](#one-pane-on-screen))
- ❌ "zen" → ✅ nothing; the mode is gone, a pane is always full size
- ❌ "session" to mean "sidebar row" → ✅ **workspace**
- ❌ "sheeps" → ✅ **sheep** (its own plural)
- ❌ "flock" for a single workspace → ✅ **pen** (the flock is all of them)
- ❌ "flock" for a *group* of pens → ✅ **field** (still: the flock is all of them)
- ❌ "vipershell" in anything a user reads → ✅ **sheepit**
- ❌ counting the dog as a sheep → ✅ **the dog is a pane, never a sheep**

### Legacy field names — don't rename, just document
- `gridId` in component props = `workspaceId`. Both names are acceptable in code; prefer `workspaceId` in new code.
- `currentSessionId` in the store = the **active workspace id**. It is a synthetic `ws-…` id, not a session id, and has not been one since pens were decoupled from their first pane.
- `activeCell` on a workspace = the index of the **shown pane**. There are no cells in a grid sense any more.
- `TerminalGrid` renders one pane and nothing else; the name is the last thing left of the grid.

## Brand palette — pasture colors

The brand color is a **meadow → moss gradient**: the greens of a field at
dusk on near-black olive surfaces. Green is now the brand *and* carries
"success" / "addition" / "healthy" — the two roles share `#9CBC7F`. What
distinguishes a state is the second colour: **amber** for wants-attention and
warnings, **terracotta** for errors and deletions.

Do not reintroduce blue or teal as a brand color — including for
`--bleating`, which was a moss teal and is now **red**. A pane that is
*stopped*, waiting on a person, is the most urgent thing sheepit has to say,
and it was saying it in a colour that read as one more shade of the pasture.
Red is what the rest of the machine uses for "blocked on you"; a flock that
invents its own word for that is a flock whose loudest signal has to be
learned. The token still means that one thing and nothing else.

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

### Chrome is not green

The **sidebar and the bars along the top** — the flock column, the workspace
bar above the pen, the mobile header, and a pane's own chrome bar — are
**neutral graphite** (`--chrome`, `--chrome-line`), not the olive the other
surfaces are tinted with. They were olive, on the reasoning that the sidebar is
the pasture the flock stands in. But chrome is the furniture around every pane,
in peripheral vision for the whole working day, and a green field held there is
tiring in a way a green button is not.

So green now has to *say* something to appear: buttons, the fence, the sheep,
the activity dots, every status colour. It no longer tints the furniture. In
particular:

- `--pane-chrome-active` is a **lift, not a hue** — the same graphite a few
  steps brighter. It was a green wash, which put the loudest colour on screen
  directly behind the thing you spend the day reading. The pane's border and
  ring already carry the brand.
- The **selected pen** is a lift out of the column too, with its fence coming
  into the light (`.session-item.active .pen-fence`) — plus a solid brand
  rail down its left edge and a brand border. The lift and fence alone were
  too close to a bleating pen's teal cards to tell which pen you were in; the
  rail is a shape no other state uses, so it says "here" without being a
  green card behind every row you scan. The **focused pane** inside it
  (`.pane-card-active`) is a lift for the same reason — it is the most common
  thing on screen, so it must not be a coloured fill, leaving those to
  bleating and unread, which want something from you. It carries the same
  **brand rail** down its left edge instead (`.pane-card-active::after`), one
  level down from the pen's: a shape no state variant draws, so the focused
  sheep stays marked whether it is bleating, unread or fresh. It was a brand
  outline, which across a wall of pens was one more coloured edge among the
  tinted ones — a bleating card and a selected card both read as "an edge of a
  different colour", which is exactly the confusion the rail exists to end.
- The **grass stays green** — the footer strip and the floor of every pen. That
  is a picture of something, and it reads better against grey than it did
  against olive.

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
| `--chrome`                 | `#15171a` (dark) / `#eef0f3` (light)        | sidebar + top bars (neutral)     |
| `--chrome-line`            | white/ink at ~7–10% alpha                   | the hairlines between them       |
| `--success`                | `#9CBC7F`                                   | healthy / additions / clean tree |
| `--warning`                | `#D9B84A`                                   | amber — dirty tree, unseen output|
| `--destructive`            | `#E0907B`                                   | terracotta — errors, deletions   |
| `--bleating`               | `#E2584A`                                   | **only** for "wants your input"  |
| `--grazing`                | `#9CBC7F`                                   | **the grass**, not the running mark |

### Folding, and the fields pens stand in

A pen **folds** to one line — its name and one dot per sheep
(`SheepDot.tsx`, `Workspace.collapsed`). The dots are not decoration: the
reason to look at this list is to see that something wants you, and a fold
that hid a bleating sheep to save four rows would have saved the wrong four.
They read the same `sheepStateOf()` as the pane bar and the pasture, so no two
of them can disagree. `SheepStatus` is not reused at that
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
`#<workspaceId>[/p:<sessionId>][/f:<fieldId>][/b:<page>]`. Two tabs standing in two
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

- around each **pen** in the sidebar (`.pen-body`), wrapping the pane cards
  only — the pen's name, star and row menu sit *above* the fence. A name
  inside the enclosure cost a row of pen the sheep needed.
- around the **workspace** in the main area (`.workspace-pen`) — **grass only**
  (`rails={false}`). A fence is a thing you look at a pen from *outside*, which
  is what the sidebar does; the workspace is the pen you are standing in, and
  at full-window size the rails were furniture drawn around furniture, since
  the pane inside is already framed by its own border, and there is exactly
  one of them. The ground stays,
  because that is what makes the gutters and margins read as a field rather
  than as empty space. Skipped entirely on mobile, where the pen is one
  full-screen pane. `gate={44}` is now only consulted when rails are drawn.

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
are the scarce resource, and that merge handed ~72px of height back per pane.
`--pane-chrome` / `--pane-chrome-active` still carry the gradient, and the
light-theme variants live on the tokens, so nothing branches on `theme` in JS.

The bar carries **identity, not telemetry**, in three ruled groups. The
**sheep leads it** — status is what you scan a wall of panes for, and the
agent's logo is not, since you already know what you started. Then the name
with the cwd as its subtitle. Then, flush right: what the pane is connected to
(agent mark, git handle, PR) │ what it is showing (the view switch) │
what you can do to it (mic, close). The agent mark is drawn as a *mark*,
not a chip — no fill, no border, same weight as the git icon beside it — and
mic and close share one `.pane-bar-btn` style so the right end reads as
one row of controls. The **branch name is deliberately not here** —
it was the only arbitrary-length string on the bar, so it set the width of
everything and squeezed the title, which matters more. The git icon still
carries the dirty state in its colour and opens the popover with the branch,
its ahead/behind counts and the rest. **The bar is the only place the PR is
shown** — the sidebar's pen card used to carry it as well and no longer does;
see [The pen card](#the-pen-card-two-rows-two-abreast). CPU / memory / URL-count readouts were deliberately removed. The process
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
`margin-left: auto`, so the bar always ends exactly on the close button
however long the name or branch run.

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

## One pane on screen

A pen holds **as many sheep as you like and shows one of them**. There is no
grid, no layout, no resize separator and no zen mode.

The grid was up to four panes in eight variants (`single`, `horizontal`,
`vertical`, four `three-*` orientations, `quad`), and zen was an overlay you
entered to read one of them without the other three. In practice zen was never
turned off — because everything worth putting beside a terminal had already
moved *inside* a pane: the browser, a pull request, the working tree, the
commit log, the files. Two terminals side by side was the one thing the grid
offered that nothing else did, and it is the one thing nobody was reading. So
the grid went, and zen went with it: a mode you never leave is not a mode, it
is the layout, and keeping it as an overlay meant paying for a backdrop, an
entrance animation, `position: fixed`, and a hit-test grid in the desktop
shell to keep a native browser view from floating over it.

What this buys, besides the deletion: a pen is no longer capped at four, since
four was the size of a 2×2 grid and there is no grid to be the size of.

- **Nothing is drawn above the pane.** A tab strip was built and removed: it
  spends a row of terminal, on every pen, on a list the sidebar is already
  drawing — and drawing better, with each sheep's name, its PR, its context and
  its own animal, none of which fits in a tab. Vertical rows are what terminal
  content is short of, which is the same argument that merged the pane's two
  chrome bars into one. **The sidebar is the switcher**; ⌘↑/↓ walks the same
  sheep without leaving the keyboard.
- **Every sheep in a pen stays mounted**, all but one under `display: none`.
  Unmounting would tear down its xterm on every switch and rebuild it from the
  daemon's ring — a visible stall, and the scroll position gone. Bounded the
  same way `PaneTerminal` bounds pens: only the pen you are standing in mounts
  its sheep, and at most a dozen pens are alive.
- **"On screen" means the shown pane, not the pen.** `isOnScreen` in the store
  is the single test, and `updateActivity`, `sessionAttention` and `markUnseen`
  all go through it. They asked `cells.includes()` before, which was right when
  a pen drew all four at once and would now swallow the "finished" notification
  from every pane you are not looking at.
- **Becoming the shown pane is a resize.** A hidden pane sits under
  `display: none`, so the pane taking over goes from no size to the whole pen
  and has to refit and tell the PTY. That is the old zen-refit effect, keyed on
  `isActive` now. Its two `requestAnimationFrame` ids stay in a **ref**: a
  switch runs the effect on two panes at once, and one global slot meant the
  pane handing over cancelled the fit of the pane taking over.
- **Nothing on a pane says "selected" any more.** The ring, the glow and the
  dimming of the unselected panes all went: the pane on screen is the selected
  pane by construction. The only outline left is the file-drop one, which is
  feedback about what is under the cursor.
- **Another sheep in this pen** is one button in the workspace bar
  (`onAddSheep`), where the layout picker used to be — with one pane on screen,
  "split" and "add" were always the same action wearing eight icons. It claims
  the new session for the pen *before* asking for the session list, or
  `renderSessions` gives it a pen of its own.
- **The URL carries the shown pane**: `#<workspaceId>[/p:<sessionId>][/f:<fieldId>][/b:<page>]`.
  This is the old `/zen:` segment doing the job it was really doing — a link to
  a pen alone lands you on whichever sheep that pen last had open, which is not
  the one the link was about.

### The pen card: two rows, two abreast

The sidebar's pen card is a **list** of pane cards (`.pane-grid-list`) rather
than a picture of the layout, and the list runs **two cards to a sidebar
line**. That is not a layout coming back: a layout meant "these panes are on
screen together, arranged so", and two columns here means only that a sidebar
line is wide enough to seat two cards and a column of one wasted half of it.

Two is fixed rather than `auto-fill`. The sidebar runs 180–500px, so an
auto-fill with any honest minimum would sit at one column across most of that
range — which is the thing being fixed. The cards shed fields instead (below).

**A pen holding one sheep spans both columns** (`:only-child`), which is much
the commonest pen and now reads exactly as it did — full width, every field. An
odd *last* card stays at half width on purpose: stretching it would make its
row taller than the ones above it for nothing.

What a card can afford also changed when the grid went. Its position used to
mean something — it *was* the grid — and it could be a 78px tile because there
were at most four, arranged in a square. Now it is one cell of a list that may
hold a dozen sheep, so every pixel is multiplied by the whole flock. A card is
~46px and two rows:

1. **the name**, up to **two** lines (it was three)
2. **the info row** — agent mark, context count, time, the sheep

**The PR is gone from the card.** It was the only field here answering a
question about somebody else's work rather than about this pane, it was the
widest thing in the row, and the pane's own bar carries it where there is room
to say more than a number (state, checks, the popover). In a card two abreast
it was spending the row's scarcest space on its least scannable field.

**The count is brand green; the name above it is foreground.** Two different
hues, because two things of equal weight in one small card have to be picked
apart by position otherwise — and the name is prose you read while the count is
a measure you scan. It matters most when the name is itself numeric ("pr 4066"
beside "33%"). Green is the right colour of the palette to spend here: amber
and terracotta both mean something is wrong, and nothing is wrong about a
context having tokens in it. The empty dash drops the hue along with the
number, since the colour is what says *there is a measure here*.

**A real count is drawn bright, not muted.** It was `--muted-foreground` at 0.85, which on the card's olive put
it within a few percent of the timestamp beside it *and* of the dash that is
meant to be its opposite — a row where every field is the same grey is a row
you read one field at a time instead of scanning. The brightness is the signal
here. The order, brightest to quietest: the name, the context count, then the
time, which is also the first thing to shed.

**An empty context is drawn as absence, not as the number zero.** Scanning
twenty panes the first question is never "how full is this one", it is *is
there anything in it at all* — and a `0` among `451k` and `88k` is a number you
have to read before you know it means nothing, which at 10px in a half-width
card reads as an `8` about as often. Zero draws a dim en-dash
(`.pane-card-ctx-empty`); the exact count is in the `title` either way.

That is deliberately **not** the fresh card's dashed border, which it often
appears beside and which means something narrower: `fresh` is the agent's own
report that nothing has been asked of it, while this is a context with nothing
in it — true of a pane just `/clear`ed, and of a plain shell that never had an
agent. And it stays a `!== undefined` test, not a truthy one: absent means
there is no agent to ask and draws nothing at all.

**The info row sheds, cheapest first, on the card's own width** — each card
sets `container-type: inline-size`, so the `@container` ladder measures the
card and not the window. Two abreast in a 180px sidebar a card is 73px:

| below | drops | because |
|---|---|---|
| 128px | the time | the sheep beside it already says whether it is working *now* |

**The context count never sheds.** It did, at 116px, while the PR was
competing with it for the row — and that was the wrong survivor. It is also
narrowest exactly when it matters most, since an empty context is one dash.
What never sheds: the agent mark, the context count and the sheep — which pane
this is, whether there is anything in it, and whether it wants you. The row
keeps its height throughout, so a card stays two rows and the cards in a pen
stay aligned.

**The dirty dot is gone too.** A 6px amber circle whose only reading was "this
tree has uncommitted changes" — true of nearly every pane you are working in,
so it was on nearly every card, which is a signal that says nothing. It was
also the card's one field in the palette's *warning* colour, and a wall of
amber dots beside sheep that use amber for unread output made that state harder
to spot. The git icon in the pane's own bar still carries the dirty state in
its colour and opens the popover with the branch and counts.

**The cwd row is gone.** It was there when a card was the only place a pane's
identity was written down; the pane's own bar has carried the path as the
title's subtitle since the two chrome bars merged, so the card said the same
thing twice and charged a row per sheep for it. The full path is still on the
card's `title`.

**The mark at the end of the info row is a sheep only half the time.** The four
states are drawn by three different things, at 34px (28px in a tight card):

| state | mark | card |
|---|---|---|
| bleating | a **raised red hand**, waving | red tint, the loudest in the pen |
| grazing | an **amber spinner** | amber tint, the weakest of the three |
| unread | a **green sheep**, hopping | green tint |
| idle | a **wool sheep**, lying down | no tint |

The animal is a picture of a pane *at rest*, and it was being asked to carry
two states it is bad at. "A command is running" is progress, and progress is
drawn as a spinner everywhere: it says *still going* by moving continuously,
where a grazing sheep said it by bobbing its head three pixels. "This pane is
blocked on you" is a request, and a request is drawn as a raised hand. Both
beat an animal at 28px, and both are already understood.

The grazing sheep's grass glyph and the bleating sheep's baa went with them.
The idle `zzz` is the **pane bar's alone**: in a card it is three 3px strokes
above a 28px animal — specks, not glyphs, which read as dirt on the card.

**Only the unread sheep moves**, and it hops: there is something in that pane
to come and collect, and what the corner of the eye catches down a column of
forty cards is displacement, not posture. Idle — much the commonest state — has
no animation at all, which is the same bargain that took the `zzz` out of the
cards; see [Measuring the UI](#measuring-the-ui--one-place-always-on).

**Unread is green because nothing is wrong.** A finished turn is the good
outcome; the two colours that mean trouble are spent on the pane that is stuck
and the pane still working. Its fleece is dyed, idle's is not — a wall of white
animals is a wall of identical shapes until you stop on one, and the commonest
state has nothing to say.

**All three live states tint the card now, at three strengths** — red loudest,
green next, amber weakest. Grazing used to carry no tint at all, on the grounds
that tinting the commonest state made most of the sidebar glow; at 11% it reads
as "this one is going" rather than as a highlight, and the spinner is what
actually says it. A slow amber band crossing a busy card was built and taken
out: it was a second moving thing for a fact the spinner had already delivered,
and the commonest live state is the worst place to spend an infinite animation
per card.

The sheep stays the last item **in** the info row rather than floating over the
card's corner: floating it meant every row above had to reserve a gutter, which
in a tight card ate the name down to "…ell".

Pen chrome was trimmed with the cards (`.session-item`, `.pen-body`) — it is
paid once per pen, and the sidebar is a column of pens. **The horizontal
padding on `.pen-body` is fence geometry** (the posts stand 8px proud of the
rails) and must not be trimmed; the vertical is free.

### Side terminals: a shell beside the agent

A pane's rail ends with **Terminals** (`split-terminals`), holding up to
`MAX_SIDE_TERMINALS` = 4 shells **of that pane's own**: opened in its
directory, headless so they never get a pen, and closed with it.

**This is the side terminal that was given up when pens lost their grid**, and
it is why that loss was affordable. What anyone actually wanted from two panes
side by side was never two agents — it was a shell next to the agent, in the
same repository, to run `npm test` or tail a log while it works. That belongs
*inside* the pane beside the browser and the git views, not as a second pane in
the sidebar.

- **`sideOf` is the whole mechanism.** A side terminal is `isHeadless` (no pen)
  *plus* `sideOf: <owning pane id>`. Its absence marks a **global** scratch
  shell. Both lists filter on it — the panel takes `isHeadless && !sideOf`, a
  pane's split takes `sideOf === me` — so neither offers to close the other's.
  It is persisted, or a side terminal would come back with no pen *and* no
  pane, reachable by nothing and closable only by `kill`.
- **The server picks the directory, from the owning pane.** The client sends
  `side_of` and no path: a path from the client is that tab's idea of the cwd,
  and OSC 7 has usually moved it since.
- **`restart` carries `side_of` too.** The restart button closes the old shell
  by id and makes a new one; without the owner it came back belonging to
  nobody, so restarting a pane's terminal silently moved it into the global
  panel. The close also had to move *above* the branch on `sideOf` — while it
  sat inside the global arm, a side-terminal restart left the old shell running
  and made a second one beside it. The cap is counted after the close, so a
  restart at the limit is a swap rather than a refusal.
- **A pane takes its side terminals with it.** `closeSession` collects them
  before the kill and closes them after, so the recursion never sees a
  half-removed map. Leaving them would leak shells nothing can show or name.
- **Capped per pane, not globally.** Twenty panes with four apiece is eighty
  shells, so the cost is bounded where it is incurred.

### A tile is not a pane

Both grids render `TerminalCell` with `tile`, and that flag is load-bearing.

**A tile has no tools at all** — no rail, no toggle in its bar, no view but the
terminal. The tools are for *the work*: you read a diff against the agent that
wrote it, you open the files of the repository it is changing. A scratch shell
is not that. It is somewhere to type a command while the work happens
elsewhere, it is a few hundred pixels wide, and it already sits inside a pane
that has all six tools of its own — git in a tile would be a second opinion
about the same repository in a quarter of the space. (It also settles the hall
of mirrors: no rail means no Terminals tab offering a pane's terminals inside
one of that pane's terminals.)

Two more follow:

- **It persists no view.** These come and go, and `sheepit:pane-views` would
  fill with the ids of shells that no longer exist. It also fixed a sharper
  bug: a tile that had once saved `split` kept reopening with the files out, so
  changing the default alone did nothing for any tile that already existed.
- **It never claims the global active-pane registries.** Every tile passes
  `isActive` — it is the only thing in its box — so the genuinely global slots
  are gated on `isActive && !tile`: the ⌘←/→ view cycle (which would point at a
  scratch shell instead of the pane you are working in), and
  `activeTerminalSend`, the one slot the mobile key bar types into, which four
  tiles would otherwise fight over. Mount-time focus is gated too, or a tile
  would steal focus from the pane it is sitting inside. Clicking a tile still
  focuses it; xterm does that itself.

A tile's `gridId` is `__headless__:<id>`, matching no workspace on purpose.
Anything reading a pane's pen from it must cope with the miss — `isLastSheep`
in `PaneHeader` did not, and called every scratch shell the last sheep in a pen
it is not standing in.

### The global scratch terminals keep a grid, and that is not a contradiction

The **Terminals panel** (`TerminalsDialog`, a `FloatingPanel` beside Files /
GitHub / Knowledge) holds up to `MAX_HEADLESS` = **4** shells that belong to no
pane at all, tiled — 1 full, 2 side by side, 3 as one wide over two, 4 as a
2×2. `TerminalTiles` draws both these and a pane's side terminals: they are the
same picture of the same kind of thing, and a second copy would have drifted
the moment one of them grew a button.

That is the grid pens just lost, and the two decisions agree. A pen is where
you **read**: one terminal at full width with the browser or a diff beside it,
so four panes there were four things none of which you could work in. These are
the opposite — shells you **watch**, in a box you park in a corner, where
seeing all four at once is the entire point. No draggable separators:
`react-resizable-panels` went out with the pen grid and is not coming back so
somebody can nudge a scratch shell 40px wider. The panel resizes; the tiles
follow. Three is one-over-two rather than three columns because a third of a
900px panel is ~290px, under the 560px where a pane's own split stacks — three
columns would put all three panes in their narrow layout at once.

- **The cap is enforced server-side** (`create_session` in `server.ts`), which
  is the only side that can count without racing two clients. The UI's
  `MAX_HEADLESS` is a mirror used for the count and the disabled button; if
  they drift the server still wins, handing back an existing shell rather than
  making one.
- **`restart` names its target now.** It used to mean "the" headless session,
  which stopped being a thing that exists. It still happens server-side in one
  step, for the original reason: a close and a create sent separately race the
  lookup, and a create that lands first is handed back the very session it was
  meant to replace.
- **The panel holds no state.** Its contents are `sessions.filter(isHeadless)`,
  so there is no second list to disagree with the server's, and nothing to
  persist — these are real PTYs the daemon keeps, so they survive a server
  restart and reopening the panel finds them.
- A scratch terminal's `gridId` is `__headless__:<id>`, matching no workspace
  on purpose. Anything reading a pane's pen from it must cope with the miss —
  `isLastSheep` in `PaneHeader` did not, and called every scratch shell the
  last sheep in a pen it is not standing in.

**What was deliberately given up in a pen**: two terminals side by side — an
agent in one, its logs in the other. If that comes back it should be a *side terminal*
inside a pane, beside the pane's own terminal, alongside the browser and git
splits. It must not come back as a grid of pens.

### Rules of thumb

- **Solid brand color** → `var(--primary)` (`#9cbc7f`).
- **Filled buttons / hero surfaces** → `background: var(--primary-gradient)`,
  `var(--primary-gradient-hover)` on hover, and `color: var(--primary-foreground)`
  for the text — never a literal `#fff`, which disappears on the light fill.
- **Soft tinted backgrounds** → `var(--primary-tint)`.
- **Surfaces** are olive-tinted near-blacks, not neutral greys:
  `#0b0d0a` page, `#111411` card, `#181c16` popover, `#232820` accent.
- **Chrome is the exception, and it is neutral** — see [Chrome is not
  green](#chrome-is-not-green).
- **ANSI palette** (`ui/src/theme.ts`) is tuned to the same pasture range —
  sage green, amber yellow, terracotta red, muted mauve. Editing it restyles a
  running Claude/Codex session without sending it any bytes.
- **Vendor marks stay vendor-coloured**: `ClaudeIcon` keeps `#CC785C`, and the
  file-type colours in `FilesPane` keep their language colours. Those are other
  people's brands, not ours.

## Session names

A name is written once and read a hundred times, at a glance, in a list of
twenty panes. Two things follow, and both are enforced in `ai.ts`.

A pane cleared with `/clear` is called `-` until its agent titles it again.
Not the directory's name, which is what it used to be: the pane bar already
carries the cwd under the title, so that said the same thing twice and read as
a name someone had chosen. `looksLikeAssignedName` claims the dash explicitly —
it cannot pass the charset, having no letter to lead with, and without the
claim every cleared pane would freeze on it at the next restart.

**The agent's own title is the name.** Claude Code writes an `ai-title` row
into its transcript every turn, and it is a better name than anything we can
derive: written by the agent doing the work, from the whole conversation rather
than three exchanges, and free. It named a pane `Litellm-sdk bedrock support`
that our own namer had called `merge`. `readAgentTitle` reads it from the tail
of the transcript — the rows are one per turn and only the last is current, and
a transcript runs to hundreds of megabytes. **Codex writes no title at all**
(`session_meta`, `turn_context`, `response_item`, nothing else), and **Pi
writes none either** (`session`, `model_change`, `message`) — so a null here is
the normal case for half the flock, not a failure.

**An agent with no title is named from the first thing you asked it**
(`readOpeningPrompt`). Those panes used to keep the directory's name, which is
the name every other pane in the same checkout had as well — so a flock of
eight Codex panes in eight worktrees of one project was eight panes called
`memlake`. The opening prompt is the same material a title is made of, chosen
by the person rather than the agent, and it has the one property a title does
not: **it never changes**, so the pane is named once instead of renamed every
turn. It is read from the **head** of the file, which is the opposite of every
other read here and is the point — the first prompt is at the top of a file
that may be 47MB, so one bounded 256KB chunk, no streaming. A slash command is
skipped: a pane whose first line was `/clear` would be called `clear`. The
name still goes through `normalizeAssignedName`, so it is six words and the
reader can claim it — a prompt head reads a little oddly (`can you make the
Files floating`) and that is the cost; what it buys is a name that says which
pane this is.

There is no model call here any more. There used to be one per pane per
sweep — three exchanges, a prompt with six rules in it, a one-shot `claude -p`
or `codex exec` — and it was paying a model to do worse what the transcript
already said. The prompt, the provider setting and the CLI command went with
it; what is left to configure is whether to take the title and how often to
look.

Its case is kept — the title is Sentence case on purpose — which is why
`NAME_CHARSET` accepts capitals. That widening also un-freezes the pre-rule
names (`check PR 1251 CI`), and its cost is deliberate: a short name typed by
hand is now claimable too, so the namer may replace it. The shape test is the
only ownership signal there is after a restart.

The reported turns (`appendAgentTurn`, persisted as `turns`) are still kept —
⌘K searches them and the hook trace shows them — but nothing names a pane from
them any more.

### The transcript also says how full the context is

`readContextTokens` reads it from the same tail the title comes from, and the
pen card shows it (`ctxTokens`, `.pane-card-ctx`). All three agents with a
transcript record it, in different places:

- **Claude Code** puts a `usage` block on every assistant row, and the prompt
  is `input + cache_read + cache_creation`. **The cached part is nearly all of
  it** — a real 451,045-token session reports `input_tokens: 32` — so counting
  only the obvious field reports every long conversation as empty.
- **Codex** writes an `event_msg` row whose payload type is `token_count`;
  `info.last_token_usage.input_tokens` is the last prompt, already summed (its
  `cached_input_tokens` is a subset, not an addition). Take the **last turn's**
  figure, not `total_token_usage`, which is every turn's input added up and is
  not what is in the context.
- **Pi** is Claude's shape under shorter names — `usage.input`, `cacheRead`,
  `cacheWrite`, `output` on every assistant row — so the same sum applies, and
  for the same reason: a real session reports `input: 1561` beside
  `cacheRead: 106368`. `readContextTokens` adds both sets of field names in one
  expression rather than branching, because one of the two is always absent.
  Pi is also the only agent that prices its own turns (`usage.cost.total`, in
  dollars), which the Agent tab shows as **Cost**; absent there means *not
  reported*, never free. The older `token_usage_record` row is still read
  as a fallback — current Codex writes none, and reading only that one is why
  Codex panes had stopped reporting any context at all.

Three things about it that are easy to get wrong:

- **A percentage when the agent says how big its window is; a count when it
  does not.** This is asymmetric on purpose, because the agents are:
  - **Codex writes `info.model_context_window`** (258400 on a real gpt-5.4
    rollout) beside the count, so its panes show `33%` — exact, and with
    nothing kept by hand.
  - **Claude Code records no window size anywhere the transcript can be read
    from.** Not on the usage block, not on a system row, and **not in any hook
    payload**. Claude Code's own status line shows a percentage because the
    *status-line interface* hands it `context_window.context_window_size` —
    a different channel, and not one sheepit is on. Installing a status line to
    get at it would clobber the user's own.

    The single trace of the window in the file is the trailing `cost-state`
    row, whose `modelUsage` map keys a 1M session as `claude-opus-5[1m]` while
    the assistant rows say plain `claude-opus-5`. Do not build on it: it is
    undocumented, it is **absent from roughly half the live transcripts** on
    this machine, it sometimes sits thousands of lines from the tail we read,
    and its keys include whatever model a subagent happened to use. Assuming
    200k when it is missing would report a real 1M session holding 536k tokens
    as **268% full** — wrong, and wrong in the alarming direction.

  So `ctxLimit` is present or absent, never guessed, and absent means *we do
  not know*, never *unlimited*. The number also drops after a compaction, which
  is right: it really did.
- **Stat before reading.** The count changes exactly when the agent replies,
  and replying is what moves the transcript's mtime — so `contextTokens` stats
  the file and only re-reads the 256KB tail when it moved. This runs inside the
  session list, which is rebuilt every couple of seconds for every pane;
  re-reading unconditionally would be megabytes a second for a number that had
  not changed.
- **The store's equality check is an allowlist**, so `ctxTokens` had to be
  added to it — and `ctxLimit` with it. Leave either out and the number renders
  once and then freezes: it climbs with every reply, and a list that calls
  itself unchanged never re-renders. The limit matters for the same reason even
  though it never changes within a session — on a fresh Codex pane it arrives a
  sweep after the count, and that sweep changes nothing else.

Unlike the title, this works for **both** agents — Codex panes have no name to
offer but do report their context, and are the only ones that can be shown as a
percentage.

**The title is taken as it is.** `normalizeAssignedName` is now *only* the
writer/reader contract — the charset, six words, sixty characters, and a letter
to lead with. Nothing in it judges what the title says.

It used to take identifiers out: PR and issue numbers, `#123`, uuids, commit
hashes. **That rule outlived its reason.** It was written to police a model
*we* called, against a prompt of six rules it might not follow. Nothing calls a
model any more — the name is the title Claude Code wrote for its own session,
chosen by the agent doing the work — and a rule that second-guesses it is a
rule with no author left to correct.

A day of PR review is what showed the cost. Every title came back shaped like
the work: `hindsight#4066`, `hindsight#4206`, `hindsight pull request 4015`.
Stripping the number left three different pens all called `hindsight`, which is
also the name of the directory each of them is in — the namer writing a name
that `isRenameable` would call a default. The number *was* the work. The old
argument (the bar already shows the PR) does not hold either: the bar shows the
**branch's** PR, and a pane reviewing someone else's has none.

The uuid goes with it, deliberately — `Recall metrics for org
81db9954-2fb1-…` is a real pane and reads long, but it is what the agent chose
to call it, and there is no longer anything here that claims to know better.

Both halves of the contract accept the same names now. `#` was always in
`NAME_CHARSET`, so the reader has claimed these all along; only the writer had
stopped producing them, which is what made every pre-rule name a name the
namer could never rewrite.

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

## Four agents, and what each one can be asked

A pane can hold Claude Code, Codex, Pi or Hermes (and the marks-only ones:
opencode, Copilot, Grok, Cursor, Antigravity). They are detected the same way
— `detectAgentApp` on the process tree — and after that they diverge, because
what sheepit can say about a pane is exactly what that agent writes down
somewhere. The table is the whole of it:

| | Claude Code | Codex | Pi | Hermes |
|---|---|---|---|---|
| transcript | `~/.claude/projects/<slug>/<uuid>.jsonl` | `~/.codex/sessions/Y/M/D/rollout-*-<id>.jsonl` | `~/.pi/agent/sessions/<slug of cwd>/<ts>_<id>.jsonl` | **none** — a SQLite `state.db` |
| how we find it | the hook hands over the path | the hook hands over a session id; the filename ends in it | **nothing reports** — found from the pane's cwd (`findPiSession`) | — |
| reporter | the hooks plugin | the hooks plugin | **an extension** (`plugin/pi/sheepit.js`), since it has no hooks | none — see below |
| busy / bleating | hooks | hooks (`waiting` from `PermissionRequest`) | the extension's own events | nothing |
| title | `ai-title`, every turn | none → opening prompt | none → opening prompt | — |
| context | sums `input + cache_read + cache_creation` | `last_token_usage` | sums `input + cacheRead + cacheWrite` | — |
| window size | **never recorded** | `model_context_window` | **never recorded** | — |
| cost | — | — | **`usage.cost.total`**, in dollars | — |
| resume after a reboot | `claude … -c` | — | `pi -c` | — |

Three things in it are worth the words:

- **A transcript is found, not reported, for Pi.** It has no hooks, so nothing
  can hand over a path — but it files its sessions per project directory, so
  the cwd is the key and the newest filename is the live session.
  `resolveAgentTranscript` is the one chokepoint every reader goes through
  (the Agent tab, the pen card's context count, ⌘K, the dog's `read_pane`), so
  Pi arrived in all four at once by being added there. The discovery is cached
  for ten seconds rather than for the session's life: a second `pi` in the same
  directory writes a *new* file beside the old one, and a path pinned once
  would leave the pane describing the conversation before last for ever. The
  slug is matched on its **letters and digits alone** rather than by rebuilding
  Pi's escaping — one `.` or space in a path and a reconstructed slug is
  silently wrong, while a comparison that ignores the punctuation cannot be.
- **Only Claude and Pi can be resumed**, and that is about the flag, not about
  favouritism: `claude -c` and `pi -c` both mean *the last conversation in this
  directory*, because both file their sessions per project. `codex resume
  --last` and `hermes --continue` mean the most recent session on the machine,
  so a restored pane would come back holding somebody else's work — worse than
  coming back holding a shell. See `AGENT_RESUME_COMMANDS`.
- **Every agent but Hermes reports its own state.** Claude Code and Codex
  load one `hooks.json`; Pi has no hook system at all, so the same reporter
  runs *inside* it as an extension. See [Agent
  hooks](#agent-hooks--the-agents-do-not-share-a-vocabulary) for both, and for
  the one rule that matters while testing: a Pi extension loaded twice reports
  everything twice.
- **Hermes is the one agent with nothing to read.** Its conversation lives in
  a SQLite `state.db` under `HERMES_HOME`, not in a JSONL anybody can tail, so
  the Agent tab says so in words rather than showing an empty list, `AgentKind`
  deliberately has no `hermes` member, and `transcriptRoots()` has no Hermes
  root. It still gets detected, drawn and counted; it is simply not a pane you
  can ask what it has been told. Its hooks are real (`hermes hooks`) but they
  are declared in the `config.yaml` that also holds the user's model and
  provider, under their own event names, behind a first-use consent allowlist
  — so wiring a reporter into them means editing that file.

**What was silently empty on a Codex pane**, until the fields were read under
the names Codex actually uses: its **turns** (it writes `task_complete`, where
Claude writes a `stop_reason` of `end_turn` and Pi a `stopReason` of `stop`),
its **effort** (`turn_context.effort`), its **sandbox** (`{"type":"read-only"}`
— the code read a `mode` key that current Codex does not write), and its
**branch** (`session_meta.git.branch`, written once at the top rather than on
every row). All four showed as absent, which reads as *this agent does not
report it* — the same wrong answer the hook trace exists to make visible.

## Agent hooks — the agents do not share a vocabulary

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
| **waiting on you** | `Notification` — **two events in one name**, see below | `PermissionRequest` — wired, see below |
| session starts / cleared | `SessionStart` (`startup`, `clear`) | `SessionStart` (`startup`, `resume`, `clear`, `compact`) |
| session ends | `SessionEnd` | `SessionEnd` |

### `Notification` is two different events wearing one name

Claude Code fires it for a permission prompt **and** about sixty seconds after
a turn *ends* when nobody has come back:

| the payload's `message` | what it is |
|---|---|
| `Claude needs your permission to use Bash` | blocked on you — a sheep bleating |
| `Claude is waiting for your input` | the turn finished and you have not looked — **unread** |

Both were reported as `waiting`, so every pane that finished and sat for a
minute turned red. With a dozen of them on screen the one colour that means
"come here now" stopped meaning anything, which is the whole cost: a signal
that fires when nothing is wrong is a signal you learn to ignore.

`report-state.mjs` downgrades the second to `idle` — the same thing `Stop`
already said — on the message text (`NOT_BLOCKED`). It reports it rather than
dropping it, so the trace can still tell a hook that fired from one that was
never wired. `src/__tests__/report-state.test.ts` drives the real file the way
Claude Code drives it; a hook reporting the *wrong* state looks exactly like a
hook that is working, so nothing but a check catches it.

**The same mistake was in the bell, and it is the bigger half.** Counted over
the 63 live ring buffers on one machine: `Claude is waiting for your input`
**108** times, `Claude needs your permission` **2**, one Codex closing message.
Fifty to one, and all 111 were published as attention. (Nothing *renders* a
bell — it is an invisible escape sequence, so this is not something anyone can
see going wrong by watching a pane; count it in the rings.)

OSC 9 is how an agent says *I am done* —
Claude Code rings it with that same "waiting for your input" line, Codex with
the model's closing message — and every one of them was published as
attention. Whether an agent is *blocked* is a question its hooks answer
exactly, so `handleNotification` now ignores the bell as an attention source
for any pane that has ever reported a state: the busy→false flip marks it
unread, which is what it is. A pane with **no reporter** in it (a plain shell,
a marks-only agent) still bleats on a bell, because there it is the only
signal there is.

Codex has **no `Notification` event at all**. Its full set is `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`,
`SubagentStop`, `Stop`, `Interrupt`. Without its own `waiting`, a Codex pane
went from grazing straight to nothing while the agent sat on an approval
prompt — the one state the flock exists to show.

**`PermissionRequest` is wired, and it is wired through `post.sh`.** It is not
a passive notification the way `Notification` is: Codex reads the hook's
*decision* from it, an exit code of 2 denies the request, and invalid JSON on
stdout is an error. A reporter on that hook sits directly in front of the
approval prompt the user is waiting to see — so it carries a **fixed body**
(`{"state":"waiting",…}`) and never the node reporter. There is nothing to buy
with a payload parse here, and in `post.sh` the rule that every path exits 0
and prints nothing stops being politeness and becomes the thing that keeps it
from answering a permission question nobody asked it.

Two things about it that are not optional, and the second is why a first look
reads as broken: the event needs a **Codex restart** before it fires at all,
and Codex will not run a hook it has not **trusted by hash** (see below), so
a new event also needs the user's approval once. **Verify it against the hook
trace on a real approval** — a `waiting` row with `source: codex` and
`event: PermissionRequest` — rather than trusting this paragraph; nothing else
distinguishes a hook that never fired from one that failed.

`post.sh` carries a fixed body, so it cannot be handed the caller's name —
hooks.json is one file and said `"source":"claude"` for both agents. It works
out which agent it is from the plugin root instead (`~/.claude` vs `~/.codex`).
Without that the trace reported Codex's tool pings as Claude's, which is worse
than leaving them unlabelled: the trace is where you go to ask "is Codex
reporting at all", and it answered no while Codex was reporting fine.

Codex reports the whole turn correctly — `UserPromptSubmit` with the prompt,
tool pings, and `Stop` with the response. Do not read a short sample of the
trace as a missing event: `Stop` fires once per turn against hundreds of tool
pings, so an idle minute looks exactly like a broken hook.

### Pi has no hooks, so the reporter lives inside it

`plugin/pi/sheepit.js` is a **Pi extension**: a module Pi imports at startup
and calls back on its own lifecycle events. It reports the same four states to
the same agent-agnostic endpoint as `source: "pi"`, so the hook trace, the
activity dot, the pane's name and ⌘K work for a Pi pane with no server-side
knowledge of Pi beyond reading its transcript.

Its events map cleanly, and one of them is better than what the other two
offer:

| moment | Pi event |
|---|---|
| turn starts | `turn_start`, and `message_end` (role `user`) for the prompt |
| still working | `tool_execution_start` / `tool_execution_end` |
| **waiting on you** | `ui_prompt_start` → `waiting`, `ui_prompt_end` → back |
| turn ends | `agent_settled`, with the reply kept from `message_end` |
| session starts / cleared | `session_start` (`reason: "new"` is the `/clear`) |
| session ends | `session_shutdown` (`reason: "quit"`) |

In-process changes the rules in both directions, and the file says so at
length because every one of them is a trap the hook plugin does not have:

- **A handler is awaited by the agent**, so nothing in that file is ever
  awaited: every POST is fire-and-forget. That is the in-process spelling of
  `post.sh` backgrounding its curl.
- **A throw lands in the agent**, not in a subprocess nobody reads, and **a
  returned value is how an extension changes Pi's behaviour**. So every
  handler is wrapped and every path returns `undefined` — asserted in
  `pi-extension.test.ts`, which drives the real file the way Pi drives it.
- **There is nothing to spawn**, so the per-tool-call ping costs a function
  call rather than the ~25ms interpreter start `post.sh` exists to avoid. The
  whole reason that file is POSIX sh does not apply here.
- **`ui_prompt_start` is the `waiting` Codex had to wait for.** Any prompt Pi
  puts up is a question only the person can answer, which is exactly what a
  bleating sheep means — and unlike Codex's `PermissionRequest` it is
  notification-only, so a reporter on it cannot affect what is being asked.
- **`agent_settled`, not `agent_end`.** Retries, recovery and compaction can
  still follow an `agent_end`, and a pane that went quiet and then started
  working again is the wrong notification twice.

Installing is a **file copy** into `~/.pi/agent/extensions/sheepit.js`
(`installIntoPi`), which Pi loads with no settings entry — there is no plugin
manager, no marketplace and no version-keyed cache, so none of the traps those
have. The version is a comment on the installed file's first line rather than a
marker file beside it, because Pi scans that directory. Like `hooks.json`, it
is read **once at startup**: a running Pi pane keeps the old code, and there is
no `syncPluginScriptsIntoCaches` equivalent to sneak a fix in, because the code
is already resident.

**Do not load it twice.** A copy passed with `pi --extension` *and* the
installed copy are two independent reporters, and every state arrives twice —
which is exactly what a hook trace showing `count: 2` on every Pi row means.
It cost an hour of looking for a duplicate-send bug in the reporter that was
never there: the extension issues one request per event, and two module
instances issued two. When testing a change, pass `--extension` with a path
*and* move the installed copy aside, or just reinstall and run plain `pi`.

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

## Measuring the UI — one place, always on

`ui/src/perf.ts` is the only thing in the UI that measures the UI. Nothing else
may call `performance.now()`, stand up a `PerformanceObserver`, or keep its own
frame counter — a second measurement is a second answer, and the whole value of
this file is that there is one. `DiagnosticsDialog` used to sample
`performance.memory` and count websocket resource entries on its own 3-second
timer; it now reads `perf.live()` like everything else.

It is **on in every build**, because the bottlenecks worth finding are the ones
in real daily use, and those are never in a profiling session somebody sat down
to run. The cost is one `requestAnimationFrame` for the whole app, two
observers, and a `Map` bump per span; nothing allocates per frame.

Four kinds of measurement, and they answer different questions:

| | what it tells you |
|---|---|
| `perf.span(name)` | what code *you suspected* costs. Returns the end function; nesting is fine, and the innermost open span is what a janky frame is blamed on. It is the only timing helper — `timed()`/`timedAsync()` wrappers were written and deleted unused |
| `perf.count(name)` | things with no duration — a render, an IPC send, bytes over the wire |
| `perf.commit(id, ms)` | what one React commit of a subtree cost, from a `<Profiler>` |
| long animation frames | what costs that **nobody wrote a span for** — the browser's own attribution: which script, which file, called from what, and how much of the frame was style and layout rather than JavaScript |

Two of those four do not survive a production build, and reading a number
without knowing which is how you end up optimising the profiler:

- **`commit:*` works in a production build too.** This file previously claimed
  otherwise — that `<Profiler>` is a no-op unless built against
  `react-dom/profiling`. That was true of React 16/17 and is not true here:
  the spans are present in the Vite production bundle, checked by serving
  `ui/dist` and reading them. So commit timings are available wherever you run,
  which is what makes the dev-versus-production comparison below possible at
  all.
- **Dev inflates every React number.** Vite serves React's development build,
  which is several times slower than production, and `main.tsx` wraps the app in
  `StrictMode`, which renders every component twice. A commit measured at 113ms
  in `./dev.sh --desktop` is not 113ms in a packaged app. The *shape* still
  holds — one socket message should not commit the whole tree — but never quote
  a dev millisecond as the user's millisecond.

That last row is the one that earns its keep. A `span` can only answer for code
someone already suspected, and the first time you look, that is not where the
time is going. The long-frame observer named a 343ms click as 307ms of React
with 16ms of style and layout — which is the opposite of what the CSS suspects
in this file would have predicted, and it took no guessing at all.

**A `render:` counter is not a substitute for a commit.** A counter averages a
burst away: thirty renders inside one click and nothing for ten seconds reads as
three a second. The commit carries the duration of the work React actually did,
so the one 300ms commit shows up as a 300ms maximum. There are exactly two
`<Profiler>`s — `sidebar` and `pane` — because the only question a wrapper here
answers is which half a slow commit landed in.

**An occluded window reports slowly, not never.** Browsers throttle background
timers to roughly once a minute, so a window behind something else posts a
snapshot about that often rather than every 10 seconds. A gap in the data after
a `DELETE` is usually that, not a broken client — wait a minute before
concluding anything is wrong.

**A window nobody is looking at is still measured.** The snapshot is closed by a
timer, never by the frame loop — the OS stops producing frames for an occluded
window, so rolling inside `requestAnimationFrame` meant such a window reported
*nothing at all*, and a real day's work has plenty of time with the window
behind something else. Frames only exist while it is on screen, so `visibleSecs`
says how much of the snapshot they can speak for and `fps` is a rate over that
rather than over wall-clock. Without it, a window spending nine seconds of ten
behind another app read as 7fps.

### The snapshots leave the browser

Every 10 seconds the window is folded into a snapshot and posted to
`POST /api/perf`, where the server keeps an hour of them in memory. **That is
the point of the whole file**: a measurement nobody can read afterwards is a
profile of a moment nobody cared about. Reading it:

```
curl -s 'localhost:4445/api/perf?spans=1&shell=electron' | python3 -m json.tool
curl -X DELETE localhost:4445/api/perf     # before measuring a fix
```

`?minutes=N` folds only the last N minutes. The server keeps an hour, which is
right for "what is this app like" and wrong for "did that change help" — an hour
of pre-fix windows drowns ten minutes of post-fix ones, and anything watching
the whole hour will report a problem that was fixed forty minutes ago.

`?spans=1` folds every window into one answer, worst total first. `shell=`
narrows to `electron` or `browser` — the same UI in two shells, so **a span that
only costs in one of them is the whole finding**. Not persisted: a server
restart losing them is fine, since what matters is the session you are in.

In Electron there is a second half the renderer cannot see. Window events,
native view placement and every IPC message are handled on the **main**
process's event loop, so a stall there is input lag that the process being
blocked cannot measure. `main.cjs` watches its own loop drift and times each IPC
handler; the renderer asks for it once per window (`perf:main`) and folds it in,
so there is still one place to read.

**One series per page.** A machine routinely has several pages open at once —
the desktop window, a tab, a second window — and folded together they average
into a picture that describes none of them. Every snapshot carries a `page` id,
regenerated per load, and the fold lists every page that reported so a mixed
sample is visible as mixed. `?page=` narrows to one.

**Compare like with like.** A window holding 5 panes, 5 browser surfaces and
18,500 DOM nodes against a tab holding 1 terminal and 3,800 nodes is not a
measurement of Electron versus the browser — it is a measurement of five things
versus one. `holding` is on every snapshot for exactly this reason: check it
before believing a difference.

**Node count is not the sidebar's size.** `holding` carries `pens` and `sheep`
as well, because `commit:sidebar` is routinely the most expensive span in the
app and the node count actively misleads about it: a 4,425-node page and a
23,000-node one had the *same* 7 pens and 40 sheep, since 40 pane cards are a
small share of a document that is mostly terminal. A 93ms sidebar commit was
read as an outlier on a small page when it was a full sidebar all along.

**A span's ms/sec is a rate, so it needs a sample to be a rate over.** Two
samples where it is not one, and both have produced false alarms: a page that
has just loaded, where mounting the pen, the sidebar and the fences is a
one-off burst that divides into ~30 ms/sec of `commit:pane` over a 31-second
window; and a window nobody is looking at, where React still commits on the
sweep but nothing is painted. `scripts/perf.py` gates the cost ceilings on
both. Note also that **`commit:split` nests inside `commit:pane`**, so one slow
commit trips two ceilings and reads as two findings.

### What it found first

- **A hidden browser pane used to poll.** `NativeBrowserSurface` followed its
  box on a timer even when the pane was not on screen — four times a second,
  per pane, and every poll a `getBoundingClientRect`, which is a forced layout
  flush over the whole document. Every pane in a pen stays mounted, so most of
  them were panes nobody could see. Measured: 5 panes, 20 forced layouts a
  second on an 18,500-node tree, **7.3ms of every second, forever, for no
  information** — and the browser build pays none of it, which is exactly the
  shape of the original complaint. An `IntersectionObserver` answers the same
  question for free, because the compositor already knows: a `display: none` box
  does not intersect, and being shown fires the callback with the new rect
  attached. The `requestAnimationFrame` now exists only while there is something
  to follow. Do not reintroduce a timer here.
- **The stalls are React, not CSS.** On a real session the worst frames were
  270–340ms of script with 1–16ms of style and layout, triggered by
  `DIV#root.onclick` and by `DOMWebSocket.onmessage`. Note what this is measured
  *in*: Vite serves React's **development** build and `main.tsx` wraps the app in
  `StrictMode`, which double-renders every component. Both inflate these
  numbers, and both are absent from a packaged build — so the number is not the
  user's number, but the **shape** is real: one socket message should not cause a
  300ms commit.
- **The flock was animating itself to a standstill.** An idle sheep drifts three
  `zzz` strokes for ever, and idle is the commonest state a pane is in — so with
  one sheep per pane card the sidebar ran **105 of those animations at once**,
  out of 152 in the document. It did not show up as script at all: the frames
  were 92–118ms carrying *no* JavaScript, with the GPU process at ~40% in a
  window where nothing was happening, which is why no amount of reading the
  JavaScript would have found it. The drift is now scoped to
  `.pane-header .sheep-idle` — the full-size animal in the pane bar, and there is
  one pane bar on screen — and the sidebar's sheep keep the glyph with staggered
  opacity instead. 153 running animations became 13. At 26px a 3px `z` drifting
  6px was never motion anybody could see; it is the same argument `SheepDot`
  makes about a 6px dot. **Do not re-scope an infinite animation to a selector
  that matches once per pane.**
  `content-visibility: auto` on the pen row was tried for the same problem and
  **removed**: a real flock fits on screen (7 pens, 41 sheep on the machine this
  was measured on), so it saved nothing that the scoping had not already saved,
  and a skipped subtree has no rendered descendants — which is exactly what
  dnd-kit measures when you drag a pane into another pen. If the sidebar ever
  does grow past a screenful, that is the right tool; it is not a free win to
  add speculatively.
- **One pane changing re-rendered every pane.** `renderSessions`' equality check
  was all-or-nothing: if any single session differed, the whole `sessions` array
  and the whole `sessionMap` were rebuilt, so every component selecting
  `sessionMap[id]` re-rendered. With 54 panes and an agent running somewhere,
  `last_activity` moves on *something* almost every sweep — so in practice the
  entire tree re-rendered on a two-second timer. Measured before the fix: a
  socket message costing 251ms of React, `commit:pane` up to 198ms, and
  `TerminalCell` re-rendering four times a second against one mounted terminal.
  `sameSession()` is the allowlist lifted out, and a session whose fields all
  match now keeps the object it already had — the same fix `nextWorkspaces` had
  already been given, for the same reason. **Identity is the signal every
  selector reads**, so anything rebuilding these objects wholesale undoes it.
- **The sidebar re-rendered every pen on every sweep.** `SessionItem` was not
  memoised, so one commit of the sidebar re-rendered the whole column — every
  pen, several times a second, because one pane somewhere had new output. It is
  `memo()`d now, and that only works because the props are all stable:
  `workspace` keeps its object unless that pen changed, and `onConnect`/`send`
  are `useCallback`s in App whose dependencies bottom out at `[]`. A pen whose
  own data changed still re-renders — its own `useStore` selectors fire
  regardless of the parent. Measured on a 7-pen flock: **2.9 pens re-render per
  sweep instead of all 7**, and those are the ones that actually changed.
  **Give that component a prop built inline at the call site and the memo is
  off.**

  Counting this needs care, because `useSharedTick(5_000)` re-renders every pen
  every five seconds *by design*, to keep the relative timestamps honest. That
  floor (pens x ticks x 2 for `StrictMode`) has to come out of the render count
  before the remainder says anything about sweeps — subtract it and the
  difference is the real signal; forget it and the memo looks like it does
  nothing.
- **The fence redraw is layout, not canvas.** The watchdog caught a 1058ms frame
  blamed on `PenFence` from a `ResizeObserverCallback`, with one `penFence:draw`
  at 209ms. The obvious suspect was the grass — the workspace pen covers the
  whole main area, about 7,000 blades, each its own `stroke()`. It was the wrong
  suspect: measured on a real page, 7,000 strokes cost **2.2ms**. What costs is
  that each callback calls `getBoundingClientRect` and `getComputedStyle` *while
  the layout is dirty* — **1.26ms and 1.54ms a call**, against ~0ms when it is
  settled — and then assigns `cv.width`, dirtying the layout again for the next
  pen. A column of pens pays a full style and layout recalculation each, in
  sequence. Both observers now coalesce into one frame. The grass batching
  stayed (7,000 draw calls became ten, a measured 1.3x) but it is **not** the
  fix, and the comment in `grass.ts` says so — a tempting story that measurement
  does not support is worse than no comment at all.
- **Every mounted *pen* re-rendered on a click.** `PaneTerminal` keeps up to a
  dozen pens mounted and renders a `TerminalGrid` for each; none of them was
  memoised, so clicking a pen in the sidebar re-rendered all twelve rather than
  the two involved in the switch. This is what the browser kept blaming
  148–208ms frames on — `DIV#root.onclick`, which is precisely the "clicking
  feels unreactive" the whole exercise started from. `TerminalGrid` takes one
  string, so memoising it is free; a pen whose own contents changed still
  re-renders, because its `useStore` selector fires regardless of the parent.
- **Every mounted pane re-rendered with the grid.** Every sheep in a pen stays
  mounted (all but one under `display: none`), and `TerminalCell` was not
  memoised — so one render of `TerminalGrid` re-rendered every pane in the pen,
  terminal chrome and tool split included. The watchdog caught `commit:pane` at
  **25ms of every second** with the app idle. It is `memo()`d now, which needed
  the handlers fixed first: `onActivate={() => setActiveCell(i)}` builds a new
  function on every render, so the memo could never have held. Both callbacks
  take the pane index instead, and the grid passes its `useCallback`s straight
  through. `TerminalTiles` keeps inline handlers on purpose — it closes by id,
  not index, and four scratch shells are not worth a lookup table.
- **A clock re-rendered the whole sidebar.** `useSharedTick(5_000)` sat on
  `SessionItem`, so every five seconds every pen re-rendered its entire subtree
  — pane cards, agent marks, context counts and a 44x38 SVG sheep each — to
  refresh a string like "48s". The tick now lives on `PaneAge`, a component that
  renders nothing but that string, so the re-render happens where the change is.
  The timer is still shared, which is the point of the hook: forty of these are
  one interval and one tick. **A component that subscribes to a clock should be
  the smallest thing the clock changes.** It subscribes to `sessionLastEvent`
  itself for the same reason: that moves on every output message an agent
  produces — 22 a second, measured — and while the card held the subscription,
  every one of those re-rendered the card's name, agent mark, context count and
  sheep to change a string.
- **Every keystroke did work for a reader that no longer exists.** `sendInput`
  ran `stripEscapeSequences` over the data, rebuilt a per-session input line
  character by character, and broadcast it to every connected client as
  `current_input`; the client copied its whole 54-entry map into the store and
  woke every subscriber. **Nothing had rendered it since the commit that removed
  the reader.** The server comment even says the broadcast "is work on the same
  path a keystroke travels, so it showed up as input lag" — it had been
  coalesced once already, when the right answer was that it should not exist.
  Gone: `inputBuffers`, `publishCurrentInput`, `INPUT_PUBLISH_MS`, the protocol
  message, the store field and its diagnostics row. Note what made it findable:
  the data said a span called `ws:current_input` was costing real time, and a
  grep said nothing read it. **Dead state is invisible until something counts
  it.**
- **`last_activity` is not last activity** — found while chasing the renders it
  was assumed to cause. The server sets it from `sess.createdAt`, and the
  restore paths stamp that with `Date.now()`, so after a restart all 54 sessions
  carry an identical value and it never changes again. Verified against the live
  API: 54 sessions, **one** distinct value, unchanged across samples. Two things
  follow. The age on every pane card, and the ordering in the New Session
  dialog, are both measuring time-since-server-start. And the perf story built
  on it was wrong twice over — first "it must stay for correctness", then "it
  churns every sweep"; it is in fact constant, so it costs nothing and removing
  it bought nothing. That change was reverted. **The bug is real and unfixed**:
  fixing it means choosing what counts as activity and stamping that.
- **Every pane that went busy wrote the store on its own.** `updateActivity`
  arms a 2200ms timer per pane and each one wrote the whole `sessionBusy` map by
  itself. Agents start work together — a sweep of hook reports, a fan-out, a
  restart — so the timers fire together; but each is its own task, so **React
  cannot batch them**. Fifteen panes going busy meant fifteen full store writes
  and fifteen full commits back to back. Found by the watchdog as a 412ms frame
  carrying 169ms of script and blamed on `src/store.ts [TimerHandler:setTimeout]`
  — not a click and not the sweep, which is why it had stayed hidden behind
  those two all day. A 0ms flush now collects whatever fires in the same turn
  into one write; the delay and the result are unchanged. A pane that finishes
  while the flush is pending is taken back out of it, or it would be written as
  busy just after saying it had stopped.
- **Hidden panes did full React work — this was what made clicking slow.**
  Every sheep in a pen stays mounted under `display: none`, and they re-rendered
  with everything else: **11 `commit:split` per sweep when at most one split is
  ever on screen**, and `commit:split` was ~90% of `commit:pane` (the durations
  nest). That was the click cost — 180–230ms, scaling with how much you had
  open, and for hours it was *every single entry* in the worst-frames list.

  Two wrong turns are worth keeping. The first was "unmount the hidden ones",
  which would close `PreviewPane`'s live browser view and discard `FilesPane`
  and `GitDiffPane` scroll and expansion on every pen switch — the trade
  [One pane on screen](#one-pane-on-screen) refuses. The second was mine: I
  wrote that `memo` could not help because the components subscribe for
  themselves. **That was false.** `GitDiffPane`, `FilesPane`, `GithubPane` and
  `AgentPane` subscribe to the store *not at all*; only `PreviewPane` does. They
  re-rendered because `TerminalCell` did, and nothing more.

  So the fix is a `useMemo` holding the split element still — five lines, no
  unmount, no state lost.

  **Be careful how this one is quoted.** The first reading after it landed —
  `commit:split` 796 commits to 19 — came from a *quiet* window, and the commit
  message that shipped it says so as though it were the general case. It is not.
  `view`, `previewNav` and `githubRef` are dependencies, so switching panes or
  tools busts the memo and the split re-renders, which is correct. Under real
  use the rate is far higher: 15 split commits a sweep, against 11 before the
  fix.
  What holds up: **0.5 split commits per `TerminalCell` render**, where without
  the memo every render would take its split with it — so it roughly halves the
  work while you are working and nearly removes it while you are not. And the
  frame numbers moved in a way that does not depend on the mechanism: long tasks
  799 to ~310 ms/min, worst long task 217ms to 114ms, `commit:pane`'s worst
  commit 201ms to 46ms, and `DIV#root.onclick` gone from the worst frames.
  The pre-fix ratio was never captured — the feed only keeps an hour — so
  "halves" is read off the mechanism, not a measured before and after. **An inline lambda added to that block turns all of it off
  silently** — the dependencies are listed rather than `eslint-disable`d for
  exactly that reason.
- **The browser pane's own loop was the app's biggest cost.** With a browser
  pane on screen, `nativeBrowser:tick` reached **77.8ms of every second**, of
  which the 4x4 hit test was **58.9ms — 5.9% of the main thread**, at 0.79ms a
  pass. The same sixteen `elementFromPoint` calls cost 0.14ms on a quiet page:
  what makes them expensive here is that eleven terminals are writing into a
  20,000-node document, so the layout is dirty on nearly every frame and each
  pass pays a full recalculation. Both things this loop watches for are now
  gated: a box moves only when the layout changes, and an overlay appears only
  because somebody did something, so after ten still frames *and* 800ms with no
  keystroke, click or scroll it runs one frame in six. Any input or any movement
  snaps it back to every frame, so a drag is still followed and an overlay is
  still caught in the frame after the key that opened it. **Plain typing does not
  count as input here**, and that is the difference between the gate engaging
  half the time and nearly always: every global shortcut in `App.tsx` starts
  with `if (!e.metaKey) return`, and every other overlay opens from a pointer, so
  the characters going into a terminal — most of the keyboard traffic in this
  app — cannot put anything over the pane. **The ceiling**: an
  overlay opened with no input at all — by a timer or a server message — could
  sit under the native view for up to six frames. Nothing does that today.
- **Following the box was the forced layout, not the hit test.** With a browser
  pane on screen, `nativeBrowser:tick` reached **27.9ms of every second** — the
  single biggest span in the app — and `nativeBrowser:covered` was only 8.2 of
  it. The rest was one `getBoundingClientRect` per frame, which forces a layout
  flush, on a document of ~20,000 nodes with terminals streaming into it. The
  box is now re-measured every frame only while it is actually moving, and every
  third frame once it has held still for ten; a box moves when the layout
  changes, and layout changes are rare next to frames. **The hit test still runs
  every frame**, against the remembered box — an overlay opening does not move
  the pane, and a native view sitting on top of a dialog for three frames is a
  flicker anyone would see.
- **What a click still costs, and the one thing it correlates with.** A
  pane-card click is 126–171ms and re-renders **every mounted dnd-kit consumer,
  every time**: 40 of 40 `PaneCard`s, 31 of 31 `TerminalCell`s, 7 of 7
  `SessionItem`s. The component that does *not* is `TerminalGrid`, at 1.0 per
  click — and it is the only one of the four with no `useDroppable` or
  `useSortable` in it. `App` renders 1.0 and `PaneTerminal` 1.3, so this is not
  the tree re-rendering from the top; it is context, which `memo` cannot stop.

  **The handler identity is not the cause, and that was tested rather than
  assumed.** Three of `DndContext`'s four props (`onDragStart`, `onDragEnd`,
  `onDragCancel`) were plain declarations, so App handed it new functions on
  every render — the same shape as the two memo bugs above. Wrapping all three
  in `useCallback` changed **nothing**: still 100% of consumers, still 126ms.
  dnd-kit keeps its handlers in refs. The change was reverted rather than left
  in place, because a `useCallback` whose comment explains a cause it does not
  address is worse than the plain function.

  Also ruled out: the pointer sensor already carries
  `activationConstraint: { distance: 6 }`, so a plain click never activates a
  drag. Whatever changes the context does so without a drag starting.

  Where to look next, in order of how lazy: isolate `DndContext` so an App
  render does not re-render it; or give the sortable lists stable `items`
  arrays (`PaneGrid` builds `sortableIds` fresh every render, which changes
  `SortableContext`'s value); or drop dnd-kit for the two drags that actually
  exist. Do not start by memoising anything — `memo` cannot stop a context
  change, which is the whole shape of this bug.

- **Measurement caveats worth re-reading before quoting any of this.** The
  figures above come from a dev build, where React is several times slower and
  `StrictMode` renders everything twice — every per-click count here is halved
  for that. Numbers taken while the machine is loaded (agents running, builds
  going) have shown `commit:sidebar` at 698ms and `commit:split:working` at
  966ms, which are real but not representative. And **always narrow to one
  `?page=`**: eight pages were reporting at one point, and a fold across them
  describes none of them — dividing their combined `by:*` totals by one page's
  click count is how "2.8 TerminalCells per click" got reported when the true
  figure was all of them.

- **Where it got to, measured on one loaded window.** Against a morning
  baseline of 23,132 nodes and a later reading at **25,254** — so the after is
  the bigger document:

  | | before | after |
  |---|---|---|
  | main thread blocked | 801 ms/min | **129 ms/min** |
  | worst frame | 649ms | **197ms** |
  | slow frames | 65.6/min | **21.7/min** |
  | `nativeBrowser:tick` | 18.54 ms/sec | **1.17** |
  | browser loop ran on | 31% of frames | **12%** |
  | `commit:pane` | 13.56 ms/sec | **2.97** |
  | `commit:sidebar` | 6.69 ms/sec | **3.12** |

  `ident:*` on the same window: 9,857 sessions kept identity against 153
  rebuilt, and every field responsible was one that is actually drawn —
  `ctxTokens` 139, `gitDirty` 6, `name` 5, `gitBranch` / `prNum` / `prRefs` one
  each. No dead churn left.

- **The refit was not the cost, and the span is why we know.** A 551ms frame
  blamed 326ms of script on `TerminalCell`'s show-fit, which looked like the
  pane switch paying for an xterm reflow. Measured across 62 real switches:
  **0.31ms average, 1.5ms worst.** FitAddon no-ops when the dimensions already
  match, which is the common case, so that frame was a one-off — a first show
  or a window resize — and not a cost anybody pays twice. Worth keeping as the
  cleanest example of why a span goes in before a fix does.

- **What is left is switching pane or pen, and it costs the same from either
  input.** `click:pane-card` averages 72.75ms and peaks at 108.7ms,
  `click:pen-body` 121.5ms, and the worst frames are three
  `App.tsx [DOMWindow.onkeydown]` at 85–104ms of script — ⌘↑/↓ doing the same
  work the click does. Clicking into a terminal is 14.5ms, so this is the
  switch itself, not input handling in general. That is the next thing to look
  at, and the `click:*` spans are what name it: a long frame only ever says
  `DIV#root.onclick`, which is true of every click in the app because that is
  where React listens.

- **Two numbers nobody displays re-rendered the whole sidebar.** `sameSession`
  compared `cpuPercent` and `memMb`, which move on every sweep for any process
  doing anything — so **38 of 55 sessions got a fresh object every two
  seconds**, handing every pane card a new `sessionMap[id]`. The pane bar's CPU
  and memory readouts were deliberately removed long ago, and the only
  references left in the UI were that comparison and the type declaration: the
  cost was forty cards re-rendering a sweep for values nothing draws. Same
  shape as the `current_input` broadcast, and found the same way — by counting
  it (`ident:sessionKept` / `ident:sessionNew`). Measured on **warm** pages
  after: sessions rebuilt per sweep **38.0 → 0.3**, `render:SessionItem`
  **22.2 → 4.4**, `render:PaneCard` **126.7 → 25.3**, `commit:sidebar`
  7.29 → 2.77 ms/sec and its worst commit 85.1ms → 44.4ms. The one remaining
  rebuild is `ctxTokens` on a pane whose agent is replying, which is exactly
  what should invalidate a card.

  **Read these only on warm pages.** The first reading after the fix said 9.2
  rebuilds per sweep and was quoted as "the rest are really changing". It was
  not: `ident:noPrev` was also 9.2, and 12 sweeps × 9.2 is 110, which is
  exactly 2 reloaded pages × 55 sessions being met for the first time. A
  freshly loaded page has no previous session objects at all, so every cold
  start pays one full rebuild of everything and smears across a short window.
  `ident:noPrev` is kept precisely so that case is distinguishable from churn —
  without it the cold start is indistinguishable from a real bug, and was
  mistaken for one. **If something ever shows these
  numbers, do not fix it by putting them back here** — that reinstates a
  sweep-wide re-render for one readout; give it its own narrow subscription.
- **Name the field, not just the fact.** `sameSession` returning false says a
  session was rebuilt and not why, and why is the whole question — a field that
  moves every sweep and is rendered nowhere costs the sidebar a full re-render.
  `countChangedField` reports the culprit as `ident:field:<name>`, called only
  on a mismatch. It is a second list from `sameSession`'s chained `&&`, which
  cannot say which link broke; **a field added to the allowlist must be added
  there too**, or its churn is invisible, which is the failure the counter
  exists to prevent.
- **Whether identity survives is now measured, not asserted.** Every memo in
  the sidebar rests on `sessionMap[id]` and `workspaces[id]` keeping their
  references, and that was a claim in a comment. `ident:*` counts it per sweep,
  which is what made the above findable and what separates "the sidebar
  re-renders every sweep" from "the sidebar's props changed every sweep" —
  two very different bugs that look identical from a render counter. It also
  cleared the pens: `ident:penKept` is 7.0 of 7 with `penNew` at 0, so
  `nextWorkspaces` has been doing its job all along.
- **`PaneCard` is memoised, and that needed two inline handlers fixed first.**
  A pen holds 5.7 cards on average and none of them was memoised, so each card
  body — agent mark, context count, age and a 26px SVG sheep — re-rendered
  whenever its pen did. `onActivate` and `onAddSheep` were built inline at the
  `PaneGrid` call site, so the memo could never have held; they are
  `useCallback`s now, the same prerequisite `TerminalCell`'s memo needed. Worth
  recording how this read before the cause above was found: the memo landed and
  changed **nothing** — cards per pen render stayed at 5.71, exactly the 40/7
  cards that exist — because the cards were never re-rendering from their
  parent. That ratio is the trap: it is identical whether every pen re-renders
  or only some, so it cannot tell you which, and an absolute rate against the
  sweep count is what settled it.
- **Fast Refresh does not establish a new `memo` boundary.** Wrapping a mounted
  component in `memo` and watching the numbers not move proves nothing until the
  page has actually reloaded — page ids in `pages[]` are how you tell, since
  they are regenerated per load. A whitespace edit to `perf.ts` forces the
  reload, because that file reloads the window on HMR by design.
- **A dead backend meant a blank window.** `bootstrap()` awaited
  `initializePreferences()` with no catch, so an unreachable server at load time
  threw and nothing was ever rendered — no spinner, no error, until somebody
  reloaded. It retries instead. It must never *proceed* without the profile:
  that is the path where the store starts from an empty layout and persists its
  emptiness over the real pens.

## The terminal font, and the cache that outlives it

Picking a font applies to every pane straight away, and for a long time it
looked like it did nothing: you chose Menlo and the panes went on rendering
whatever they had. The setting, the preference and the xterm option were all
correct. **The renderer's glyph cache was the problem.**

xterm's WebGL renderer keeps a texture atlas of rasterised glyphs and a render
model holding, per cell, the texture coordinates into it. Setting
`fontFamily` does swap in a new atlas — the atlas config includes the family —
but `_handleOptionsChanged` refreshes the atlas and leaves the model alone, and
`_updateModel` skips any cell whose character and colours are unchanged. On a
screen nobody has typed into, that is *every* cell. So the pane keeps drawing
the old font from coordinates computed against the old atlas.

`term.refresh()` does not fix it, which is why it was there and did not work: a
refresh marks rows dirty, and dirty rows still hit that unchanged-cell
`continue`. The fix is `WebglAddon.clearTextureAtlas()`, which clears the atlas
*and* the model, so every cell is rasterised again. It is why the addon is kept
in a ref (`webglRef`) rather than only as a local in the mount effect — the
font effect has to reach it.

Two things follow that are easy to get wrong:

- **A font *size* change needs none of this.** It moves the cell metrics, so
  the renderer resizes and clears the model itself. That asymmetry is why zoom
  always worked and the family picker never did, and why a bug report here will
  say "the size works, the font doesn't".
- **The DOM renderer has no atlas.** With no WebGL context there is no addon,
  and a plain repaint is both necessary and enough — so the font effect falls
  back to `refresh()` when `webglRef` is empty rather than assuming an addon.

A reload always looked correct, because a fresh `Terminal` is constructed with
the right family and rasterises from scratch. "It works after a reload" is the
signature of this bug, not evidence against it.

### Row height matches a native terminal

`TERMINAL_LINE_HEIGHT` is **1**, and that is not "no leading": xterm multiplies
the font's *measured* line box — ascent + descent + leading, about 1.2x the
point size for a monospace face — not the point size. So 1 is the row height a
native terminal gives you, and the same thing iTerm calls Vertical Spacing 1.0.

It was 1.2, which stacked that leading on top of the font's own: every row came
out about a fifth taller than the same font in a real terminal beside it, which
costs rows in a pane and reads looser than the thing sheepit is standing in for.

It lives in `theme.ts` because five places need to agree on it. Four are the
wheel-scroll distance calculations (`TerminalCell`, `TerminalPane`,
`MobileKeybar`), which read `term.options.lineHeight` and fall back to the
constant when there is no terminal yet — a fallback that disagreed with the
constructor would compute a row height no pane has. The fifth is the font
preview in Appearance, which is CSS and therefore takes **`line-height:
normal`**, not `1`: CSS multiplies the font size, xterm multiplies the line
box, and `normal` is the line box. Using `1` there would draw a preview tighter
than any pane.

Only a new `Terminal` picks this up — it is a constructor option, so a running
pane keeps the height it opened with until a reload.

## The native view — Claude Code, drawn by sheepit

A pane running Claude Code carries one more button on its bar: it swaps the
xterm TUI for a conversation sheepit draws itself. **It is the session already
running in that pane** — not a copy, not a fork, not a second process. Two
wires, and that is the whole design:

  **in**  — the text is typed into the pane's PTY, exactly as a keyboard would.
            `DirectBridge.sendInput`, the same path a keystroke travels.
  **out** — the agent's own transcript is tailed, and its rows are drawn.

Which is why there is no Claude Code feature it can be missing. Slash commands,
plan mode, `/compact`, skills, attachments, subagents, permission modes, MCP,
whatever ships next week — **none of them are known about here**, so none of
them can be left out. `src/claude-native.ts` is a file tailer and a PTY write.

### The approach that was built first, and deleted

The first cut drove a second `claude` over its stream-json stdio protocol
(`-p --input-format stream-json --output-format stream-json`), forking the
conversation into it with `--resume --fork-session`. It worked — real session,
hooks firing, token-by-token streaming, a measured 137k-token context carried
into the fork — and it was the wrong trade. A forked session is a *different*
session writing a *different* transcript, and every TUI-only affordance either
had to be rebuilt or given up. For a view whose whole promise is *this is your
real session*, buying streaming with fidelity is backwards.

**What the transcript costs instead is streaming within a message.** Measured
on a real turn, the rows land as they happen:

```
+18.9s  assistant ["thinking"]        ← written before the tool runs
+18.9s  assistant ["tool_use(Bash)"]
+26.3s  user ["tool_result"]          ← the moment it returns
+32.9s  assistant ["text"]            ← the answer
```

So the conversation is live to about the latency of a file write; it simply
arrives a message at a time rather than a token at a time. Liveness in between
comes from the pane's own busy flag — the hooks sheepit already reads — so the
view knows the agent is working before it knows what it will say. There is
deliberately **no second liveness mechanism**: a view that worked it out again
could disagree with the sheep on the card beside it.

### The questions the agent asks, which ARE in the transcript

`AskUserQuestion` and `ExitPlanMode` are ordinary tool calls, so the questions,
their headers, and every option's label and description are in the tool's
input — **read, never inferred from a screen**. They were landing in the
generic one-line tool block: a collapsed row called "AskUserQuestion" whose
body was raw JSON, which is exactly backwards for the one tool call addressed
to the person reading. `ChoiceBlock` draws them as questions, with the answer
underneath once it has been given, and goes neutral once answered so it stops
competing with whatever the agent is doing now.

**It deliberately cannot be answered from here.** Picking an option in the TUI
means arrow keys and Enter against a list this view cannot see, and a wrong
guess answers a real question wrongly in somebody's session. So it shows the
question in full and hands over. Answering in place needs the agent to expose
the choice as something better than keystrokes.

### The `/` menu is an accelerator, not a gate

Typing `/` in the composer opens a completion menu (`src/slash-commands.ts`,
`useSlashCommands`). Everything it offers still goes through the TUI as typed,
and the agent is what answers for a command that does not exist — exactly as it
would at the keyboard. **That is what makes an incomplete list acceptable**,
and it is the only reason this can exist at all.

Everything the user added is read off disk and is therefore complete and
verifiable: skills and commands from `~/.claude` and from the pane's own
`<cwd>/.claude`, and from every plugin under `~/.claude/plugins/cache`. That is
the half worth having — nobody forgets `/clear`, everybody forgets what they
called the skill they wrote in March. A plugin's skills are addressed
`plugin:skill`, which is why those are the ones prefixed.

**The built-ins are a static list, and that is a deliberate retreat.** Claude
Code ships as a 233MB compiled binary with no machine-readable command list.
Scraping its strings was tried: 355 candidates, mostly filesystem paths and
minified identifiers (`/usr`, `/tmp`, `/jsx-dev-runtime`, `/zfn5`). A clever
source that is wrong a third of the time is worse than a short list that is
honest about being short — and the footer of the menu says so in one line.

Two details: a skill's description is often a **YAML block scalar**
(`description: >` with the text indented below), and reading the line as
written gave every plugin skill a description of `>`. And the menu opens only
while `/` is the *first* character and the draft holds no space — a slash in
the middle of a sentence is a path or a date, and a menu over `src/components`
would be in the way of nearly every message this view sends.

### What it cannot show, and how much it can honestly say

A dialog the TUI *draws* is **not in the transcript**, because it is not part
of the conversation: a permission prompt, a first-run trust prompt, a
`/resume` picker. This view cannot invent them and does not guess.

It can sometimes notice. A permission prompt makes the pane bleat, which
sheepit already knows from the agent's hooks, so the view says the pane is
waiting on something only the terminal can show.

**But not every dialog raises anything at all**, and that is worth knowing
before trusting the card. Checked against a real first-run trust prompt
("Is this a project you created or one you trust?"): it fires no hook and
writes no transcript row, so the pane neither bleats nor says anything — the
native view simply shows an empty conversation. The empty state names that
possibility rather than leaving it a mystery, and the terminal toggle is on the
bar at all times, so the view is never a dead end. Do not build a heuristic
that claims to detect these; the honest answer is the one that is always true.

### Details that are easy to get wrong

- **Typing is bracketed paste, then Enter as its own write.** Without the
  brackets the first newline of a multi-line message submits a half-written
  prompt and the rest lands as a second one. Enter must be outside them, or it
  is just a character in the pasted text.
- **Interrupt is Escape** — a real interrupt, the same key you would press. The
  session, its context and its transcript all survive, which is the thing the
  forked version could not do (there it was a kill).
- **The transcript can be replaced under you.** A `/clear`, or a resumed
  session, starts a new file, so the path is re-asked every poll rather than
  captured, and a change emits `reset` — the client throws its conversation
  away and takes the new one. This fires in practice, not in theory: it was
  seen the first time the view typed into a pane whose registered path had gone
  stale.
- **The transcript is not only the conversation.** It carries `attachment`,
  `queue-operation`, `last-prompt`, `atis-latch`, `cost-state` and `system`
  rows, and a sidechain (subagent) conversation interleaved with the main one.
  Only non-sidechain `user` and `assistant` rows are messages — the same filter
  ⌘K's search already applies. Claude Code also puts its own notices through as
  `user` rows wrapped in `<...>` tags; drawn as a user bubble they read as the
  person shouting machine output at the agent, so they are dropped.
- **A row is routinely caught half-written**, since the agent appends as it
  goes. The reader keeps the trailing partial line for the next read rather
  than parsing it.
- **What you just sent is echoed before the agent has written it down.** The
  conversation is the transcript, and the transcript only gets your message
  once the TUI has taken it and the agent has flushed the row — measured at
  about three seconds. For three seconds the composer emptied and *nothing
  happened*, which reads as a dropped message, so people send it again. The
  echo is dropped the moment the real row arrives, matched on the text, since
  the id is Claude Code's and is not known until then: it is a placeholder for
  a row we know is coming, never a second copy of it.
- **Nothing in the message list may shrink, and forgetting it hid every tool
  call.** The list is a column flexbox, so its children take `flex-shrink: 1`
  by default and are squashed below their content once it overflows — which it
  always does. Text blocks resist, because text cannot be compressed; a tool
  block has `overflow: hidden` and collapsed to **2px**, its own two borders
  and nothing else. Every tool call in a conversation was on screen as a
  hairline, which reads as a horizontal rule, which reads as *the tools are not
  rendered at all* — and that is exactly how it was reported. `.nat-list > *`
  takes `flex-shrink: 0`.
- **A tool call is a ruled line, not a card.** It was a filled bordered box per
  call, and a turn is mostly tool calls, so a conversation came out as a stack
  of boxes with the prose lost between them. What the row has to answer is
  "what did it just do", which is one line; a left rail in the brand green
  marks the column of machine actions so they read as a margin beside the
  prose rather than as items in it.
- **One scale for the view, and a phone reads a size UP.** `--nat-size` on
  `.nat-pane` is the single number everything else is `em` or `calc()` off, so
  "make it bigger" is one edit rather than a hunt through twenty rules. 14.5px,
  and **16px below 768px** — a phone is held at arm's length and has no pointer
  to hover for detail. 16px on the composer is also what stops a mobile browser
  zooming the whole viewport when the field takes focus; below that, iOS and
  some Android keyboards scale the page and it has to be pinched back.
  It was a flat 13px, which came out of a condensing pass that shrank the
  *size* along with the vertical rhythm — only the rhythm needed it.
- **Markdown must not inherit `white-space: pre-wrap`.** `.nat-text` sets it,
  which is right for plain text and wrong for rendered Markdown: the HTML
  react-markdown emits carries a newline between every `<li>` and every `<p>`,
  and pre-wrap turns each one into a real line box. Measured: **25px between
  list items whose margin is 1.45px**. Every gap in every answer was a blank
  line too tall, which reads as the whole view being loose when it is one
  inherited property leaking across. `white-space: normal` on the Markdown
  variant; 25px became 1px.
- **The measure is the typography fix.** A pane is routinely 800–900px wide,
  and 13px prose across it is about 120 characters a line — roughly double what
  the eye tracks comfortably, which is why a long answer read as work even
  though nothing was wrong with it. `.nat-text` caps at **74ch**, which never
  narrows a pane already narrower than that. A code block is exempt: it is not
  prose, and wrapping it costs more than the width does.
  `.md-preview` otherwise stays the GitHub view's style — 14px on 1.7 with
  0.6em paragraph margins is right for a page of someone else's Markdown and
  loose for a conversation, so the overrides are all one idea: tighter vertical
  rhythm. The one that matters most is `li > p { margin: 0 }` — a list with
  blank lines between its items is "loose" per the Markdown spec and each item
  gets wrapped in a paragraph, so every bullet was paying a paragraph's margin.
  The agent writes those constantly.
- **A 200 is not an answer; the content type is.** The install banner asks
  `HEAD /download/sheepit.apk` to find out whether there is an app to offer —
  and a single-page app answers 200 to *every* unknown path with its own
  index.html, which is what the dev server does and what any static host would.
  So `r.ok` was true on exactly the machines with no APK to download. The check
  is `content-type: application/vnd.android.package-archive`. The dev server
  also has to proxy `/download`, or the same fallback hands the UI an HTML file
  named `.apk`.
- **The agent writes Markdown, so the view renders Markdown.** Showing the
  source shows the wrong thing — `**Quality**` as literal asterisks, a table as
  pipes. `react-markdown` + `remark-gfm` and the `.md-preview` style are
  already in the bundle for the GitHub view, so this is the same two lines
  rather than a second renderer with its own opinions. The *user's* own message
  stays plain text: it is what they typed, not something to re-interpret.
- **`/clear` has to forget the pane's agent ref**, and did not. The endpoint
  marked the pane fresh and cleared its turns but left `agentSessions`
  pointing at the transcript the clear had just ended, so
  `resolveAgentTranscript` kept returning it until the next `UserPromptSubmit`
  happened to repoint it. That is not only this view's problem: the pen card's
  context count, ⌘K and the Agent tab all went on describing a conversation
  that had been thrown away. `clearAgentSession` drops it, and absent is the
  honest answer every one of those readers already copes with — no count
  rather than a stale one. The hook that reports a clear carries a fixed body
  (see post.sh) and so cannot hand over a new path; there is none to hand over.
- **The project directory slug is the *resolved* path.** A session in
  `/tmp/x` files under `-private-tmp-x` on macOS. Reconstructing the slug from
  cwd silently finds nothing — the same trap [the Pi transcript
  lookup](#four-agents-and-what-each-one-can-be-asked) documents, which is why
  the path comes from `resolveAgentTranscript` rather than being rebuilt.

### What switching costs, which is nothing

**The terminal stays mounted**, hidden rather than unmounted — the same trade
every pane in a pen already makes. Tearing down the xterm would discard the
scrollback and make switching back a rebuild from the daemon's ring. Both
directions are one click, and the PTY never knew.

**The reader is dropped when nobody is watching**, and nothing is lost by that:
the conversation is the transcript, not the object, so reopening re-reads it.
That is the one real simplification over owning a process.

**The mode is one setting for the whole app, and it is device-local.** "Do I
read panes as a terminal or as a conversation" is a way of looking, like a zoom
level, so having chosen it every pane you move to keeps it — a toggle that had
to be flipped again on arrival is a toggle nobody uses. Panes mounted in the
same window follow each other through `subscribePaneMode`, so the app is in one
mode rather than in as many modes as it has mounted panes.

It is **not** in the profile. That profile is shared by every browser looking at
this machine (see [One key per
pen](#one-key-per-pen-and-the-profile-talks-back)), and the right answer here
genuinely differs between a phone — where a TUI in 390px is a hard read — and a
laptop. `sheepit:pane-mode` therefore lives in localStorage and is listed in
`DEVICE_LOCAL` in preferences.ts, which is what keeps the profile's own
migration from sweeping it up. A tile is never offered the view, so it is never
in it however the preference is set.

**On a phone the key bar is hidden in this mode.** It types Esc, Tab and the
arrows into the PTY, which is what a terminal wants and the opposite of what
this view does — there, Esc *interrupts the agent*. The composer has the keys
it needs.

**Only Claude Code.** The button is drawn only on a pane running it: the
transcript shape and the TUI's input handling are its, and Codex and Pi are not
guessed at.

## Nothing reads the terminal as text

Two things used to be derived by reading the output as prose. Both are gone,
and the rule now is: **the terminal is bytes to render, not a source of
facts.** What an agent is doing, what it was asked, and what it touched all
arrive through its hooks; everything else the server needs it asks the OS or
git for.

What is left on the byte stream is *protocol*, and that stays: OSC 7 (the
shell reporting its cwd), OSC 9 / 777 / 99 (the app raising a notification →
unread, or bleating when nothing is reporting hooks for that pane — see
[`Notification` is two different events](#notification-is-two-different-events-wearing-one-name)),
OSC 9;4 progress, and the DEC private modes that have to survive a reconnect. Those are applications reporting in a defined format, which is a
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
it read.

**There is no "PR of this branch" lookup any more.** `/api/git/:id/github` used
to run `gh pr view` with no number for every pane every 30s, to paint the
branch's PR with its state and checks. Measured: ~45 calls a minute, a third
of them failing on branches with no PR, all competing with the GitHub view for
the same `gh`. The PR a pane is about is the one its agent reported, so the
route now answers only the repository (from `repoSlug`) and the chip shows the
reference without state.

### Searching the flock

`⌘K` asks one question — *which sheep is working on this?* — and `src/search.ts`
answers it in two halves.

The **facts** come from memory and cost nothing: the pane's name, cwd, branch,
the PR references its hooks reported, and its last few exchanges. This is what
makes the motivating case work. A pane called "check PR 1251 CI", sitting on a
branch named `retain-extraction-mode-docs`, is the pane working on PR 3993 —
nothing in its name or its branch says so, and `prRefs` does.

The **transcripts** come from ripgrep over the agents' own JSONL: Claude's
`~/.claude/projects/<slug>/<uuid>.jsonl`, Codex's
`~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` and Pi's
`~/.pi/agent/sessions/<slug of cwd>/<ts>_<id>.jsonl`. One run over every pane's
file rather than one per pane — measured at 30–90 ms for 102 MB across 24 panes,
which is what makes searching on every keystroke reasonable.

Rules that are easy to get wrong:

- **The terminal is still not read.** Scrollback is bytes to render; this reads
  what the agents recorded. Adding the ring buffer here would undo the section
  above.
- **Only conversation counts.** `transcriptLineText` keeps `user` and
  `assistant` rows and drops everything else — Claude's `attachment`, `system`
  and tool-result rows, Codex's `developer` rows carrying the skills preamble.
  Pi needs no filtering beyond the role: it files a tool result under a role of
  its own (`toolResult`) and injects AGENTS.md and its rules into the `system`
  row, so there is no envelope wearing a user's clothes.
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

**Typing marks a pane read, selecting does not.** Unread and bleating are
cleared by `clearUnseen`, called from `sendInput` in `TerminalCell` for real
keystrokes only — escape sequences (focus and mouse reports, CPR, arrows) are
not typing. Selecting a pen used to clear every pane in it, including the ones
you never looked at.

## What a pane can show

Six states. The pane bar has **no view switch** — only one button that shows
or hides the **tools**, and every tool is a tab on one rail beside the
terminal (`ToolRail`, `TOOL_TABS`):

| state | shows | reached from |
|---|---|---|
| `terminal` | the terminal, alone — tools hidden | the pane bar's toggle |
| `split-github` | terminal **+ pull requests and issues** | the rail, first |
| `working` | terminal **+ the working tree** | the rail |
| `log` | terminal **+ the commit log** | the rail |
| `split` | terminal **+ files** | the rail |
| `split-preview` | terminal **+ the browser** | the rail |
| `split-terminals` | terminal **+ shells in this pane's directory** | the rail, last |

The toggle brings back whichever tool was showing when the tools were hidden
(`lastToolRef`). There used to be a three-way switch — terminal, browser, git —
which made the browser a different half-pane from the files beside it; on the
rail it is one more click at the same shape, like the rest.

**Nothing is ever shown alone, and the terminal is never hidden.** Reading a
file, watching a dev server, reading a pull request, going over what you have
changed — every one of them is something you do *while* working in the
terminal, and a pane that gave its whole width to one of them had hidden the
thing the pane is for.

Git used to be the exception and take the whole pane, on the reasoning that a
diff is wide and reading one is its own activity. It isn't: a diff is what you
read *against* the code you are running, and the terminal beside it is where
you run it. So the git group is four ordinary splits, and `PaneView` has no
full-pane state left at all.

That is also why **`showsTerminal()` is gone**. It was the single predicate for
"xterm has a size right now" — worth having while some views hid the terminal,
because three separate `view !== 'terminal' && view !== 'split'` tests drifting
apart is exactly how a terminal ends up unfitted with its last row clipped. Now
that no view hides it, the predicate could only answer `true`, and a test that
cannot fail is one every reader has to go and verify before trusting a branch
on it. `isSplit` (`view !== 'terminal'`) is the only question left.

So there is no `files` or `preview` in `PaneView` either. A pane persisted in
one of those opens in the split it means — see `readPaneView`, which is also
where the `diff` → `working` and `github` → `split-github` migrations live.

Every split shares one divider and one stored width, because it is one
question: how much of the pane is not the terminal.

The tools are a **vertical rail** (`ToolRail`), not a strip
across the top, and GitHub leads it. Four labelled buttons across the top of a
half-pane column is most of that column; a 28px rail down its edge costs the
diff nothing. All four views carry the same rail, so moving between a pull
request, what you have changed, what you have committed and the files
themselves is one click and never changes the pane's shape.

**The file browser is the fourth of them, and it is last.** It used to be its
own button on the pane bar's switch, which made "open the file this diff
changed" a different half-pane arriving in place of the one you were reading —
`GitDiffPane`'s own *open in Files* handle did exactly that. It answers the
same question the other three do, *what is in this repository*, so it belongs
on the same rail; it is last because it is the only one of the four that is not
about a change. The state is still called `split` — the oldest of the group and
the value already persisted in `sheepit:pane-views` — which is a legacy name to
document, not to rename.

### The file viewer pays for a grammar at a time

`FileView` is lazy-loaded, and for a while that lazy chunk was **1.76 MB**.
The Files pane auto-opens a file when it mounts, so that whole chunk stood
between pressing *Files* and seeing anything — which is what "the file browser
is slow" was. The server was never in it: `readdir` plus a `stat` per entry
answers a 353-entry directory in 5 ms.

It was two highlighters and an editor, all eager:

- **react-syntax-highlighter's barrel entry bundles refractor's ~290 language
  grammars** — 632 KB measured, to colour one file in one language. The
  `prism-async-light` build loads refractor's core and then the single grammar
  the open file needs. There is no registration to keep in step; the package
  ships a loader per language. Its cost is visible in `dist/`: ~290 tiny
  chunks, one per grammar, and none of them fetched until a file wants one.
- **CodeMirror and its 17 language modes are 1.1 MB**, and nothing needs them
  until you press Edit. They live in `CodeEditor.tsx` behind a `lazy()`.

What is left is 94 KB. Two rules follow:

- **The extension→language map lives in `ui/src/lang.ts`**, not in `FileView`.
  Both halves read it, and a lazy editor importing it from the viewer would
  pull the viewer back in behind it.
- **Import the deep ESM path, not the barrel.** A later `import … from
  'react-syntax-highlighter'` anywhere puts all 290 grammars back in whatever
  chunk it lands in, silently. `vite-env.d.ts` declares the deep path, which
  the package itself does not type.

### A `.csv` is read as a table

`CsvTable` draws .csv/.tsv in the View slot — sortable header, a filter, a row
count — and the raw text is still one click away under Edit. The parser is
twenty lines in `ui/src/csv.ts` rather than a dependency: quotes, `""` escapes,
newlines inside a field and CRLF is the whole of RFC 4180 that matters here.
The delimiter is guessed from the header line rather than the extension, since
a tab-delimited `.csv` is a common export. Sorting is numeric when both cells
parse as numbers, and blanks sink to the end in both directions so a sparse
column still shows its values first. It renders at most 2000 rows — a ceiling
marked in the code, not a windowing library.

### The GitHub view asks `gh`, and `gh` has two traps

Everything in the GitHub view is one `gh` call the server made — no token, no
OAuth app, no GitHub client of our own. Two things about that are easy to get
wrong, and both shipped broken once.

**Linked references are the one call that is GraphQL**, and not by preference:
`gh pr view --json` has no `closingIssuesReferences` and `gh issue view --json`
has no linked-pull-request field at all. That is checked against the binary —
gh 2.57.0 prints both `--json` field lists in full when handed an unknown
field, and neither name is in them — so no amount of adding to `PR_FIELDS`
answers this. `gh api graphql` does, through the same signed-in `gh`, and one
query serves both directions: `issueOrPullRequest` resolves the number and
inline fragments pick the side, so it never waits to learn which kind answered
and starts alongside the view and the diff. `includeClosedPrs: true` is
load-bearing — the pull request that closed an issue is usually merged, and
without it the commonest case comes back empty.

**The kind in `/gh/:kind/:num` is a hint, not an answer.** Pull requests and
issues share one numbering sequence, so a bare `#448` typed into the search
says nothing about which it is, and neither does a `/issues/N` link — GitHub
redirects those to a PR happily. The server resolves it instead of trusting the
caller, and the order is load-bearing:

- **`gh pr view N` is the probe.** It succeeds *only* for a pull request; on an
  issue it fails outright with `Could not resolve to a PullRequest with the
  number of N`. That failure is the signal.
- **`gh issue view N` is the fallback**, because it answers for **both**. That
  is also why it must never go first: asking it first labels every pull request
  an issue and silently drops its diff.

The reply carries the kind that actually answered, so the pane draws the right
mark and does not wait for a diff an issue will never have. Guessing from the
filter instead is what made typing an issue id report "could not load".

**`null` is not `[]`.** A failed `gh` and an empty repository were the same
empty array in the list route, so a rate-limited or logged-out refresh rendered
as a confident **"None."** — and the 30s cache then held that lie on screen. A
half that could not be fetched is `null` and says so with a Retry; `[]` means
the repository genuinely has none. For the same reason **a failure is never
cached**, or the refresh button returns the failure it was pressed to clear,
which reads as the button being broken.

Failures carry the reason (`{ error }`, the first line of `gh`'s stderr) rather
than a bare null. "Could not resolve to a PullRequest", `gh: command not found`
and an expired token are three different problems with three different fixes,
and a pane that says only "could not load" sends you off to guess which one you
have — the same argument as [the hook trace](#the-hook-trace): read it for the
gaps.

### Never ask a *list* for `statusCheckRollup`

It is the check runs of every row, and `gh` fetches them all. Measured on one
repository: **0.73s and 9.7KB without it, 10.1s and 633KB with it** — for one
word per row, which the list draws as a single dot.

On **closed** pull requests it does not merely cost that, it fails outright:
`gh` exits 1 with `unexpected end of JSON input`. That is worse than slow,
because a failed half comes back `null`, `isGoodGh` rightly refuses to cache a
failure, and every later look pays the eleven seconds again. **A list that is
never cacheable is a list that always loads**, which is exactly how it was
reported: "it takes seconds, they should all be cached by now."

The detail view still shows CI, and should — `gh pr view` asks about one pull
request, where the rollup is affordable and is the point of the panel. The rule
is about breadth, not the field: cheap per item, ruinous per list.

### One cache per repository, not per worktree

Everything else in `api.ts` coalesces on the **working directory**, because
that is what `git status` and friends answer for. The PR/issue routes are the
exception: they key on **`owner/repo`** (`repoSlug()`), because nothing they
ask for is branch-scoped — `gh pr list`, `gh pr view N` and `gh pr diff N` all
answer for the repository, whichever checkout you happen to ask from.

Keying those by directory is a real cost, not a tidiness point. Eight worktrees
of one project — `memlake`, `memlake1` … `memlake7` — are eight directories and
one GitHub repo, so every one of them fetched, rate-limited and held its own
copy of the identical pull request list. Measured after the change: the first
worktree pays 0.84s for a list and 1.87s for an issue, and the next two pay
0.02s and 0.001s.

### Nobody waits for GitHub

Measured: a list costs 0.7–1.5s and one pull request 0.9–1.5s (the view with
its checks and comments is the long pole), and GitHub itself takes 350ms+ even
for a rate-limit ping — so a faster client (native HTTP instead of `gh`, tried:
70–220ms saved per call) cannot make it instant. Only never asking while
somebody waits can. Three pieces; the data lives on the server, keyed on the
repository, so every worktree shares them:

- **Watched lists refresh themselves.** A list somebody asked for in the last
  5 minutes (`watchedLists`, `WATCH_MS`) is refetched every `GH_FRESH_MS` (30s)
  by a timer, not by the next reader. An open view re-asks every 30s, so
  "watched" means "somebody is looking at it".
- **Every row of a list is loaded behind it** (`warmItems`), four at a time —
  but only rows never loaded, rows whose `updatedAt` moved, and pull requests
  whose checks are `PENDING` (CI finishing does not move `updatedAt`). That is
  what keeps "every PR fresh within 30s" from being 60 items × 3 calls every
  30s. A row's kind is a fact, so warming an issue skips probing it as a pull
  request first (`fetchItem`'s `known`).
- **The GitHub view re-asks every 30s** while on screen, which is a cache read
  on the server.

Measured after: a pull request or issue never opened before answers in
**9–21ms**. Every `gh` call and every answer is logged with `[gh]` —
`hit`/`stale`/`join`/`miss` and how long the reader waited, `bg` for work
done behind them.

The cache is in memory, so a server restart (every code change, in dev) starts
it cold: the first list after one waits for GitHub.

`repoSlug()` falls back to the directory when there is no GitHub remote, or
every such directory would collide under a single empty key. Its own 5-minute
TTL is long on purpose: it reads a git config value that changes approximately
never.

The **client** cache in `GithubPane.tsx` is keyed on the repository too, not on
the session. It cannot be at first sight — a pane does not know its repository
until something tells it — so **every answer carries `repo`**, and `repoOf`
remembers it per session for every later lookup. An explicit `?repo=` wins over
that memo, so a link to somebody else's pull request is shared from the first
look rather than after the first answer.

That leaves exactly one fetch per session, the one that learns the slug, and
the server answers it from its own repo-keyed cache in about a millisecond.
Everything after it — other panes in other worktrees, switching between pens,
coming back to a PR you read ten seconds ago — is served from memory without
touching the network.

### Only ports that answer

`/fs/:sessionId/ports` lists what is listening — the pane's own descendants
first, then the rest of the machine — and then **probes each one and keeps only
what speaks HTTP**. A machine has dozens of listeners and almost none are web
servers: on this one it is 58 down to 6, the rest being sccache, adb, kubectl
port-forwards and a database. Offering those as chips is offering blanks.

Any HTTP status counts, 401 and 404 included: the question is whether something
speaks HTTP, not whether it likes being asked. The probes run in parallel with a
500ms bound — a port that accepts a connection and never answers is exactly what
that bounds — and the answers are cached for 15s, because the panel re-asks
every time it opens and a port does not change what it is between two clicks.

It does mean sending a GET to ports nobody asked about, which is the price of
filtering them at all; a non-HTTP service reads it as junk and closes. Sheepit's
own port is dropped from the list rather than probed: a chip for it would open
sheepit inside sheepit.

### The browser half

It shows what the work produces — a dev server, a pull request, an `.html` file
from the tree — and **it is the real browser on this machine**: a Chromium
driven over CDP, streamed into the pane as frames, with your clicks and keys
sent back. See [The live browser](#the-live-browser).

**A URL clicked in the terminal opens here**, not in the system browser
(`handleWebLink` in `TerminalCell.tsx`, wired into both `WebLinksAddon` and the
OSC 8 `linkHandler` so a bare URL and a Claude Code hyperlink behave the same).
The agent starts a dev server or prints the PR it just opened, and looking at
it should not mean leaving the app for a window that knows nothing about which
pane sent you there. Two things still go outside: a **modifier click**
(⌘/Ctrl/Shift), and anything that is **not http(s)** — `mailto:`, `vscode:`.
The bar's "open in your own browser" button is the third way out, after you
have looked. `navSeq` counts openings rather than URLs, so clicking the same
link again after wandering off inside the page takes you back to it — a prop
that has not changed says nothing.

**Chromium is assumed present.** Chrome, Brave, Edge or Chromium, or
`SHEEPIT_BROWSER` pointing at one; where there is none, the pane says so
instead of degrading. Two earlier routes are gone, and the reasons are worth
keeping because they are the argument for owning a browser at all:

- **direct** put the URL straight into an iframe. Native rendering and no cost
  — but not a browser: no session of yours, forms that went nowhere, nothing at
  all on a site that refuses to be framed, and `localhost:3000` resolving to
  the phone you were holding.
- **via sheepit** was a one-document proxy (`/api/preview`) that stripped the
  headers refusing the frame. It showed a page and could not log in, submit, or
  run an app. It also made sheepit an **open web proxy** for anything that
  could reach it — a surface that is now gone outright rather than bounded, and
  `src/preview.ts` with it.

Having more than one answer to "show me this page" also cost a probe
(`/api/preview/probe`) on every open, and could still land on the crippled one.

**The page is in sheepit's own URL** — `/b:<percent-encoded page>`, last in the
fragment because a URL contains every character the other segments use as
punctuation. That is what makes the *window's* Back and Forward, and the mouse
buttons that mean them, walk the pages you looked at in a pane: every
navigation the page makes pushes a hash entry, and a popstate asks the pane to
go back. Only the **active pane's** page is carried — several panes can hold a
browser, and a URL naming all of them is one nobody can read or share — and
`browserUrls` in the store holds only panes that are currently showing one, so
the URL never claims a page nobody is looking at. The request travels with a
**sequence number** (`requestBrowserUrl`): stepping back to a page you are
already on still has to navigate, because you left it by following a link and
Back means undo that. A link someone sends carries the page too.

**Each pane remembers its last page** in `sheepit:pane-url:<sessionId>` — its
own key, not a shared map, because the profile is shared by every browser
looking at this machine and a blob is last-writer-wins (see [One key per
pen](#one-key-per-pen-and-the-profile-talks-back)). It is read synchronously at
mount, so reloading sheepit puts the pane back on the page it was showing.

**Loading is the page's answer, not ours** —
`Page.frameStartedLoading` / `frameStoppedLoading` on the *main* frame, since an
embed finishing says nothing about the thing you asked for. It has to be shown,
because a streamed page keeps showing the *old* page until the new one paints:
without the bar, a slow load and a click that did nothing look identical.

**A screenshot's product is its path.** The camera in the bar asks the page
for a PNG (`Page.captureScreenshot`, not the streamed frame — that is a JPEG
scaled to the pane and quantised for the wire), keeps it in
`~/.config/sheepit/screenshots`, and puts the **path** on the clipboard. The
reason to screenshot a pane is almost always to show it to the agent in the
terminal beside it, and what an agent wants is a file to read: an image on the
clipboard has to be pasted into something that accepts images, which a terminal
does not. It does not go to the pane's cwd, where a *pasted* image goes — a
pasted image is something you brought to the work, while these are made by the
dozen while reading a page and would litter a repository with untracked PNGs.
The clipboard write falls back to `execCommand` because `navigator.clipboard`
is secure-context only and sheepit is routinely reached over plain http on a
LAN.

**Sheepit's own files.** `/api/fs/raw?as=html` still renders a local `.html`,
and the pane points the browser at `http://127.0.0.1:<serverPort>/api/fs/raw…`
— absolute, on loopback, because the browser runs on this machine and a
relative path would be the viewing device's. `/api/browser/status` carries that
port along with whether a browser was found. Port chips are loopback for the
same reason, which is why they work from a phone.

## The Android app

A Capacitor shell (`ui/android`) around the same UI, talking to a sheepit
server over the LAN. `ui/capacitor.config.ts` explains the two settings that
make that work at all — an `http` WebView origin, and `CapacitorHttp` so the
server needs no CORS headers.

**The app offers its own update.** `GET /download/version` answers
`{available, version}`, and the banner compares that against the APK's own
`versionName` from `App.getInfo()`. **The comparison is on the commit, not the
release number** — `1.15.0+<sha>` — because twenty APKs come out of 1.15.0 in a
day and a release number cannot say whether the app in your hand is the code on
the machine. That is what the sha in the version is for.

Three rules keep it from becoming wallpaper: it is drawn only on Android, only
when an APK exists (`available: false`, not a 404 — the app asks on every
launch and a plain "no" needs no interpreting), and only when the versions
actually differ. Dismissal is remembered **per version**, so dismissing
"update to X" does not hide "update to Y" three commits later; that would make
it silent exactly when it mattered.

**An upgrade keeps your settings, and that is checked rather than assumed.**
Android installs the new APK over the old one and the WebView's localStorage
survives, so the server address, the password and the view mode are all still
there — measured on the emulator by reading them before and after an in-place
install. The banner says so, because "will I have to set it up again" is the
question that stops people updating.

**Getting it onto a phone is a URL**: `/download` is a page served by sheepit
itself, offering the APK this checkout last built (`src/download.ts`). The
phone is already able to reach this server — that is the whole point of the app
— so it is the right place to hand the file over, and the build it serves is
necessarily the build that matches the server it will be paired with. Nothing
is published anywhere for that to work.

It serves straight out of Gradle's output rather than copying the APK somewhere
tidier, because a copy goes stale silently: the page would keep offering a
two-week-old build with no way to tell. Reading the build output means the page
is either current or honestly empty, and when it is empty it says which command
fills it. The filename carries the version so a phone cannot hand back a cached
older build under the same name, and the response is
`application/vnd.android.package-archive` — Android only offers to install a
file it has been told is a package.

**Upgrading is one command**: `npm run android` builds the UI, syncs it in,
assembles a signed release and installs it over adb on whatever is attached
(`--build` to stop at the APK, which is all `/download` needs; `--debug` for an
unsigned one). It exists
because every one of those steps was a thing to remember, and the forgotten one
was always the version: the APK sat at **1.5.3, shipping an August build of the
UI, while sheepit was on 1.15.0**.

So **the version is not typed anywhere** — `app/build.gradle` reads
`package.json` and packs the semver into `versionCode` as
`major*10000 + minor*100 + patch`. A hand-bumped `versionCode` is worse than a
stale one, because Android *enforces* it: an APK whose code has not gone up is
refused as a downgrade, which reads as a broken phone rather than a forgotten
edit.

**A release build that cannot sign now fails** instead of handing you an
unsigned APK that installs nowhere. `keystore.properties` is gitignored and
pointed at `~/.sheepit/android-release.jks` — it still said `~/.vipershell/`
long after the rebrand, and the "leave it unsigned" tolerance (which exists so
a fresh clone can still `assembleDebug`) turned that into silence. **Back that
keystore up**: Android refuses an update signed with a different key, so losing
it means uninstall/reinstall on every device.

### Reaching it from outside the LAN

**Two things broke the Android app here, and both answered 200.** They cost
several wrong diagnoses between them, so they are worth knowing before
debugging anything that reports `Unexpected token '<', "<!DOCTYPE "`:

1. **ngrok's free-tier browser interstitial.** A request whose User-Agent looks
   like a browser gets ngrok's own HTML warning page — **200, `text/html`** —
   instead of being proxied. The app is a WebView, so every API call it made
   was answered with that page. `curl` never sees it, which is why every test
   from the command line passed while the phone failed. Any value for the
   `ngrok-skip-browser-warning` header suppresses it, and it is harmless to
   servers that have never heard of it. The WebSocket is unaffected — the
   interstitial is for HTML-ish GETs — which is checkable and was checked.
2. **The fetch interceptor matched only one of the two spellings.** Some code
   fetches a bare `/api/...` and relies on the interceptor to prefix it; some
   calls `apiUrl()` first and arrives already absolute. Matching only the bare
   paths left everything built by `apiUrl` — most of the startup path,
   preferences included — with no `Authorization` and no skip header. The app
   got past the connect screen, rendered nothing, and said so only in a console
   a release build does not show.

Which is why `android.webContentsDebuggingEnabled` is now on in
`capacitor.config.ts`. A release APK is otherwise a black box: a white screen
with the explanation sitting in a console nobody can read leaves guessing as
the only tool, and guessing is what the two wrong diagnoses were. With it,
`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` plus CDP
reads the console, and the answer took one run.


sheepit binds to the LAN and nothing in it authenticates — **anything that can
reach it has a shell on this machine as this user**, which is the trust
boundary the whole product has (see the security note under [The live
browser](#the-live-browser)). So the answer to "use it from anywhere" is a
tunnel that authenticates in front of it, not a change here.

**The authentication is sheepit's, not the tunnel's**, and that is not a
preference — a tunnel cannot do it. `config.password` (or `SHEEPIT_PASSWORD`)
turns on `src/auth.ts`; the tunnel is left open and simply forwards.

The reason is the Android app. **A WebView cannot authenticate a WebSocket.**
A browser can: it prompts, caches the credential for the origin, and sends
`Authorization` on the upgrade for you. The app cannot, because its UI is
served from a `localhost` origin and talks to a *different* one, so there is no
cached credential — and script has no API to set a header on a handshake.
Measured against a live tunnel with `basic_auth` on: the upgrade returns 401
without the header and connects with it, and the app has no way to add it. The
first cut of this was tunnel-level basic auth, and it locked the app out
completely; the symptom was the connect screen saying *Unexpected token '<'*,
which is ngrok's HTML 401 page being parsed as JSON.

So the password is checked in two channels, because that is what the two
transports allow:

| | how |
|---|---|
| HTTP | `Authorization: Basic <anything>:<password>` — the username is ignored, so a browser's own prompt works whatever is typed in it |
| WebSocket | `?k=<password>` on the URL — the only channel a handshake gives you |

**A request that arrived directly on loopback is exempt**, since whoever sent
it can already open a terminal here. "Directly" is load-bearing: a tunnelled
request *also* arrives from 127.0.0.1, so the test is loopback **and no
forwarding header**. Every proxy sets `x-forwarded-for`, and a direct
connection cannot forge one in a direction that weakens the check.

The 401 carries `WWW-Authenticate`, which is what makes a browser put up its
own prompt — that is how `/download` is reachable before there is an app.

The tunnel itself is a launchd agent
(`~/Library/LaunchAgents/dev.sheepit.ngrok.plist`, `KeepAlive`) running
`ngrok start sheepit`, with the tunnel defined in `~/Library/Application
Support/ngrok/ngrok.yml` rather than on a command line. It needs `HOME` and a
`PATH` in its environment: launchd gives a job neither, and ngrok reads its
config out of the user's Application Support directory.

The phone then takes the `https://….ngrok-free.app` URL as its server address,
and `/download` on that same URL hands over the APK. Two things make this work
without any change to sheepit: ngrok's basic auth covers the **WebSocket
upgrade** as well, because that is an HTTP request, and the app speaks https to
it without the mixed-content problem that `androidScheme: 'http'` exists to
avoid (see capacitor.config.ts).

**A tunnel without auth is a shell on the public internet.** `cloudflared
tunnel --url http://localhost:4445` is one command and gives a working URL, and
it is the wrong tool here for exactly that reason. If a tunnel that cannot
authenticate is ever the only option, sheepit needs auth of its own first —
HTTP Basic on every route *and* on the upgrade handler, since a WebSocket that
skips the check is the whole API.

### A phone is not a narrow desktop

Two things were costing most of the device, and both were the same mistake —
rendering what a phone does not show. Measured in the APK with the same
`/api/perf` feed everything else uses (on an emulator with a software GPU, so
read the ratios, not the milliseconds):

| | before | after |
|---|---|---|
| main thread blocked | 16,017 ms/min | **811** |
| fps | 9.4 | **27.6** |
| worst frame | 2503ms | 3620ms once at startup, then ≤440 |
| cold launch (`am start -W`) | 2178ms | **777ms** |

- **The sidebar is not mounted on a phone.** It carries `hidden md:flex`, so
  below 768px it was `display: none` and rendering the whole time behind it —
  8 pens, 41 pane cards, 41 sheep and the fence and grass canvases, every
  sweep. `commit:sidebar` was **78 ms/sec with a worst commit of 1180ms**,
  against 2.8 on the desktop: about 70% of all the React work on the device,
  for pixels never painted. The phone has its own copy anyway — the Pens sheet
  renders its own `SessionList`, and only while it is open. This is the third
  instance of the same bug in this file; see [Measuring the
  UI](#measuring-the-ui--one-place-always-on). **`display: none` stops the
  painting, never the rendering.**
- **A phone opens on the terminal, alone, and remembers no view.**
  `sheepit:pane-views` lives in the shared profile, so the phone was opening
  whichever split the desktop last had out — halving a 390px screen, and
  costing `commit:split:split-agent` **9.1 of `commit:pane`'s 10.3 ms/sec** for
  a tool nobody on that device had asked for. A narrow screen now neither reads
  that key nor writes it, exactly as a tile does not; the rail still works
  while you are there. A second storage key would buy a remembered tool across
  app launches, which is not what a phone is for.

`isNarrowScreen()` / `NARROW_QUERY` in `ui/src/platform.ts` are the one
definition of the breakpoint, matching Tailwind's `md:` so the CSS and the
mounting decisions can never disagree.

**What is left, and not done:** startup. The first 10-second window still
carries one ~3.6s frame, which is the bundle — `App-*.js` is 1.17 MB, and
dnd-kit is in it and then disabled on mobile (`dndEnabled = !isMobile`). A lazy
boundary around it is the next real lever; everything after that first window
is already at zero long tasks for stretches.

### The desktop app's browser

Inside the Electron shell (`npm run desktop:dev`, `electron/`) the browser half
is **not** the streamed headless Chrome: it is a native `WebContentsView` laid
over the pane's box (`NativeBrowserSurface`, driven through
`window.sheepitDesktop` from `electron/preload.cjs`). A page in a window you
are looking at gets foreground priority, real input, IME and clipboard — the
streamed one could not keep a heavy GitHub diff smooth, because Chrome and
macOS treat a headless renderer as background work.

- **The desktop app adds, it never forks.** `PreviewPane` picks the native
  surface when `desktopBrowser` exists and the streamed one otherwise; nothing
  else in the UI knows which it is in. The streamed browser stays — a phone or
  any tab on the LAN has no other way to show a page.
- **The UI owns placement, the shell obeys.** The surface reports its box
  every frame (a pane moves without resizing, which a ResizeObserver misses),
  and `null` when it has no box, so a hidden pen hides its view.
- **A native view is above the whole page**, so it cannot sit under ⌘K, a
  floating panel or a menu. The surface hit-tests a grid of points over its box
  and hides the view when anything else is on top. That is what lets no
  overlay know the view exists; do not replace it with per-overlay hiding.
- **A UI reload never unmounts React**, so `main.cjs` closes an owner's views
  when its page navigates or is destroyed — otherwise they float over the new
  page.
- **A focused page gets every key first**, so `main.cjs` takes back the ⌘
  chords that are sheepit's (`APP_SHORTCUTS`: ⌘K, ⌘N, ⌘↑, ⌘↓), refocuses the
  UI and the preload replays them on `window` for `App.tsx`. ⌘←/→ and ⌘+/−/0
  stay with the page on purpose — line start/end in a text field matters more
  there. A new global shortcut is not reachable from a page until it is added
  to that set.
- **The window has no title bar**, so it is dragged by `.sidebar-header` and
  `.workspace-bar`, and the traffic lights sit over the header. That CSS is
  injected by `preload.cjs` under `.desktop-app`, not written in `style.css`:
  a tab has a title bar, and must not grow 84px of padding for buttons it does
  not have. A control added to either bar needs no-drag, or it moves the window
  instead of taking the click — the preload covers buttons, inputs and links.
- Its profile is `persist:sheepit-browser`, separate from the headless one:
  logins are made once per browser.
- **A link that leaves goes to the OS, not to another window of this app.**
  `target="_blank"` is right in a tab — the browser showing sheepit *is* the
  user's browser — but inside the shell it opens another Electron window, which
  made "open in your own browser" the one button that could not do the single
  thing it says. `ui/src/openExternal.ts` asks the shell
  (`shell:open-external` → `shell.openExternal`) when it is there and falls
  back to `window.open` when it is not, so every caller writes one thing.
  **The backstop is the shell, not the callers**: the main window sets a
  `setWindowOpenHandler` that denies every `window.open` and hands the URL to
  the OS. Electron's default there is a bare `BrowserWindow`, and that default
  — not the buttons — is what produced a second frame. The UI is shared with
  the browser build, where `_blank` is exactly right, so a call site will
  eventually be written without the helper; this way the rule holds anyway.
  (The pane's own `WebContentsView` has a different handler on purpose: a
  `_blank` inside a page you are browsing loads *in the pane*, because that is
  the browser, not a link leaving it.)
  Anchors keep their `href` and only their plain left click is taken: a
  modified or middle click means "new tab" or "save", which the surrounding
  browser honours better than the OS can. **Web URLs only** — `http`, `https`
  and `mailto` — checked in the main process, which is the side that cannot be
  talked out of it, and again in the UI so a scheme it would refuse falls back
  to the browser instead of silently doing nothing. The strings reaching it
  come from pull request bodies, CI links and terminal output; handing the OS
  an arbitrary scheme is asking it to launch something rather than show a page.

In dev the window loads Vite on 4444, so UI edits hot-reload as in a tab; only
a change under `electron/` needs the app relaunched, which costs no sessions.
`./dev.sh --desktop` starts it with the dev servers and closes it with them —
it waits for both ports first, because `main.cjs` starts Vite and the backend
itself when they do not answer, and launching early races it into a second
Vite on the same port.

**In dev the app is Electron's own bundle**, so macOS took its name and icon
from there and the Dock said "Electron". `app.setName()` cannot move that —
the display name is the bundle's `Info.plist` — so `scripts/brand-dev-electron.sh`
(run by `desktop:dev`, and idempotent) patches the copy in `node_modules`:
name, display name, and the sheep icon rendered from `icon-512.png`. It is
safe there precisely because `npm ci` throws it away and the script runs
again. It re-signs ad-hoc afterwards, because macOS kills a modified signed
bundle on Apple Silicon. Packaged builds need none of this.

### The live browser

A genuine Chromium, running here, shown in a pane. Four things about it are
load-bearing:

- **It is the browser already on the machine** (`findBrowser`: Chrome, Brave,
  Edge, Chromium; `SHEEPIT_BROWSER` overrides). No 300 MB download bundled into
  an npm package whose whole pitch is `npx`.
- **Its profile is persistent and its own** (`browserProfileDir()`, which lives
  in `live-browser.ts` and *not* `paths.ts` — see [what the daemon
  hashes](#what-the-daemon-hashes-and-why-it-is-one-small-file)). Signing in to
  GitHub once is the point; the cookies are on disk, so they survive a server
  restart. It never touches the user's own browser profile — two processes
  cannot share a `--user-data-dir` anyway.
- **It is headless, and stays headless.** A Chrome in the Dock — in the app
  switcher, stealing focus, drawing a window on somebody's screen — is the
  thing this feature exists to avoid, so "run it windowed but off-screen" is
  not an answer, even though it works and was tried. The cost is real and worth
  naming: headless Chrome calls itself `HeadlessChrome` in its user agent, and
  sign-in flows that refuse automated browsers read that first — Google answers
  "this browser or app may not be secure" and stops. So:
  - **Pages are told a plain `Chrome/…`** (`Emulation.setUserAgentOverride`,
    per page rather than as a launch flag, so a re-attached browser gets it too
    and the browser's own requests keep their real name). The engine, the
    version and every capability are identical to the Chrome beside it in the
    Dock; that word was the only difference being reported. It is the cheap
    half of the problem, not a disguise that survives real fingerprinting.
  - **`SHEEPIT_BROWSER_HEADFUL=1`** runs a windowed browser for as long as it
    takes to sign in to something that refuses anyway. The cookies land in the
    profile on disk and stay there when it goes back to headless, so it is a
    one-off rather than a mode to live in.
- **A leftover browser is kept unless it is the wrong kind.** Re-attaching to
  the browser a previous start left running is the default — its pages are open
  and somebody may be reading them — but a headless one when `HEADFUL=1` was
  asked for (or a windowed one when it was not) is closed and replaced, or
  flipping that variable would appear to do nothing. `Browser.close` rather
  than a signal: it needs no pid, and the profile is written out properly.
- **Every view gets its own window** (`Target.createTarget({newWindow: true})`)
  plus `Emulation.setFocusEmulationEnabled`. This is not a detail — it is what
  lets more than one pane show a live page at all. Screencast is the
  compositor's output, and a page the compositor treats as not visible produces
  no frames; tabs in one window share a visibility, so exactly one casts and
  opening a second pane's page stopped the first pane's frames dead, even
  across a reload. A window has its own active tab. Measured: three panes at
  20 fps each, simultaneously, against a page repainting every 50 ms, with
  typing landing correctly in a background one. Focus emulation is the other
  half — it keeps `:focus`, autofocus and carets behaving in a pane the OS
  considers unfocused.
- **Pages are disposable, and are closed when nobody is looking.** Two rules,
  both in `sweep()`, every 30s:
  - **A page out of sight for `VIEW_TTL_MS` (10 min) is closed**, and its
    pane keeps the last frame, dimmed, under *Click to reload*. "Out of sight"
    is the pane's own report, not a guess: while it has a box and the sheepit
    tab is visible it sends `alive` every 30s, and any input counts too. So a
    page you are reading without touching is never closed under you; one in a
    pen you are not showing, or behind a backgrounded tab, is. An expired pane
    stays closed across a reconnect — a dev-server restart reconnects every
    pane, and reopening there would undo the TTL wholesale.
  - **A page no view owns is closed outright.** That is what a server restart
    leaves: the old server dies without closing its windows, and the new one
    re-attaches to the same browser without knowing they exist. Nothing ever
    closed them. On one machine 31 pages had piled up over two days — mostly
    GitHub, each holding live-update sockets — and the hidden Chrome sat at
    half a core while nobody looked at any of it. That, not the streaming, is
    what made GitHub feel slow in a pane and fast in a normal tab: measured,
    a scroll reaches the screen in ~20ms. A view still mid-`openView` is not an
    orphan yet (`opening`), so the sweep skips the orphan pass while one is.
  Logins survive both: they are in the profile on disk, not in the pages.
- **A target must be activated once before it will cast at all.**
  `Page.startScreencast` on a never-activated target fails with "Not attached
  to an active page", which is what an empty pane looks like. `activate()` is
  called on open and again if a view is somehow not casting; it no longer stops
  anybody else.
- **We keep our own note of the browser we started** (`browser.json`: pid and
  port). Chromium's `DevToolsActivePort` is gone after anything but a clean
  exit, and what is left then is the worst state there is — a live browser
  holding the profile's `SingletonLock`, unreachable because nothing knows its
  port, with every later launch exiting 21. With the note we can re-attach, or
  kill the orphan and clear the stale locks.

The client speaks CDP's own `Input.*` dialect rather than a vocabulary of our
own: a DOM event already carries what CDP wants, and translating it twice only
adds a second place for a modifier bit to go missing. Two details in that
translation are not optional:

- **The virtual key code is the event's own `keyCode`**, never one derived from
  the character. `key.toUpperCase().charCodeAt(0)` is right for letters and
  digits and wrong for punctuation in a way that does damage rather than
  nothing: `.` became 46, which is `VK_DELETE`, so typing a full stop sent
  Chromium a Delete carrying the text ".".
- **`keyDown` when there is text, `rawKeyDown` when there is not** — that is
  what decides whether Chromium raises a keypress. Enter has no character but
  does carry text (`\r`), and without it Enter raised a keydown that no form
  ever submitted on.

**Send nothing to the browser while a modifier is held.** This is the rule the
rest of the keyboard section exists to support, and it cost a day to find.

Driving a Chrome over CDP makes that Chrome **activate itself at the macOS
window level** — a known Chromium bug (chromium#223828, and
`ChromeDevTools/chrome-devtools-mcp#1254`). Any command will do it. So a bare
`Alt` keydown forwarded the moment you hold Option pulled the desktop's focus
off the browser you were typing into, and the half-composed character died with
it: `@` on an Italian layout is ⌥ò, and macOS was mid-composition when the
window blurred. What the user saw was a beep, no character, and *System
Information* coming to the front — the chord escalating up macOS's menu chain,
where Option turns "About This Mac" into "System Information…".

Everything about it pointed away from us. It happened in Brave and in Comet
alike (the thief is Chrome, not the viewer). It never happened in any other
app (nothing else drives a second browser over CDP while you type). It worked
if you pressed both keys fast enough to beat the round trip. Hours went into
the machine's shortcut stores, extension commands and accessibility settings,
and the answer was one WebSocket message at exactly the wrong moment.

A modifier on its own is therefore **dropped**: not cancelled (that kills the
composition too), not forwarded. Nothing needs it — every mouse and key event
already carries the modifier bits. `Target.activateTarget` is in the same
family and is now only sent once, to start a cast; see `activate()`.

**The keyboard goes into a real text field.** The pane keeps an invisible
one-pixel `<textarea>` (`.live-browser-key-sink`) and focuses that, the same
trick xterm uses, for the same reason: focusing a plain `<div>` gives the OS no
*text input context*, so macOS never runs the input method. `@` on an Italian
layout is ⌥ò, and the composition that turns those two into a character only
happens when something editable has focus — without it the raw chord fell
through to the application's accelerators, so Brave switched tab and no `@` was
ever typed. Dead keys, IME candidates, the emoji picker and paste were lost the
same way; all of them arrive now as an `input` event, already composed, and are
sent with `Input.insertText`.

**The pane's `mousedown` cancels its default**, and that is load-bearing: a
mousedown's default action moves focus to whatever was clicked, and the surface
is not focusable, so it took the focus straight back out of the sink — leaving
a pane where the mouse worked and nothing could be typed at all. (It also stops
the drag from selecting the pane's own image.)

**A character composed with Option/AltGr is taken explicitly, and marked
handled.** Chromium hands any key event the renderer did *not* handle back to
the browser for accelerator processing — so ⌥ò reached the sink, was not
inserted as text, bounced back, and Brave ran its own shortcut with it (a tab
switch). `preventDefault` is what says "handled" and ends that; the character
is already composed in `e.key`, because macOS did that part, so it goes in with
`Input.insertText`. Note the shape of this: the sink was still necessary —
without a text input context the key never reached the page at all — but it was
not sufficient.

So the split is: **text comes from the sink, keys come from `keydown`**
(`producesText` decides). A keystroke that makes a character is deliberately
*not* cancelled — cancelling it is what stops the character from ever existing.
Enter, Tab, arrows, Escape and every ⌘/⌃ chord are cancelled and forwarded as
key events. ⌘V needs no special handling at all: the browser pastes into the
sink and the same `input` event carries it, with no clipboard permission asked
for.

**The keyboard is captured at the window, not taken on the element.** A page
can only stop a browser shortcut it sees first, and by the time a handler on
the element runs, the event has already passed the window — so the *viewing*
browser acts on its own binding regardless. Brave maps `@` (Option+ò on an
Italian layout) to Back, which meant typing an email address in a pane
navigated sheepit backwards. The listener is on `window` in the capture phase,
and only while the surface holds focus, so the address bar, ⌘K and the rest of
sheepit keep their keys.

A character the keyboard **composed** — `@` as Option+ò, `#` as Option+à,
anything AltGr makes — arrives already composed in `e.key` with the modifier
that made it still held. Forwarded as a key event that reads as a chord, not as
typing; it goes through `Input.insertText` instead, which says the only true
thing about it.

**Copy and paste cross the machine boundary by hand.** ⌘C in a streamed page
works perfectly and puts the text on the *host's* clipboard, where nothing on
the viewing machine can reach it. So the shortcut is caught in the pane, never
forwarded: a copy asks the server what is selected (`window.getSelection()`,
plus the text field's own selection, which the Selection API does not see) and
writes it to the clipboard inside the keydown, which is the gesture browsers
require for a clipboard write. Paste is the mirror — read this machine's
clipboard, have the page type it with `Input.insertText` — because a paste
inside the page would read the wrong clipboard. Cut is copy plus the keystroke,
since the page still has to do the removing.

**The page reports its own cursor.** A picture of a page has no cursor, so
every link looked like prose and every field like nothing. CDP has no "what is
the cursor here" question, so a small script is injected into every document
(`CURSOR_REPORTER`) that watches the pointer and calls a binding *when the
cursor changes* — a handful of messages a minute, rather than a round trip per
pointer sample. The client keeps an allowlist of CSS cursor keywords: the value
comes from the page, and `cursor` accepts `url(...)`, which would have an
untrusted page fetching an image through the viewer's browser.

**The socket reconnects, with backoff.** The backend restarts — a deploy, a
code change in dev — and each restart used to take every browser pane with it:
the socket closed, nothing reopened it, and the pane sat on a black rectangle
until the whole page was reloaded. On reconnect the view is opened again on the
page the pane was already showing, which is why `LiveBrowserSurface` keeps that
URL in a ref. Frames ride a **separate
WebSocket** (`/ws/browser`) — tens of kilobytes many times a second must not
queue in front of a keystroke on its way to a PTY. Both sockets are `noServer`
and one `upgrade` listener routes them; a second path-bound `WebSocketServer`
on the same HTTP server destroys the first one's sockets, which once killed
every terminal connection in the app.

**Security, plainly.** Anything that can reach sheepit can drive this browser
and is therefore inside every session it is signed into. That is a real
escalation over the preview iframe — and not one over sheepit itself, which
hands the same caller a shell on the same machine as the same user. The shell
is the bigger key. Do not add a way to reach the browser that does not come
through sheepit's own front door.

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

### What the daemon hashes, and why it is one small file

`dev.sh` decides whether the running daemon is stale by hashing
`DAEMON_SOURCES` and comparing that to the hash the daemon recorded at startup.
A difference means "replace the daemon" — and replacing the daemon closes every
shell it holds and kills every agent running in one.

That set used to be `src/pty-daemon.ts src/paths.ts`, and `paths.ts` holds
every path in the product. The daemon imports exactly one of them
(`configDir`), but the hash covered all of them, so adding an unrelated
directory for an unrelated feature — a browser profile the daemon never reads —
armed a trap that the next ordinary restart sprang. 24 live sessions, closed by
a function nobody called. The tell afterwards is a full session list whose
panes all hold a fresh `/bin/zsh -l`.

Two things now stand between that mistake and your sessions, and both matter:

- **`src/daemon-paths.ts`** holds `configDir` and nothing else, and is what the
  daemon imports; `paths.ts` re-exports it, so there is still one definition of
  where sheepit keeps its state. `DAEMON_SOURCES` is `pty-daemon.ts` and that
  file. A new path added to `paths.ts` can no longer change what is hashed.
  **Keep `daemon-paths.ts` small** — a change to it should mean the daemon
  genuinely needs to restart.
- **A stale daemon holding live shells is kept, not replaced.** `dev.sh` says
  what changed and tells you to run `./dev.sh --fresh-daemon` deliberately.
  Sessions are the expensive thing here — an agent mid-run, an hour of
  scrollback — and "the daemon is running older code" is the cheaper problem.
  It still replaces a stale daemon that holds nothing, which is the case the
  check was written for.

### When the shell dies with the machine, the agent comes back

A session outlives a server restart because the daemon holds its fd; it does
not outlive the daemon. When `restoreSessions` finds a saved session the daemon
no longer has, it recreates it with a fresh shell in the pane's own directory
and replays the ring — so the pane looks exactly as it did, and holds a bare
`/bin/zsh -l` with the agent gone.

The conversation is not gone, though: it is on disk, in the pane's directory.
So a pane whose persisted `sessionType` is `claude` gets
`claude --dangerously-skip-permissions -c` typed into its new shell
(`AGENT_RESUME_COMMANDS`, `aiResumeAgents` in `config.json`, toggled under
Settings → AI Features). `-c` continues the most recent conversation *in that
directory*, which is the one that was running there — no session id to keep, and
nothing to get wrong if the pane was moved.

**Only Claude Code is in that map.** It is the one agent with a "continue the
last conversation here" flag; for the others a guess would resume the wrong
work, and a pane that looks restored and is not is worse than a pane with a
prompt in it.

The command is **not written straight away**, unlike `init_command` on a new
session. That shell was spawned a moment ago and is still sourcing rc files, and
a prompt drawn *after* the command lands is a prompt with half a command on it.
So the write waits for the pane's output to go quiet (`RESUME_SETTLE_MS`), with
`RESUME_DEADLINE_MS` as the backstop for a shell that never does — which is what
makes it survive a machine bringing twenty slow-starting shells up at once.
Two things cancel a queued resume: the pane exiting, and **anybody typing into
it**. Past that point they are driving, and an injected line would land in the
middle of what they wrote.

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

### One key per pen, and the profile talks back

The profile is shared by every browser looking at this machine, and each one
holds a copy of it, read once at startup. Two rules keep the copies from
diverging, and they only work together.

**Writes are disjoint.** The sidebar is `sheepit:pen:<workspaceId>` per pen plus
a small `sheepit:flock` for the one genuinely shared thing — the order and the
fields themselves. It was a single `sheepit:workspaces` blob, which meant every
save restated every pen from a snapshot that could be hours old, so the last
browser to write replaced the other's work. Something saves every two seconds
(`renderSessions`), so "last" was arbitrary. That is how one pen stood in two
different fields in two browsers: membership lives on the pen, and each browser
kept rewriting the pen with its own idea of it. `writeWorkspaces` diffs against
what the profile holds and sends only the pens that moved; callers still hand
over the whole map, and a pen missing from it has its key removed. Splitting the
old blob is one-shot and runs on load; the blob is left in place as the way
back, so it is frozen at the cutover and must not be read for anything else.

**The profile tells you when it changes.** `PATCH /api/preferences` publishes
the patch — the keys, not the profile — on the `__sessions__` channel, and every
other client merges it. `subscribePreferences` in the store re-reads the pen and
flock keys the moment one lands. Three things make the merge safe:

- **A tab ignores its own echo**, matched on the `origin` it sent. Applying it
  would revert a value changed while the request was in flight.
- **A key with a local write pending or in flight is never overwritten.** Ours
  is the newer intention. `pending` alone does not cover the window between the
  send and the response, which is why `inFlight` exists as well.
- **A reconnect resyncs the whole profile** — values only, never deletions. A
  broadcast only reaches a connected tab; one that was asleep missed every
  patch meanwhile. But a resync cannot tell a key someone deleted from a
  profile that came back short (a half-written file, a server restarting
  mid-read), and inferring deletion from absence turns one bad answer into
  "throw away every pen". Deletions arrive as a broadcast, which says so.

**A session belongs to exactly one pen**, and `dedupePens` is what enforces it
on the way in. Two clients can both notice an unclaimed session in the same
breath and both make a pen for it — `renderSessions` claims sessions against
the pens *this* tab knows about, and a pen another tab made a moment ago is not
one of them. The whole-blob write hid that by erasing the loser's pens
wholesale; per-pen keys keep both, and the same sheep stands in the flock
twice. The **bigger pen wins**: a pen holding two, three or four sheep is one
somebody built, while a single over the same session is what the sweep makes
automatically. Ties go to the shared order, so every client discards the same
pen without needing to agree on anything first, and the loser's key is removed
rather than merely ignored.

The profile is also snapshotted **once a day** (`preferences.json.<date>.bak`,
a fortnight kept) beside the five rolling backups. The rolling ones are written
on every save and something saves every couple of seconds, so by the time
anyone notices a profile has been damaged all five already hold the damage.
The day-stamped copy is the one still standing an hour later.

Re-reading on a remote change cannot lose a local edit because `preferences` is
a synchronous mirror — a pen this tab just changed is already in it. If you add
state that two browsers can both edit, give it its own key. A shared blob is a
last-writer-wins channel wearing a preference's clothes.
