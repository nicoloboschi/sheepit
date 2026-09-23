import { useRef, useState } from 'react';
import { FolderOpen, Home, Monitor, FileText, Download, HardDrive, TerminalSquare, Star, X } from 'lucide-react';
import FloatingPanel from './FloatingPanel';
import FilesPane from './FilesPane';
import useStore from '../store';
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

interface FilesDialogProps {
  onClose: () => void;
}

/** The file browser as a dialog over the whole app — the Finder you do not
 *  have to leave sheepit for.
 *
 *  It is the pane's own Files view (`FilesPane`), not a second browser: one
 *  tree, one editor, the same breadcrumb, go-up, search, upload and new-file
 *  controls. What the dialog adds is Finder's left column — it opens at your
 *  home directory rather than inside one pane's repo, because a file manager
 *  that starts wherever the terminal happens to be standing is a pane, not a
 *  Finder. */
export default function FilesDialog({ onClose }: FilesDialogProps) {
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

  const saveFavourites = (next: string[]) => {
    setFavourites(next);
    preferences.setItem(FAVOURITES_KEY, JSON.stringify(next));
  };
  const isFavourite = !!dir && favourites.includes(dir);
  const toggleFavourite = () => {
    if (!dir) return;
    saveFavourites(isFavourite ? favourites.filter(p => p !== dir) : [...favourites, dir]);
  };
  // FilesPane hands its "open this path" handle back through a ref, for the
  // terminal's file links. Nothing calls it from here.
  const openFileRef = useRef<((path: string) => void | Promise<void>) | null>(null);
  /** "Browse to this folder", filled in by FilesPane. Called rather than
   *  passed as a value, so picking Home while standing in a folder under home
   *  still navigates. */
  const browseRef = useRef<((path: string) => void) | null>(null);

  const goTo = (target: string) => { setPath(target); browseRef.current?.(target); };

  const places: { label: string; path: string; icon: React.ReactNode }[] = [
    { label: 'Home',      path: '~',            icon: <Home size={13} /> },
    { label: 'Desktop',   path: '~/Desktop',    icon: <Monitor size={13} /> },
    { label: 'Documents', path: '~/Documents',  icon: <FileText size={13} /> },
    { label: 'Downloads', path: '~/Downloads',  icon: <Download size={13} /> },
    { label: 'Root',      path: '/',            icon: <HardDrive size={13} /> },
    // Where the pane you were in is standing — the one place a terminal
    // multiplexer knows that Finder does not.
    ...(panePath ? [{ label: 'This pane', path: panePath, icon: <TerminalSquare size={13} /> }] : []),
  ];

  return (
    <FloatingPanel
      title="Files"
      icon={<FolderOpen size={13} style={{ color: 'var(--primary)' }} />}
      onClose={onClose}
      width={980}
      height={640}
    >
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 160, flexShrink: 0, padding: 8, overflowY: 'auto',
            borderRight: '1px solid var(--border)', background: 'var(--chrome)',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          {places.map(p => (
            <button
              key={p.path}
              onClick={() => goTo(p.path)}
              title={p.path}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '5px 8px', borderRadius: 5, border: 'none', cursor: 'pointer',
                fontSize: 12, textAlign: 'left', width: '100%',
                background: path === p.path ? 'var(--accent)' : 'none',
                color: path === p.path ? 'var(--foreground)' : 'var(--muted-foreground)',
              }}
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
        </div>
        <FilesPane sessionId={sessionId} openFileRef={openFileRef} browseRef={browseRef} initialPath={path} onDirChange={setDir} />
      </div>
    </FloatingPanel>
  );
}
