# Page media

`docs/index.html` renders a dashed placeholder wherever a recording or a still
is missing, and each placeholder names the exact file it wants. Drop the file
in here with that name and it takes over — no markup change needed.

## The demo video

| file | what to record |
|---|---|
| `demo.mp4` | The two-minute walkthrough: one command, the flock filling up, answering a bleating agent, zen on one pane. |
| `demo-poster.png` | A still from it for the poster frame. |

The demo is its own section and holds nothing else. The video tag is commented
out in the HTML so an empty player never renders — swap the placeholder
`<div class="demo-slot">` for the `<video>` line directly above it once the
file is here.

## Stills: what it replaces

One screenshot each, 16:10, dark theme.

| file | what to show |
|---|---|
| `replaces-terminal.png` | A pen of four live shells. |
| `replaces-agents.png` | Claude Code, Codex and Hermes running in one pen. |
| `replaces-files.png` | The file tree open beside a terminal. |
| `replaces-ide.png` | Editing a file and reading its diff. |
| `replaces-notes.png` | A markdown note beside the flock. |

## Works from anywhere

| file | what to show |
|---|---|
| `mobile.png` | A phone, **portrait** — the flock list with something bleating, or a live pane. It sits in a phone-shaped frame at 9:19.5, so shoot it on a real device rather than cropping a desktop shot. |

## Recordings: the feature set

| file | what to record |
|---|---|
| `persistent-sessions.gif` | A build running, the server restarted underneath it, the build still going. |
| `resume-agent.gif` | A pane after a reboot: fresh shell, then the agent picking its own conversation back up. |
| `self-naming-panes.gif` | A pane called `-` renaming itself as the agent finishes a turn. |
| `search-flock.gif` | ⌘K, a PR number typed, the right pane selected out of a full flock. |
| `browser-pane.gif` | A dev-server URL printed in the terminal, clicked, opening in the pane beside it. |
| `git-pane.gif` | Dirty state on the pane bar → the diff → the pull request it belongs to. |
| `files-and-notes.gif` | A file open beside the terminal, refreshing as an agent rewrites it on disk. |

Notes for recording:

- Keep each GIF **under ~6 seconds** and loop cleanly — eight of them autoplay
  side by side, and a long one pulls the eye off the others.
- Record at **1280×800** or tighter and crop to roughly **16:10**; the slots are
  that ratio and crop with `object-fit: cover`.
- Use the **dark theme**, so they sit in the page rather than flashing white.
- Aim for **under 2 MB** per GIF. GitHub Pages serves them uncompressed.

## Logos

`claudecode.svg` and `openai.png` are copied from `ui/public/`; `hermes.png` is
the favicon from hermes-agent.nousresearch.com. They appear on the pane cards
in the field's pen rows and in the popup that opens when you click a sheep.
