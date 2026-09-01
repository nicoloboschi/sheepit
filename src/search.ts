/**
 * Search across the open panes: which sheep is working on this?
 *
 * With twenty panes open, "who is on PR 3993?" is answered by clicking through
 * pens and reading. Everything needed to answer it is already here — the
 * pane's name, cwd and branch, the PR references its hooks reported, the last
 * few exchanges — and the rest is in the agent's own transcript on disk.
 *
 * What this does NOT read is the terminal. The scrollback is bytes to render,
 * not a source of facts (see "Nothing reads the terminal as text" in
 * CLAUDE.md); this searches what the agents themselves recorded.
 *
 * Everything here is pure. The endpoint in api.ts does the I/O — reading the
 * facts out of the bridge and running ripgrep — and this decides what matches,
 * how well, and what the reader is shown.
 */
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import type { PrRef } from './pr-refs.js';

/** Where a match came from, and how loudly it answers the question. */
export type MatchSource = 'pr' | 'name' | 'branch' | 'path' | 'turn' | 'transcript';

export interface SearchQuery {
  /** What was typed, trimmed. */
  raw: string;
  /** Lowercased words. A field matches when it contains ALL of them. */
  terms: string[];
  /** The number in a query like `3993`, `#3993` or `pr 3993`. Its own field
   *  because it is the question people actually ask, and because a PR
   *  reference is an exact match rather than a substring. */
  prNumber: number | null;
}

