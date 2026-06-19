import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  RefreshCw, ChevronDown, ChevronRight, FilePlus, FileMinus, FileCode,
  GitCommitHorizontal, FolderOpen,
} from 'lucide-react';
import FileView, { parseDiff, type DiffFile } from './FileView';

// ── Interfaces ────────────────────────────────────────────────────────────────
// Diff types + parser live in FileView (the shared single-file component).

interface Commit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  relDate: string;
}


// ── File block ────────────────────────────────────────────────────────────────

interface FileBlockProps {
  file: DiffFile;
  gitRoot: string | null;
  /** Pane session (for the FileView content/edit + per-file diff fetch). */
  sessionId?: string | null;
  isFocused: boolean;
  /** The scrolling diff container, used as the IntersectionObserver root so a
   *  file's (potentially huge) diff body only mounts when near the viewport. */
  scrollRoot?: React.RefObject<HTMLDivElement | null>;
}

function FileBlock({ file, gitRoot, sessionId, isFocused, scrollRoot }: FileBlockProps) {
  const displayPath = file.isDeleted ? file.oldPath : (file.newPath || file.oldPath);
  const absPath = gitRoot ? `${gitRoot}/${displayPath}` : null;
  // The whole per-file UI (header, collapse, diff⇄content toggle, lazy-mounted
  // body) is the shared FileView. `data-file` stays on the wrapper so the
  // sidebar/keyboard "jump to file" can still scroll to it.
  return (
    <div data-file={displayPath}>
      <FileView
        path={absPath}
        sessionId={sessionId}
        displayPath={displayPath}
        defaultMode="diff"
        editable
        hunks={file.hunks}
        additions={file.additions}
        deletions={file.deletions}
        isNew={file.isNew}
        isDeleted={file.isDeleted}
        isBinary={file.isBinary}
        collapsible
        isFocused={isFocused}
        scrollRoot={scrollRoot}
      />
    </div>
  );
}

// ── File sidebar ──────────────────────────────────────────────────────────────

const BLOCKS = 5 as const;

interface StatBarProps {
  add: number;
  del: number;
}

function StatBar({ add, del }: StatBarProps) {
  const total = add + del || 1;
  const greenN = Math.round((add / total) * BLOCKS);
  const redN = BLOCKS - greenN;
  return (
    <span style={{ display: 'inline-flex', gap: 1, flexShrink: 0 }}>
      {Array.from({ length: greenN }).map((_, i) => <span key={`g${i}`} style={{ width: 8, height: 8, borderRadius: 1, background: '#4ADE80', display: 'inline-block' }} />)}
      {Array.from({ length: redN }).map((_, i) => <span key={`r${i}`} style={{ width: 8, height: 8, borderRadius: 1, background: '#F87171', display: 'inline-block' }} />)}
    </span>
  );
}

interface FileSidebarProps {
  files: DiffFile[];
  focusedIndex: number;
  onJump: (path: string) => void;
  onSelect: (index: number) => void;
  onOpenFile: ((path: string) => void) | null;
}

function FileSidebar({ files, focusedIndex, onJump, onSelect, onOpenFile }: FileSidebarProps) {
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files), [files]);

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
        onClick={() => { onSelect(index); onJump(path); }}
        style={{
          padding: '4px 10px', paddingLeft: 10 + depth * 12, cursor: 'pointer', borderBottom: '1px solid #111111',
          display: 'flex', alignItems: 'center', gap: 6,
          background: isFocused ? '#1f3a56' : 'transparent',
          borderLeft: isFocused ? '2px solid #0074d9' : '2px solid transparent',
        }}
        onMouseEnter={(e: React.MouseEvent<HTMLElement>) => { if (!isFocused) e.currentTarget.style.background = '#111111'; }}
        onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { if (!isFocused) e.currentTarget.style.background = 'transparent'; }}
      >
        {file.isNew ? <FilePlus size={11} color="#4ADE80" style={{ flexShrink: 0 }} /> : file.isDeleted ? <FileMinus size={11} color="#F87171" style={{ flexShrink: 0 }} /> : <FileCode size={11} color="#525252" style={{ flexShrink: 0 }} />}
        <span style={{ fontSize: 11, color: '#F4F4F5', fontFamily: '"JetBrains Mono",monospace', overflow: 'hidden', whiteSpace: 'nowrap', flex: 1, minWidth: 0, textOverflow: 'ellipsis' }}>
          {name}
        </span>
        <StatBar add={file.additions} del={file.deletions} />
        {onOpenFile && (
          <button
            title="Open in Files tab"
            onClick={(e) => { e.stopPropagation(); onOpenFile(path); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', color: '#484f58', flexShrink: 0, display: 'flex', alignItems: 'center' }}
            onMouseEnter={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = '#93C5FD'; }}
            onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = '#484f58'; }}
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
            borderBottom: '1px solid #111111',
            background: '#0a0a0a',
          }}
          onMouseEnter={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = '#111111'; }}
          onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = '#0a0a0a'; }}
        >
          {collapsed
            ? <ChevronRight size={11} color="#525252" style={{ flexShrink: 0 }} />
            : <ChevronDown size={11} color="#525252" style={{ flexShrink: 0 }} />}
          <FolderOpen size={11} color="#737373" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: '#a1a1aa', fontFamily: '"JetBrains Mono",monospace', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {dirLabel}
          </span>
          <span style={{ fontSize: 9, color: '#525252', flexShrink: 0 }}>
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
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: '#0c0c0c' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #222222', background: '#111111', fontSize: 11, color: '#525252', display: 'flex', gap: 6, alignItems: 'center', position: 'sticky', top: 0, zIndex: 1 }}>
        <span>{files.length} file{files.length !== 1 ? 's' : ''}</span>
        <span style={{ color: '#4ADE80' }}>+{totalAdd}</span>
        <span style={{ color: '#F87171' }}>-{totalDel}</span>
      </div>
      {renderNode(tree, '', '', -1)}
    </div>
  );
}

