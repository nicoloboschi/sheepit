import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw, GitPullRequest, CircleDot, ExternalLink, Link2, Check,
  CircleCheck, CircleX, Clock, MessageSquare, GitMerge, Search, X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseDiff, type DiffFile } from '../diff';
import { externalClick } from '../openExternal';
import { copyText } from '../utils';
// The one diff viewer — the tree and the diffs, laid out the same way the
// working tree is read in. It defers FileView (CodeMirror and sixteen language
// packs) behind a lazy import, so a PR you have not opened loads none of it.
import { ChangedFiles } from './GitDiffPane';

/**
 * The GitHub half of the git view — pull requests and issues, read only.
 *
 * It exists to stop a review meaning a trip to the browser. The pane already
 * knows which repository it is in, and `gh` on this machine is already signed
 * in to it, so there is no GitHub client here, no token and no OAuth app:
 * every panel below is one `gh` call the server made, rendered.
 *
 * **Read only is the whole scope.** Approving, commenting and merging are the
 * obvious next things, and every one of them is a write to somebody else's
 * repository from a pane anything on the LAN can reach. The "open on GitHub"
 * button is what you press when you want to do one — and it is also where CI
 * links go, because a build log is a live JavaScript page and this pane
 * renders none of that.
 *
 * Layout: **the list never goes away.** It is a narrow column down the left,
 * and whatever you picked fills the rest — reading a PR and moving to the next
 * one is the loop this pane is for, and a list you had to navigate back to put
 * a click in the middle of it. Inside the detail, a pull request reads top to
 * bottom: what it is and what it says, full width, and only then what it
 * changed, in two columns.
 */

export interface GhRef {
  kind: 'pr' | 'issue';
  num: number;
  /** `owner/repo`, when the reference named one — a link clicked in the
   *  terminal can point at a repository this pane is not standing in. */
  repo?: string;
}

type Checks = 'PASS' | 'FAIL' | 'PENDING' | null;

interface ListRow {
  kind: 'pr' | 'issue';
  number: number;
  title: string;
  author: string;
  state: string;
  /** Issues only: what a closed one was closed *as*. It is what tells a
   *  resolved issue from an abandoned one, and so what picks its colour. */
  stateReason?: string | null;
  isDraft?: boolean;
  updatedAt: string;
  url: string;
  // No `checks` here on purpose — asking a list for them costs ten seconds and
  // fails on closed PRs. See the list route in api.ts. CI lives in the detail.
}

/** A half that is `null` is one `gh` could not answer for — distinct from an
 *  empty array, which means the repository genuinely has none. Rendering the
 *  two the same way is how a rate-limited refresh came to say "None.". */
interface GhList {
  prs: ListRow[] | null;
  issues: ListRow[] | null;
  repo?: string | null;
  /** How many there are in the repository, against the rows above — a list of
   *  30 must not claim the repository has 30. Null when GitHub would not say. */
  prTotal?: number | null;
  issueTotal?: number | null;
  /** Search only: how many GitHub says there are, and the query it answered —
   *  ours plus the `repo:` scope, so the panel can show what it really asked. */
  searchTotal?: number | null;
  q?: string;
}

interface Comment { author: string; body: string; createdAt: string; }
interface CheckRun { name: string; workflow: string; conclusion: string; url: string; }
/** The thing on the other end of a link — an issue this PR closes, or a PR
 *  that closes this issue. `kind` is which, so the chip draws the right mark
 *  and opens it as the right thing. */
interface LinkedRef { kind: 'pr' | 'issue'; number: number; title: string; state: string; stateReason?: string | null; url: string; }

interface GhItem {
  kind: 'pr' | 'issue';
  /** `owner/repo` this belongs to — what the cache is keyed on. */
  repo?: string | null;
  number: number;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  isDraft: boolean;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  baseRefName: string | null;
  headRefName: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  checks: Checks;
  checkRuns: CheckRun[];
  labels: { name: string; color: string }[];
  comments: Comment[];
  /** Optional on the way in: a payload cached by an older build has no
   *  `linked`, and a missing link list must not take the panel down. */
  linked?: LinkedRef[];
  diff: string;
  diffTruncated: boolean;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/** The server coalesces on the same clock; this is the half that makes moving
 *  between one PR and the next and back cost nothing at all, rather than merely
 *  costing no GitHub round-trip. It is module-level so it survives the pane
 *  unmounting when you switch to the terminal and back. */
/** How long an answer is shown without checking. */
const FRESH_MS = 30_000;
/** How long it is still worth showing while a fresh one is fetched behind it.
 *
 *  A cold `gh pr list` takes ten seconds on a large repository, so an answer
 *  thrown away after thirty was one somebody had to wait ten seconds for
 *  again. Past `FRESH_MS` the rows go up instantly and are replaced when the
 *  refresh lands — the list stops being something you wait for at all. */
const KEEP_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

function cacheGet<T>(key: string): { value: T; stale: boolean; at: number } | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  const age = Date.now() - hit.at;
  if (age >= KEEP_MS) { cache.delete(key); return undefined; }
  // `at` rides along so the detail header can say how old what you are reading
  // is: an answer served from here can be up to KEEP_MS old.
  return { value: hit.value as T, stale: age >= FRESH_MS, at: hit.at };
}

