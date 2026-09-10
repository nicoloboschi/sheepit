# DESIGN.md — sheepit

The one design system, for the landing page (`docs/`) and the app (`ui/`).

This file was written **from the website**, because that is where the system
was worked out in one pass with nothing to be compatible with, and then applied
back to the app. [Where the app stands](#where-the-app-stands) records what has
landed there.

The loop is: **iterate on `docs/index.html` → update this file → apply to
`ui/`.** A change that lands in one of the three and not the others is how a
system stops being one.

---

## 1. Type

**Two families. Not three.**

| role | family | why |
|---|---|---|
| Everything that is language | **Outfit** | Geometric sans, OFL, variable. Display, body, nav, labels, buttons — all of it. |
| Only what is literally code | **JetBrains Mono** | The terminal, and the things you could paste into one: commands, paths, branch names, filenames, ports. |

**Outfit is the default; mono is the exception you have to justify.** The test
is not "is this small" or "is this technical" — it is **could you paste this
into a shell?** `npx @nicoloboschi/sheepit`, `~/dev/orchard-api`,
`session-ttl`, `media/demo.mp4`: mono. A nav item, an eyebrow, a button label,
a state pill, a footer link, an agent's name: Outfit, however small or
technical it feels.

There is no third face and no display/body split by *typeface*. What separates
a headline from a paragraph is **weight and tracking**, never a different font.
A page with two families reads as one system; the moment a third arrives,
somebody has to decide which of the three a new thing belongs to, and they will
decide differently from the last person.

### Why the second family is not optional

It would be tidier to set everything in Outfit. The terminal makes that
impossible, and not as a matter of taste:

**xterm.js renders a character grid.** It measures one reference glyph, fixes
the cell width from it, and positions every subsequent character on that grid.
Hand it a proportional face and the glyphs still draw at their own natural
widths inside fixed cells — an `i` leaves a hole, an `m` overlaps its
neighbour, and the drift accumulates across a row. Column alignment is the
entire contract of a terminal, and everything that lives in one depends on it:
box-drawing characters (`─ │ ┌ ┐ └ ┘`) stop connecting, the braille spinners
agents print (`⠋⠙⠹⠸`) jitter, `top`, `vim`, `less` and Claude Code's own TUI
draw over themselves, and `git diff` columns stop lining up.

So sheepit ships a monospace face whatever else it does — `DEFAULT_TERMINAL_FONT`
in `ui/src/theme.ts` is JetBrains Mono, and it is the bundled default among nine
presets in the picker. **It is already in the payload and cannot leave.** Given
that, using it for the handful of places that show pasteable text costs *zero
additional bytes*, and buys three things Outfit cannot give:

- `0` vs `O` and `1` vs `l` vs `I` stay distinguishable — in a port, a hash, a
  branch name or `0.0.0.0`, that is the difference between reading a value and
  guessing it.
- Numbers line up in columns without `tabular-nums` gymnastics.
- Text on the page and text in the terminal beside it look like the same kind
  of thing, because they *are* the same kind of thing.

The honest cost of the pair is that mono creeps: it is easy to reach for it for
anything small or technical-feeling. That is what the paste test above exists
to stop.

### Why Outfit, and what it costs

Outfit is geometric: near-circular bowls, a **single-storey `a`**, short
descenders, and it tightens up beautifully at display weights. That is the
whole reason to pick it — a headline in Outfit 700 at −0.035em looks
deliberately set rather than typed.

That same geometry is its weakness. At small sizes `a`, `o`, `e` and `c` all
carry the same circle, and a single-storey `a` has less to distinguish it than
a double-storey one. So:

> **Set small lowercase text in uppercase, or set it larger.** Uppercase has no
> single-storey `a` to lose, so a 9–11px uppercase label in Outfit holds
> perfectly well; it is 10px *lowercase* Outfit that goes soft. This is why
> every micro-label on the page is uppercase with heavy tracking rather than
> being handed to mono — reaching for mono to solve a legibility problem is how
> a two-family system quietly becomes a mono-first one.

### The scale

Live values from `docs/index.html`. Sizes that scale use `clamp()` so a phone
and a 27" display both get a sensible measure.

| token | size | weight | tracking | line-height |
|---|---|---|---|---|
| Hero | `clamp(38px, 5.6vw, 64px)` | 700 | −0.035em | 1.0 |
| Section head (h2) | `clamp(25px, 3.2vw, 34px)` | 600 | −0.03em | 1.12 |
| Block head (h3, large) | `clamp(21px, 2.5vw, 27px)` | 600 | −0.03em | 1.2 |
| Sub-head (h3) | 17.5–18px | 600 | −0.02em | 1.3 |
| Card title | 16px | 600 | 0 | 1.3 |
| Row title (app density) | 13.5px | 600 | 0 | 1.35 |
| Lede | 18px | 400 | 0 | 1.55 |
| Body | 16px | 400 | 0 | 1.66 |
| Secondary / caption | 14.5px | 400 | 0 | 1.5 |
| Eyebrow / micro-label | 11px | 500 | **+0.17em**, uppercase | 1.4 |
| Nav, footer, link buttons | 13.5px | 500 | 0 | 1.5 |
| **Code, inline** | **mono 10–13px** | 400–500 | +0.04em | 1.5 |
| Terminal | mono, user's size | 400 | 0 | **1** (see below) |

### The app is the same scale, one tier down

A landing page and a terminal multiplexer cannot share sizes: 16px body is
right for a page you read and wrong for a sidebar holding thirty rows. The app
runs the same *system* at density, in **five steps and no others**:

| step | used for | weight |
|---|---|---|
| **14px** | dialog titles, the biggest thing in a panel | 600 |
| **13px** | a row title — a pen name, a pane name | 600 |
| **12px** | controls, inputs, body text inside a dialog | 400 / 500 |
| **11px** | captions, secondary meta, most inline code | 400 / mono |
| **10px** | micro-labels (uppercase, +0.14em), badges, counts, paths | 500 / 600 |

Nothing between the steps. The app had thirteen sizes — 7, 8.5, 9, 9.5, 10,
10.5, 11, 11.5, 12, 13, 14, 15, 40 — because each was picked next to whatever
it sat beside rather than from a list. Half of them differed from a neighbour
by half a pixel, which nobody can see and everybody has to maintain.

Three sizes stay off the scale, deliberately, and each is a picture rather than
text: `.logo` at 15px is a wordmark, `.placeholder-icon` at 40px is a glyph,
and `.flock-sheep-baa` (7px) / `.flock-sheep-call` (8.5px) are drawn at sheep
scale inside the pasture strip — the tag is up to 118px of a ~250px band, and
sizing them from a text scale would break the animal they belong to.

**700 is for the wordmark and nothing else.** Outfit 700 is a visibly heavier
face than Space Grotesk 700 was, and at 10px with tracking the difference
between 600 and 700 is only weight, not emphasis. 600 is the heading weight
everywhere.

Two rules that fall out of that table:

- **Tracking is negative above 20px and zero below it.** Outfit is drawn tight;
  a 14px paragraph at −0.02em closes up the counters and starts to smear.
- **Uppercase always gets +0.15em or more.** Uppercase set at normal tracking
  is the single most reliable way to make a page look unconsidered.
- Digits that line up in a column take `font-variant-numeric: tabular-nums`.

### Terminal line height is 1, and that is not "no leading"

`TERMINAL_LINE_HEIGHT` in `ui/src/theme.ts` is **1**, because xterm multiplies
the font's *measured line box* — ascent + descent + leading, about 1.2× the
point size — not the point size. So 1 is what a native terminal gives you, and
what iTerm calls Vertical Spacing 1.0. It was 1.2, which stacked leading on top
of leading and cost a row of output in every pane.

Five places have to agree on it, and one of them is CSS: the font preview in
Appearance takes `line-height: normal`, **not** `1`, because CSS multiplies the
font size where xterm multiplies the line box.

### Loading fonts

- **The app self-hosts. Always.** `ui/public/fonts`, generated by
  `python3 scripts/selfhost-fonts.py`, linked from `ui/index.html` with a
  `<link rel="preload">` for the two faces above the fold. A render-blocking
  request to `fonts.googleapis.com` stalls forever on a LAN with no route out —
  which is exactly where the Android build runs — and the UI silently falls
  back to system fonts. Changing a family here means editing `GOOGLE_CSS` in
  that script and re-running it.
- **The website may use the Google Fonts CDN.** It is a public page on GitHub
  Pages; it is always online by definition. That is the *only* place the two
  differ, and it is deliberate.
- Every stack ends in a real fallback (`-apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif` / `ui-monospace, SFMono-Regular, Menlo, monospace`),
  so a failed load degrades instead of disappearing.

**One definition each.** `--font-sans` and `--font-mono` are declared once in
`:root` in `ui/src/style.css`, and nothing anywhere else names a family. Those
are also the names Tailwind v4 emits its own defaults under, and our `:root`
block comes after `@import "tailwindcss"` — so redefining them there means the
`font-sans` and `font-mono` **utility classes resolve to our stacks too**,
without a `@theme` entry. That is not a trick, it is the reason to use those
exact names: before it, three `font-mono` class usages were silently rendering
in Tailwind's default `ui-monospace` rather than in JetBrains Mono.

The one literal that stays a literal is `DEFAULT_TERMINAL_FONT` in
`ui/src/theme.ts`. It is a *value*, not a style: it is persisted to
preferences, shown in the font picker, and handed to xterm.

---

## 2. Colour

The brand is a **meadow → moss gradient**: the greens of a field at dusk on
near-black olive surfaces. Green is the brand *and* carries success, addition
and health — the two roles share `#9CBC7F`. What distinguishes a state is the
**second** colour: amber for wants-attention, terracotta for errors.

Do not reintroduce blue or teal as a brand colour. The one remaining cool tone
is `--bleating`, a moss teal, used for exactly one thing: a pane waiting on you.

### Tokens

| token | dark | light | use |
|---|---|---|---|
| `--ground` / `--background` | `#0b0d0a` | `#f5f7f2` | the page |
| `--soil` / alternating band | `#101410` | `#eef1ea` | every other section |
| `--primary` | `#9cbc7f` | `#4e7a3b` | solid brand: borders, text, marks |
| `--primary-end` | `#6fa98c` | `#2f6b55` | gradient end / second accent |
| `--primary-foreground` | `#0b0d0a` | `#ffffff` | text **on** a gradient fill |
| `--fence` | `#a29e79` | — | weathered rail; structural lines |
| `--parchment` / `--foreground` | `#eae8dd` | `#161a14` | body text — warm, never `#fff` |
| `--dim` | `#c6c8bd` | `#3b4237` | secondary prose |
| `--muted` | `#8e948a` | `#5d6459` | captions, data, disabled |
| `--success` / `--grazing` | `#9CBC7F` | | healthy, additions, running |
| `--warning` | `#D9B84A` | | amber — dirty tree, unread output |
| `--destructive` | `#E0907B` | | terracotta — errors, deletions |
| `--bleating` | `#8EBFA2` | | **only** "wants your input" |
| `--chrome` | `#15171a` | `#eef0f3` | sidebar + top bars — **neutral** |
| `--chrome-line` | white/ink @ 7–10% | | the hairlines between them |

Gradient: `linear-gradient(135deg, #9cbc7f 0%, #6fa98c 100%)`. Hover goes
**up**, not down — the base is light: `#b0ce93 → #83bc9f`.

### Rules

- **Neutrals are olive-tinted, not grey.** `#0b0d0a` page, `#111411` card,
  `#181c16` popover, `#232820` accent. A pure grey next to this palette reads
  as a mistake.
- **Chrome is the exception and it is neutral.** The sidebar and the bars along
  the top are graphite, not olive. They sit in peripheral vision all day, and a
  green field held there is tiring in a way a green button is not. Green has to
  *say* something to appear.
- **Selection is a lift, not a hue.** `--pane-chrome-active` is the same
  graphite a few steps brighter. The loudest colour on screen must never sit
  directly behind the thing you spend the day reading.
- **Vendor marks keep their own colours.** `ClaudeIcon` stays `#CC785C`,
  file-type colours in `FilesPane` stay their language colours. Those are other
  people's brands.
- **Semantic colour is not the accent.** Bleating, grazing, unread and error
  are a separate axis from "this is a sheepit thing".

### Both themes, three states

The viewer has three states, not two: an explicit choice stamps
`data-theme="dark"` / `"light"` on the root, and the default *system* setting
stamps nothing. So:

1. Bare `:root` holds the **complete** dark palette (this product is dark-first).
2. `@media (prefers-color-scheme: light)` guarded as `:root:not([data-theme="dark"])`
   redefines **only tokens**.
3. `:root[data-theme="light"]` redefines them again, so an explicit choice wins
   in both directions.

Every component reads a token. A colour whose only definition sits inside a
media or `[data-theme]` block never applies in the un-stamped state — that is
the classic unreadable-page bug.

---

## 3. Structure: the fence is the system

A fence is what turns ground into a pen, and a pen is what turns twenty running
agents into something you can watch. So the fence is not decoration — it is the
structural device, and it should encode something true wherever it appears.

- **Section dividers are a fence**: two rails on posts every 46px
  (`.fenceline`). Sections are pens; you cross a fence to get from one to the
  next.
- **An enclosure has a way in.** Anything drawn as a pen gets a gate — a real
  gap in the near rail with two taller gateposts. A closed rectangle is a box,
  not a pen.
- **Grass is ground, not texture.** It goes *behind* content, scattered faintly
  over the floor and dense along the front edge, and the bottom padding of a
  pen is deeper than the other three sides because that front strip has to grow
  in clear ground.
- **Cards on grass stay opaque** (`--accent`, never an alpha over it). A
  translucent card puts the whole field behind every line of text.
- **Deterministic randomness only.** Blade and post positions come from a fixed
  integer hash, never `Math.random()`. A field that reshuffles itself when a
  session goes busy is a distraction; and the sidebar's grass and a pen's grass
  must look like the same field.

Numbering (`01 / 02 / 03`) is allowed **only when the content is a sequence**.
The steps of getting started are; a list of capabilities is not.

---

## 4. Components

**Activity dot** — 7px (10px at rest in a legend), the one carrier of state:

| dot | means |
|---|---|
| teal, pulsing (`--bleating`) | bleating — wants your input |
| meadow, steady (`--grazing`) | grazing — a command is running |
| amber, filled (`--warning`) | idle, with output you have not read |
| hollow ring (`--muted`) | idle, and you have seen it |

Live states take precedence over unread; bleating beats grazing, so the two
counts never double-count a pane.

**Pen row** — the sidebar row, and the label on a pen in the hero animation.
Graphite chrome, a fenced body with a grass strip, one opaque pane card per
sheep, each carrying a dot, a short name and its agent's mark. The name, badge
and branch sit **above** the fence: a name inside the enclosure costs a row of
pen the sheep needed.

**Media slot** — every image the page is waiting for renders a dashed
placeholder naming the exact file (`media/<name>.gif`), with a terracotta
record dot. Drop the file in and it takes over; `onerror` removes a broken
`<img>` so a missing asset degrades to the placeholder rather than to a broken
icon. Never ship an empty `<video>` — it renders a dead player over the slot.

**Peek popup** — a card anchored to the thing it describes with a tail pointing
back at it, not a modal. Harness logo, name, state pill, title, path, two
sentences, and the line it is on.

**Buttons** — filled brand surfaces take `var(--primary-gradient)` with
`var(--primary-foreground)` text, never a literal `#fff`, which disappears on
the light fill. Soft backgrounds take the 10% tint.

**Focus** — `2px solid var(--primary)` with `outline-offset: 2–3px`, on
`:focus-visible`. Everything interactive keeps a visible focus state.

---

## 5. Motion

- **Show the page at rest.** Everything meant to be read is visible on load.
  Nothing parked at `opacity: 0` waiting for an observer.
- **Entrances are one-shot animations, never transitions.** A transition
  interrupted mid-interpolation *stays there* — a dialog stuck at 76% opacity
  is a dialog you can read the page through. (This is a real bug we hit: a
  background tab freezes the animation clock, and `transition` left the pane
  half-transparent while `animation … both` at least ends where it was told.)
- **Nothing in a bar changes size with selection.** The pane bar used to grow
  4px when a pane became active, which resized the terminal under it and
  clipped the bottom row of output. Selection is background, border and ring.
- **`prefers-reduced-motion: reduce` stops movement, keeps everything else.**
  The flock stays; the walking stops.

---

## 6. Voice

UI copy uses the flock vocabulary; code uses the plain names. The mapping lives
in `ui/src/flock.ts`.

| UI word | code |
|---|---|
| sheep | pane |
| pen | workspace |
| field | field |
| the flock | every pen together |
| bleating | needs attention |
| grazing | busy |

**The plural of sheep is "sheep".** Never "sheeps" — counts go through
`sheepCount()` rather than each call site remembering.

Write from the reader's side: name things by what they recognise, active voice,
a control says exactly what happens. Specific beats clever. Never "vipershell"
in anything a user reads.

---

## Where the app stands

Applied to `ui/`:

- Outfit vendored into `ui/public/fonts` and Space Grotesk deleted, by pointing
  `GOOGLE_CSS` in `scripts/selfhost-fonts.py` at Outfit and re-running it. The
  bundle is 16 files, 351 KB.
- `--font-sans` / `--font-mono` declared once in `:root`; `body` set to
  `var(--font-sans)`; every other declaration in the app now reads a token.
  That included 38 hard-coded `"JetBrains Mono", monospace` literals in
  component inline styles and two bare `font-family: monospace` declarations,
  which had been picking up whatever the platform called monospace.
- The paste test applied: the sidebar group heading moved to uppercase Outfit;
  paths, ports, branches, PR refs, log output and code stayed mono.
- `ui/index.html` preloads `outfit-500-latin.woff2` instead of the Space
  Grotesk it no longer ships.

Also applied:

- The type scale, at app density — thirteen ad-hoc sizes collapsed onto the
  five steps above, with the three picture-not-text exceptions left alone.
- The weight audit — the three text uses of 700 (`.session-group-label`,
  `.field-elsewhere`, `.session-pane-badge`) moved to 600. `.logo` keeps 700.

The app and this file now agree on type and on colour. What is left is not a
delta — it is the next thing to design: the app has no documented spacing or
radius scale, and its paddings were picked the same way its font sizes were.
That is the section to write next, from the website, the same way.
