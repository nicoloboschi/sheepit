// Unified single-file viewer used by BOTH the Files browser and the Git diff
// pane. It renders one file as either its working-tree DIFF or its CONTENT
// (view / editable), with a toggle between them. The diff button is only
// offered when the file actually has changes.
//
// - Files view  → mounts with `defaultMode="content"`; Diff appears when the
//   file has tracked changes.
// - Git diff    → mounts with `defaultMode="diff"` and pre-parsed `hunks` (so
//   it doesn't re-fetch); flipping to content fetches the raw file.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import CodeMirror from '@uiw/react-codemirror';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { php } from '@codemirror/lang-php';
import { go } from '@codemirror/lang-go';
import { sass } from '@codemirror/lang-sass';
import { less } from '@codemirror/lang-less';
import { xml } from '@codemirror/lang-xml';
import { StreamLanguage } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r as rMode } from '@codemirror/legacy-modes/mode/r';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { csharp, scala, kotlin, dart } from '@codemirror/legacy-modes/mode/clike';
import type { Extension } from '@codemirror/state';
import {
  ChevronDown, ChevronRight, FileCode, FilePlus, FileMinus,
  Eye, Pencil, Diff, Save, Copy, Check, ClipboardCopy, ExternalLink, Trash2,
  Maximize2, Minimize2, Loader2, AlertCircle,
} from 'lucide-react';
import * as sharedWs from '../sharedWs';

// ── Diff types + parser (owned here; GitDiffPane/FilesPane import from this) ──