function cacheSet(key: string, value: unknown): void {
  cache.set(key, { at: Date.now(), value });
  // Bounded the way the server's coalescer is: keys are per repository and per
  // filter, so the set is small, but a map that only grows is a leak.
  if (cache.size > 64) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at >= KEEP_MS) cache.delete(k);
  }
}

/**
 * Which repository a pane is looking at, learned from the answers.
 *
 * The cache is keyed on `owner/repo`, never on the session: a pull request
 * belongs to GitHub, not to the pane that asked, and eight worktrees of one
 * project asking eight times for the same list is the thing this exists to
 * stop. But a pane cannot know its repository before it has asked once — so
 * every answer names it, and this remembers it for every later lookup.
 *
 * The one fetch per session that funds this is answered from the server's own
 * repo-keyed cache in about a millisecond.
 */
const repoOf = new Map<string, string>();

/** Rows per page. `gh` has no offset, so "more" is the same query with a
 *  bigger limit; the server caps it, because a list nobody scrolls to the end
 *  of should not fetch a thousand rows to prove it could. */
const PAGE = 30;

/** Where the scroll stops asking. The server caps it at the same number; past
 *  a few hundred rows the question is a search, not a list. */
const MAX_ROWS = 300;

/** "30 of 214" while there are more, and just the number once the list holds
 *  all of them — a count that keeps saying "214 of 214" is reading work for
 *  nothing. Falls back to the rows when GitHub would not say a total. */
function countLabel(shown: number, total: number | null | undefined): string {
  return typeof total === 'number' && total > shown ? `${shown} of ${total}` : String(total ?? shown);
}

/** An explicit repo wins over the memo, here too: the GitHub panel names the
 *  repository it wants, which is usually not the one this session stands in. */
const listKey = (
  sid: string, kind: string, state: string, repo?: string, limit = PAGE, q = '',
): string =>
  // A search is its own answer: the kind and state filters are not part of it,
  // because the query says those itself.
  q
    ? `${repo ?? repoOf.get(sid) ?? sid}|search|${q}|${limit}`
    : `${repo ?? repoOf.get(sid) ?? sid}|list|${kind}|${state}|${limit}`;

/** An explicit repo wins over the memo: a link to somebody else's PR names its
 *  repository outright, so it is shared from the very first look. */
const refKey = (sid: string, num: number, repo?: string): string =>
  `${repo ?? repoOf.get(sid) ?? sid}|ref|${num}`;

// ── Small pieces ──────────────────────────────────────────────────────────────

const mono = 'var(--font-mono)';

/**
 * **A closed issue is not a failed issue.** GitHub closes an issue *as*
 * something, and which one it was decides the colour: `COMPLETED` is done, so
 * it takes the same violet the merged state does; `NOT_PLANNED` and
 * `DUPLICATE` are neither done nor broken, so they go muted.
 *
 * Terracotta is reserved — see the palette in CLAUDE.md, where it means errors
 * and deletions — and exactly one closed thing earns it: a pull request closed
 * without merging, which really is a dead end. Painting every `CLOSED` with it
 * reported a resolved issue as a failure.
 *
 * `kind` and `stateReason` are optional so the callers that never had them
 * still compile; a closed thing of unknown kind keeps the old colour. An issue
 * closed with no reason recorded (older ones report none) counts as completed,
 * which is what GitHub itself shows.
 */
function stateColor(it: { state: string; isDraft?: boolean; kind?: 'pr' | 'issue'; stateReason?: string | null }): string {
  if (it.isDraft) return 'var(--muted-foreground)';
  if (it.state === 'MERGED') return '#B79CCA';
  if (it.state === 'CLOSED') {
    if (it.kind !== 'issue') return '#E0907B';
    const reason = (it.stateReason ?? '').toUpperCase();
    return reason === 'NOT_PLANNED' || reason === 'DUPLICATE' ? 'var(--muted-foreground)' : '#B79CCA';
  }
  return '#9CBC7F';
}

/** The state in words, for the one case where the bare state misleads: a
 *  closed issue. "closed" alone is what made a resolved one read as a
 *  failure, and the label has to agree with the colour above. */
