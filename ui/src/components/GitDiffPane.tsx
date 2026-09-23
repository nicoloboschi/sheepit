import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import {
  RefreshCw, ChevronDown, ChevronRight, ChevronLeft, FilePlus, FileMinus, FileCode,
  GitCommitHorizontal, FolderOpen,
} from 'lucide-react';
import { parseDiff, type DiffFile } from '../diff';
import { usePoll } from '../hooks/usePoll';
import { preferences } from '../preferences';

const TREE_WIDTH_KEY = 'sheepit:diff-tree-width';
const DEFAULT_TREE_WIDTH = 200;
const clampTreeWidth = (n: number) => Math.max(120, Math.min(560, Math.round(n)));
// Deferred: FileView drags CodeMirror and sixteen language packs behind it,
// and a diff you have not opened needs none of them.
const FileView = lazy(() => import('./FileView'));

// ── Interfaces ────────────────────────────────────────────────────────────────
// Diff types + parser live in FileView (the shared single-file component).

interface Commit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  relDate: string;
}


// ── Changed files (tree + diffs) ──────────────────────────────────────────────

interface ChangedFilesProps {
  files: DiffFile[];
  focusedIndex: number;
  onSelect: (index: number) => void;
  onJump: (path: string) => void;
  /** The scrolling container, used as the IntersectionObserver root so a
   *  file's (potentially huge) diff body only mounts when near the viewport. */
  scrollRoot?: React.RefObject<HTMLDivElement | null>;
  /** Working tree only: the repo root (so a file can be opened/edited) and the
   *  pane session. A PR's files are not on disk, so both are absent there. */
  gitRoot?: string | null;
  sessionId?: string | null;
  onOpenFile?: ((path: string) => void) | null;
}

/**
 * One diff viewer, used by the working tree and by a pull request alike.
 *
 * The tree is a narrow column down the left that sticks as the diffs scroll
 * past it, so it stays a way around a long change; the diffs fill the rest.
 * This was two layouts — a tree stacked in a short box above the working-tree
 * diff, a sticky column beside a PR's — and two layouts for the same question
 * ("what changed") are two things to learn and one to keep in sync.
 */