export function parseQuery(raw: string): SearchQuery {
  const trimmed = raw.trim();
  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  // `3993`, `#3993`, `pr 3993`, `pr#3993`, `issue 88` — the label is optional
  // and ignored, since a bare number is by far the common case.
  const m = trimmed.match(/^(?:(?:pr|pull|issue|ticket)\b[\s#:_-]*)?#?(\d{1,6})$/i);
  return { raw: trimmed, terms, prNumber: m ? parseInt(m[1]!, 10) : null };
}

/** The facts the server holds about one pane, as search sees them. */
export interface SessionFacts {
  id: string;
  name: string;
  path?: string;
  gitBranch?: string;
  prRefs?: PrRef[];
}

/** One exchange, newest first (see AgentTurn in direct-bridge). */
export interface TurnText {
  prompt?: string;
  response?: string;
  /** When it was reported, for "20m ago" beside the result. */
  at?: number;
}

export interface Match {
  source: MatchSource;
  /** What to show under the pane's name. Already trimmed to a readable width. */
  snippet: string;
  score: number;
  /** When the matched message was written, epoch ms. Absent for the sources
   *  that are not a message — a name or a branch has no "when". */
  at?: number;
}

/** How loudly each source answers "who is working on this?".
 *
 *  A PR reference is an exact fact the agent reported, so it wins outright.
 *  The pane's own name is next — it was chosen to describe the work. Text
 *  from the conversation comes last, because a term can appear in a turn for
 *  any number of reasons, including the agent being told NOT to do something. */
const WEIGHT: Record<MatchSource, number> = {
  pr: 1000, name: 500, branch: 300, path: 200, turn: 100, transcript: 50,
};

/** Longest snippet we return. Two lines in the palette at its width. */
const SNIPPET_LEN = 160;

/** How many occurrences of `term` are in `lower`, and where the first is. */
function occurrences(lower: string, term: string): { count: number; first: number } {
  let count = 0, first = -1, i = lower.indexOf(term);
  while (i >= 0) {
    if (first < 0) first = i;
    count++;
    i = lower.indexOf(term, i + term.length);
  }
  return { count, first };
}

/** A fragment of `clean` around `at`. A third of the window sits before the
 *  match: the words after a term are usually the ones that explain it. */
function fragment(clean: string, at: number, width: number): { start: number; end: number } {
  const start = Math.max(0, at - Math.floor(width / 3));
  return { start, end: Math.min(clean.length, start + width) };
}

/**
 * The part of `text` that shows why it matched.
 *
 * A snippet that does not contain the thing you searched for is worse than no
 * snippet: it reads as a wrong result. Three cases, in order:
 *
 *   - everything fits — show it all;
 *   - the terms sit close enough together — one window over all of them;
 *   - they are far apart — two fragments joined by an ellipsis, anchored on
 *     the *rarest* term (the one that actually distinguishes this pane; a
 *     query like "pane bar" would otherwise centre on the first of a hundred
 *     "pane"s and never reach "bar").
 */
export function snippetAround(text: string, terms: string[], max = SNIPPET_LEN): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const lower = clean.toLowerCase();

  const found = terms
    .map(t => ({ term: t, ...occurrences(lower, t) }))
    .filter(f => f.first >= 0)
    // Rarest first, longest breaking the tie: that is the term carrying the
    // information, and the one the reader is looking for.
    .sort((a, b) => a.count - b.count || b.term.length - a.term.length);

  if (found.length === 0) return clean.slice(0, max).trimEnd() + '…';

  const anchor = found[0]!;
  const lo = Math.min(...found.map(f => f.first));
  const hi = Math.max(...found.map(f => f.first + f.term.length));

  // All of them within one window: show the span that covers them.
  if (hi - lo <= max) {
    const { start, end } = fragment(clean, lo, max);
    return (start > 0 ? '…' : '') + clean.slice(start, end).trim() + (end < clean.length ? '…' : '');
  }

  // Too far apart for one window. Take the rarest term, then the furthest
  // term from it that is still missing, and show both halves.
  const other = found.slice(1).find(f => Math.abs(f.first - anchor.first) > max / 2) ?? null;
  const width = other ? Math.floor(max / 2) : max;
  const spans = [fragment(clean, anchor.first, width)];
  if (other) spans.push(fragment(clean, other.first, width));
  spans.sort((a, b) => a.start - b.start);

  return spans
    .map((sp, i) => (i === 0 && sp.start > 0 ? '…' : '') + clean.slice(sp.start, sp.end).trim())
    .join(' … ') + (spans[spans.length - 1]!.end < clean.length ? '…' : '');
}

/** Does this text actually contain what ripgrep matched?
 *
 *  Ripgrep searches the raw JSONL line, so a hit can land anywhere in the
 *  row — a uuid, a file path in a tool result, an id in machinery nobody
 *  wrote. When the message we would show does not contain the term, the match
 *  was not in the conversation, and showing it is worse than showing nothing:
 *  it reads as a wrong answer with a snippet to prove it. */
export function containsPattern(text: string, pattern: string): boolean {
  return text.toLowerCase().includes(pattern.toLowerCase());
}

/** Does this haystack contain every term? */
function hasAll(haystack: string | undefined, terms: string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return terms.every(t => lower.includes(t));
}

/**
 * Match a pane on what the server already knows — no disk, no subprocess.
 *
 * Returns the single best match, because the palette shows one row per pane:
 * a pane that matches on both its name and a turn is one answer, not two.
 */
export function matchFacts(
  facts: SessionFacts, turns: TurnText[], q: SearchQuery,
): Match | null {
  if (q.terms.length === 0) return null;
  const out: Match[] = [];

  if (q.prNumber !== null) {
    const ref = facts.prRefs?.find(r => r.num === q.prNumber);
    if (ref) {
      out.push({ source: 'pr', snippet: `${ref.kind === 'issue' ? 'issue' : 'pr'} #${ref.num}${ref.repo ? ` · ${ref.repo}` : ''}`, score: WEIGHT.pr });
    }
  }
  if (hasAll(facts.name, q.terms)) out.push({ source: 'name', snippet: facts.name, score: WEIGHT.name });
  if (hasAll(facts.gitBranch, q.terms)) out.push({ source: 'branch', snippet: facts.gitBranch!, score: WEIGHT.branch });
  if (hasAll(facts.path, q.terms)) out.push({ source: 'path', snippet: facts.path!, score: WEIGHT.path });

  turns.forEach((turn, i) => {
    // Recency counts, and so does who said it: what you asked describes the
    // work better than what the agent replied, which may be quoting the
    // question back or explaining why it did not do it.
    const recency = Math.max(0, 20 - i * 10);
    if (hasAll(turn.prompt, q.terms)) {
      out.push({ source: 'turn', snippet: snippetAround(turn.prompt!, q.terms), score: WEIGHT.turn + 25 + recency, at: turn.at });
    } else if (hasAll(turn.response, q.terms)) {
      out.push({ source: 'turn', snippet: snippetAround(turn.response!, q.terms), score: WEIGHT.turn + recency, at: turn.at });
    }
  });

  if (out.length === 0) return null;
  return out.sort((a, b) => b.score - a.score)[0]!;
}

/** Score a transcript hit. `count` is how many lines matched in that file. */
export function transcriptScore(role: 'user' | 'assistant', count: number): number {
  // Capped: a pane that mentioned the term forty times is not eight times more
  // relevant than one that mentioned it five times, and letting the count run
  // free would let one chatty session bury every other answer.
  return WEIGHT.transcript + (role === 'user' ? 25 : 0) + Math.min(count, 5) * 2;
}

/** One readable line out of an agent transcript, or null for a line that is
 *  not something a person said or read.
 *
 *  Both agents write JSONL, and most of it is not conversation: Claude's
 *  `attachment`, `system` and tool-result rows, Codex's `developer` rows
 *  carrying the whole skills preamble. Dropping them is not tidiness — a
 *  search for "skills" would otherwise match every Codex pane on a preamble
 *  nobody wrote. */
export function transcriptLineText(line: string): { role: 'user' | 'assistant'; text: string; at?: number } | null {
  let row: any;
  try { row = JSON.parse(line); } catch { return null; }
  if (!row || typeof row !== 'object') return null;

  // Claude Code: one row per message, `user` content is a plain string and
  // `assistant` content is a block list.
  if (row.type === 'user' || row.type === 'assistant') {
    // A subagent's exchange belongs to the subagent, not to this pane.
    if (row.isSidechain === true) return null;
    const content = row.message?.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content)
        ? content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
        : '';
    return text.trim() ? { role: row.type, text: text.trim(), at: rowTime(row) } : null;
  }

  // Codex: rollout rows, where the conversation lives in `response_item`.
  if (row.type === 'response_item' && row.payload?.type === 'message') {
    const role = row.payload.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const text = Array.isArray(row.payload.content)
      ? row.payload.content.filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text).join('\n')
      : '';
    return text.trim() ? { role, text: text.trim(), at: rowTime(row) } : null;
  }

  return null;
}