function stateLabel(it: { state: string; kind?: 'pr' | 'issue'; stateReason?: string | null }): string {
  if (it.state !== 'CLOSED' || it.kind !== 'issue') return it.state.toLowerCase();
  const reason = (it.stateReason ?? '').toUpperCase();
  if (reason === 'NOT_PLANNED') return 'closed as not planned';
  if (reason === 'DUPLICATE') return 'closed as duplicate';
  return 'closed as completed';
}

function checkColor(c: Checks): string {
  return c === 'PASS' ? '#9CBC7F' : c === 'FAIL' ? '#E0907B' : '#D9B84A';
}

function CheckIcon({ checks, size = 13 }: { checks: Checks; size?: number }) {
  if (!checks) return null;
  const Icon = checks === 'PASS' ? CircleCheck : checks === 'FAIL' ? CircleX : Clock;
  return <Icon size={size} style={{ color: checkColor(checks), flexShrink: 0 }} />;
}

function relTime(at: string | number): string {
  const then = new Date(at).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  const [n, unit] =
    secs < 60       ? [secs, 'second'] :
    secs < 3600     ? [secs / 60, 'minute'] :
    secs < 86400    ? [secs / 3600, 'hour'] :
    secs < 2592000  ? [secs / 86400, 'day'] :
    secs < 31536000 ? [secs / 2592000, 'month'] :
                      [secs / 31536000, 'year'];
  const v = Math.floor(n);
  return `${v} ${unit}${v === 1 ? '' : 's'} ago`;
}

/** A body is Markdown written by somebody else, so its links leave for the
 *  real browser rather than navigating this panel somewhere it cannot return
 *  from — the same rule the terminal follows for a printed URL. */