export function ChangedFiles(
  { files, focusedIndex, onSelect, onJump, scrollRoot, gitRoot, sessionId, onOpenFile }: ChangedFilesProps,
) {
  // How wide the tree is, kept across reloads: on a wide pane a deep path is
  // worth the room, in a quad it is not.
  const [treeWidth, setTreeWidth] = useState(
    () => clampTreeWidth(Number(preferences.getItem(TREE_WIDTH_KEY)) || DEFAULT_TREE_WIDTH),
  );
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidth;
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => setTreeWidth(clampTreeWidth(startW + ev.clientX - startX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = prevSelect;
      preferences.setItem(TREE_WIDTH_KEY, String(clampTreeWidth(startW + ev.clientX - startX)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The tree follows the scroll. Reading a diff is scrolling, not clicking, so
  // a tree that only moved when clicked pointed at whatever you last picked —
  // usually a file three screens back.
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const shownRef = useRef(-1);
  useEffect(() => {
    const root = scrollRoot?.current;
    const body = bodyRef.current;
    if (!root || !body) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      // The file whose diff crosses the top of the viewport is the one being
      // read; a little slack so a heading just above the edge still counts.
      const edge = root.getBoundingClientRect().top + 12;
      const els = body.querySelectorAll<HTMLElement>('[data-file]');
      let idx = 0;
      els.forEach((el, i) => { if (el.getBoundingClientRect().top <= edge) idx = i; });
      if (idx !== shownRef.current) { shownRef.current = idx; selectRef.current(idx); }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(sync); };
    root.addEventListener('scroll', onScroll, { passive: true });
    sync();
    return () => { root.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [scrollRoot, files]);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      <div style={{ width: treeWidth, flexShrink: 0, position: 'sticky', top: 0, maxHeight: '100vh', overflowY: 'auto', display: 'flex' }}>
        <FileSidebar
          files={files}
          focusedIndex={focusedIndex}
          onJump={onJump}
          onSelect={onSelect}
          onOpenFile={onOpenFile ?? null}
        />
      </div>
      {/* The rail between the two columns is the handle. */}
      <div
        onPointerDown={startResize}
        title="Drag to resize the file tree"
        style={{ position: 'sticky', top: 0, width: 5, height: '100vh', flexShrink: 0, cursor: 'col-resize', background: 'var(--border)' }}
        onMouseEnter={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--primary)'; }}
        onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--border)'; }}
      />
      <div ref={bodyRef} style={{ flex: 1, minWidth: 0, padding: '0 12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Suspense fallback={<div style={{ padding: 16, color: 'var(--muted-foreground)', fontSize: 12 }}>Loading the diff…</div>}>
          {files.map((f, i) => {
            const displayPath = f.isDeleted ? f.oldPath : (f.newPath || f.oldPath);
            // `data-file` stays on the wrapper so the tree's and the keyboard's
            // "jump to file" can scroll to it.
            return (
              <div key={`${displayPath}${i}`} data-file={displayPath}>
                <FileView
                  path={gitRoot ? `${gitRoot}/${displayPath}` : null}
                  sessionId={sessionId}
                  displayPath={displayPath}
                  defaultMode="diff"
                  editable={!!gitRoot}
                  hunks={f.hunks}
                  additions={f.additions}
                  deletions={f.deletions}
                  isNew={f.isNew}
                  isDeleted={f.isDeleted}
                  isBinary={f.isBinary}
                  collapsible
                  isFocused={i === focusedIndex}
                  scrollRoot={scrollRoot}
                />
              </div>
            );
          })}
        </Suspense>
      </div>
    </div>
  );
}

// ── File sidebar ──────────────────────────────────────────────────────────────

/** What happened to a file, in the colours the diff body already uses for it:
 *  green for an addition, terracotta for a deletion, amber for a change. The
 *  icon carried this and the name did not, so scanning the tree meant reading
 *  11px glyphs. */
function statusColor(file: { isNew?: boolean; isDeleted?: boolean }): string {
  return file.isNew ? '#9CBC7F' : file.isDeleted ? '#E0907B' : '#D9B84A';
}

interface FileSidebarProps {
  files: DiffFile[];
  focusedIndex: number;
  onJump: (path: string) => void;
  onSelect: (index: number) => void;
  onOpenFile: ((path: string) => void) | null;
}

/** The tree inside `ChangedFiles`, and only there — a diff is a diff, and two
 *  file lists that drifted apart would be two different answers to "what
 *  changed". The GitHub view used to import this and lay it out itself; it
 *  takes the whole viewer now, so there is one layout rather than two. */
function FileSidebar({ files, focusedIndex, onJump, onSelect, onOpenFile }: FileSidebarProps) {
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files), [files]);

  // Keep the pointed-at row in view. It scrolls the tree's own box and nothing
  // above it, so it cannot push back on the diff scroll that moved the pointer
  // in the first place.
  const listRef = useRef<HTMLDivElement>(null);
  const focusedRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = listRef.current;
    const el = focusedRowRef.current;
    if (!box || !el) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const header = 28; // the sticky totals row at the top of the tree
    if (r.top < b.top + header) box.scrollTop += r.top - b.top - header;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }, [focusedIndex]);

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath); else next.add(dirPath);
      return next;
    });
  };

  function renderFileRow(file: DiffFile, index: number, name: string, depth: number) {
    const path = file.isDeleted ? file.oldPath : (file.newPath || file.oldPath);
    const isFocused = index === focusedIndex;
    return (
      <div
        key={index}
        ref={isFocused ? focusedRowRef : undefined}
        onClick={() => { onSelect(index); onJump(path); }}
        style={{
          padding: '4px 10px', paddingLeft: 10 + depth * 12, cursor: 'pointer', borderBottom: '1px solid var(--card)',
          display: 'flex', alignItems: 'center', gap: 6,
          background: isFocused ? 'var(--accent)' : 'transparent',
          borderLeft: isFocused ? '2px solid #9cbc7f' : '2px solid transparent',
        }}
        onMouseEnter={(e: React.MouseEvent<HTMLElement>) => { if (!isFocused) e.currentTarget.style.background = 'var(--card)'; }}
        onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { if (!isFocused) e.currentTarget.style.background = 'transparent'; }}
      >
        {file.isNew ? <FilePlus size={11} color="#9CBC7F" style={{ flexShrink: 0 }} /> : file.isDeleted ? <FileMinus size={11} color="#E0907B" style={{ flexShrink: 0 }} /> : <FileCode size={11} color="#D9B84A" style={{ flexShrink: 0 }} />}
        <span style={{ fontSize: 11, color: statusColor(file), fontFamily: 'var(--font-mono)', overflow: 'hidden', whiteSpace: 'nowrap', flex: 1, minWidth: 0, textOverflow: 'ellipsis' }}>
          {name}
        </span>
        {/* The counts, not a bar of blocks: five squares say which way a file
            leans, and "+240 −3" says that and how much. */}
        {file.additions > 0 && <span style={{ fontSize: 10, color: '#9CBC7F', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>+{file.additions}</span>}
        {file.deletions > 0 && <span style={{ fontSize: 10, color: '#E0907B', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>−{file.deletions}</span>}
        {onOpenFile && (
          <button
            title="Open in Files tab"
            onClick={(e) => { e.stopPropagation(); onOpenFile(path); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', color: 'var(--muted-foreground)', flexShrink: 0, display: 'flex', alignItems: 'center' }}
            onMouseEnter={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = '#8EBFA2'; }}
            onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = 'var(--muted-foreground)'; }}
          >
            <FolderOpen size={11} />
          </button>
        )}
      </div>
    );
  }

  function renderNode(node: TreeNode, dirPath: string, dirLabel: string, depth: number): React.ReactNode {
    const sortedChildren = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const sortedFiles = [...node.files].sort((a, b) => {
      const aName = (a.file.isDeleted ? a.file.oldPath : a.file.newPath).split('/').pop()!;
      const bName = (b.file.isDeleted ? b.file.oldPath : b.file.newPath).split('/').pop()!;
      return aName.localeCompare(bName);
    });

    // Root: render children and root-level files directly
    if (depth < 0) {
      return (
        <>
          {sortedChildren.map(([name, child]) => renderNode(child, name, name, 0))}
          {sortedFiles.map(({ file, index }) => {
            const fileName = (file.isDeleted ? file.oldPath : file.newPath).split('/').pop()!;
            return renderFileRow(file, index, fileName, 0);
          })}
        </>
      );
    }

    const collapsed = collapsedDirs.has(dirPath);

    return (
      <div key={dirPath}>
        <div
          onClick={() => toggleDir(dirPath)}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '4px 10px', paddingLeft: 10 + depth * 12,
            cursor: 'pointer', userSelect: 'none',
            borderBottom: '1px solid var(--card)',
            background: 'var(--background)',
          }}
          onMouseEnter={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--card)'; }}
          onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--background)'; }}
        >
          {collapsed
            ? <ChevronRight size={11} color="var(--muted-foreground)" style={{ flexShrink: 0 }} />
            : <ChevronDown size={11} color="var(--muted-foreground)" style={{ flexShrink: 0 }} />}
          <FolderOpen size={11} color="var(--muted-foreground)" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {dirLabel}
          </span>
          <span style={{ fontSize: 9, color: 'var(--muted-foreground)', flexShrink: 0 }}>
            {node.fileCount}
          </span>
        </div>
        {!collapsed && (
          <>
            {sortedChildren.map(([name, child]) => renderNode(child, `${dirPath}/${name}`, name, depth + 1))}
            {sortedFiles.map(({ file, index }) => {
              const fileName = (file.isDeleted ? file.oldPath : file.newPath).split('/').pop()!;
              return renderFileRow(file, index, fileName, depth + 1);
            })}
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--background)' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--card)', fontSize: 11, color: 'var(--muted-foreground)', display: 'flex', gap: 6, alignItems: 'center', position: 'sticky', top: 0, zIndex: 1 }}>
        <span>{files.length} file{files.length !== 1 ? 's' : ''}</span>
        <span style={{ color: '#9CBC7F' }}>+{totalAdd}</span>
        <span style={{ color: '#E0907B' }}>-{totalDel}</span>
      </div>
      {renderNode(tree, '', '', -1)}
    </div>
  );
}


