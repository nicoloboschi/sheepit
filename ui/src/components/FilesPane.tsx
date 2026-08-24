import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Folder, FolderOpen, ChevronLeft, FileCode, FileText, Image,
  FileJson, Film, Music, Archive, File, RefreshCw,
  Search, X, Filter, Upload, FilePlus, FolderPlus,
} from 'lucide-react';
import FileView from './FileView';
import { preferences } from '../preferences';

// ── Types ─────────────────────────────────────────────────────────────────────

type LucideIcon = typeof FileCode;

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface SearchResultData {
  file: string;
  line: number;
  text: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const EXT_ICONS: Record<string, LucideIcon> = {
  js: FileCode, jsx: FileCode, ts: FileCode, tsx: FileCode,
  py: FileCode, go: FileCode, rs: FileCode, java: FileCode,
  c: FileCode, cpp: FileCode, h: FileCode, rb: FileCode,
  sh: FileCode, bash: FileCode, zsh: FileCode, fish: FileCode,
  css: FileCode, scss: FileCode, html: FileCode, vue: FileCode, svelte: FileCode,
  json: FileJson, yaml: FileCode, yml: FileCode, toml: FileCode, env: FileCode,
  md: FileText, txt: FileText, rst: FileText,
  png: Image, jpg: Image, jpeg: Image, gif: Image, svg: Image, webp: Image, ico: Image,
  mp4: Film, mov: Film, avi: Film,
  mp3: Music, wav: Music,
  zip: Archive, tar: Archive, gz: Archive,
};

function getIcon(name: string, isDir: boolean, open: boolean = false): LucideIcon {
  if (isDir) return open ? FolderOpen : Folder;
  return EXT_ICONS[name.split('.').pop()?.toLowerCase() ?? ''] ?? File;
}

/** Color tint by file type category for visual differentiation */
const EXT_ICON_COLORS: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6',                    // TypeScript blue
  js: '#f0db4f', jsx: '#f0db4f',                    // JavaScript yellow
  py: '#3572A5',                                     // Python blue
  go: '#00ADD8', rs: '#dea584', java: '#b07219',     // Go/Rust/Java
  json: '#D9B84A', yaml: '#D9B84A', yml: '#D9B84A', toml: '#D9B84A', // Config yellow
  html: '#e34c26', css: '#563d7c', scss: '#c6538c',  // Web
  sh: '#9CBC7F', bash: '#9CBC7F', zsh: '#9CBC7F',    // Shell green
  md: 'var(--muted-foreground)', txt: 'var(--muted-foreground)',                      // Text muted
  svg: '#FF9A00',                                     // SVG orange
};

function getIconColor(name: string, isDir: boolean, gitColor: string | null): string {
  if (gitColor) return gitColor;
  if (isDir) return '#8EBFA2';
  return EXT_ICON_COLORS[ext(name)] ?? 'var(--muted-foreground)';
}

const GIT_TOOLTIPS: Record<string, string> = {
  modified: 'Modified', untracked: 'Untracked', added: 'Added', deleted: 'Deleted', renamed: 'Renamed',
};

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

const ext     = (name: string): string => (name ?? '').split('.').pop()?.toLowerCase() ?? '';


// ── File list entry ───────────────────────────────────────────────────────────

const GIT_COLORS: Record<string, string> = {
  modified:  '#D9B84A',
  untracked: '#9CBC7F',
  added:     '#9CBC7F',
  deleted:   '#E0907B',
  renamed:   '#b79cca',
};

const GIT_LABELS: Record<string, string> = {
  modified: 'M', untracked: 'U', added: 'A', deleted: 'D', renamed: 'R',
};

interface EntryProps {
  entry: Entry;
  index?: number;
  selected: string | null;
  focused?: boolean;
  /** Mouse click on a file — pins it as an open tab. Keyboard navigation
   *  (j/k/arrows) uses onSelect instead to avoid polluting the tab row. */
  onOpen: (path: string) => void;
  onNavigate: (path: string) => void;
  gitStatus: Record<string, string> | null;
}

function EntryRow({ entry, index, selected, focused, onOpen, onNavigate, gitStatus }: EntryProps) {
  const Icon = getIcon(entry.name, entry.isDir);
  const active = selected === entry.path;
  const status = gitStatus?.[entry.path] ?? null;

  // For directories, check if any child file has changes
  const dirHasChanges = entry.isDir && !status && gitStatus
    ? Object.keys(gitStatus).some(p => p.startsWith(entry.path + '/'))
    : false;

  const dirChangeColor = dirHasChanges ? '#D9B84A' : null;
  const gitColor = status ? GIT_COLORS[status] : dirChangeColor;
  const fileColor = gitColor ?? (entry.isDir ? 'var(--foreground)' : 'var(--muted-foreground)');
  const iconColor = getIconColor(entry.name, entry.isDir, gitColor ?? null);
  return (
    <div
      data-entry-idx={index}
      onClick={() => entry.isDir ? onNavigate(entry.path) : onOpen(entry.path)}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '4px 10px', cursor: 'pointer', userSelect: 'none',
        background: active ? 'var(--accent)' : focused ? 'var(--accent)' : 'transparent',
        borderLeft: focused ? '2px solid #9cbc7f' : '2px solid transparent',
        borderBottom: '1px solid var(--card)',
      }}
      onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => { if (!active) e.currentTarget.style.background = 'var(--card)'; }}
      onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <Icon size={13} color={iconColor} style={{ flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: fileColor, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: '"JetBrains Mono",monospace' }}>
        {entry.name}{entry.isDir ? '/' : ''}
      </span>
      {status && (
        <span
          title={GIT_TOOLTIPS[status] ?? status}
          style={{ fontSize: 9, color: gitColor ?? undefined, fontWeight: 700, flexShrink: 0, fontFamily: '"JetBrains Mono",monospace' }}
        >
          {GIT_LABELS[status]}
        </span>
      )}
      {dirHasChanges && (
        <span title="Contains modified files" style={{ width: 6, height: 6, borderRadius: '50%', background: '#D9B84A', flexShrink: 0 }} />
      )}
      {!entry.isDir && entry.size > 0 && !status && (
        <span style={{ fontSize: 10, color: 'var(--muted-foreground)', flexShrink: 0 }}>{fmtSize(entry.size)}</span>
      )}
    </div>
  );
}