export interface DiffLine { type: 'add' | 'del' | 'ctx'; content: string; }
export interface DiffHunk { header: string; context: string; oldStart: number; newStart: number; lines: DiffLine[]; }
export interface DiffFile {
  oldPath: string; newPath: string; hunks: DiffHunk[];
  additions: number; deletions: number;
  isNew: boolean; isDeleted: boolean; isBinary: boolean;
}

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = { oldPath: m ? m[1]! : '', newPath: m ? m[2]! : '', hunks: [], additions: 0, deletions: 0, isNew: false, isDeleted: false, isBinary: false };
      files.push(file!); hunk = null;
    } else if (!file) {
      continue;
    } else if (line.startsWith('new file'))     { file.isNew = true; }
    else if (line.startsWith('deleted file'))   { file.isDeleted = true; }
    else if (line.startsWith('Binary files'))   { file.isBinary = true; }
    else if (line.startsWith('--- '))           { file.oldPath = line.slice(4).replace(/^a\//, ''); }
    else if (line.startsWith('+++ '))           { file.newPath = line.slice(4).replace(/^b\//, ''); }
    else if (line.startsWith('@@ ')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (m) { hunk = { header: line.match(/@@ .* @@/)?.[0] ?? line, context: m[3]!.trim(), oldStart: +m[1]!, newStart: +m[2]!, lines: [] }; file.hunks.push(hunk); }
    } else if (hunk) {
      if (line.startsWith('+'))      { hunk.lines.push({ type: 'add', content: line.slice(1) }); file.additions++; }
      else if (line.startsWith('-')) { hunk.lines.push({ type: 'del', content: line.slice(1) }); file.deletions++; }
      else if (line.startsWith(' ') || line === '') { hunk.lines.push({ type: 'ctx', content: line.slice(1) }); }
    }
  }
  return files;
}

interface HunkRow extends DiffLine { oldNum: number | null; newNum: number | null; }

export function HunkView({ hunk }: { hunk: DiffHunk }) {
  const rows: HunkRow[] = [];
  let old = hunk.oldStart, nw = hunk.newStart;
  for (const line of hunk.lines) {
    rows.push({ ...line, oldNum: (line.type !== 'add') ? old : null, newNum: (line.type !== 'del') ? nw : null });
    if (line.type !== 'add') old++;
    if (line.type !== 'del') nw++;
  }
  return (
    <div style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 8, padding: '2px 12px', background: 'var(--accent)', borderBottom: '1px solid var(--border)' }}>
        <span style={{ color: '#93C5FD', userSelect: 'none' }}>{hunk.header}</span>
        {hunk.context && <span style={{ color: 'var(--muted-foreground)' }}>{hunk.context}</span>}
      </div>
      {rows.map((row, i) => {
        const isAdd = row.type === 'add', isDel = row.type === 'del';
        return (
          <div key={i} style={{ display: 'flex', background: isAdd ? 'var(--diff-add-bg)' : isDel ? 'var(--diff-del-bg)' : 'transparent', borderBottom: '1px solid var(--background)' }}>
            <div style={{ width: 44, padding: '1px 8px', textAlign: 'right', color: 'var(--muted-foreground)', userSelect: 'none', flexShrink: 0, borderRight: '1px solid var(--border)' }}>{row.oldNum ?? ''}</div>
            <div style={{ width: 44, padding: '1px 8px', textAlign: 'right', color: 'var(--muted-foreground)', userSelect: 'none', flexShrink: 0, borderRight: '1px solid var(--border)' }}>{row.newNum ?? ''}</div>
            <div style={{ width: 20, padding: '1px 4px', textAlign: 'center', color: isAdd ? '#4ADE80' : isDel ? '#F87171' : 'var(--muted-foreground)', userSelect: 'none', flexShrink: 0 }}>
              {isAdd ? '+' : isDel ? '-' : ' '}
            </div>
            <pre style={{ margin: 0, padding: '1px 8px 1px 0', color: isAdd ? 'var(--diff-add-fg)' : isDel ? 'var(--diff-del-fg)' : 'var(--foreground)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1, minWidth: 0 }}>
              {row.content}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

// ── File-type helpers ───────────────────────────────────────────────────────

const ext = (name: string): string => (name ?? '').split('.').pop()?.toLowerCase() ?? '';

const EXT_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'docker', makefile: 'makefile',
  swift: 'swift', kt: 'kotlin', scala: 'scala', r: 'r',
  lua: 'lua', perl: 'perl', php: 'php', dart: 'dart',
  vue: 'html', svelte: 'html', astro: 'html',
  md: 'markdown', mdx: 'markdown', tex: 'latex',
  ini: 'ini', env: 'bash', conf: 'ini', cfg: 'ini',
  proto: 'protobuf', tf: 'hcl',
};
export const getLang = (name: string) => EXT_LANG[ext(name)] ?? 'text';

const legacy = (m: Parameters<typeof StreamLanguage.define>[0]): Extension => StreamLanguage.define(m);

function getCmLang(name: string): Extension[] {
  switch (getLang(name)) {
    case 'javascript': return [javascript()];
    case 'jsx':        return [javascript({ jsx: true })];
    case 'typescript': return [javascript({ typescript: true })];
    case 'tsx':        return [javascript({ jsx: true, typescript: true })];
    case 'python':     return [python()];
    case 'css':        return [css()];
    case 'scss':       return [sass()];
    case 'less':       return [less()];
    case 'html':       return [html()];
    case 'xml':        return [xml()];
    case 'json':       return [json()];
    case 'markdown':   return [markdown()];
    case 'rust':       return [rust()];
    case 'java':       return [java()];
    case 'cpp': case 'c': return [cpp()];
    case 'csharp':     return [legacy(csharp)];
    case 'scala':      return [legacy(scala)];
    case 'kotlin':     return [legacy(kotlin)];
    case 'dart':       return [legacy(dart)];
    case 'go':         return [go()];
    case 'sql':        return [sql()];
    case 'yaml':       return [yaml()];
    case 'php':        return [php()];
    case 'bash':       return [legacy(shell)];
    case 'ruby':       return [legacy(ruby)];
    case 'toml':       return [legacy(toml)];
    case 'ini':        return [legacy(properties)];
    case 'swift':      return [legacy(swift)];
    case 'lua':        return [legacy(lua)];
    case 'perl':       return [legacy(perl)];
    case 'r':          return [legacy(rMode)];
    case 'docker':     return [legacy(dockerFile)];
    case 'protobuf':   return [legacy(protobuf)];
    case 'latex':      return [legacy(stex)];
    default:           return [];
  }
}

export const isImage = (name: string): boolean => ['png','jpg','jpeg','gif','webp','svg','ico','bmp'].includes(ext(name));
export const isPdf   = (name: string): boolean => ext(name) === 'pdf';
export const isMd    = (name: string): boolean => ['md','markdown','mdx'].includes(ext(name));
export const isText  = (name: string): boolean => !isImage(name) && !isPdf(name);

// ── Unified file view ─────────────────────────────────────────────────────────

type Mode = 'preview' | 'edit' | 'diff';

export interface FileViewProps {
  /** Absolute path on disk — used for content fetch and file actions. */
  path: string | null;
  /** Session whose cwd the file belongs to (for fetching its diff). */
  sessionId?: string | null;
  /** Path shown in the header (relative). Falls back to `path`. */
  displayPath?: string;
  /** Initial mode: 'content' (view/preview), 'edit' (editor), or 'diff'. Default 'content'. */
  defaultMode?: 'content' | 'edit' | 'diff';
  /** Allow editing + Save in the content view. */
  editable?: boolean;
  /** Debounced auto-save while editing (opt-in; used by Knowledge notes) so the
   *  user doesn't have to hit Save. Off → explicit Save only. */
  autoSave?: boolean;
  /** Pre-parsed diff hunks (git diff view passes these to avoid re-fetching). */
  hunks?: DiffHunk[];
  additions?: number;
  deletions?: number;
  isNew?: boolean;
  isDeleted?: boolean;
  isBinary?: boolean;
  /** Files-view git status string; used to decide if a diff exists when no
   *  `hunks` are supplied. */
  gitStatus?: string | null;
  highlightQuery?: string | null;
  highlightLine?: number | null;
  onDelete?: () => void;
  /** Collapsible header (the stacked multi-file git list uses this). */
  collapsible?: boolean;
  /** Focus ring (keyboard nav in the git list). */
  isFocused?: boolean;
  /** Scroll container — when set, the diff body lazy-mounts on approach. */
  scrollRoot?: React.RefObject<HTMLDivElement | null>;
}

export default function FileView({
  path, sessionId, displayPath, defaultMode = 'content', editable = false, autoSave = false,
  hunks, additions, deletions, isNew, isDeleted, isBinary,
  gitStatus, highlightQuery, highlightLine, onDelete,
  collapsible = false, isFocused = false, scrollRoot,
}: FileViewProps) {
  const name = (displayPath ?? path ?? '').split('/').pop() ?? '';
  const mdFile  = isMd(name);
  const imgFile = isImage(name);
  const pdfFile = isPdf(name);
  const textFile = isText(name);

  // Directory of the markdown file — relative image srcs resolve against it.
  const mdDir = useMemo(() => {
    if (!path) return '';
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(0, i) : '';
  }, [path]);

  // Rewrite a markdown image src to something the browser can load. Absolute
  // URLs / data: URIs pass through; local paths (relative to the .md file, or
  // absolute-on-disk, or ~-rooted) are routed through the /fs/raw endpoint,
  // which serves the file bytes with the right content-type.
  const resolveImgSrc = (src?: string): string | undefined => {
    if (!src) return src;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src; // http:, https:, data:, …
    let abs = (src.startsWith('/') || src.startsWith('~')) ? src : `${mdDir}/${src}`;
    // Collapse ./ and ../ segments (no node path module in the browser).
    const rooted = abs.startsWith('/');
    const out: string[] = [];
    for (const seg of abs.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop();
        else if (!rooted) out.push('..');
      } else out.push(seg);
    }
    abs = (rooted ? '/' : '') + out.join('/');
    return `/api/fs/raw?path=${encodeURIComponent(abs)}`;
  };

  // A diff exists when hunks were supplied, or (files view) the git status says
  // the tracked/new file changed. Deleted files have nothing to show as content.
  const hasDiff = hunks
    ? (hunks.length > 0 || !!isNew || !!isBinary)
    : (!!path && !!gitStatus && gitStatus !== 'deleted');

  const [mode, setMode] = useState<Mode>(
    defaultMode === 'diff' && hasDiff ? 'diff'
    : defaultMode === 'edit' && editable ? 'edit'
    : 'preview',
  );
  // Per-file fullscreen (distraction-free) mode.
  const [zen, setZen] = useState(false);
  const [original, setOriginal] = useState('');
  const [content, setContent] = useState('');
  // Start in the loading state when the content view will fetch on mount, so the
  // spinner shows immediately instead of a blank pane that fills in.
  const [loading, setLoading] = useState(() => !!path && textFile && !(defaultMode === 'diff' && hasDiff));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedContent, setCopiedContent] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Diff fetched on demand when no hunks were supplied (files view).
  const [fetchedHunks, setFetchedHunks] = useState<DiffHunk[] | null>(null);
  const highlightRef = useRef<HTMLElement>(null);

  const isDirty = content !== original;
  const diffHunks = hunks ?? fetchedHunks ?? [];
  // Live-update: `justUpdated` flashes the body when the file changes on disk;
  // `diskChanged` warns when it changed under unsaved edits (we don't clobber).
  const [justUpdated, setJustUpdated] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const contentRef = useRef(content); contentRef.current = content;
  const isDirtyRef = useRef(isDirty); isDirtyRef.current = isDirty;
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Prism (showLineNumbers + per-line lineProps + wrapLongLines) is O(n) and
  // janky on big files, so above a threshold we render plain monospace text —
  // instant. We ALSO skip Prism when there's no language to highlight (e.g.
  // .jsonl, .log, .ndjson, .csv, plain .txt): it gains nothing from tokenizing
  // and pays the full wrapLongLines cost, which made data files feel like they
  // hung. `getLang` returns 'text' for any extension without a Prism grammar.
  const noHighlight = content.length > 50_000
    || content.split('\n', 1501).length > 1500
    || getLang(name) === 'text';

  // Lazy-mount the diff body when inside a scrolling list.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyVisible, setBodyVisible] = useState(!scrollRoot);
  const estHeight = useMemo(() => Math.max(40, diffHunks.reduce((s, h) => s + h.lines.length + 1, 0) * 18), [diffHunks]);
  useEffect(() => {
    if (bodyVisible || collapsed || mode !== 'diff') return;
    const el = bodyRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some(e => e.isIntersecting)) { setBodyVisible(true); io.disconnect(); } },
      { root: scrollRoot?.current ?? null, rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [bodyVisible, collapsed, mode, scrollRoot]);

  // Load content for the content view (skipped for img/pdf which load via <img>/<iframe>).
  useEffect(() => {
    if (!path || mode === 'diff' || imgFile || pdfFile) return;
    setError(null); setSaveMsg(null); setLoading(true);
    fetch(`/api/fs/raw?path=${encodeURIComponent(path)}`)
      .then(r => { if (!r.ok) return r.text().then(t => { throw new Error(t); }); return r.text(); })
      .then(text => { setContent(text); setOriginal(text); setLoading(false); setDiskChanged(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [path, mode]); // eslint-disable-line

  // Live updates: subscribe to on-disk changes for the open file and re-fetch
  // when it's rewritten (e.g. by Claude Code). We never clobber unsaved edits —
  // if the user has local changes we surface a "changed on disk" hint instead.
  useEffect(() => {
    if (!path || imgFile || pdfFile) return;
    // Rides the shared WebSocket rather than an SSE stream per open file: a
    // browser allows only ~6 HTTP/1.1 connections per host and an SSE stream
    // never completes, so a handful of open files starved every other request
    // to the origin — the whole app failed with "Failed to fetch".
    const unwatch = sharedWs.watchFile(path);
    const unsub = sharedWs.subscribeGlobal((msg) => {
      if (msg.type !== 'file_changed' || msg.path !== path) return;
      fetch(`/api/fs/raw?path=${encodeURIComponent(path)}`)
        .then(r => r.ok ? r.text() : Promise.reject())
        .then(text => {
          if (text === contentRef.current) return;      // our own save / no-op
          if (isDirtyRef.current) { setDiskChanged(true); return; } // don't overwrite edits
          setContent(text); setOriginal(text);
          setJustUpdated(true);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setJustUpdated(false), 1400);
        })
        .catch(() => { /* transient read error — ignore */ });
    });
    return () => { unsub(); unwatch(); };
  }, [path, imgFile, pdfFile]);

  // Fetch the per-file diff when toggled to diff with no pre-parsed hunks.
  useEffect(() => {
    if (mode !== 'diff' || hunks || !path || !sessionId) return;
    let cancelled = false;
    setFetchedHunks(null);
    fetch(`/api/git/${encodeURIComponent(sessionId)}/diff?path=${encodeURIComponent(path)}`)
      .then(r => r.text())
      .then(text => { if (!cancelled) setFetchedHunks(parseDiff(text).flatMap(f => f.hunks)); })
      .catch(() => { if (!cancelled) setFetchedHunks([]); });
    return () => { cancelled = true; };
  }, [mode, path, sessionId, hunks]);

  // If a file loses its changes while showing the diff, fall back to content.
  useEffect(() => { if (mode === 'diff' && !hasDiff) setMode('preview'); }, [hasDiff]); // eslint-disable-line

  useEffect(() => {
    if (highlightRef.current) setTimeout(() => highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
  }, [content, highlightLine, highlightQuery]);

  // Esc exits fullscreen.
  useEffect(() => {
    if (!zen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zen]);

  // Fill available height (vs. capped boxes in the collapsible git list) when
  // standalone (files view) OR in fullscreen.
  const fill = !collapsible || zen;

  const save = async () => {
    if (!path) return;
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch(`/api/fs/write?path=${encodeURIComponent(path)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setOriginal(content); setSaveMsg('Saved'); setTimeout(() => setSaveMsg(null), 2000);
    } catch (e: any) { setSaveMsg(`Error: ${e.message}`); } finally { setSaving(false); }
  };

  // ── Auto-save (opt-in) ──────────────────────────────────────────────────────
  // Debounce a write shortly after the user stops typing, then flush any pending
  // edits when switching files or unmounting so the last keystrokes aren't lost.
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!autoSave || !editable || !path || !isDirty || mode !== 'edit') return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => { void save(); }, 600);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [content, autoSave, editable, path, isDirty, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Latest buffer, read by the flush-on-switch/unmount cleanup below.
  const flushRef = useRef({ content, isDirty, autoSave, editable });
  flushRef.current = { content, isDirty, autoSave, editable };
  useEffect(() => {
    const flushPath = path; // captured: the file this effect instance is for
    return () => {
      const { content: c, isDirty: d, autoSave: a, editable: e } = flushRef.current;
      if (a && e && d && flushPath) {
        fetch(`/api/fs/write?path=${encodeURIComponent(flushPath)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: c }), keepalive: true,
        }).catch(() => {});
      }
    };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const openNative = async () => {
    if (!path) return;
    try {
      const res = await fetch(`/api/fs/open?path=${encodeURIComponent(path)}`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to open');
    } catch (e: any) { setSaveMsg(`Error: ${e.message}`); setTimeout(() => setSaveMsg(null), 3000); }
  };

  const deleteFile = async () => {
    if (!path) return;
    if (!window.confirm(`Delete ${name}?`)) return;
    try {
      const res = await fetch(`/api/fs/delete?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      onDelete?.();
    } catch (e: any) { setError(e.message); }
  };

  const copy = (text: string, set: (v: boolean) => void) => navigator.clipboard.writeText(text).then(() => { set(true); setTimeout(() => set(false), 1500); });

  if (!path && !hunks) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--muted-foreground)', fontSize: 13 }}>
      Select a file to view
    </div>
  );

  const shownPath = displayPath ?? path ?? name;
  // Content side needs a path on disk; the diff side just needs changes.
  const toggleBtns = ([
    path ? { id: 'preview' as const, icon: <Eye size={11} />, label: mdFile ? 'Preview' : 'View' } : null,
    path && editable ? { id: 'edit' as const, icon: <Pencil size={11} />, label: 'Edit' } : null,
    hasDiff ? { id: 'diff' as const, icon: <Diff size={11} />, label: 'Diff' } : null,
  ].filter(Boolean)) as { id: Mode; icon: JSX.Element; label: string }[];

  const showBody = !(collapsible && collapsed) || zen;

  // Shown while the file's content is being fetched, across all text modes so
  // there's always a clear "loading" cue (not just a blank pane that fills in).
  const loadingEl = (
    <div style={{ flex: fill ? 1 : undefined, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--muted-foreground)', fontSize: 12, padding: 24 }}>
      <Loader2 size={14} className="animate-spin" /> Loading…
    </div>
  );

  const containerStyle: React.CSSProperties = zen
    ? {
        position: 'fixed', inset: 32, zIndex: 1000, display: 'flex', flexDirection: 'column',
        background: 'var(--background)', border: '1px solid #0074d9', borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 0 80px rgba(0,116,217,0.35), 0 20px 60px rgba(0,0,0,0.6)',
      }
    : collapsible
      ? { border: `1px solid ${isFocused ? '#0074d9' : 'var(--border)'}`, borderRadius: 6, marginBottom: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' }
      : { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 };

  return (
    <>
      {zen && (
        <div
          onClick={() => setZen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,8,20,0.85)', backdropFilter: 'blur(6px)' }}
        />
      )}
      <div style={containerStyle}>
      {/* Header — filename, stats, actions, and the content/diff toggle. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderBottom: showBody ? '1px solid var(--border)' : 'none', background: 'var(--card)', flexShrink: 0 }}>
        {collapsible && (
          <div onClick={() => setCollapsed(c => !c)} style={{ display: 'flex', cursor: 'pointer', flexShrink: 0 }}>
            {collapsed ? <ChevronRight size={13} color="var(--muted-foreground)" /> : <ChevronDown size={13} color="var(--muted-foreground)" />}
          </div>
        )}
        {isNew ? <FilePlus size={13} color="#4ADE80" style={{ flexShrink: 0 }} />
          : isDeleted ? <FileMinus size={13} color="#F87171" style={{ flexShrink: 0 }} />
          : <FileCode size={13} color="var(--muted-foreground)" style={{ flexShrink: 0 }} />}
        <span title={shownPath} style={{ fontSize: 11, color: 'var(--foreground)', fontFamily: '"JetBrains Mono",monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {shownPath}{isDirty ? ' •' : ''}
        </span>
        {justUpdated && <span className="file-updated-badge" style={{ flexShrink: 0 }}>updated</span>}
        {diskChanged && <span className="file-disk-changed-badge" title="This file changed on disk while you have unsaved edits" style={{ flexShrink: 0 }}>changed on disk</span>}
        {(additions ?? 0) > 0 && <span style={{ fontSize: 11, color: '#4ADE80', fontFamily: 'monospace', flexShrink: 0 }}>+{additions}</span>}
        {(deletions ?? 0) > 0 && <span style={{ fontSize: 11, color: '#F87171', fontFamily: 'monospace', flexShrink: 0 }}>-{deletions}</span>}

        {path && (
          <>
            <button onClick={() => copy(path, setCopied)} title="Copy path" style={iconBtn(copied ? '#4ADE80' : 'var(--muted-foreground)')}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            {textFile && (
              <button onClick={() => copy(content, setCopiedContent)} title="Copy file content" style={iconBtn(copiedContent ? '#4ADE80' : 'var(--muted-foreground)')}>
                {copiedContent ? <Check size={12} /> : <ClipboardCopy size={12} />}
              </button>
            )}
            <button onClick={openNative} title="Open in native app" style={iconBtn('var(--muted-foreground)')}><ExternalLink size={12} /></button>
            {onDelete && <button onClick={deleteFile} title="Delete file" style={iconBtn('var(--muted-foreground)')}><Trash2 size={12} /></button>}
          </>
        )}

        <button onClick={() => setZen(z => !z)} title={zen ? 'Exit fullscreen (Esc)' : 'Fullscreen this file'} style={iconBtn(zen ? '#0074d9' : 'var(--muted-foreground)')}>
          {zen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>

        {/* Fixed-width save-status slot — icon only, always reserved so it never
            shifts the surrounding header icons as it appears/clears. */}
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 14, flexShrink: 0 }} title={saveMsg ?? (saving ? 'Saving…' : undefined)}>
          {saving ? <Loader2 size={12} className="animate-spin" style={{ color: 'var(--muted-foreground)' }} />
            : saveMsg?.startsWith('Error') ? <AlertCircle size={12} style={{ color: '#F87171' }} />
            : saveMsg ? <Check size={12} style={{ color: '#4ADE80' }} />
            : null}
        </span>

        {textFile && toggleBtns.length > 1 && (
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 5, overflow: 'hidden', flexShrink: 0 }}>
            {toggleBtns.map(({ id, icon, label }, i) => (
              <button key={id} onClick={() => setMode(id)} style={{
                display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 8px',
                background: mode === id ? 'var(--accent)' : 'none',
                color: mode === id ? 'var(--foreground)' : 'var(--muted-foreground)',
                border: 'none', borderRight: i < toggleBtns.length - 1 ? '1px solid var(--border)' : 'none', cursor: 'pointer',
              }}>{icon}{label}</button>
            ))}
          </div>
        )}
        {textFile && editable && mode === 'edit' && !autoSave && (
          <button onClick={save} disabled={saving || !isDirty} title="Save (⌘S)" style={{
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 5,
            background: isDirty ? '#1f6feb' : 'none', border: isDirty ? 'none' : '1px solid var(--border)',
            color: isDirty ? '#fff' : 'var(--muted-foreground)', cursor: isDirty && !saving ? 'pointer' : 'default', flexShrink: 0,
          }}><Save size={11} />{saving ? 'Saving…' : 'Save'}</button>
        )}
      </div>

      {/* Body */}
      {showBody && error && <div style={{ padding: 16, color: '#F87171', fontSize: 12 }}>{error}</div>}
      {showBody && !error && (
        <>
          {imgFile && path && mode !== 'diff' && (
            <div style={{ padding: 16, overflow: 'auto', flex: fill ? 1 : undefined }}>
              <img src={`/api/fs/raw?path=${encodeURIComponent(path)}`} alt={name} style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid var(--border)' }} />
            </div>
          )}
          {pdfFile && path && mode !== 'diff' && (
            <iframe src={`/api/fs/raw?path=${encodeURIComponent(path)}`} title={name} style={{ flex: fill ? 1 : undefined, height: fill ? undefined : 480, border: 'none', minHeight: 0, width: '100%' }} />
          )}

          {mode === 'diff' && (
            <div ref={bodyRef} style={{ ...(fill ? { flex: 1, minHeight: 0 } : {}), overflow: 'auto', background: 'var(--background)', ...(bodyVisible ? {} : { minHeight: estHeight }) }}>
              {bodyVisible && (
                isBinary ? <div style={{ padding: '10px 14px', color: 'var(--muted-foreground)', fontSize: 12, fontStyle: 'italic' }}>Binary file changed</div>
                : diffHunks.length === 0 ? <div style={{ padding: 16, color: 'var(--muted-foreground)', fontSize: 12 }}>{(!hunks && fetchedHunks === null) ? 'Loading…' : 'No diff to show'}</div>
                : diffHunks.map((hunk, i) => <HunkView key={i} hunk={hunk} />)
              )}
            </div>
          )}

          {textFile && mode !== 'diff' && loading && loadingEl}

          {textFile && mode === 'edit' && editable && !loading && (
            <div className={justUpdated ? 'file-updated-flash' : undefined} style={{ flex: fill ? 1 : undefined, minHeight: 0, maxHeight: fill ? undefined : 600, overflow: 'auto' }}>
              <CodeMirror
                value={content}
                extensions={[EditorView.lineWrapping, ...getCmLang(name)]}
                theme={vscodeDark}
                onChange={setContent}
                onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 's' && e.metaKey) { e.preventDefault(); if (isDirty) save(); } }}
                basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, tabSize: 2, searchKeymap: false }}
                style={{ fontSize: 13, fontFamily: '"JetBrains Mono",monospace', minHeight: '100%' }}
              />
            </div>
          )}
          {textFile && (mode === 'edit' && !editable || mode === 'preview') && !mdFile && !loading && (
            <div className={justUpdated ? 'file-updated-flash' : undefined} style={{ flex: fill ? 1 : undefined, maxHeight: fill ? undefined : 600, overflow: 'auto' }}>
              {noHighlight ? (
                <pre style={{ margin: 0, padding: '8px 12px', background: 'var(--background)', fontSize: 12, fontFamily: '"JetBrains Mono",monospace', color: 'var(--foreground)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {content}
                </pre>
              ) : (
                <SyntaxHighlighter
                  language={getLang(name)} style={vscDarkPlus} showLineNumbers wrapLongLines
                  lineNumberStyle={{ minWidth: '3em', paddingRight: 12, color: 'var(--muted-foreground)', userSelect: 'none' }}
                  customStyle={{ margin: 0, padding: '8px 0', background: 'var(--background)', fontSize: 12, fontFamily: '"JetBrains Mono",monospace' }}
                  lineProps={highlightLine == null ? undefined : (lineNum: number) => {
                    const isTarget = lineNum === highlightLine;
                    return { ref: isTarget ? (highlightRef as any) : undefined, style: isTarget ? { background: 'rgba(210,153,34,0.15)', display: 'block' } : { display: 'block' } };
                  }}
                >{content}</SyntaxHighlighter>
              )}
            </div>
          )}
          {textFile && mode === 'preview' && mdFile && !loading && (
            <div className={justUpdated ? 'file-updated-flash' : undefined} style={{ flex: fill ? 1 : undefined, maxHeight: fill ? undefined : 600, overflow: 'auto', padding: '16px 24px' }}>
              {content.trim()
                ? <div className="md-preview"><Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      img: ({ src, alt, ...props }) => (
                        // eslint-disable-next-line jsx-a11y/alt-text
                        <img {...props} src={resolveImgSrc(typeof src === 'string' ? src : undefined)} alt={alt ?? ''} loading="lazy" />
                      ),
                    }}
                  >{content}</Markdown></div>
                : <div style={{ color: 'var(--muted-foreground)', fontSize: 12, fontStyle: 'italic' }}>Empty note — switch to Edit to start writing.</div>}
            </div>
          )}
        </>
      )}
      </div>
    </>
  );
}

const iconBtn = (color: string): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color, padding: 2, flexShrink: 0,
});