function Body({ text }: { text: string }) {
  if (!text.trim()) {
    return <div style={{ fontSize: 13.5, color: 'var(--muted-foreground)', fontStyle: 'italic' }}>No description.</div>;
  }
  return (
    <div className="md-preview" style={{ fontSize: 13.5, lineHeight: 1.65 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, href, ...p }) => (
            <a {...p} href={href} target="_blank" rel="noopener noreferrer" onClick={externalClick(href)} />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** A switch you can see every position of. A `<select>` hides its options
 *  behind a click and renders as an OS menu that ignores the theme — and with
 *  three or four short choices there is nothing to save by hiding them. */
function Segmented<T extends string>(
  { value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void },
) {
  return (
    <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
      {options.map(([id, label], i) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          style={{
            fontSize: 12, padding: '4px 10px', border: 'none',
            borderLeft: i > 0 ? '1px solid var(--border)' : 'none',
            background: value === id ? 'var(--primary)' : 'none',
            color: value === id ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
            cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1.5,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 16px', fontSize: 13, color: 'var(--muted-foreground)' }}>
      <RefreshCw size={13} className="animate-spin" />
      Loading {what}…
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--muted-foreground)', padding: 0, display: 'flex', alignItems: 'center',
};

const retryBtn: React.CSSProperties = {
  fontSize: 12, padding: '3px 10px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'none',
  color: 'var(--foreground)', cursor: 'pointer',
};

// ── List row ──────────────────────────────────────────────────────────────────

function Row(
  { row, active, onSelect }: { row: ListRow; active: boolean; onSelect: (r: GhRef) => void },
) {
  const Icon = row.kind === 'issue' ? CircleDot : row.state === 'MERGED' ? GitMerge : GitPullRequest;
  const color = stateColor(row);
  return (
    <button
      onClick={() => onSelect({ kind: row.kind, num: row.number })}
      style={{
        display: 'flex', flexDirection: 'column', gap: 3, width: '100%', textAlign: 'left',
        background: active ? 'var(--accent)' : 'none',
        borderLeft: active ? '2px solid var(--primary)' : '2px solid transparent',
        border: 'none', borderBottom: '1px solid var(--border)',
        padding: '8px 10px', cursor: 'pointer',
        // A draft is a pull request that is not asking anything of you yet, so
        // the whole row steps back — the number and icon already did (see
        // stateColor), and a title in full white kept pulling the eye to the
        // one row that did not want it.
        color: row.isDraft ? 'var(--muted-foreground)' : 'var(--foreground)',
      }}
      className={active ? undefined : 'hover:bg-white/5'}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
        <Icon size={13} style={{ color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontFamily: mono, color, flexShrink: 0 }}>#{row.number}</span>
      </span>
      <span style={{ fontSize: 13, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {row.title}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.author} · {relTime(row.updatedAt)}
        {row.isDraft && ' · draft'}
        {row.state !== 'OPEN' && ` · ${row.state.toLowerCase()}`}
      </span>
    </button>
  );
}

// ── The pane ──────────────────────────────────────────────────────────────────

/** One or the other, never both. Pull requests and issues are different jobs —
 *  reviewing and triaging — and a merged list made you read past half of it to
 *  find either. */
type KindFilter = 'pr' | 'issue';
type StateFilter = 'open' | 'closed' | 'merged' | 'all';

const KIND_OPTIONS = [['pr', 'PRs'], ['issue', 'Issues']] as const;
const STATE_OPTIONS = [['open', 'Open'], ['closed', 'Closed'], ['merged', 'Merged'], ['all', 'Any']] as const;

interface GithubPaneProps {
  sessionId: string | null;
  /** `owner/repo` to read instead of the session's own. The pane still needs a
   *  session — the routes are session-scoped, and `gh` runs somewhere — but
   *  every answer, and every cache key, belongs to this repository. */
  repo?: string | null;
  /** The reference being read, or null for none. Owned by the pane above so a
   *  link clicked in the terminal, or the pane bar's PR chip, can put one
   *  here. */
  selected: GhRef | null;
  onSelect: (ref: GhRef | null) => void;
}

export default function GithubPane({ sessionId, repo, selected, onSelect }: GithubPaneProps) {
  const [list, setList] = useState<GhList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listFailed, setListFailed] = useState(false);

  const [item, setItem] = useState<GhItem | null>(null);
  const [itemLoading, setItemLoading] = useState(false);
  /** What GitHub actually said, when it said something. A pane that only ever
   *  reports "could not load" makes every cause look like the same cause. */
  const [itemError, setItemError] = useState<string | null>(null);
  /** When what is on screen was fetched. Worth saying out loud because this
   *  pane deliberately shows a cached answer first — up to KEEP_MS old — and
   *  refreshes behind it, so "merged" or a green tick can be ten minutes stale
   *  with nothing on the panel admitting it. */
  const [itemAt, setItemAt] = useState<number | null>(null);

  const [kind, setKind] = useState<KindFilter>('pr');
  /** How deep the list goes. Grows as you scroll; back to one page whenever
   *  the question changes, because the rows below are answers to the old one. */
  const [limit, setLimit] = useState(PAGE);
  // Open only: the reason to open this list is the work in front of you, and a
  // repository's closed PRs outnumber its open ones by a hundred to one.
  const [state, setState] = useState<StateFilter>('open');
  const [query, setQuery] = useState('');
  /** The submitted GitHub search, passed to GitHub exactly as typed. Empty
   *  means the plain list. */
  const [search, setSearch] = useState('');
  useEffect(() => { setLimit(PAGE); }, [repo, kind, state, search]);
  const [copied, setCopied] = useState(false);
  const [focusedFileIdx, setFocusedFileIdx] = useState(0);
  const detailRef = useRef<HTMLDivElement>(null);

  /**
   * Whether this pane knows which repository it is in yet.
   *
   * Nothing is fetched until it does. The caches are keyed on `owner/repo`, so
   * a pane that asked before learning its own would look under its session id,
   * miss, and spend ten seconds fetching a list eight sibling worktrees already
   * have. Asking `/repo` first costs one local `git remote` read.
   */
  const [slugReady, setSlugReady] = useState(() => !!repo || (!!sessionId && repoOf.has(sessionId)));

  useEffect(() => {
    if (repo) { setSlugReady(true); return; }
    if (!sessionId) return;
    if (repoOf.has(sessionId)) { setSlugReady(true); return; }
    setSlugReady(false);
    let cancelled = false;
    fetch(`/api/git/${encodeURIComponent(sessionId)}/repo`)
      .then(r => r.json())
      .then((d: { repo?: string | null }) => { if (!cancelled && d?.repo) repoOf.set(sessionId, d.repo); })
      .catch(() => { /* no remote, or no server — fall back to the session key */ })
      // Ready either way: a repository we could not name is one we key by
      // session, which is worse but still works.
      .finally(() => { if (!cancelled) setSlugReady(true); });
    return () => { cancelled = true; };
  }, [sessionId, repo]);

  const loadList = useCallback(async (force = false) => {
    if (!sessionId || !slugReady) return;
    const hit = force ? undefined : cacheGet<GhList>(listKey(sessionId, kind, state, repo ?? undefined, limit, search));
    if (hit) {
      setList(hit.value);
      setListFailed(false);
      // Fresh enough to stand alone. Otherwise the rows stay up and the fetch
      // below runs behind them, so nobody waits for a list they can already
      // read.
      if (!hit.stale) return;
    }
    // The previous rows stay on screen while this runs — a refresh should look
    // like a refresh, not like the list being emptied and refilled.
    setListLoading(true); setListFailed(false);
    try {
      const res = await fetch(`/api/git/${encodeURIComponent(sessionId)}/gh/list?kind=${kind}&state=${state}&limit=${limit}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`);
      const data = await res.json() as GhList | null;
      if (!data) { setListFailed(true); setList(null); return; }
      // Only a wholly good answer is worth keeping: caching a half that failed
      // would serve the gap back for the next 30s.
      // Learn the repository before storing, so this lands under the shared
      // key rather than under the session that happened to ask first.
      if (data.repo) repoOf.set(sessionId, data.repo);
      if (data.prs !== null && data.issues !== null) cacheSet(listKey(sessionId, kind, state, repo ?? undefined, limit, search), data);
      setList(data);
    } catch { setListFailed(true); }
    finally { setListLoading(false); }
  }, [sessionId, repo, kind, state, limit, search, slugReady]);

  const loadItem = useCallback(async (force = false) => {
    if (!sessionId || !selected || !slugReady) return;
    // No kind in the key: the server resolves it, so both spellings of one
    // number are the same answer and must not be fetched twice.
    const hit = force ? undefined : cacheGet<GhItem>(refKey(sessionId, selected.num, selected.repo));
    if (hit) {
      setItem(hit.value);
      setItemError(null);
      setItemAt(hit.at);
      if (!hit.stale) return;
      // Stale: refresh behind what is already on screen, so the description
      // does not blink out and come back the same.
      setItemLoading(true);
    } else {
      setItemLoading(true); setItemError(null); setItem(null); setItemAt(null);
    }
    try {
      const q = selected.repo ? `?repo=${encodeURIComponent(selected.repo)}` : '';
      // The kind here is only a hint — the server works out whether the number
      // is a pull request or an issue and answers with whichever it is.
      const res = await fetch(`/api/git/${encodeURIComponent(sessionId)}/gh/${selected.kind}/${selected.num}${q}`);
      const data = await res.json() as (GhItem & { error?: string }) | null;
      if (!data || data.error) { setItemError(data?.error ?? 'Could not load it from GitHub.'); return; }
      if (data.repo) repoOf.set(sessionId, data.repo);
      cacheSet(refKey(sessionId, selected.num, selected.repo ?? data.repo ?? undefined), data);
      setItem(data);
      setItemAt(Date.now());
    } catch (e) { setItemError(String(e)); }
    finally { setItemLoading(false); }
  }, [sessionId, selected, slugReady]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadItem(); }, [loadItem]);
  // The "loaded …" label has to keep counting. Frozen at whatever it said when
  // the answer landed it becomes the opposite of the thing it is for — a panel
  // that has been open for an hour insisting it loaded a moment ago.
  const [, bumpClock] = useState(0);
  useEffect(() => {
    if (itemAt === null) return;
    const t = setInterval(() => bumpClock(n => n + 1), 15_000);
    return () => clearInterval(t);
  }, [itemAt]);
  // A different reference starts at the top and on its first file — otherwise
  // a short issue opens halfway down, where the last PR's diff was.
  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 });
    setFocusedFileIdx(0);
  }, [selected?.num, selected?.repo]);

  const files: DiffFile[] = useMemo(() => (item?.diff ? parseDiff(item.diff) : []), [item?.diff]);

  const jumpToFile = (path: string): void => {
    detailRef.current?.querySelector(`[data-file="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /**
   * One box, three things — in the order that a keystroke could mean them.
   *
   * A number or a pasted URL names one pull request or issue, and typing the
   * number is the fastest way to it. Anything else is **GitHub's own search**,
   * sent exactly as typed: `is:pr review-requested:@me`, `label:bug
   * sort:updated`, the same string that works in the box on github.com. An
   * empty box goes back to the plain list.
   */
  const submitQuery = (): void => {
    const raw = query.trim();
    if (!raw) { setSearch(''); return; }
    const url = raw.match(/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/);
    if (url) {
      onSelect({ kind: url[3] === 'issues' ? 'issue' : 'pr', num: Number(url[4]), repo: `${url[1]}/${url[2]}` });
      setQuery('');
      return;
    }
    const n = raw.match(/^#?(\d+)$/);
    if (!n) { setSearch(raw); return; }
    // A bare number does not say whether it is a pull request or an issue, and
    // guessing from the filter above was wrong half the time — typing an issue
    // id asked `gh pr view`, which fails outright on an issue. The server
    // resolves it now, so this only has to name the number.
    onSelect({ kind: 'pr', num: Number(n[1]) });
    setQuery('');
  };

  // ── Top toolbar: filters and search, over both columns ──────────────────────

  const toolbar = (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--card)', flexShrink: 0, flexWrap: 'wrap' }}
      onClick={(e) => e.stopPropagation()}
    >
      <Segmented value={kind} options={KIND_OPTIONS} onChange={setKind} />
      {/* The state filter is the list's, not the search's: a query says
          `state:closed` itself, and leaving ours on screen beside it would be
          two controls claiming the same thing. */}
      {!search && <Segmented value={state} options={STATE_OPTIONS} onChange={setState} />}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 90 }}>
        <Search size={12} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submitQuery(); }}
          placeholder="#id, URL, or a GitHub search"
          style={{
            fontSize: 12.5, padding: '4px 7px', width: '100%', minWidth: 0,
            background: 'var(--background)', color: 'var(--foreground)',
            border: '1px solid var(--border)', borderRadius: 6,
          }}
        />
      </span>
      {listLoading
        ? <RefreshCw size={13} color="var(--muted-foreground)" className="animate-spin" />
        : <button onClick={() => loadList(true)} title="Refresh the list" style={iconBtn} className="hover:text-foreground"><RefreshCw size={13} /></button>}
      {search && (
        // What GitHub was actually asked, including the `repo:` scope the
        // server adds when the query names none — a search you cannot read
        // back is one you cannot correct.
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', fontSize: 11.5, color: 'var(--muted-foreground)' }}>
          <span style={{ fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {list?.q ?? search}
          </span>
          {typeof list?.searchTotal === 'number' && (
            <span style={{ flexShrink: 0 }}>
              · {list.searchTotal} result{list.searchTotal === 1 ? '' : 's'}
              {list.searchTotal > (list.prs?.length ?? 0) + (list.issues?.length ?? 0) ? `, showing ${(list.prs?.length ?? 0) + (list.issues?.length ?? 0)}` : ''}
            </span>
          )}
          <button
            onClick={() => { setSearch(''); setQuery(''); }}
            title="Back to the list"
            style={{ ...iconBtn, flexShrink: 0 }}
            className="hover:text-foreground"
          >
            <X size={12} />
          </button>
        </span>
      )}
    </div>
  );

  // ── The list column ─────────────────────────────────────────────────────────

  const sections = list && (
    // Dimmed while a refresh is in flight, never emptied: the rows on screen
    // are still the best answer anyone has until the new ones arrive.
    <div style={{ opacity: listLoading ? 0.55 : 1, transition: 'opacity 0.15s ease' }}>
      {([['Pull requests', list.prs, 'pr'], ['Issues', list.issues, 'issue']] as const).map(([heading, rows, k]) => (
        k === kind && (
          <div key={heading}>
            <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)', padding: '9px 10px 4px', position: 'sticky', top: 0, background: 'var(--background)' }}>
              {heading}{rows ? ` (${countLabel(rows.length, k === 'pr' ? list.prTotal : list.issueTotal)})` : ''}
            </div>
            {rows === null ? (
              // Not "None." — GitHub did not answer, and saying the repository
              // has none would be inventing the answer.
              <div style={{ fontSize: 12.5, color: '#D9B84A', padding: '2px 10px 9px', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                Could not reach GitHub.
                <button onClick={() => loadList(true)} style={retryBtn} className="hover:bg-white/5">Retry</button>
              </div>
            ) : rows.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted-foreground)', padding: '2px 10px 9px' }}>None.</div>
            ) : (
              rows.map(r => (
                <Row
                  key={`${r.kind}${r.number}`}
                  row={r}
                  active={selected?.num === r.number}
                  onSelect={onSelect}
                />
              ))
            )}
          </div>
        )
      ))}
    </div>
  );

  /** The deepest the rows could go, so the scroll knows when to stop asking
   *  and the heading knows whether "more" exists at all. */
  const shownRows = (kind === 'pr' ? list?.prs : list?.issues)?.length ?? 0;
  const totalRows = (kind === 'pr' ? list?.prTotal : list?.issueTotal) ?? null;
  const hasMore = totalRows !== null ? shownRows < totalRows : shownRows >= limit;

  const listColumn = (
    <div
      // Infinite scroll, not a button: the rows are a column you read
      // downwards, and "load more" at the bottom of a scroll you are already
      // doing is a click that says nothing the scroll did not.
      onScroll={e => {
        if (listLoading || !hasMore || limit >= MAX_ROWS) return;
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
          setLimit(l => Math.min(MAX_ROWS, l + PAGE));
        }
      }}
      style={{
        // ~20% of the half-pane, with a floor so it stays a list rather than a
        // column of ellipses, and a ceiling so a wide window does not hand it
        // space the diff wants.
        width: '22%', minWidth: 170, maxWidth: 300,
        flexShrink: 0, borderRight: '1px solid var(--border)',
        overflowY: 'auto', background: 'var(--background)',
      }}
    >
      {listFailed ? (
        <div style={{ padding: 12, fontSize: 12.5, color: 'var(--muted-foreground)', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', lineHeight: 1.55 }}>
          Could not load from GitHub. Needs <code style={{ fontFamily: mono }}>gh</code> signed in and a GitHub remote.
          <button onClick={() => loadList(true)} style={retryBtn} className="hover:bg-white/5">Retry</button>
        </div>
      ) : listLoading && !list ? (
        <Loading what="the list" />
      ) : sections}
      {list && listLoading && shownRows > 0 && (
        <div style={{ padding: '8px 10px', fontSize: 11.5, color: 'var(--muted-foreground)' }}>Loading more…</div>
      )}
      {list && !hasMore && shownRows > PAGE && (
        <div style={{ padding: '8px 10px', fontSize: 11.5, color: 'var(--muted-foreground)' }}>That is all of them.</div>
      )}
    </div>
  );

  // ── The detail column ───────────────────────────────────────────────────────

  const detailHeader = item && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border)', background: 'var(--card)', flexShrink: 0 }}>
      <span style={{ fontSize: 12, fontFamily: mono, color: stateColor(item) }}>#{item.number}</span>
      {itemAt !== null && (
        <span
          title={`Fetched from GitHub at ${new Date(itemAt).toLocaleString()}`}
          style={{ fontSize: 11.5, color: 'var(--muted-foreground)' }}
        >
          {/* "loaded 0 seconds ago" is noise dressed as precision. It says
              `new` until the clock's first bump and only then starts
              counting, so the threshold is the tick interval itself — any
              smaller and there would be a gap reading "0 seconds ago" again. */}
          {Date.now() - itemAt < 15_000 ? 'loaded new' : `loaded ${relTime(itemAt)}`}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {itemLoading
        ? <RefreshCw size={13} color="var(--muted-foreground)" className="animate-spin" />
        : <button onClick={() => loadItem(true)} title="Refresh this one" style={iconBtn} className="hover:text-foreground"><RefreshCw size={13} /></button>}
      {/* The URL itself, for pasting somewhere else — a terminal, a message,
          a browser that did not open on its own. */}
      <button
        onClick={() => { void copyText(item.url).then(ok => { if (!ok) return; setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
        title="Copy link"
        style={{ ...iconBtn, color: copied ? '#9CBC7F' : 'var(--muted-foreground)' }}
        className="hover:text-foreground"
      >
        {copied ? <Check size={13} /> : <Link2 size={13} />}
      </button>
      <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={externalClick(item.url)} title="Open on GitHub" style={iconBtn} className="hover:text-foreground">
        <ExternalLink size={13} />
      </a>
    </div>
  );

  /** Everything about the reference except what it changed. Full width: a
   *  description squeezed into a column beside a file list is the thing this
   *  pane exists to be better than. */
  const head = item && (
    <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          {item.kind === 'issue'
            ? <CircleDot size={16} style={{ color: stateColor(item), alignSelf: 'center' }} />
            : item.state === 'MERGED'
              ? <GitMerge size={16} style={{ color: stateColor(item), alignSelf: 'center' }} />
              : <GitPullRequest size={16} style={{ color: stateColor(item), alignSelf: 'center' }} />}
          <span style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>{item.title}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 7, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted-foreground)' }}>
          <span style={{ color: stateColor(item), textTransform: 'lowercase', fontWeight: 600 }}>
            {item.isDraft ? 'draft' : stateLabel(item)}
          </span>
          <span>{item.author} · {relTime(item.createdAt)}</span>
          {item.headRefName && <span style={{ fontFamily: mono }}>{item.baseRefName} ← {item.headRefName}</span>}
          {item.kind === 'pr' && item.changedFiles > 0 && (
            <span>
              {item.changedFiles} file{item.changedFiles === 1 ? '' : 's'}
              <span style={{ color: '#9CBC7F', marginLeft: 6 }}>+{item.additions}</span>
              <span style={{ color: '#E0907B', marginLeft: 4 }}>-{item.deletions}</span>
            </span>
          )}
          {item.reviewDecision && <span style={{ textTransform: 'lowercase' }}>{item.reviewDecision.replace(/_/g, ' ').toLowerCase()}</span>}
        </div>

        {item.labels.length > 0 && (
          <div style={{ display: 'flex', gap: 5, marginTop: 9, flexWrap: 'wrap' }}>
            {item.labels.map(l => (
              <span key={l.name} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: `1px solid #${l.color || '888888'}`, color: `#${l.color || '888888'}` }}>
                {l.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* What this is linked to: the issues a pull request closes, or the pull
          requests that close an issue. Each one is a BUTTON, not a link —
          following it moves this panel to that reference, which is the whole
          point of reading them here rather than on github.com. It carries the
          repository so a link into another repo resolves from the first look,
          the way the search box's pasted URLs already do. */}
      {item.linked?.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)' }}>
            {item.kind === 'pr'
              ? `Closes ${item.linked.length === 1 ? 'issue' : 'issues'}`
              : `Linked pull request${item.linked.length === 1 ? '' : 's'}`}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {item.linked.map(l => {
              const Icon = l.kind === 'issue' ? CircleDot : l.state === 'MERGED' ? GitMerge : GitPullRequest;
              const color = stateColor({ state: l.state, kind: l.kind, stateReason: l.stateReason });
              return (
                <button
                  key={`${l.kind}${l.number}`}
                  onClick={() => onSelect({ kind: l.kind, num: l.number, repo: item.repo ?? undefined })}
                  title={`${l.title} · ${l.state.toLowerCase()}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                    border: '1px solid var(--border)', borderRadius: 6, background: 'none',
                    color: 'var(--foreground)', padding: '4px 9px', fontSize: 12.5,
                    cursor: 'pointer', textAlign: 'left',
                  }}
                  className="hover:bg-white/5"
                >
                  <Icon size={12} style={{ color, flexShrink: 0 }} />
                  <span style={{ fontFamily: mono, color, flexShrink: 0 }}>#{l.number}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                    {l.title}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* CI. Every run links out to its own log — those are live pages, and
          following one here would be reimplementing Actions in a pane. */}
      {item.checkRuns.length > 0 && (
        <details style={{ border: '1px solid var(--border)', borderRadius: 6 }}>
          <summary style={{ cursor: 'pointer', padding: '8px 11px', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}>
            <CheckIcon checks={item.checks} />
            <span style={{ color: checkColor(item.checks) }}>{item.checks ? item.checks.toLowerCase() : 'checks'}</span>
            <span style={{ color: 'var(--muted-foreground)' }}>· {item.checkRuns.length} check{item.checkRuns.length === 1 ? '' : 's'}</span>
          </summary>
          <div style={{ borderTop: '1px solid var(--border)' }}>
            {item.checkRuns.map((c, i) => {
              const bad = c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.conclusion === 'CANCELLED';
              const pending = c.conclusion === 'PENDING' || c.conclusion === 'QUEUED' || c.conclusion === 'IN_PROGRESS' || c.conclusion === 'WAITING';
              const color = bad ? '#E0907B' : pending ? '#D9B84A' : '#9CBC7F';
              return (
                <a
                  key={`${c.name}${i}`}
                  href={c.url || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={externalClick(c.url)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 11px', fontSize: 12.5, textDecoration: 'none', color: 'var(--foreground)' }}
                  className="hover:bg-white/5"
                >
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.name}
                    {c.workflow && <span style={{ color: 'var(--muted-foreground)' }}> · {c.workflow}</span>}
                  </span>
                  <ExternalLink size={11} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                </a>
              );
            })}
          </div>
        </details>
      )}

      <Body text={item.body} />

      {item.comments.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)' }}>
            <MessageSquare size={12} />{item.comments.length} comment{item.comments.length === 1 ? '' : 's'}
          </div>
          {item.comments.map((c, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 5 }}>
                <b style={{ color: 'var(--foreground)' }}>{c.author}</b> · {relTime(c.createdAt)}
              </div>
              <Body text={c.body} />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  /** What it changed: the file tree and the diff, side by side, starting below
   *  the description. The tree sticks to the top as the diff scrolls past it,
   *  so it stays a way around a long PR. */
  const changed = item && item.kind === 'pr' && files.length > 0 && (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <div style={{ padding: '10px 16px 6px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)' }}>
        Files changed
      </div>
      {item.diffTruncated && (
        <div style={{ padding: '0 16px 8px', fontSize: 12.5, color: '#D9B84A' }}>
          Diff too large to show in full — open it on GitHub for the rest.
        </div>
      )}
      <ChangedFiles
        files={files}
        focusedIndex={focusedFileIdx}
        onSelect={setFocusedFileIdx}
        onJump={jumpToFile}
        scrollRoot={detailRef}
      />
    </div>
  );

  const detailColumn = (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {detailHeader}
      <div ref={detailRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {!selected ? (
          <div style={{ padding: '18px 16px', fontSize: 13, color: 'var(--muted-foreground)' }}>
            Pick a pull request or an issue.
          </div>
        ) : itemError ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--muted-foreground)', lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ fontFamily: mono, fontSize: 12.5, color: '#D9B84A' }}>{itemError}</div>
            <button onClick={() => loadItem(true)} style={retryBtn} className="hover:bg-white/5">Retry</button>
          </div>
        ) : itemLoading && !item ? (
          <Loading what={`#${selected.num}`} />
        ) : (
          <>{head}{changed}</>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--background)', color: 'var(--foreground)' }}>
      {toolbar}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        {listColumn}
        {detailColumn}
      </div>
    </div>
  );
}