// ── Open-file tabs strip ─────────────────────────────────────────────────────

interface TabsBarProps {
  tabs: string[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

/** Horizontal strip of pinned file tabs rendered above the FileViewer. Each
 *  tab is keyed by its full path (there can be `index.ts` from two dirs),
 *  displays the basename, and shows a close X on hover / when active. */
function TabsBar({ tabs, activePath, onSelect, onClose }: TabsBarProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activePath]);
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      background: 'var(--background)', borderBottom: '1px solid var(--border)',
      overflowX: 'auto', flexShrink: 0, minHeight: 28,
    }}>
      {tabs.map(path => {
        const name = path.split('/').pop() ?? path;
        const Icon = getIcon(name, false);
        const active = path === activePath;
        return (
          <div
            key={path}
            ref={active ? activeRef : undefined}
            onClick={() => onSelect(path)}
            onMouseDown={e => { if (e.button === 1) { e.preventDefault(); onClose(path); } }}
            title={path}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '0 8px 0 10px',
              cursor: 'pointer', userSelect: 'none',
              fontSize: 11, fontFamily: '"JetBrains Mono",monospace',
              color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
              background: active ? 'var(--card)' : 'transparent',
              borderRight: '1px solid var(--border)',
              borderTop: active ? '2px solid #9cbc7f' : '2px solid transparent',
              maxWidth: 200, flexShrink: 0,
            }}
            onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => { if (!active) e.currentTarget.style.background = 'var(--card)'; }}
            onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon size={12} color={getIconColor(name, false, null)} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            <button
              onClick={e => { e.stopPropagation(); onClose(path); }}
              title="Close tab"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'none', border: 'none', cursor: 'pointer',
                color: active ? 'var(--muted-foreground)' : 'var(--muted-foreground)',
                padding: 2, marginLeft: 2, borderRadius: 3, flexShrink: 0,
              }}
              onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'var(--border)'; e.currentTarget.style.color = 'var(--foreground)'; }}
              onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = active ? 'var(--muted-foreground)' : 'var(--muted-foreground)'; }}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Preview / editor ──────────────────────────────────────────────────────────

interface FileViewerProps {
  path: string | null;
  cwd?: string | null;
  /** Session the file belongs to — needed to fetch its git diff. */
  sessionId?: string | null;
  /** Git status of this file (from the parent's status map). When the file has
   *  tracked changes, the viewer offers a content/diff toggle. */
  gitStatus?: string | null;
  highlightQuery?: string | null;
  highlightLine?: number | null;
  onDelete?: () => void;
  /** Debounced auto-save while editing (used by Knowledge notes). */
  autoSave?: boolean;
}

export function FileViewer({ path, cwd: viewerCwd, sessionId, gitStatus, highlightQuery, highlightLine, onDelete, autoSave }: FileViewerProps) {
  const displayPath = viewerCwd && path?.startsWith(viewerCwd + '/') ? path.slice(viewerCwd.length + 1) : (path ?? undefined);
  return (
    <FileView
      path={path}
      sessionId={sessionId}
      displayPath={displayPath}
      gitStatus={gitStatus}
      highlightQuery={highlightQuery}
      highlightLine={highlightLine}
      onDelete={onDelete}
      editable
      autoSave={autoSave}
      defaultMode={autoSave ? 'edit' : 'content'}
    />
  );
}

// ── Search panel ─────────────────────────────────────────────────────────────

interface SearchResultProps {
  result: SearchResultData;
  cwd: string | null;
  isActive: boolean;
  onClick: () => void;
  query: string;
}

function SearchResult({ result, isActive, onClick, query }: SearchResultProps) {
  // Highlight matching text
  const highlightSearchText = (text: string): React.ReactNode => {
    if (!query) return text;
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let idx: number;
    const lowerQuery = query.toLowerCase();
    let key = 0;
    while ((idx = remaining.toLowerCase().indexOf(lowerQuery)) !== -1) {
      if (idx > 0) parts.push(<span key={key++}>{remaining.slice(0, idx)}</span>);
      parts.push(<span key={key++} style={{ background: '#D9B84A40', color: '#d9b84a', borderRadius: 2, padding: '0 1px' }}>{remaining.slice(idx, idx + query.length)}</span>);
      remaining = remaining.slice(idx + query.length);
    }
    if (remaining) parts.push(<span key={key++}>{remaining}</span>);
    return parts.length ? parts : text;
  };

  return (
    <div
      onClick={onClick}
      style={{
        padding: '3px 10px 3px 20px',
        cursor: 'pointer',
        background: isActive ? 'var(--accent)' : 'transparent',
        borderBottom: '1px solid var(--card)',
        display: 'flex', alignItems: 'baseline', gap: 8,
      }}
      onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => { if (!isActive) e.currentTarget.style.background = 'var(--card)'; }}
      onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ fontSize: 10, color: 'var(--muted-foreground)', flexShrink: 0, fontFamily: '"JetBrains Mono",monospace', minWidth: 28, textAlign: 'right' }}>{result.line}</span>
      <div style={{
        fontSize: 11, color: 'var(--muted-foreground)', fontFamily: '"JetBrains Mono",monospace',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
      }}>
        {highlightSearchText(result.text.trim())}
      </div>
    </div>
  );
}