/**
 * One commit's diff, in the same viewer the working tree and pull requests
 * use. Reached by clicking a row in the log — which is the only thing you can
 * want from a list of commits, and until now the rows did nothing at all.
 *
 * Read-only: these files are a snapshot of what that commit changed, not what
 * is on disk now, so no `gitRoot` goes in and nothing here offers to edit
 * them. The same reason a pull request's diff is read-only.
 */
function CommitDiff(
  { sessionId, commit, onBack }: { sessionId: string; commit: Commit & { date: string }; onBack: () => void },
) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [focusedIdx, setFocusedIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setFocusedIdx(0);
    fetch(`/api/git/${encodeURIComponent(sessionId)}/diff?mode=commit&commit=${encodeURIComponent(commit.hash)}`)
      .then(r => r.text())
      .then(t => { if (!cancelled) setFiles(parseDiff(t)); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [sessionId, commit.hash]);

  const jumpToFile = (path: string): void => {
    scrollRef.current?.querySelector(`[data-file="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--card)', flexShrink: 0 }}>
        <button
          onClick={onBack}
          title="Back to the log"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 0, display: 'flex' }}
          className="hover:text-foreground"
        >
          <ChevronLeft size={13} />
        </button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#8EBFA2', flexShrink: 0 }}>{commit.short}</span>
        <span style={{ fontSize: 12, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {commit.subject}
        </span>
        <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: 'var(--muted-foreground)' }}>
          {commit.author} · {commit.relDate}
        </span>
      </div>
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {files === null
          ? <div style={{ padding: 16, color: 'var(--muted-foreground)', fontSize: 12 }}>Loading the diff…</div>
          : files.length === 0
            ? <div style={{ padding: 16, color: 'var(--muted-foreground)', fontSize: 12 }}>Nothing in this commit.</div>
            : (
              <ChangedFiles
                files={files}
                focusedIndex={focusedIdx}
                onSelect={setFocusedIdx}
                onJump={jumpToFile}
                scrollRoot={scrollRef}
              />
            )}
      </div>
    </>
  );
}

// ── Full log ──────────────────────────────────────────────────────────────────

function FullLog({ sessionId }: { sessionId: string }) {
  const [commits, setCommits] = useState<(Commit & { date: string })[]>([]);
  /** The commit being read, or null for the list. */
  const [openCommit, setOpenCommit] = useState<(Commit & { date: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  /** Bumped by the reload button. The log is not polled — a commit you made
   *  yourself is the only thing that changes it — so this is how it refreshes. */
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/git/${encodeURIComponent(sessionId)}/log?full=1&limit=200`)
      .then(r => r.json())
      .then(setCommits)
      .catch(() => setCommits([]))
      .finally(() => setLoading(false));
  }, [sessionId, seq]);

  const bar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--card)', flexShrink: 0 }}>
      <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
        {commits.length ? `${commits.length} commit${commits.length === 1 ? '' : 's'}` : ''}
      </span>
      <div style={{ flex: 1 }} />
      {loading
        ? <RefreshCw size={11} color="var(--muted-foreground)" className="animate-spin" />
        : (
          <button
            onClick={() => setSeq(n => n + 1)}
            title="Reload the log"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 0, display: 'flex' }}
            className="hover:text-foreground"
          >
            <RefreshCw size={11} />
          </button>
        )}
    </div>
  );

  if (openCommit) {
    return <CommitDiff sessionId={sessionId} commit={openCommit} onBack={() => setOpenCommit(null)} />;
  }

  if (loading) return <>{bar}<div style={{ padding: 16, color: 'var(--muted-foreground)', fontSize: 12 }}>Loading…</div></>;
  if (commits.length === 0) return <>{bar}<div style={{ padding: 16, color: 'var(--muted-foreground)', fontSize: 12 }}>No commits</div></>;

  // Group by date
  const grouped = new Map<string, typeof commits>();
  for (const c of commits) {
    const day = c.date;
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day)!.push(c);
  }

  return (
    <>
    {bar}
    <div style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
      {[...grouped.entries()].map(([date, cs]) => (
        <div key={date}>
          <div style={{
            padding: '6px 16px', fontSize: 11, fontWeight: 600, color: 'var(--muted-foreground)',
            background: 'var(--card)', borderBottom: '1px solid var(--border)',
            position: 'sticky', top: 0, zIndex: 1,
          }}>
            {date}
          </div>
          {cs.map(c => (
            <div
              key={c.hash}
              onClick={() => setOpenCommit(c)}
              title="Show what this commit changed"
              style={{ padding: '8px 16px', borderBottom: '1px solid var(--card)', display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}
              onMouseEnter={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--card)'; }}
              onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <GitCommitHorizontal size={13} color="#9CBC7F" style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--foreground)', marginBottom: 2 }}>{c.subject}</div>
                <div style={{ display: 'flex', gap: 8, fontSize: 10, color: 'var(--muted-foreground)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: '#8EBFA2' }}>{c.short}</span>
                  <span>{c.author}</span>
                  <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{c.relDate}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
    </>
  );
}

// ── Directory tree for sidebar ───────────────────────────────────────────────

interface TreeNode {
  files: { file: DiffFile; index: number }[];
  children: Map<string, TreeNode>;
  additions: number;
  deletions: number;
  fileCount: number;
}

function buildTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = { files: [], children: new Map(), additions: 0, deletions: 0, fileCount: 0 };
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const path = file.isDeleted ? file.oldPath : (file.newPath || file.oldPath);
    const parts = path.split('/');
    parts.pop(); // remove filename
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { files: [], children: new Map(), additions: 0, deletions: 0, fileCount: 0 });
      }
      node = node.children.get(part)!;
    }
    node.files.push({ file, index: i });
  }
  function calcStats(node: TreeNode): void {
    node.additions = node.files.reduce((s, e) => s + e.file.additions, 0);
    node.deletions = node.files.reduce((s, e) => s + e.file.deletions, 0);
    node.fileCount = node.files.length;
    for (const child of node.children.values()) {
      calcStats(child);
      node.additions += child.additions;
      node.deletions += child.deletions;
      node.fileCount += child.fileCount;
    }
  }
  calcStats(root);
  // Collapse single-child directories without files (src/components → src/components)
  function collapse(node: TreeNode): TreeNode {
    const newChildren = new Map<string, TreeNode>();
    for (const [name, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const collapsed = collapse(child);
      if (collapsed.files.length === 0 && collapsed.children.size === 1) {
        const [subName, subChild] = [...collapsed.children.entries()][0]!;
        newChildren.set(`${name}/${subName}`, subChild);
      } else {
        newChildren.set(name, collapsed);
      }
    }
    return { ...node, children: newChildren };
  }
  return collapse(root);
}

// ── Root ─────────────────────────────────────────────────────────────────────

// The unified per-pane switch (Terminal · Working · Files · Git Log) lives in
// PaneHeader; this pane is told which git mode to render via the `mode` prop.
// 'head' = working-tree diff, 'log' = commit log.
type ModeId = 'head' | 'log';

interface GitDiffPaneProps {
  sessionId: string | null;
  mode: ModeId;
  onOpenFile?: (path: string) => void;
}

export default function GitDiffPane({ sessionId, mode, onOpenFile }: GitDiffPaneProps) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gitRoot, setGitRoot] = useState<string | null>(null);
  const [focusedFileIdx, setFocusedFileIdx] = useState(0);
  const diffRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/git/${encodeURIComponent(sessionId)}/root`)
      .then(r => r.json())
      .then((d: { root: string }) => setGitRoot(d.root))
      .catch(() => {});
  }, [sessionId]);

  const load = useCallback(async (quiet = false) => {
    if (!sessionId || mode === 'log') return;
    // A refresh behind an existing diff must not empty the pane: the rows on
    // screen are the best answer anyone has until the new ones arrive.
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/git/${encodeURIComponent(sessionId)}/diff`);
      const text = await res.text();
      setFiles(parseDiff(text));
    } catch (e) { setError((e as Error).message); }
    finally     { setLoading(false); }
  }, [sessionId, mode]);

  /**
   * Keep up with the repository, rather than showing whatever it looked like
   * when the view was opened.
   *
   * The diff was fetched once, on mount. An agent working in the pane beside
   * it stages a file, commits, or touches another — and the diff went on
   * saying what was true minutes ago, with nothing on screen admitting it. The
   * manual refresh button existed precisely because of this, which is the
   * tell: you should not have to ask a view of the working tree whether it is
   * still a view of the working tree.
   *
   * Only while it is actually on screen. `usePoll` already stops in a hidden
   * tab; `offsetParent` is the same question one level down, because a pane in
   * a pen you are not showing sits under `display: none` and forking `git
   * diff HEAD` for it every few seconds — on twenty panes, in repositories
   * this size — is the kind of thing that pegs a core.
   */
  usePoll(() => {
    if (!containerRef.current?.offsetParent) return;
    void load(true);
  }, 5000, sessionId, mode !== 'log');

  useEffect(() => { setFiles(null); setFocusedFileIdx(0); }, [mode]);
  useEffect(() => { load(); }, [load]); // eslint-disable-line
  useEffect(() => { if (files?.length) setFocusedFileIdx(0); }, [files]);

  // Auto-focus for keyboard navigation when the pane mounts
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Sorted file order (matching sidebar grouping) — maps visual position to original index
  const sortedFileOrder = useMemo(() => {
    if (!files?.length) return [];
    const entries = files.map((file, i) => {
      const path = file.isDeleted ? file.oldPath : (file.newPath || file.oldPath);
      const parts = path.split('/');
      const name = parts.pop()!;
      const dir = parts.join('/') || '.';
      return { index: i, dir, name };
    });
    entries.sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
    return entries.map(e => e.index);
  }, [files]);

  const jumpToFile = (path: string): void => {
    const el = diffRef.current?.querySelector(`[data-file="${CSS.escape(path)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const navigateFile = useCallback((direction: 'prev' | 'next') => {
    if (!files?.length || !sortedFileOrder.length) return;
    setFocusedFileIdx(idx => {
      const currentPos = sortedFileOrder.indexOf(idx);
      const pos = currentPos === -1 ? 0 : currentPos;
      const nextPos = direction === 'next'
        ? Math.min(pos + 1, sortedFileOrder.length - 1)
        : Math.max(pos - 1, 0);
      const next = sortedFileOrder[nextPos]!;
      const f = files[next]!;
      const path = f.isDeleted ? f.oldPath : (f.newPath || f.oldPath);
      const el = diffRef.current?.querySelector(`[data-file="${CSS.escape(path)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return next;
    });
  }, [files, sortedFileOrder]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Don't capture when typing in an input
    if ((e.target as HTMLElement).tagName === 'INPUT') return;

    // File navigation: left/right arrows or h/l
    if (e.key === 'ArrowRight' || e.key === 'l') {
      e.preventDefault();
      navigateFile('next');
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'h') {
      e.preventDefault();
      navigateFile('prev');
      return;
    }

    // Scroll the diff content area: up/down arrows or j/k
    const scrollEl = diffRef.current;
    if (!scrollEl) return;
    const scrollAmount = 120;

    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      scrollEl.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      scrollEl.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      scrollEl.scrollBy({ top: e.shiftKey ? -200 : 200, behavior: 'smooth' });
      return;
    }

    // Page up/down
    if (e.key === 'PageDown') {
      e.preventDefault();
      scrollEl.scrollBy({ top: scrollEl.clientHeight * 0.8, behavior: 'smooth' });
      return;
    }
    if (e.key === 'PageUp') {
      e.preventDefault();
      scrollEl.scrollBy({ top: -scrollEl.clientHeight * 0.8, behavior: 'smooth' });
      return;
    }

    // Home/End — first/last file
    if (e.key === 'Home') {
      e.preventDefault();
      if (sortedFileOrder.length) setFocusedFileIdx(sortedFileOrder[0]!);
      scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      if (sortedFileOrder.length) setFocusedFileIdx(sortedFileOrder[sortedFileOrder.length - 1]!);
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
      return;
    }

    // Refresh
    if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      load();
      return;
    }
  }, [files, sortedFileOrder, navigateFile, load]);

  const showSidebar = files && files.length > 0;
  const totalAdd = files?.reduce((s, f) => s + f.additions, 0) ?? 0;
  const totalDel = files?.reduce((s, f) => s + f.deletions, 0) ?? 0;

  return (
    <div ref={containerRef} tabIndex={0} onKeyDown={handleKeyDown} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--background)', color: 'var(--foreground)', outline: 'none' }}>

      {/* Body */}
      {mode === 'log' && sessionId ? (
        <FullLog sessionId={sessionId} />
      ) : (
      <>
        {/* Toolbar — working-tree stats */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--card)', flexShrink: 0 }}>
          <div style={{ flex: 1 }} />
          {files !== null && !loading && (
            <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
              {files.length} file{files.length !== 1 ? 's' : ''}
              {totalAdd > 0 && <span style={{ color: '#9CBC7F', marginLeft: 6 }}>+{totalAdd}</span>}
              {totalDel > 0 && <span style={{ color: '#E0907B', marginLeft: 4 }}>-{totalDel}</span>}
            </span>
          )}
          {loading
            ? <RefreshCw size={11} color="var(--muted-foreground)" className="animate-spin" />
            : (
              <button
                onClick={() => load()}
                title="Reload the working tree"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 0, display: 'flex' }}
                className="hover:text-foreground"
              >
                <RefreshCw size={11} />
              </button>
            )}
        </div>

        {/* The same tree-beside-diffs viewer a pull request is read in. */}
        <div ref={diffRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <div style={{ padding: 16, paddingBottom: 0 }}>
            {loading && <div style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>Loading…</div>}
            {error   && <div style={{ color: '#E0907B', fontSize: 13 }}>Error: {error}</div>}
            {!loading && files !== null && files.length === 0 && (
              <div style={{ color: '#9CBC7F', fontSize: 13 }}>✓  No changes</div>
            )}
          </div>
          {!loading && showSidebar && (
            <ChangedFiles
              files={files}
              focusedIndex={focusedFileIdx}
              onSelect={setFocusedFileIdx}
              onJump={jumpToFile}
              scrollRoot={diffRef}
              gitRoot={gitRoot}
              sessionId={sessionId}
              onOpenFile={onOpenFile && gitRoot ? (relPath: string) => onOpenFile(`${gitRoot}/${relPath}`) : null}
            />
          )}
        </div>
      </>
      )}
    </div>
  );
}
