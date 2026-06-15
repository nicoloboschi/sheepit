import { useEffect, useRef, useState, useCallback } from 'react';
import { Plus, X, FileText, Eye, Pencil } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function NotesPane(): JSX.Element {
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [preview, setPreview] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<string>('');

  // Load sheet list
  useEffect(() => {
    fetch('/api/notes/sheets')
      .then(r => r.json())
      .then((d: { sheets: string[] }) => {
        setSheets(d.sheets);
        if (d.sheets.length > 0 && !activeSheet) {
          const saved = localStorage.getItem('vipershell:active-note-sheet');
          setActiveSheet(d.sheets.includes(saved ?? '') ? saved! : d.sheets[0]!);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load active sheet content
  useEffect(() => {
    if (!activeSheet) return;
    setContent(null);
    localStorage.setItem('vipershell:active-note-sheet', activeSheet);
    fetch(`/api/notes/sheets/${encodeURIComponent(activeSheet)}`)
      .then(r => r.json())
      .then((d: { content: string }) => {
        const c = d.content ?? '';
        setContent(c);
        contentRef.current = c;
      })
      .catch(() => {
        setContent('');
        contentRef.current = '';
      });
  }, [activeSheet]);

  const save = useCallback((text: string) => {
    if (!activeSheet) return;
    setSaving(true);
    fetch(`/api/notes/sheets/${encodeURIComponent(activeSheet)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    })
      .then(() => setSaving(false))
      .catch(() => setSaving(false));
  }, [activeSheet]);

  const handleChange = useCallback((text: string) => {
    contentRef.current = text;
    setContent(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(text), 500);
  }, [save]);

  // Save on unmount if pending
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        if (activeSheet) {
          navigator.sendBeacon?.(`/api/notes/sheets/${encodeURIComponent(activeSheet)}`, new Blob(
            [JSON.stringify({ content: contentRef.current })],
            { type: 'application/json' }
          ));
        }
      }
    };
  }, [activeSheet]); // eslint-disable-line react-hooks/exhaustive-deps

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
          if (activeSheet === name) {
            setActiveSheet(next.length > 0 ? next[0]! : null);
          }
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
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#0c0c0c' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        borderBottom: '1px solid var(--border)',
        background: '#111111',
        overflowX: 'auto',
        flexShrink: 0,
      }}>
        {sheets.map(name => (
          <div
            key={name}
            onClick={() => setActiveSheet(name)}
            onDoubleClick={() => startRename(name)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '5px 10px',
              fontSize: 11,
              fontFamily: '"JetBrains Mono", monospace',
              cursor: 'pointer',
              color: activeSheet === name ? 'var(--foreground)' : 'var(--muted-foreground)',
              background: activeSheet === name
                ? 'linear-gradient(135deg, #0074d9 0%, #009296 100%) bottom / 100% 2px no-repeat, #0c0c0c'
                : 'transparent',
              borderBottom: '2px solid transparent',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            <FileText size={10} style={{ flexShrink: 0, opacity: 0.5 }} />
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
                  width: 80, fontSize: 11, background: 'var(--input)',
                  border: '1px solid var(--ring)', borderRadius: 3,
                  padding: '0 4px', color: 'var(--foreground)',
                  fontFamily: 'inherit', outline: 'none',
                }}
              />
            ) : (
              <span>{name}</span>
            )}
            {sheets.length > 1 && activeSheet === name && (
              <button
                onClick={(e) => { e.stopPropagation(); deleteSheet(name); }}
                style={{
                  display: 'flex', alignItems: 'center',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--muted-foreground)', padding: 0,
                }}
                title="Delete sheet"
              >
                <X size={10} />
              </button>
            )}
          </div>
        ))}
        <button
          onClick={addSheet}
          style={{
            display: 'flex', alignItems: 'center',
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--muted-foreground)', padding: '5px 8px',
          }}
          title="New sheet"
        >
          <Plus size={12} />
        </button>

        <div style={{ flex: 1 }} />
        {saving && <span style={{ fontSize: 10, color: 'var(--muted-foreground)', marginRight: 8 }}>Saving...</span>}
        <button
          onClick={() => setPreview(p => !p)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'none', border: 'none', cursor: 'pointer',
            color: preview ? 'var(--primary)' : 'var(--muted-foreground)',
            padding: '5px 10px', fontSize: 10,
            fontFamily: '"JetBrains Mono", monospace',
          }}
          title={preview ? 'Edit' : 'Preview markdown'}
        >
          {preview ? <Pencil size={11} /> : <Eye size={11} />}
          <span>{preview ? 'Edit' : 'Preview'}</span>
        </button>
      </div>

      {/* Editor / Preview */}
      {content === null ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted-foreground)' }}>
          Loading...
        </div>
      ) : preview ? (
        <div
          className="notes-preview"
          style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            padding: '16px 20px',
            color: 'var(--foreground)',
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <textarea
          key={activeSheet}
          value={content}
          onChange={e => handleChange(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1, minHeight: 0,
            width: '100%',
            padding: '16px 20px',
            background: '#0c0c0c',
            color: 'var(--foreground)',
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
            lineHeight: 1.6,
            tabSize: 2,
          }}
        />
      )}
    </div>
  );
}
