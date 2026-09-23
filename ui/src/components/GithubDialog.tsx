import { useEffect, useMemo, useState } from 'react';
import { Github, Star, Plus } from 'lucide-react';
import FloatingPanel from './FloatingPanel';
import GithubPane, { type GhRef } from './GithubPane';
import useStore from '../store';
import { preferences } from '../preferences';

/** Repositories you asked to keep, in the server-side profile like every other
 *  preference — its own key, because two tabs writing one blob is
 *  last-writer-wins. The ones you have open are not in here: those are a fact
 *  about the flock, re-asked every time the panel opens. */
const KEPT_KEY = 'sheepit:github-repos';

function readKept(): string[] {
  try {
    const raw = JSON.parse(preferences.getItem(KEPT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : [];
  } catch { return []; }
}

const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

interface GithubDialogProps {
  onClose: () => void;
}

/**
 * GitHub as a global, over the whole app: the same pull-request and issue
 * viewer a pane has, with one level above it — which repository.
 *
 * In a pane the repository is decided for you: it is the one that checkout is
 * in. That is right beside a terminal and wrong on its own, because the
 * question you open this for is "what is happening on my projects", and half
 * of them are not checked out anywhere right now.
 *
 * So the column lists **the repositories the flock is standing in**, always,
 * and **the ones you keep**, which you add by name. Switching between them is
 * free after the first look: `GithubPane`'s caches are keyed on `owner/repo`,
 * not on the pane that asked.
 */
export default function GithubDialog({ onClose }: GithubDialogProps) {
  // Any live session: the gh routes are session-scoped because `gh` has to run
  // somewhere, but the repository is named explicitly from here.
  const sessionId = useStore(s => {
    const ws = s.currentSessionId ? s.workspaces[s.currentSessionId] : undefined;
    return ws?.cells[ws.activeCell] ?? s.currentSessionId;
  });

  const [open, setOpen] = useState<string[]>([]);
  const [kept, setKept] = useState<string[]>(readKept);
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<GhRef | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/github/repos')
      .then(r => r.json())
      .then((d: { repos?: string[] }) => { if (!cancelled) setOpen(d?.repos ?? []); })
      .catch(() => { /* no server, or no gh: the kept list still works */ });
    return () => { cancelled = true; };
  }, []);

  // Open first, then the kept ones that are not already open — a repository
  // you keep *and* have open is one row, not two.
  const repos = useMemo(
    () => [...open, ...kept.filter(r => !open.includes(r))],
    [open, kept],
  );

  // Land on something as soon as there is something to land on, and never on a
  // row that has since gone away.
  useEffect(() => {
    if (repos.length === 0) { setActive(null); return; }
    setActive(cur => (cur && repos.includes(cur) ? cur : repos[0]!));
  }, [repos]);

  const saveKept = (next: string[]) => {
    setKept(next);
    preferences.setItem(KEPT_KEY, JSON.stringify(next));
  };

  const add = () => {
    const slug = draft.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
    setDraft(''); setAdding(false);
    if (!SLUG.test(slug) || kept.includes(slug)) return;
    saveKept([...kept, slug]);
    setActive(slug);
  };

  const row = (repo: string) => {
    const isOpen = open.includes(repo);
    const isKept = kept.includes(repo);
    const isActive = repo === active;
    const [owner, name] = repo.split('/');
    return (
      <div key={repo} style={{ display: 'flex', alignItems: 'center' }}>
        <button
          onClick={() => { setActive(repo); setSelected(null); }}
          title={repo}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0,
            flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 5,
            border: 'none', cursor: 'pointer', textAlign: 'left',
            background: isActive ? 'var(--accent)' : 'none',
            color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
            {name}
          </span>
          <span style={{ fontSize: 10, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
            {owner}{isOpen ? ' · open' : ''}
          </span>
        </button>
        {/* Star keeps a repository after the last pane in it is gone; on one
            you only keep, it is how you drop it again. */}
        <button
          onClick={() => saveKept(isKept ? kept.filter(r => r !== repo) : [...kept, repo])}
          title={isKept ? `Stop keeping ${repo}` : `Keep ${repo}`}
          aria-label={isKept ? `Stop keeping ${repo}` : `Keep ${repo}`}
          style={{
            display: 'flex', background: 'none', border: 'none', padding: 3, cursor: 'pointer',
            color: isKept ? 'var(--warning)' : 'var(--muted-foreground)',
          }}
        >
          {isKept ? <Star size={11} fill="var(--warning)" /> : <Star size={11} />}
        </button>
      </div>
    );
  };

  return (
    <FloatingPanel
      title="GitHub"
      icon={<Github size={13} style={{ color: 'var(--primary)' }} />}
      onClose={onClose}
      width={1040}
      height={680}
    >
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 170, flexShrink: 0, padding: 8, overflowY: 'auto',
            borderRight: '1px solid var(--border)', background: 'var(--chrome)',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          {repos.map(row)}
          {repos.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--muted-foreground)', padding: '4px 8px' }}>
              No repository open. Add one below.
            </span>
          )}
          {adding ? (
            <input
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') add();
                // Escape belongs to this field first — the panel's own
                // Escape-to-close would otherwise take the whole panel away
                // mid-typing.
                if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); setDraft(''); }
              }}
              onBlur={add}
              placeholder="owner/repo"
              style={{
                marginTop: 6, padding: '4px 6px', fontSize: 11, fontFamily: 'var(--font-mono)',
                background: 'var(--background)', color: 'var(--foreground)',
                border: '1px solid var(--primary)', borderRadius: 4, outline: 'none', minWidth: 0,
              }}
            />
          ) : (
            <button
              onClick={() => setAdding(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, marginTop: 6,
                padding: '5px 8px', borderRadius: 5, border: 'none', cursor: 'pointer',
                background: 'none', color: 'var(--muted-foreground)', fontSize: 11, textAlign: 'left',
              }}
            >
              <Plus size={12} /> Add a repository
            </button>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <GithubPane
            sessionId={sessionId}
            repo={active}
            selected={selected}
            // A row names only its number; the repository is whichever one this
            // column is on, so the detail fetch asks the right `gh --repo`.
            onSelect={ref => setSelected(ref ? { ...ref, repo: ref.repo ?? active ?? undefined } : null)}
          />
        </div>
      </div>
    </FloatingPanel>
  );
}
