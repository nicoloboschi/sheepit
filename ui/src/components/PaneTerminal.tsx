import { useEffect, useRef, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import useStore, { refreshAllTerminals } from '../store';
import SessionStatsBar from './SessionStatsBar';
import GitDiffPane from './GitDiffPane';
import FilesPane from './FilesPane';
import NotesPane from './NotesPane';
import TerminalGrid from './TerminalGrid';
import type { Layout } from './TerminalGrid';

export const NOTES_SESSION_ID = '__notes__';

// Search lives inside the Files tab now (toggleable from its toolbar, scoped
// to the currently-browsed folder), so it's no longer a top-level tab.
const TABS = ['terminal', 'diff', 'files'] as const;
type TabType = typeof TABS[number];

interface PaneTerminalProps {
  sessionId: string | null;
  send: (msg: Record<string, unknown>) => void;
  onTabReady?: (fn: (dir: 'left' | 'right') => void) => void;
}

export default function PaneTerminal({ sessionId, send, onTabReady }: PaneTerminalProps): JSX.Element {
  const openFileRef      = useRef<((path: string) => void) | null>(null);
  const [highlightQuery, setHighlightQuery] = useState<string | null>(null);
  const [highlightLine,  setHighlightLine]  = useState<number | null>(null);
  const [gridLayout, setGridLayout] = useState<Layout>('single');
  const changeLayoutRef = useRef<((l: Layout) => void) | null>(null);

  // Git / Files / Search tabs track the currently-active pane within the
  // workspace — when you click a different pane, the tabs re-scope to that
  // pane's cwd automatically. `sessionId` here is the active workspace id.
  const activePaneSessionId = useStore(s => {
    if (!sessionId || sessionId === NOTES_SESSION_ID) return sessionId;
    const ws = s.workspaces[sessionId];
    if (!ws || ws.cells.length === 0) return sessionId;
    return ws.cells[ws.activeCell] ?? ws.cells[0] ?? sessionId;
  });

  // Keep visited workspaces mounted (hidden) for instant switching. Each id
  // in this list is a workspace id (what `sessionId` holds after the workspace
  // refactor), not a backend session id.
  const allWorkspaceIds = useStore(useShallow(s => s.workspaceOrder));
  const [visitedIds, setVisitedIds] = useState<string[]>([]);
  useEffect(() => {
    if (!sessionId || sessionId === NOTES_SESSION_ID) return;
    setVisitedIds(prev => prev.includes(sessionId) ? prev : [...prev, sessionId]);
  }, [sessionId]);
  // Drop cached entries for workspaces that no longer exist (e.g. dissolved
  // via drag-out-last-pane).
  const activeVisited = visitedIds.filter(id => allWorkspaceIds.includes(id));

  const LS_KEY      = 'vipershell:session-tabs';
  const LS_FILE_KEY = 'vipershell:session-last-file';

  function readTabMap(): Record<string, string> {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
  }
  function saveTab(sid: string, tab: TabType): void {
    try {
      const map = readTabMap();
      map[sid] = tab;
      localStorage.setItem(LS_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
  }
  function getLastFile(sid: string): string | null {
    try { return JSON.parse(localStorage.getItem(LS_FILE_KEY) || '{}')[sid] ?? null; } catch { return null; }
  }
  function saveLastFile(sid: string, path: string): void {
    try {
      const map: Record<string, string> = JSON.parse(localStorage.getItem(LS_FILE_KEY) || '{}');
      map[sid] = path;
      localStorage.setItem(LS_FILE_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
  }

  const [activeTab, setActiveTab] = useState<TabType>(() => {
    if (!sessionId) return 'terminal';
    return (readTabMap()[sessionId] as TabType) ?? 'terminal';
  });

  useEffect(() => {
    if (!sessionId) return;
    setActiveTab((readTabMap()[sessionId] as TabType) ?? 'terminal');
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sessionId) saveTab(sessionId, activeTab);
  }, [activeTab, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expose cycleTab to parent
  useEffect(() => {
    onTabReady?.((dir: 'left' | 'right') => {
      setActiveTab((prev: TabType) => {
        const idx = TABS.indexOf(prev);
        const next = (idx + (dir === 'right' ? 1 : -1) + TABS.length) % TABS.length;
        return TABS[next]!;
      });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refit + refocus terminal when switching back to terminal tab
  useEffect(() => {
    if (activeTab === 'terminal') {
      // Small delay to let display:none→flex take effect so xterm can measure
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('vipershell:terminal-tab-active'));
      }, 50);
    }
  }, [activeTab]);

  // Restore last opened file when switching to files tab OR when the
  // active pane changes (each pane remembers its own last file).
  useEffect(() => {
    if (activeTab !== 'files') return;
    const last = activePaneSessionId ? getLastFile(activePaneSessionId) : null;
    if (last) setTimeout(() => openFileRef.current?.(last), 50);
  }, [activeTab, activePaneSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Create split: create a new session inheriting the ACTIVE pane's cwd and
  // return its id. The caller (TerminalGrid) is responsible for attaching the
  // new session to this workspace via `appendPaneToWorkspace`. Workspaces
  // themselves have no path — we take the cwd from whichever pane is focused
  // right now, which is what the user expects when they split.
  const handleCreateSplit = useCallback(async (): Promise<string | null> => {
    if (!sessionId) return null;
    const state = useStore.getState();
    const ws = state.workspaces[sessionId];
    const activeSid = ws?.cells[ws.activeCell] ?? null;
    const path = activeSid ? state.sessionMap[activeSid]?.path ?? null : null;
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (data.ok && data.session_id) {
        // Refresh sessions list so the new session appears in sessionMap
        // (the workspace reconciliation in renderSessions will NOT create a
        // second workspace for it because TerminalGrid.ensureCells calls
        // appendPaneToWorkspace synchronously after this returns).
        send({ type: 'list_sessions' });
        return data.session_id;
      }
      return null;
    } catch { return null; }
  }, [sessionId, send]);

  const handleFileLinkClick = useCallback(async (rawPath: string) => {
    let cleaned = rawPath;
    let line: number | null = null;
    const colonMatch = cleaned.match(/^(.+?)(?::(\d+)(?::\d+)?)\s*$/);
    const parenMatch = !colonMatch && cleaned.match(/^(.+?)\((\d+)(?:[,:]\d+)?\)\s*$/);
    if (colonMatch) { cleaned = colonMatch[1]!; line = parseInt(colonMatch[2]!, 10); }
    else if (parenMatch) { cleaned = parenMatch[1]!; line = parseInt(parenMatch[2]!, 10); }
    cleaned = cleaned.replace(/[.,;)'">\]]+$/, '');

    let absPath = cleaned;
    // Resolve relative paths against the ACTIVE pane's cwd — the user expects
    // "./foo" in a split pane to open relative to that pane's directory.
    const wsState = useStore.getState().workspaces[sessionId ?? ''];
    const resolveAgainst = wsState?.cells[wsState.activeCell] ?? sessionId;
    if (!cleaned.startsWith('/') && !cleaned.startsWith('~/') && resolveAgainst) {
      try {
        const res = await fetch(`/api/fs/${encodeURIComponent(resolveAgainst)}/browse`);
        const data = await res.json();
        const cwd = (data.cwd as string) ?? '';
        absPath = cwd ? `${cwd}/${cleaned.replace(/^\.\//, '')}` : cleaned;
      } catch { /* use cleaned as-is */ }
    }
    if (line) { setHighlightLine(line); setHighlightQuery(null); }
    setActiveTab('files');
    setTimeout(() => openFileRef.current?.(absPath), 50);
  }, [sessionId]);

  const isNotes = sessionId === NOTES_SESSION_ID;

  if (isNotes) {
    return (
      <div className="flex flex-col flex-1 min-w-0 min-h-0" style={{ position: 'relative' }}>
        <NotesPane />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0" style={{ position: 'relative' }}>
      <SessionStatsBar
        sessionId={sessionId}
        activeTab={activeTab}
        onTabChange={setActiveTab as (tab: string) => void}
        layout={gridLayout}
        onLayoutChange={(l) => changeLayoutRef.current?.(l)}
      />
      {activeVisited.map(vid => {
        const isVisible = activeTab === 'terminal' && vid === sessionId;
        return (
          <div
            key={vid}
            style={{
              display: isVisible ? 'flex' : 'none',
              flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden',
            }}
          >
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <TerminalGrid
                sessionId={vid}
                onCreateSplit={handleCreateSplit}
                onFileLinkClick={handleFileLinkClick}
                onLayoutReady={vid === sessionId ? ({ layout: l, changeLayout }) => {
                  setGridLayout(l);
                  changeLayoutRef.current = changeLayout;
                } : undefined}
              />
            </div>
          </div>
        );
      })}
      {activeTab === 'diff'   && <GitDiffPane sessionId={activePaneSessionId} onOpenFile={(path: string) => { setActiveTab('files'); setTimeout(() => openFileRef.current?.(path), 50); }} />}
      <div style={{ display: activeTab === 'files' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
        <FilesPane sessionId={activePaneSessionId} openFileRef={openFileRef} onFileSelect={(path: string) => { if (activePaneSessionId) saveLastFile(activePaneSessionId, path); setHighlightQuery(null); setHighlightLine(null); }} highlightQuery={highlightQuery} highlightLine={highlightLine} />
      </div>
    </div>
  );
}
