import { useEffect, useRef, useState } from 'react';
import { Plus, X, FileText, Folder } from 'lucide-react';
import { FileViewer } from './FilesPane';

export default function NotesPane(): JSX.Element {
  const [sheets, setSheets] = useState<string[]>([]);
  const [dir, setDir] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement | null>(null);

  // Load sheet list + the on-disk notes directory.
  const loadSheets = (selectAfter?: (sheets: string[]) => string | null) => {
    return fetch('/api/notes/sheets')
      .then(r => r.json())
      .then((d: { sheets: string[]; dir?: string }) => {
        setSheets(d.sheets);
        setDir(d.dir ?? null);
        setActiveSheet(prev => {
          if (selectAfter) return selectAfter(d.sheets);
          if (prev && d.sheets.includes(prev)) return prev;
          const saved = localStorage.getItem('sheepit:active-note-sheet');
          return d.sheets.includes(saved ?? '') ? saved! : (d.sheets[0] ?? null);
        });
      })
      .catch(() => {});
  };

  useEffect(() => { loadSheets(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeSheet) localStorage.setItem('sheepit:active-note-sheet', activeSheet); }, [activeSheet]);

  // Absolute (home-relative) path of the active sheet — the notes are plain .md
  // files on disk, so the Files pane's FileViewer can edit/open/copy them via
  // the /api/fs endpoints (which expand "~/").
  const activePath = dir && activeSheet ? `${dir}/${activeSheet}.md` : null;

  const addSheet = () => {
    const base = 'untitled';
    let name = base;
    let i = 2;
    while (sheets.includes(name)) name = `${base}-${i++}`;
    fetch(`/api/notes/sheets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    }).then(() => {
      setSheets(prev => [...prev, name]);
      setActiveSheet(name);
    });
  };

  const deleteSheet = (name: string) => {
    fetch(`/api/notes/sheets/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(() => {
        setSheets(prev => {
          const next = prev.filter(s => s !== name);
          if (activeSheet === name) setActiveSheet(next.length > 0 ? next[0]! : null);
          return next;
        });
      });
  };

  const startRename = (name: string) => {
    setRenaming(name);
    setRenameValue(name);
    setTimeout(() => renameRef.current?.select(), 50);
  };

  const commitRename = () => {
    if (!renaming) return;
    const trimmed = renameValue.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    setRenaming(null);
    if (!trimmed || trimmed === renaming || sheets.includes(trimmed)) return;
    fetch(`/api/notes/sheets/${encodeURIComponent(renaming)}`)
      .then(r => r.json())
      .then((d: { content: string }) => {
        return fetch(`/api/notes/sheets/${encodeURIComponent(trimmed)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: d.content ?? '' }),
        });
      })
      .then(() => fetch(`/api/notes/sheets/${encodeURIComponent(renaming)}`, { method: 'DELETE' }))
      .then(() => {
        setSheets(prev => prev.map(s => s === renaming ? trimmed : s));
        if (activeSheet === renaming) setActiveSheet(trimmed);
      });
  };

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, background: 'var(--background)' }}>
      {/* Left sidebar — sheets as a filesystem-style list */}
      <div style={{
        width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--border)', background: 'var(--card)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 8px 6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)', fontWeight: 600 }}>
            Sheets
          </span>
          <button
            onClick={addSheet}
            title="New sheet"
            className="hover:text-foreground"
            style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 }}
          >
            <Plus size={13} />
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {sheets.map(name => {
            const active = activeSheet === name;
            return (
              <div
                key={name}
                onClick={() => setActiveSheet(name)}
                onDoubleClick={() => startRename(name)}
                title={name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 8px 5px 12px', cursor: 'pointer', userSelect: 'none',
                  fontSize: 12, fontFamily: '"JetBrains Mono", monospace',
                  color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
                  background: active ? 'var(--accent)' : 'transparent',
                  borderLeft: active ? '2px solid var(--primary)' : '2px solid transparent',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
              >
                <FileText size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
                {renaming === name ? (
                  <input
                    ref={renameRef}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onClick={e => e.stopPropagation()}
                    style={{
                      flex: 1, minWidth: 0, fontSize: 12, background: 'var(--input)',
                      border: '1px solid var(--ring)', borderRadius: 3,
                      padding: '0 4px', color: 'var(--foreground)',
                      fontFamily: 'inherit', outline: 'none',
                    }}
                  />
                ) : (
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                )}
                {sheets.length > 1 && active && (
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteSheet(name); }}
                    style={{
                      display: 'flex', alignItems: 'center', flexShrink: 0,
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--muted-foreground)', padding: 0,
                    }}
                    title="Delete sheet"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {dir && (
          <div
            title={dir}
            style={{
              flexShrink: 0, borderTop: '1px solid var(--border)',
              padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 10, color: 'var(--muted-foreground)',
              fontFamily: '"JetBrains Mono", monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            <Folder size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{dir}</span>
          </div>
        )}
      </div>

      {/* Main — each sheet is a real .md file, rendered with the Files pane's
          viewer so it gets edit / preview / copy / open-in-app / delete. */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <FileViewer
          path={activePath}
          cwd={dir}
          autoSave
          onDelete={() => loadSheets(s => s[0] ?? null)}
        />
      </div>
    </div>
  );
}
