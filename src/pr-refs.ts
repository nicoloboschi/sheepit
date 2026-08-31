/**
 * Pull request and issue references, extracted from what the agent's hooks
 * report — never from terminal output.
 *
 * The pane bar used to learn a PR number by scanning the byte stream in the
 * browser for anything matching a URL. That works for a shell where `gh pr
 * create` prints a line and it stays printed; it is close to useless for a TUI
 * agent, which wraps, truncates and redraws its own output, so the URL rarely
 * survives as a contiguous string in one chunk. It also died on a page reload,
 * because the scraped list only ever lived in the tab that saw it go past.
 *
 * The hooks already carry the same information in a form that cannot be
 * mangled: the tool call and its result (`post.sh` greps those and forwards
 * only the matches), and the turn text itself (`report-state.mjs` already
 * sends the prompt and the reply for naming). Both land here.
 *
 * Two shapes are recognised:
 *
 *   - a full GitHub PR/issue URL — unambiguous, and what `gh pr create` and
 *     `gh pr view --json url` both emit;
 *   - a bare `#123`, which is how people and agents actually write it in prose.
 *
 * The bare form is only ever read from text a human or the model wrote (a
 * prompt, a reply, a `gh` command line). It is deliberately NOT applied to
 * tool *results*, where `#1` is as likely to be a comment, a CSS colour or a
 * line in a changelog as a pull request.
 */

/** One reference the agent mentioned. `url` is present for the URL form and
 *  synthesised for the bare form only when the repo is known. */
export interface PrRef {
  kind: 'pr' | 'issue';
  num: number;
  url?: string;
  /** `owner/repo`, when the reference carried it. */
  repo?: string;
}

/** A GitHub PR/issue URL anywhere in a blob of text. */
const URL_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(pull|issues)\/(\d+)/g;

/** `gh pr view 3672`, `gh issue comment 88`, `gh pr checkout 12` — the number
 *  is the argument, with or without a leading `#`. */
const GH_CMD_RE = /\bgh\s+(pr|issue)\s+[a-z-]+(?:\s+--?[\w-]+(?:[= ][^\s]+)?)*\s+#?(\d+)\b/g;

/** `--repo owner/name` on a gh command line. Worth catching: without it a
 *  `gh pr view 3730 --repo other/repo` is indistinguishable from a PR of the
 *  repository the pane is sitting in, and the bar would link to the wrong one.
 *  Read from the whole payload rather than from the matched command, because
 *  the flag is as often after the number as before it. */
const GH_REPO_RE = /--repo[= ]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/;

/** A bare `#123`. Bounded to six digits — more than that is a hash, a colour
 *  or a byte count, not an issue anyone filed. Rejected when glued to a word
 *  on either side, which is what keeps `#0d1117` and `foo#3` out. */
const BARE_RE = /(?:^|[^\w#/])#(\d{1,6})(?![\w#])/g;

/** How many references we keep per session. The bar shows one and counts the
 *  rest; a session that has touched more than a handful has moved on. */
export const MAX_REFS = 5;

function push(out: PrRef[], ref: PrRef): void {
  // Newest wins its position, but an existing entry keeps whatever richer
  // information it already had: the URL form carries a repo, the bare form
  // does not, and a later `#123` must not erase the link we already have.
  const at = out.findIndex(r => r.kind === ref.kind && r.num === ref.num);
  if (at >= 0) {
    const prev = out[at]!;
    out.splice(at, 1);
    out.unshift({ ...prev, ...ref, url: ref.url ?? prev.url, repo: ref.repo ?? prev.repo });
    return;
  }
  out.unshift(ref);
}

/**
 * Every reference in `text`, most recently mentioned first.
 *
 * `bare` opts into the `#123` form; leave it off for tool output, where the
 * shape is far too common to mean anything. Order within one blob is
 * last-mentioned-first, because a turn that ends by opening a PR is about that
 * PR and not about the one it read at the start.
 */
export function extractPrRefs(text: string, { bare = false }: { bare?: boolean } = {}): PrRef[] {
  if (!text) return [];

  // Collected with their position first and ordered afterwards, rather than
  // one regex at a time: the order that means something is the order they
  // appear in, not which pattern happened to match them.
  const found: { at: number; ref: PrRef }[] = [];

  for (const m of text.matchAll(URL_RE)) {
    found.push({
      at: m.index ?? 0,
      ref: {
        kind: m[3] === 'pull' ? 'pr' : 'issue',
        num: parseInt(m[4]!, 10),
        url: m[0],
        repo: `${m[1]}/${m[2]}`,
      },
    });
  }
  const named = text.match(GH_REPO_RE)?.[1];
  for (const m of text.matchAll(GH_CMD_RE)) {
    found.push({
      at: m.index ?? 0,
      ref: { kind: m[1] === 'pr' ? 'pr' : 'issue', num: parseInt(m[2]!, 10), repo: named },
    });
  }
  if (bare) {
    for (const m of text.matchAll(BARE_RE)) {
      // A bare number cannot say whether it is a PR or an issue. Call it a PR:
      // that is what the bar shows, GitHub resolves /pull/<n> for an issue
      // number by redirecting, and being wrong about the word costs nothing
      // next to not showing the number at all.
      found.push({ at: m.index ?? 0, ref: { kind: 'pr', num: parseInt(m[1]!, 10) } });
    }
  }

  // Earliest first into `push`, which unshifts — so what comes out is
  // last-mentioned-first.
  found.sort((a, b) => a.at - b.at);
  const out: PrRef[] = [];
  for (const { ref } of found) push(out, ref);
  return out.filter(r => r.num > 0);
}

/** Merge freshly reported references into what a session already had, newest
 *  first, capped. Returns null when nothing changed, so callers can skip a
 *  write and a broadcast — this runs on every tool call. */
export function mergePrRefs(prev: PrRef[], next: PrRef[]): PrRef[] | null {
  if (next.length === 0) return null;
  const merged = [...prev];
  // Reversed: `push` unshifts, so replaying in reverse leaves the first
  // reference of `next` at the front.
  for (const ref of [...next].reverse()) push(merged, ref);
  const capped = merged.slice(0, MAX_REFS);
  const same = capped.length === prev.length && capped.every((r, i) => {
    const p = prev[i];
    return !!p && p.kind === r.kind && p.num === r.num && p.url === r.url && p.repo === r.repo;
  });
  return same ? null : capped;
}