interface SearchPanelProps {
  sessionId: string | null;
  onOpenFile: (path: string, query?: string, line?: number) => void;
  active?: boolean;
  /** When set, restrict the search root to this directory instead of the
   *  session's cwd. Lets the user run "search in this folder" from any
   *  point in the file browser. */
  scopeDir?: string | null;
}

export function SearchPanel({ sessionId, onOpenFile, active, scopeDir }: SearchPanelProps) {
  const [query, setQuery]       = useState('');
  const [glob, setGlob]         = useState('');
  const [showGlob, setShowGlob] = useState(false);
  const [results, setResults]   = useState<SearchResultData[]>([]);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [cwd, setCwd]           = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched]   = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Group results by file
  const grouped: Record<string, SearchResultData[]> = {};
  for (const r of results) {
    if (!grouped[r.file]) grouped[r.file] = [];
    grouped[r.file]!.push(r);
  }

  const doSearch = useCallback(async (q: string, g: string) => {
    if (!sessionId || !q.trim()) { setResults([]); setFileResults([]); setSearched(false); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setSearched(true);
    try {
      const contentParams = new URLSearchParams({ q: q.trim() });
      if (g.trim())  contentParams.set('glob', g.trim());
      if (scopeDir)  contentParams.set('dir', scopeDir);
      const fileParams = new URLSearchParams({ q: q.trim() });
      if (scopeDir)  fileParams.set('dir', scopeDir);
      // Fetch content search and filename search in parallel
      const [contentRes, fileRes] = await Promise.all([
        fetch(`/api/fs/${encodeURIComponent(sessionId!)}/search?${contentParams}`, { signal: controller.signal }),
        fetch(`/api/fs/${encodeURIComponent(sessionId!)}/find?${fileParams}`, { signal: controller.signal }),
      ]);
      const [contentData, fileData] = await Promise.all([contentRes.json(), fileRes.json()]);
      if (!controller.signal.aborted) {
        setResults(contentData.results ?? []);
        setFileResults(fileData.results ?? []);
        setCwd(contentData.cwd ?? fileData.cwd ?? null);
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') { setResults([]); setFileResults([]); }
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, [sessionId, scopeDir]);

  const [focusedResult, setFocusedResult] = useState(-1);
  const flatResults = results; // already flat

  // Debounced search
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleInput = (val: string) => {
    setQuery(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(val, glob), 300);
  };

  const handleGlobChange = (val: string) => {
    setGlob(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (query.trim()) timerRef.current = setTimeout(() => doSearch(query, val), 300);
  };

  // Reset when session changes
  useEffect(() => {
    setQuery(''); setGlob(''); setResults([]); setFileResults([]); setSearched(false);
    inputRef.current?.focus();
  }, [sessionId]);

  // Re-run the current search when the scope folder changes — e.g. user
  // navigated to a different directory while the search panel was open.
  useEffect(() => {
    if (query.trim()) doSearch(query, glob);
  }, [scopeDir]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus on mount and when tab becomes active
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { if (active) setTimeout(() => inputRef.current?.focus(), 0); }, [active]);

  const fileCount = Object.keys(grouped).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Search input */}
      <div style={{ padding: '8px 10px 4px', borderBottom: '1px solid var(--border)', background: 'var(--card)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 5, padding: '4px 8px' }}>
          <Search size={12} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => handleInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setQuery(''); setResults([]); setSearched(false); setFocusedResult(-1); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setFocusedResult(prev => Math.min(prev + 1, flatResults.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setFocusedResult(prev => Math.max(prev - 1, -1)); }
              else if (e.key === 'Enter' && focusedResult >= 0 && flatResults[focusedResult]) {
                e.preventDefault();
                const r = flatResults[focusedResult]!;
                onOpenFile(cwd ? `${cwd}/${r.file}` : r.file, query, r.line);
              }
            }}
            placeholder={scopeDir ? `Search in ${scopeDir.split('/').pop() ?? ''}/…` : 'Search in files…'}
            spellCheck={false}
            style={{
              flex: 1, border: 'none', outline: 'none', background: 'transparent',
              color: 'var(--foreground)', fontSize: 12, fontFamily: '"JetBrains Mono",monospace',
              padding: 0,
            }}
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setResults([]); setSearched(false); inputRef.current?.focus(); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', display: 'flex', padding: 0, flexShrink: 0 }}
            >
              <X size={12} />
            </button>
          )}
          <button
            onClick={() => setShowGlob(g => !g)}
            title={glob ? `File filter active: ${glob}` : 'Filter by file type (e.g. *.ts, *.jsx)'}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0, display: 'flex',
              color: showGlob || glob ? '#9cbc7f' : 'var(--muted-foreground)',
            }}
          >
            <Filter size={12} />
          </button>
        </div>
        {showGlob && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 8px' }}>
            <span style={{ fontSize: 10, color: 'var(--muted-foreground)', flexShrink: 0 }}>glob:</span>
            <input
              value={glob}
              onChange={e => handleGlobChange(e.target.value)}
              placeholder="e.g. *.ts, *.jsx"
              spellCheck={false}
              style={{
                flex: 1, border: 'none', outline: 'none', background: 'transparent',
                color: 'var(--foreground)', fontSize: 11, fontFamily: '"JetBrains Mono",monospace',
                padding: 0,
              }}
            />
          </div>
        )}
        {searched && (
          <div style={{ fontSize: 10, color: 'var(--muted-foreground)', padding: '4px 0 2px', display: 'flex', gap: 6 }}>
            {searching ? (
              <span>Searching\u2026</span>
            ) : (
              <span>
                {fileResults.length > 0 && `${fileResults.length} file${fileResults.length !== 1 ? 's' : ''}`}
                {fileResults.length > 0 && results.length > 0 && ' · '}
                {results.length > 0 && `${results.length} match${results.length !== 1 ? 'es' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}`}
                {fileResults.length === 0 && results.length === 0 && 'No results'}
                {results.length >= 500 ? ' (limit reached)' : ''}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!searched && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted-foreground)', fontSize: 12 }}>
            Type to search file names and contents
          </div>
        )}
        {searched && !searching && results.length === 0 && fileResults.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted-foreground)', fontSize: 12 }}>
            No results found
          </div>
        )}
        {/* File name matches */}
        {fileResults.length > 0 && (
          <div>
            <div style={{
              padding: '4px 10px', fontSize: 10, color: 'var(--muted-foreground)',
              background: 'var(--card)', borderBottom: '1px solid var(--secondary)',
              textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
              position: 'sticky', top: 0, zIndex: 2,
            }}>
              Files
            </div>
            {fileResults.map(file => (
              <div
                key={file}
                onClick={() => onOpenFile(cwd ? `${cwd}/${file}` : file)}
                style={{
                  padding: '4px 10px',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                  borderBottom: '1px solid var(--card)',
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => e.currentTarget.style.background = 'var(--card)'}
                onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => e.currentTarget.style.background = 'transparent'}
              >
                <File size={11} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                <span style={{
                  fontSize: 11, color: '#8EBFA2',
                  fontFamily: '"JetBrains Mono",monospace',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {file}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* Content matches */}
        {results.length > 0 && fileResults.length > 0 && (
          <div style={{
            padding: '4px 10px', fontSize: 10, color: 'var(--muted-foreground)',
            background: 'var(--card)', borderBottom: '1px solid var(--secondary)',
            textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
            position: 'sticky', top: 0, zIndex: 2,
          }}>
            Content
          </div>
        )}
        {(() => {
          let globalIdx = 0;
          return Object.entries(grouped).map(([file, matches], groupIdx) => (
          <div key={file} style={{ marginTop: groupIdx > 0 ? 6 : 0 }}>
            <div style={{
              padding: '5px 10px', fontSize: 11, color: 'var(--foreground)',
              fontFamily: '"JetBrains Mono",monospace',
              background: 'var(--card)', borderBottom: '1px solid var(--secondary)',
              display: 'flex', alignItems: 'center', gap: 6,
              position: 'sticky', top: fileResults.length > 0 ? 22 : 0, zIndex: 1,
            }}>
              <FileCode size={11} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{file}</span>
              <span style={{ color: 'var(--muted-foreground)', flexShrink: 0, fontSize: 10 }}>{matches.length}</span>
            </div>
            {matches.map((r, i) => {
              const idx = globalIdx++;
              return (
              <SearchResult
                key={`${r.line}-${i}`}
                result={r}
                cwd={cwd}
                query={query}
                isActive={idx === focusedResult}
                onClick={() => onOpenFile(cwd ? `${cwd}/${r.file}` : r.file, query, r.line)}
              />
              );
            })}
          </div>
          ));
        })()}
      </div>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

interface FilesPaneProps {
  sessionId: string | null;
  openFileRef: React.MutableRefObject<((path: string) => void | Promise<void>) | null>;
  onFileSelect?: (path: string) => void;
  highlightQuery?: string | null;
  highlightLine?: number | null;
}

export default function FilesPane({ sessionId, openFileRef, onFileSelect, highlightQuery, highlightLine }: FilesPaneProps) {
  const [dir,          setDir]          = useState<string | null>(null);
  const [entries,      setEntries]      = useState<Entry[]>([]);
  const [cwd,          setCwd]          = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading,      setLoading]      = useState(false);
  // Monotonic browse counter — only the latest navigation applies its result,
  // so rapid subdir clicks don't get clobbered by an earlier in-flight load.
  const browseSeqRef = useRef(0);
  // Only surface a loading indicator if a navigation is actually slow (>150ms),
  // so quick browses don't flash/flicker the list.
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!loading) { setShowLoading(false); return; }
    const t = setTimeout(() => setShowLoading(true), 150);
    return () => clearTimeout(t);
  }, [loading]);
  // Height of the file-list panel, which sits ABOVE the file viewer (the list
  // and viewer are stacked vertically). Drag the divider to resize.
  const [listHeight, setListHeight] = useState<number>(() => {
    try { return parseInt(preferences.getItem('sheepit:files-list-h') ?? '') || 240; } catch { return 240; }
  });
  // Mobile: 'list' | 'preview'
  const [mobileView,   setMobileView]   = useState<'list' | 'preview'>('list');
  const [gitStatus,    setGitStatus]    = useState<Record<string, string> | null>(null);
  const [isDragOver,   setIsDragOver]   = useState(false);
  const [uploadMsg,    setUploadMsg]    = useState<string | null>(null);
  const [creating,     setCreating]     = useState<'file' | 'folder' | null>(null);
  const [createName,   setCreateName]   = useState('');
  const [fileFilter,   setFileFilter]   = useState('');
  const [showFileFilter, setShowFileFilter] = useState(false);
  /** Recursive search mode — replaces the entries list with a SearchPanel
   *  scoped to the currently-browsed directory. Toggled from the toolbar. */
  const [searchMode,   setSearchMode]   = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);
  const fileFilterRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);
  const [focusedEntry, setFocusedEntry] = useState(-1);
  const fileListRef = useRef<HTMLDivElement>(null);
  // ── Pinned tabs ───────────────────────────────────────────────────────────
  // Double-clicking a file in the tree (or opening one via Search / external
  // openFileRef) promotes it from an ephemeral preview to a pinned tab. Tabs
  // are per-session and persisted in localStorage so switching away from the
  // Files view (or to a different session and back) keeps them visible.
  const [openTabs, setOpenTabs] = useState<string[]>([]);

  // Highlight state — seeded from props (terminal file-link clicks, git-diff
  // jumps), but the integrated search panel can also drive it for in-pane
  // search-hit navigation. Internal state lets us own the latest value.
  const [hlQuery, setHlQuery] = useState<string | null>(highlightQuery ?? null);
  const [hlLine,  setHlLine]  = useState<number | null>(highlightLine  ?? null);
  useEffect(() => { setHlQuery(highlightQuery ?? null); }, [highlightQuery]);
  useEffect(() => { setHlLine(highlightLine ?? null); }, [highlightLine]);

  const browse = useCallback(async (targetPath: string | null, { autoReadme = false }: { autoReadme?: boolean } = {}) => {
    if (!sessionId) return;
    const seq = ++browseSeqRef.current;
    setLoading(true);
    try {
      const url = targetPath
        ? `/api/fs/${encodeURIComponent(sessionId!)}/browse?path=${encodeURIComponent(targetPath)}`
        : `/api/fs/${encodeURIComponent(sessionId!)}/browse`;
      const res  = await fetch(url);
      const data = await res.json();
      // A newer navigation superseded this one — drop the stale result.
      if (seq !== browseSeqRef.current) return;
      if (data.error) throw new Error(data.error);
      setDir(data.dir);
      setCwd(prev => prev ?? data.cwd);
      setEntries(data.entries);
      if (autoReadme) {
        const readme = data.entries.find((e: Entry) => !e.isDir && /^readme\.md$/i.test(e.name));
        const firstFile = data.entries.find((e: Entry) => !e.isDir);
        const toOpen = readme ?? firstFile ?? null;
        if (toOpen) setSelectedFile(toOpen.path);
      }
    } catch (e) {
      if (seq === browseSeqRef.current) console.error(e);
    } finally {
      if (seq === browseSeqRef.current) setLoading(false);
    }
  }, [sessionId]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length || !dir) return;
    let errors = 0;
    for (const file of files) {
      try {
        const res = await fetch(
          `/api/fs/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }
        );
        const data = await res.json();
        if (!data.ok) errors++;
      } catch { errors++; }
    }
    const msg = errors === 0
      ? (files.length === 1 ? `Uploaded ${files[0]!.name}` : `Uploaded ${files.length} files`)
      : `${errors} upload(s) failed`;
    setUploadMsg(msg);
    setTimeout(() => setUploadMsg(null), 3000);
    browse(dir);
  }, [dir, browse]);

  const onDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    const startY = e.clientY;
    const startH = listHeight;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const h = Math.max(100, Math.min(600, startH + ev.clientY - startY));
      setListHeight(h);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setListHeight(h => { try { preferences.setItem('sheepit:files-list-h', String(h)); } catch {} return h; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [listHeight]);

  // Reset cwd (the per-session project root) so the next browse re-anchors to
  // THIS pane's root. `browse` pins cwd via `prev ?? data.cwd`, so without this
  // reset the root stays stuck on whichever pane's repo was opened first —
  // making the breadcrumb / "go up" / relative paths point at another repo.
  useEffect(() => { if (!sessionId) return; setCwd(null); browse(null, { autoReadme: true }); setSelectedFile(null); setMobileView('list'); setGitStatus(null); }, [sessionId]); // eslint-disable-line

  // Load pinned tabs whenever the session changes (per-session storage key).
  useEffect(() => {
    if (!sessionId) { setOpenTabs([]); return; }
    try {
      const raw = preferences.getItem(`sheepit:files-tabs:${sessionId}`);
      const arr = raw ? JSON.parse(raw) : [];
      setOpenTabs(Array.isArray(arr) ? arr.filter((p): p is string => typeof p === 'string') : []);
    } catch { setOpenTabs([]); }
  }, [sessionId]);

  // Persist tabs whenever they change.
  useEffect(() => {
    if (!sessionId) return;
    try { preferences.setItem(`sheepit:files-tabs:${sessionId}`, JSON.stringify(openTabs)); } catch {}
  }, [openTabs, sessionId]);

  // Fetch git status and refresh every 5s
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/git/${encodeURIComponent(sessionId)}/status`);
        const data = await res.json();
        if (!cancelled) setGitStatus(data.files ?? null);
      } catch { /* ignore */ }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sessionId]);

  // Expose openFile(path) to parent via ref
  useEffect(() => {
    if (!openFileRef) return;
    openFileRef.current = async (filePath: string) => {
      // Browse to the file's parent directory, then select it
      const parentDir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : null;
      await browse(parentDir);
      setSelectedFile(filePath);
      setMobileView('preview');
      // External opens (e.g. search-result jump, "open in files") are
      // intentional enough to pin as a tab.
      setOpenTabs(tabs => tabs.includes(filePath) ? tabs : [...tabs, filePath]);
      onFileSelect?.(filePath);
    };
  }, [openFileRef, browse, onFileSelect]);

  const selectFile = (path: string) => {
    setSelectedFile(path);
    setMobileView('preview');
    onFileSelect?.(path);
  };

  const openFileTab = useCallback((path: string) => {
    setOpenTabs(tabs => tabs.includes(path) ? tabs : [...tabs, path]);
    selectFile(path);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Click-handler for SearchPanel results: opens the file as a pinned tab,
  // sets the highlight so the viewer scrolls to and tints the match line,
  // and clears the search panel so the user can read the file. The search
  // query/results stay populated — toggling the search button back on
  // re-shows the same state.
  const openSearchHit = useCallback((path: string, query?: string, line?: number) => {
    setHlQuery(query ?? null);
    setHlLine(line ?? null);
    setSearchMode(false);
    setOpenTabs(tabs => tabs.includes(path) ? tabs : [...tabs, path]);
    selectFile(path);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const closeTab = useCallback((path: string) => {
    setOpenTabs(tabs => {
      const idx = tabs.indexOf(path);
      if (idx === -1) return tabs;
      const next = tabs.filter(t => t !== path);
      // If the closed tab was the active file, fall back to an adjacent tab
      // so the viewer stays populated — matches how editors handle tab close.
      if (selectedFile === path) {
        const adjacent = next[idx] ?? next[idx - 1] ?? null;
        if (adjacent) { setSelectedFile(adjacent); onFileSelect?.(adjacent); }
        else         { setSelectedFile(null); setMobileView('list'); }
      }
      return next;
    });
  }, [selectedFile, onFileSelect]);

  const startCreate = (type: 'file' | 'folder') => {
    setCreating(type);
    setCreateName('');
    setTimeout(() => createInputRef.current?.focus(), 0);
  };

  const commitCreate = async () => {
    const name = createName.trim();
    if (!name || !dir) { setCreating(null); return; }
    const fullPath = `${dir}/${name}`;
    try {
      if (creating === 'folder') {
        await fetch(`/api/fs/mkdir?path=${encodeURIComponent(fullPath)}`, { method: 'POST' });
      } else {
        await fetch(`/api/fs/write?path=${encodeURIComponent(fullPath)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: '' }),
        });
      }
      await browse(dir);
      if (creating === 'file') selectFile(fullPath);
    } catch { /* ignore */ }
    setCreating(null);
  };

  const handleDelete = useCallback(() => {
    const deletedFile = selectedFile;
    setSelectedFile(null);
    setMobileView('list');
    if (deletedFile) setOpenTabs(tabs => tabs.filter(t => t !== deletedFile));
    if (dir) browse(dir);
    if (deletedFile) onFileSelect?.(null as any);
  }, [selectedFile, dir, browse, onFileSelect]);

  // When entries change, restore focus to the selected file or default to first entry
  useEffect(() => {
    setFileFilter('');
    if (selectedFile && entries.length > 0) {
      const idx = entries.findIndex(e => e.path === selectedFile);
      setFocusedEntry(idx >= 0 ? idx : (entries.length > 0 ? 0 : -1));
    } else {
      setFocusedEntry(entries.length > 0 ? 0 : -1);
    }
    setTimeout(() => fileListRef.current?.focus(), 0);
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredEntries = fileFilter
    ? entries.filter(e => e.name.toLowerCase().includes(fileFilter.toLowerCase()))
    : entries;

  const handleFileListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (filteredEntries.length === 0) return;

    // File navigation: up/down or j/k to move through entries
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedEntry(prev => {
        const next = Math.min(prev + 1, filteredEntries.length - 1);
        fileListRef.current?.querySelector(`[data-entry-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        const entry = filteredEntries[next];
        if (entry && !entry.isDir) selectFile(entry.path);
        return next;
      });
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedEntry(prev => {
        const next = Math.max(prev - 1, 0);
        fileListRef.current?.querySelector(`[data-entry-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        const entry = filteredEntries[next];
        if (entry && !entry.isDir) selectFile(entry.path);
        return next;
      });
      return;
    }
    // Right/l: enter directory or open file
    if (e.key === 'ArrowRight' || e.key === 'l') {
      e.preventDefault();
      const entry = filteredEntries[focusedEntry];
      if (!entry) return;
      if (entry.isDir) browse(entry.path);
      else selectFile(entry.path);
      return;
    }
    // Left/h: go to parent directory
    if (e.key === 'ArrowLeft' || e.key === 'h') {
      e.preventDefault();
      if (dir && cwd && dir !== cwd) {
        const parent = dir.split('/').slice(0, -1).join('/') || '/';
        browse(parent);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const entry = filteredEntries[focusedEntry];
      if (!entry) return;
      if (entry.isDir) browse(entry.path);
      else selectFile(entry.path);
      return;
    }
    if (e.key === 'Backspace') {
      if (dir && cwd && dir !== cwd) {
        e.preventDefault();
        const parent = dir.split('/').slice(0, -1).join('/') || '/';
        browse(parent);
      }
      return;
    }
  }, [filteredEntries, focusedEntry, browse, dir, cwd, selectFile]);

  // Breadcrumb segments for the current `dir`, with navigation targets.
  //  - When `dir` is under `cwd` (the common case), we anchor the trail at
  //    the project root: first crumb is cwd's basename → cwd; remaining
  //    crumbs are relative subdirectories.
  //  - When `dir` is outside `cwd` (the user browsed up past the project, or
  //    into /tmp, etc.), we render absolute path segments instead of
  //    pretending they live under cwd — otherwise the trail ends up showing
  //    something like "project/Users/me/other-tree" which is misleading.
  const { crumbs, absolute: crumbsAbsolute } = (() => {
    if (!dir) return { crumbs: [] as { label: string; path: string }[], absolute: false };
    const insideCwd = !!cwd && (dir === cwd || dir.startsWith(cwd + '/'));
    if (insideCwd) {
      const rel = dir === cwd ? '' : dir.slice(cwd!.length + 1);
      const rootLabel = cwd!.split('/').pop() || '/';
      const out: { label: string; path: string }[] = [{ label: rootLabel, path: cwd! }];
      if (rel) {
        const segs = rel.split('/');
        let cur = cwd!;
        for (const s of segs) { cur += '/' + s; out.push({ label: s, path: cur }); }
      }
      return { crumbs: out, absolute: false };
    }
    const out: { label: string; path: string }[] = [];
    let cur = '';
    for (const s of dir.split('/').filter(Boolean)) {
      cur += '/' + s;
      out.push({ label: s, path: cur });
    }
    return { crumbs: out, absolute: true };
  })();

  // "Go up" target: disabled at cwd (when inside cwd) or at filesystem root.
  const upDir = dir && dir !== cwd && dir !== '/'
    ? (dir.split('/').slice(0, -1).join('/') || '/')
    : null;

  const toolbar = (showBack: boolean = false) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--card)', flexShrink: 0 }}>
      {showBack ? (
        <button onClick={() => setMobileView('list')} title="Back to files" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2, flexShrink: 0 }}>
          <ChevronLeft size={14} />
        </button>
      ) : upDir ? (
        <button onClick={() => browse(upDir)} title="Go up" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2, flexShrink: 0 }}>
          <ChevronLeft size={14} />
        </button>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0, overflow: 'hidden', fontFamily: '"JetBrains Mono",monospace', fontSize: 11 }}>
        {showBack ? (
          <span style={{ color: 'var(--muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedFile?.split('/').pop() ?? ''}
          </span>
        ) : (
          <>
            {/* Leading "/" for absolute paths outside cwd so it's clear the
                trail doesn't start at the project root. */}
            {crumbsAbsolute && <span style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}>/</span>}
            {crumbs.map((c, i) => {
              const isLast = i === crumbs.length - 1;
              return (
                <React.Fragment key={i}>
                  {i > 0 && <span style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}>/</span>}
                  <button
                    onClick={() => browse(c.path)}
                    title={c.path}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: '0 2px', fontFamily: 'inherit', fontSize: 'inherit',
                      color: isLast ? 'var(--foreground)' : 'var(--muted-foreground)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      minWidth: 0, borderRadius: 3,
                    }}
                    onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.color = 'var(--foreground)'}
                    onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.color = isLast ? 'var(--foreground)' : 'var(--muted-foreground)'}
                  >
                    {c.label}
                  </button>
                </React.Fragment>
              );
            })}
          </>
        )}
      </div>
      {!showBack && (
        <>
          <button
            onClick={() => { setSearchMode(m => !m); setShowFileFilter(false); }}
            title={searchMode ? 'Exit search' : 'Search in this folder'}
            style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: searchMode ? '#9cbc7f' : 'var(--muted-foreground)', flexShrink: 0, padding: 3 }}
          >
            <Search size={12} />
          </button>
          <button
            onClick={() => { setShowFileFilter(f => { if (!f) setTimeout(() => fileFilterRef.current?.focus(), 0); return !f; }); setFileFilter(''); }}
            title="Filter visible entries"
            style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: showFileFilter ? '#9cbc7f' : 'var(--muted-foreground)', flexShrink: 0, padding: 3 }}
          >
            <Filter size={12} />
          </button>
          <button onClick={() => startCreate('file')} title="New file" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', flexShrink: 0, padding: 3 }}>
            <FilePlus size={15} />
          </button>
          <button onClick={() => startCreate('folder')} title="New folder" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', flexShrink: 0, padding: 3 }}>
            <FolderPlus size={15} />
          </button>
          <button onClick={() => browse(dir)} disabled={loading} title="Refresh" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer', color: loading ? 'var(--muted-foreground)' : 'var(--muted-foreground)', flexShrink: 0 }}>
            <RefreshCw size={11} />
          </button>
        </>
      )}
    </div>
  );

  const fileFilterInput = showFileFilter && (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
      background: 'var(--background)', borderBottom: '1px solid var(--secondary)',
    }}>
      <Search size={11} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
      <input
        ref={fileFilterRef}
        value={fileFilter}
        onChange={e => { setFileFilter(e.target.value); setFocusedEntry(-1); }}
        onKeyDown={e => {
          if (e.key === 'Escape') { setShowFileFilter(false); setFileFilter(''); }
        }}
        placeholder="Filter files…"
        spellCheck={false}
        style={{
          flex: 1, border: 'none', outline: 'none', background: 'transparent',
          color: 'var(--foreground)', fontSize: 11, padding: 0,
          fontFamily: '"JetBrains Mono",monospace',
        }}
      />
      {fileFilter && (
        <span style={{ fontSize: 10, color: 'var(--muted-foreground)', flexShrink: 0 }}>
          {filteredEntries.length}/{entries.length}
        </span>
      )}
      <button
        onClick={() => { setShowFileFilter(false); setFileFilter(''); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', display: 'flex', padding: 0, flexShrink: 0 }}
      >
        <X size={11} />
      </button>
    </div>
  );

  const createInput = creating && (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7, padding: '4px 10px',
      background: 'var(--secondary)', borderBottom: '1px solid var(--card)',
    }}>
      {creating === 'folder'
        ? <FolderPlus size={13} color="#8EBFA2" style={{ flexShrink: 0 }} />
        : <FilePlus size={13} color="var(--muted-foreground)" style={{ flexShrink: 0 }} />}
      <input
        ref={createInputRef}
        value={createName}
        onChange={e => setCreateName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') commitCreate();
          if (e.key === 'Escape') setCreating(null);
        }}
        onBlur={commitCreate}
        placeholder={creating === 'folder' ? 'folder name' : 'file name'}
        spellCheck={false}
        style={{
          flex: 1, border: 'none', outline: 'none', background: 'transparent',
          color: 'var(--foreground)', fontSize: 12, padding: 0,
          fontFamily: '"JetBrains Mono",monospace',
        }}
      />
    </div>
  );

  const fileList = (
    <>
      {toolbar(false)}
      {searchMode ? (
        <SearchPanel
          sessionId={sessionId}
          scopeDir={dir}
          active
          onOpenFile={openSearchHit}
        />
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {fileFilterInput}
          {createInput}
          {showLoading && <div className="file-loading-bar" />}
          {!loading && filteredEntries.length === 0 && !creating && <div style={{ padding: '16px 12px', color: 'var(--muted-foreground)', fontSize: 12, textAlign: 'center' }}>{fileFilter ? 'No matches' : 'Empty directory'}</div>}
          <div key={dir ?? 'root'} className="file-list-anim">
            {filteredEntries.map(e => (
              <EntryRow key={e.path} entry={e} selected={selectedFile} onOpen={openFileTab} onNavigate={browse} gitStatus={gitStatus} />
            ))}
          </div>
        </div>
      )}
    </>
  );

  const tabsBar = openTabs.length > 0 && (
    <TabsBar tabs={openTabs} activePath={selectedFile} onSelect={selectFile} onClose={closeTab} />
  );

  const preview = (
    <>
      {toolbar(true)}
      {tabsBar}
      <FileViewer path={selectedFile} cwd={cwd} sessionId={sessionId} gitStatus={selectedFile ? gitStatus?.[selectedFile] ?? null : null} highlightQuery={hlQuery} highlightLine={hlLine} onDelete={handleDelete} />
    </>
  );

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--background)', position: 'relative' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 50,
          background: 'rgba(124, 168, 96, 0.12)',
          border: '2px dashed #9CBC7F',
          borderRadius: 4,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{ textAlign: 'center', color: '#9cbc7f' }}>
            <Upload size={28} style={{ marginBottom: 6 }} />
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              Drop to upload to /{dir?.split('/').pop() ?? ''}
            </div>
          </div>
        </div>
      )}
      {uploadMsg && (
        <div style={{
          position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '6px 14px', fontSize: 12, zIndex: 40, whiteSpace: 'nowrap', pointerEvents: 'none',
          color: uploadMsg.includes('failed') ? '#E0907B' : '#9CBC7F',
        }}>
          {uploadMsg}
        </div>
      )}
      {/* Mobile: single panel (list or preview) */}
      <div className="md:hidden flex flex-col flex-1 min-h-0">
        {mobileView === 'list' ? fileList : preview}
      </div>

      {/* Desktop: split layout */}
      <div className="hidden md:flex flex-col flex-1 min-h-0">
        {toolbar(false)}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div
            ref={fileListRef}
            tabIndex={0}
            onKeyDown={searchMode ? undefined : handleFileListKeyDown}
            style={{ height: listHeight, flexShrink: 0, overflowY: searchMode ? 'hidden' : 'auto', overflowX: 'hidden', position: 'relative', outline: 'none', display: 'flex', flexDirection: 'column' }}
          >
            {searchMode ? (
              <SearchPanel
                sessionId={sessionId}
                scopeDir={dir}
                active
                onOpenFile={openSearchHit}
              />
            ) : (
              <>
                {fileFilterInput}
                {createInput}
                {showLoading && <div className="file-loading-bar" />}
                {!loading && filteredEntries.length === 0 && !creating && <div style={{ padding: '16px 12px', color: 'var(--muted-foreground)', fontSize: 12, textAlign: 'center' }}>{fileFilter ? 'No matches' : 'Empty directory'}</div>}
                <div key={dir ?? 'root'} className="file-list-anim">
                  {filteredEntries.map((e, i) => (
                    <EntryRow key={e.path} entry={e} index={i} selected={selectedFile} focused={i === focusedEntry} onOpen={openFileTab} onNavigate={browse} gitStatus={gitStatus} />
                  ))}
                </div>
              </>
            )}
          </div>
          {/* Resize divider — drag to grow/shrink the file list above. */}
          <div
            onMouseDown={onDragStart}
            style={{
              flexShrink: 0, height: 4, width: '100%',
              cursor: 'row-resize', zIndex: 10,
              background: 'var(--border)',
            }}
            onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => e.currentTarget.style.background = '#9cbc7f'}
            onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => { if (!draggingRef.current) e.currentTarget.style.background = 'var(--border)'; }}
          />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
            {tabsBar}
            <FileViewer path={selectedFile} cwd={cwd} sessionId={sessionId} gitStatus={selectedFile ? gitStatus?.[selectedFile] ?? null : null} highlightQuery={hlQuery} highlightLine={hlLine} onDelete={handleDelete} />
          </div>
        </div>
      </div>
    </div>
  );
}
