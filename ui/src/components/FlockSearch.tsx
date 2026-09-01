/**
 * Search the flock: which sheep is working on this?
 *
 * With twenty pens open, "who is on PR 3993?" was answered by clicking through
 * them and reading. This asks the server instead (`/api/search`), which matches
 * each pane's facts — its name, cwd, branch, the PR references its hooks
 * reported, its last few exchanges — and then its agent's own transcript.
 *
 * A result is a *pane*, not a line: the question is which sheep, so each row
 * carries one reason and Enter takes you there.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, GitBranch, GitPullRequest, MessageSquare, FolderTree, Tag } from 'lucide-react';
import { Dialog, DialogContent } from './ui/dialog';
import useStore from '../store';

/** What the server says matched. */
interface SearchHit {
  sessionId: string;
  source: 'pr' | 'name' | 'branch' | 'path' | 'turn' | 'transcript';
  snippet: string;
  score: number;
  matchCount: number;
}

/** A hit, resolved against the flock: which pen, which sheep, what it is called. */
interface Row extends SearchHit {
  workspaceId: string;
  paneIndex: number;
  name: string;
  penName: string;
  path?: string;
  branch?: string;
}

/** Long enough that a word is worth searching for, short enough that the
 *  answer arrives while you are still typing the next one. */
const DEBOUNCE_MS = 200;

const SOURCE_LABEL: Record<SearchHit['source'], string> = {
  pr: 'pr', name: 'name', branch: 'branch', path: 'path', turn: 'turn', transcript: 'said',
};

function SourceIcon({ source }: { source: SearchHit['source'] }): React.ReactElement {
  const size = 10;
  if (source === 'pr') return <GitPullRequest size={size} />;
  if (source === 'branch') return <GitBranch size={size} />;
  if (source === 'path') return <FolderTree size={size} />;
  if (source === 'name') return <Tag size={size} />;
  return <MessageSquare size={size} />;
}

/** Show the term in the snippet rather than leaving the reader to find it. */
function Highlighted({ text, terms }: { text: string; terms: string[] }): React.ReactElement {
  if (terms.length === 0) return <>{text}</>;
  // One pass, longest terms first, so "pr 39" does not chop up a match on "3993".
  const escaped = [...terms].sort((a, b) => b.length - a.length)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'ig'));
  return (
    <>
      {parts.map((part, i) =>
        terms.some(t => part.toLowerCase() === t)
          ? <mark key={i} className="flock-search-hit">{part}</mark>
          : <span key={i}>{part}</span>)}
    </>
  );
}

export default function FlockSearch({ onClose, onJump }: {
  onClose: () => void;
  /** Go to this pane — the pen first, then the sheep inside it. */
  onJump: (workspaceId: string, paneIndex: number) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inFlight = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  /** Resolve server hits (session ids) against the flock. The server deals in
   *  sessions and knows nothing about pens and panes — that mapping is the
   *  client's, and it is also what drops a hit whose pane has since closed. */
  const resolve = useCallback((hits: SearchHit[]): Row[] => {
    const { workspaces, workspaceOrder, sessionMap } = useStore.getState();
    const out: Row[] = [];
    for (const hit of hits) {
      for (const wsId of workspaceOrder) {
        const ws = workspaces[wsId];
        const paneIndex = ws?.cells.indexOf(hit.sessionId) ?? -1;
        if (!ws || paneIndex < 0) continue;
        const session = sessionMap[hit.sessionId];
        const rootName = sessionMap[ws.cells[0] ?? '']?.name;
        out.push({
          ...hit,
          workspaceId: wsId,
          paneIndex,
          name: session?.name ?? 'sheep',
          penName: rootName ?? wsId,
          path: session?.path,
          branch: session?.gitBranch,
        });
        break;
      }
    }
    return out;
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setRows([]); setBusy(false); inFlight.current?.abort(); return; }

    const timer = setTimeout(async () => {
      // Abort the previous request rather than letting it land: a slow answer
      // to "39" must not overwrite a fresh answer to "3993".
      inFlight.current?.abort();
      const ctl = new AbortController();
      inFlight.current = ctl;
      setBusy(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
        const data = await res.json();
        setRows(resolve(data.results ?? []));
        setCursor(0);
      } catch {
        // Aborted, or the server is unhappy — either way, show nothing rather
        // than a stale list.
        if (!ctl.signal.aborted) setRows([]);
      } finally {
        if (!ctl.signal.aborted) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, resolve]);

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rows]);

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[cursor];
      if (row) { onJump(row.workspaceId, row.paneIndex); onClose(); }
    }
  }

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="flock-search flex flex-col gap-0 p-0" onKeyDown={onKeyDown}>
        <div className="flock-search-field">
          <Search size={14} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search the flock — a PR number, a branch, something you said…"
            spellCheck={false}
          />
          {busy && <span className="flock-search-busy">…</span>}
        </div>

        <div className="flock-search-results" ref={listRef}>
          {rows.map((row, i) => (
            <button
              key={`${row.sessionId}-${row.source}`}
              type="button"
              data-active={i === cursor}
              className="flock-search-row"
              onMouseEnter={() => setCursor(i)}
              onClick={() => { onJump(row.workspaceId, row.paneIndex); onClose(); }}
            >
              <div className="flock-search-row-top">
                <span className="flock-search-sheep" aria-hidden>🐑</span>
                <span className="flock-search-name">{row.name}</span>
                <span className="flock-search-where">
                  {row.penName}
                  {row.branch && <><span className="flock-sep">·</span>{row.branch}</>}
                </span>
                <span className="flock-search-source">
                  <SourceIcon source={row.source} />
                  {SOURCE_LABEL[row.source]}
                  {row.matchCount > 1 && <span className="flock-search-count">{row.matchCount}</span>}
                </span>
              </div>
              <div className="flock-search-snippet">
                <Highlighted text={row.snippet} terms={terms} />
              </div>
            </button>
          ))}

          {rows.length === 0 && (
            <div className="flock-search-empty">
              {query.trim()
                ? (busy ? 'Looking…' : 'No sheep matched.')
                : 'Type to find the sheep working on it — a PR number, a branch, a phrase from the conversation.'}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