/** When a transcript row was written. Both agents stamp every row with an ISO
 *  `timestamp`, which is what puts "20m ago" beside a result — the pane's own
 *  last activity would answer a different question, since a pane can be busy
 *  now on something it discussed yesterday. */
function rowTime(row: any): number | undefined {
  const t = Date.parse(row?.timestamp ?? '');
  return Number.isFinite(t) ? t : undefined;
}

/** Directories a transcript may live in. */
function transcriptRoots(): string[] {
  return [
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.codex', 'sessions'),
  ];
}

/**
 * Is this a path we are willing to open?
 *
 * The path arrives from a hook, and the endpoint that takes it is reachable by
 * anything running on this machine — so it is untrusted input that ends up as
 * an argument to a file reader. Resolved first, so `../` cannot climb out of
 * an allowed root, and matched against the root plus a separator, so
 * `~/.claude/projects-of-mine` does not pass as `~/.claude/projects`.
 */
export function isSearchableTranscript(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  if (!path.endsWith('.jsonl')) return false;
  const full = resolve(path);
  return transcriptRoots().some(root => full.startsWith(root + sep));
}

/** The pattern handed to ripgrep for the transcript pass.
 *
 *  A numeric query searches the number itself rather than the phrase, so
 *  "pr 3993" finds "#3993", "PR 3993" and "pull/3993" alike. Everything else
 *  is a literal phrase (ripgrep runs it with -F): predictable, and what people
 *  mean when they type two words. */
export function transcriptPattern(q: SearchQuery): string {
  return q.prNumber !== null ? String(q.prNumber) : q.raw;
}
