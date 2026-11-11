import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Home, Monitor, FileText, Download, HardDrive, TerminalSquare, Star, X, History, NotebookPen, Activity, Github, Repeat } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import FilesPane from './FilesPane';
import ActivityMonitor from './ActivityMonitor';
import ScratchTerminals from './ScratchTerminals';
import GithubPage from './GithubPage';
import RepsPage from './RepsPage';
import DiskPage from './DiskPage';

import useStore, { type SystemPage as Page } from '../store';
import { preferences } from '../preferences';

/** Favourited directories, in the server-side profile like every other
 *  preference — so the folders you keep are the same in every browser looking
 *  at this machine. Its own key, not a field on a bigger blob: two tabs
 *  writing one blob is last-writer-wins. */
const FAVOURITES_KEY = 'sheepit:file-favourites';

function readFavourites(): string[] {
  try {
    const raw = JSON.parse(preferences.getItem(FAVOURITES_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  } catch { return []; }
}

interface SystemDialogProps {
  /** A file to open, from a path clicked in a terminal. `seq` counts requests
   *  rather than naming files: clicking the same path again after browsing away
   *  means "take me back to it", and a value that has not changed says nothing. */
  openFile?: { path: string; line: number | null; seq: number } | null;
}

/** The System panel: the file browser over the whole app — the Finder you do
 *  not have to leave sheepit for — plus your notes (a place in its left
 *  column: they are plain .md files), the scratch terminals, GitHub, reps and
 *  a small Activity Monitor. Every global lives here, one page at a time.
 *
 *  It is the pane's own Files view (`FilesPane`), not a second browser: one
 *  tree, one editor, the same breadcrumb, go-up, search, upload and new-file
 *  controls. What the dialog adds is Finder's left column — it opens at your
 *  home directory rather than inside one pane's repo, because a file manager
 *  that starts wherever the terminal happens to be standing is a pane, not a
 *  Finder. */
export default function SystemDialog({ openFile }: SystemDialogProps) {
  // Any live session will do: the fs API is session-scoped only to resolve a
  // starting directory, and we hand it an absolute path instead.
  const sessionId = useStore(s => {
    const ws = s.currentSessionId ? s.workspaces[s.currentSessionId] : undefined;
    return ws?.cells[ws.activeCell] ?? s.currentSessionId;
  });
  const panePath = useStore(s => (sessionId ? s.sessionMap[sessionId]?.path : undefined));

  const [path, setPath] = useState<string>('~');
  const [dir, setDir] = useState<string | null>(null);
  const [favourites, setFavourites] = useState<string[]>(readFavourites);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  /** Which page fills the right side. Files stays mounted under the others,
   *  so coming back finds the folder and the open file where you left them;
   *  the rest mount only while shown (Activity and reps poll). */
  const page = useStore(s => s.systemPage);
  const setPage = useStore(s => s.setSystemPage);
  const scratchCount = useStore(useShallow(s => s.sessions.filter(x => x.isHeadless && !x.sideOf).length));
  /** Where the notes live (`~/.config/sheepit/notes`). Asked of the server,
   *  which also makes the folder and a first sheet if there are none. */
  const [notesDir, setNotesDir] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/notes/sheets').then(r => r.json()).then((d: { dir?: string }) => setNotesDir(d.dir ?? null)).catch(() => {});
  }, []);

  const saveFavourites = (next: string[]) => {
    setFavourites(next);
    preferences.setItem(FAVOURITES_KEY, JSON.stringify(next));
  };
  const isFavourite = !!dir && favourites.includes(dir);
  const toggleFavourite = () => {
    if (!dir) return;
    saveFavourites(isFavourite ? favourites.filter(p => p !== dir) : [...favourites, dir]);
  };
  // FilesPane hands its "open this path" handle back through a ref — this is
  // what a file link clicked in a terminal arrives through.
  const openFileRef = useRef<((path: string, opts?: { pin?: boolean }) => void | Promise<void>) | null>(null);
  /** "Browse to this folder", filled in by FilesPane. Called rather than
   *  passed as a value, so picking Home while standing in a folder under home
   *  still navigates. */
  const browseRef = useRef<((path: string) => void) | null>(null);

  const goTo = (target: string) => { setPage('files'); setPath(target); browseRef.current?.(target); };

  /** The line to scroll to and tint, from a `path.ts:42` link. Kept here and
   *  dropped as soon as another file is opened, or line 42 of that one would be
   *  highlighted too. */
  const [hlLine, setHlLine] = useState<number | null>(null);

  // FilesPane's own mount effect browses `initialPath` at the same time, and it
  // starts first (child effects run before the parent's), so this navigation
  // has the higher sequence number inside FilesPane and wins.
  useEffect(() => {
    if (!openFile) return;
    setPage('files');
    setHlLine(openFile.line);
    void openFileRef.current?.(openFile.path);
  }, [openFile?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Open this folder" from the Activity page's details.
  useEffect(() => {
    const onFolder = (e: Event) => {
      const p = (e as CustomEvent).detail?.path as string | undefined;
      if (p) goTo(p);
    };
    window.addEventListener('sheepit:open-folder', onFolder);
    return () => window.removeEventListener('sheepit:open-folder', onFolder);
  });

  const places: { label: string; path: string; icon: React.ReactNode }[] = [
    { label: 'Home',      path: '~',            icon: <Home size={13} /> },
    { label: 'Desktop',   path: '~/Desktop',    icon: <Monitor size={13} /> },
    { label: 'Documents', path: '~/Documents',  icon: <FileText size={13} /> },
    { label: 'Downloads', path: '~/Downloads',  icon: <Download size={13} /> },
    { label: 'Root',      path: '/',            icon: <HardDrive size={13} /> },
    // Where the pane you were in is standing — the one place a terminal
    // multiplexer knows that Finder does not.
    ...(panePath ? [{ label: 'This pane', path: panePath, icon: <TerminalSquare size={13} /> }] : []),
    // What Knowledge used to be: one .md file per sheet, edited like any file.
    ...(notesDir ? [{ label: 'Notes', path: notesDir, icon: <NotebookPen size={13} /> }] : []),
  ];
  const pages: { id: Page; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'files',     label: 'Files',     icon: <FolderOpen size={20} /> },
    { id: 'terminals', label: 'Terminals', icon: <TerminalSquare size={20} />, count: scratchCount },
    { id: 'github',    label: 'GitHub',    icon: <Github size={20} /> },
    { id: 'reps',      label: 'Reps',      icon: <Repeat size={20} /> },
    { id: 'activity',  label: 'Activity',  icon: <Activity size={20} /> },
    { id: 'disk',      label: 'Disk',      icon: <HardDrive size={20} /> },
  ];
  const placeStyle = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '5px 8px', borderRadius: 5, border: 'none', cursor: 'pointer',
    fontSize: 12, textAlign: 'left', width: '100%',
    background: on ? 'var(--accent)' : 'none',
    color: on ? 'var(--foreground)' : 'var(--muted-foreground)',
  });

  return (
    <div className="system-view" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--background)' }}>
      {/* The pages as a dock: an icon and its name, one click each. */}
      <div className="system-dock" role="tablist">
        {pages.map(p => (
          <button
            key={p.id}
            role="tab"
            aria-selected={page === p.id}
            className={`system-dock-item${page === p.id ? ' is-on' : ''}`}
            onClick={() => setPage(p.id)}
          >
            <span className="system-dock-icon">
              {p.icon}
              {p.count ? <span className="system-dock-badge">{p.count}</span> : null}
            </span>
            <span className="system-dock-label">{p.label}</span>
          </button>
        ))}
      </div>
      <div className="system-body">
        {page === 'files' && (
        <div
          className="sys-panel sys-side"
          style={{ width: 170, flexShrink: 0, padding: 8, overflowY: 'auto', gap: 2 }}
        >
          {places.map(p => (
            <button
              key={p.path}
              onClick={() => goTo(p.path)}
              title={p.path}
              style={placeStyle(page === 'files' && path === p.path)}
            >
              {p.icon}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
            </button>
          ))}

          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            margin: '10px 2px 2px', fontSize: 10, letterSpacing: 0.4,
            textTransform: 'uppercase', color: 'var(--muted-foreground)',
          }}>
            <span style={{ flex: 1 }}>Favourites</span>
            <button
              onClick={toggleFavourite}
              disabled={!dir}
              title={!dir ? 'Favourite this folder' : isFavourite ? `Remove ${dir}` : `Favourite ${dir}`}
              aria-label="Favourite this folder"
              style={{
                display: 'flex', background: 'none', border: 'none', padding: 2,
                cursor: dir ? 'pointer' : 'default',
                color: isFavourite ? 'var(--warning)' : 'var(--muted-foreground)',
              }}
            >
              <Star size={12} fill={isFavourite ? 'var(--warning)' : 'none'} />
            </button>
          </div>
          {favourites.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--muted-foreground)', padding: '2px 8px' }}>
              Star a folder to keep it here.
            </span>
          )}
          {favourites.map(fav => (
            <div key={fav} style={{ display: 'flex', alignItems: 'center' }}>
              <button
                onClick={() => goTo(fav)}
                title={fav}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, flex: 1, minWidth: 0,
                  padding: '5px 8px', borderRadius: 5, border: 'none', cursor: 'pointer',
                  fontSize: 12, textAlign: 'left',
                  background: dir === fav ? 'var(--accent)' : 'none',
                  color: dir === fav ? 'var(--foreground)' : 'var(--muted-foreground)',
                }}
              >
                <Star size={13} style={{ flexShrink: 0, color: 'var(--warning)' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fav.split('/').filter(Boolean).pop() ?? fav}
                </span>
              </button>
              <button
                onClick={() => saveFavourites(favourites.filter(p => p !== fav))}
                title={`Remove ${fav}`}
                aria-label={`Remove ${fav}`}
                style={{ display: 'flex', background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--muted-foreground)' }}
              >
                <X size={11} />
              </button>
            </div>
          ))}

          {recentFiles.length > 0 && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 4,
                margin: '12px 2px 2px', fontSize: 10, letterSpacing: 0.4,
                textTransform: 'uppercase', color: 'var(--muted-foreground)',
              }}>
                <span style={{ flex: 1 }}>Recent</span>
              </div>
              {recentFiles.map(file => {
                const name = file.split('/').pop() ?? file;
                return (
                  <button
                    key={file}
                    onClick={() => { setPage('files'); setHlLine(null); void openFileRef.current?.(file, { pin: false }); }}
                    title={file}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7, width: '100%', minWidth: 0,
                      padding: '5px 8px', borderRadius: 5, border: 'none', cursor: 'pointer',
                      fontSize: 12, textAlign: 'left', background: 'none', color: 'var(--muted-foreground)',
                    }}
                  >
                    <History size={13} style={{ flexShrink: 0, color: 'var(--muted-foreground)' }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
        )}
        {page === 'activity' && <div className="sys-panel is-grow"><ActivityMonitor /></div>}
        {page === 'disk' && <div className="sys-panel is-grow"><DiskPage /></div>}
        {page === 'github' && <GithubPage />}
        {page === 'reps' && <div className="sys-panel is-grow"><RepsPage /></div>}
        {page === 'terminals' && <div className="sys-panel is-grow"><ScratchTerminals /></div>}
        <div className="sys-panel is-grow" style={{ display: page === 'files' ? 'flex' : 'none', flexDirection: 'row' }}>
        <FilesPane
          sessionId={sessionId}
          openFileRef={openFileRef}
          browseRef={browseRef}
          initialPath={path}
          onDirChange={setDir}
          onRecentFilesChange={setRecentFiles}
          finder
          highlightLine={hlLine}
          onFileSelect={(p: string) => { if (p !== openFile?.path) setHlLine(null); }}
        />
        </div>
      </div>
    </div>
  );
}