// ── Full log ──────────────────────────────────────────────────────────────────

function FullLog({ sessionId }: { sessionId: string }) {
  const [commits, setCommits] = useState<(Commit & { date: string })[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/git/${encodeURIComponent(sessionId)}/log?full=1&limit=200`)
      .then(r => r.json())
      .then(setCommits)
      .catch(() => setCommits([]))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (loading) return <div style={{ padding: 16, color: '#525252', fontSize: 12 }}>Loading…</div>;
  if (commits.length === 0) return <div style={{ padding: 16, color: '#484f58', fontSize: 12 }}>No commits</div>;

  // Group by date
  const grouped = new Map<string, typeof commits>();
  for (const c of commits) {
    const day = c.date;
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day)!.push(c);
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
      {[...grouped.entries()].map(([date, cs]) => (
        <div key={date}>
          <div style={{
            padding: '6px 16px', fontSize: 11, fontWeight: 600, color: '#525252',
            background: '#111111', borderBottom: '1px solid #222222',
            position: 'sticky', top: 0, zIndex: 1,
          }}>
            {date}
          </div>
          {cs.map(c => (
            <div key={c.hash} style={{ padding: '8px 16px', borderBottom: '1px solid #111111', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <GitCommitHorizontal size={13} color="#4ADE80" style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#F4F4F5', marginBottom: 2 }}>{c.subject}</div>
                <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#525252' }}>
                  <span style={{ fontFamily: '"JetBrains Mono",monospace', color: '#93C5FD' }}>{c.short}</span>
                  <span>{c.author}</span>
                  <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{c.relDate}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
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

  const load = useCallback(async () => {
    if (!sessionId || mode === 'log') return;
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/git/${encodeURIComponent(sessionId)}/diff`);
      const text = await res.text();
      setFiles(parseDiff(text));
    } catch (e) { setError((e as Error).message); }
    finally     { setLoading(false); }
  }, [sessionId, mode]);

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
    <div ref={containerRef} tabIndex={0} onKeyDown={handleKeyDown} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#0c0c0c', outline: 'none' }}>

      {/* Body */}
      {mode === 'log' && sessionId ? (
        <FullLog sessionId={sessionId} />
      ) : (
      <>
        {/* Toolbar — working-tree stats */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid #222222', background: '#111111', flexShrink: 0 }}>
          <div style={{ flex: 1 }} />
          {files !== null && !loading && (
            <span style={{ fontSize: 11, color: '#525252' }}>
              {files.length} file{files.length !== 1 ? 's' : ''}
              {totalAdd > 0 && <span style={{ color: '#4ADE80', marginLeft: 6 }}>+{totalAdd}</span>}
              {totalDel > 0 && <span style={{ color: '#F87171', marginLeft: 4 }}>-{totalDel}</span>}
            </span>
          )}
          {loading && <RefreshCw size={11} color="#525252" className="animate-spin" />}
        </div>

        {/* File list (top) + diff content (bottom) — stacked vertically */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
          {showSidebar && (
            <div className="hidden md:flex flex-col" style={{ height: 220, flexShrink: 0, borderBottom: '1px solid #222222' }}>
              <FileSidebar
                files={files}
                focusedIndex={focusedFileIdx}
                onJump={jumpToFile}
                onSelect={setFocusedFileIdx}
                onOpenFile={onOpenFile && gitRoot ? (relPath: string) => onOpenFile(`${gitRoot}/${relPath}`) : null}
              />
            </div>
          )}

          {/* Diff content */}
          <div ref={diffRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
            {loading && <div style={{ color: '#525252', fontSize: 13 }}>Loading…</div>}
            {error   && <div style={{ color: '#F87171', fontSize: 13 }}>Error: {error}</div>}
            {!loading && files !== null && files.length === 0 && (
              <div style={{ color: '#4ADE80', fontSize: 13 }}>✓  No changes</div>
            )}
            {!loading && files?.map((file, i) => <FileBlock key={i} file={file} gitRoot={gitRoot} sessionId={sessionId} isFocused={i === focusedFileIdx} scrollRoot={diffRef} />)}
          </div>
        </div>
      </>
      )}
    </div>
  );
}
