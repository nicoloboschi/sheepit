import { useState } from 'react';
import { SplitSquareHorizontal, SplitSquareVertical, Grid2x2, Columns3, Minus, Plus, RotateCw, BookOpen, SquarePlus, TerminalSquare, Settings } from 'lucide-react';
import useStore from '../store';
import type { Layout } from './TerminalGrid';
import SettingsDialog from './SettingsDialog';

// Workspace-level toolbar: workspace name (click to rename) + actions (Knowledge)
// on the left; layout picker + zoom on the right. The terminal/git/files switch
// lives per-pane (see PaneHeader).
interface SessionStatsBarProps {
  sessionId: string | null;
  layout?: Layout;
  onLayoutChange?: (layout: Layout) => void;
  onCreateSession?: (headless: boolean) => void;
}

export default function SessionStatsBar({ sessionId, layout, onLayoutChange, onCreateSession }: SessionStatsBarProps) {
  // Terminal font size is a single global value shared by every pane.
  const fontSize          = useStore(s => s.fontSize);
  const adjustFontSize    = useStore(s => s.adjustFontSize);
  const resetFontSize     = useStore(s => s.resetFontSize);
  const renameWorkspace   = useStore(s => s.renameWorkspace);
  const knowledgeOpen     = useStore(s => s.knowledgeOpen);
  const setKnowledgeOpen  = useStore(s => s.setKnowledgeOpen);
  const hasHeadlessSession = useStore(s => s.sessions.some(session => session.isHeadless));
  // Display name for the active workspace: its title, else its root pane's name.
  const workspaceName = useStore(s => {
    const ws = sessionId ? s.workspaces[sessionId] : undefined;
    if (!ws) return undefined;
    const root = ws.cells[0];
    return ws.title || (root ? s.sessionMap[root]?.name : undefined) || 'Workspace';
  });
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (!sessionId) return null;

  const commitRename = () => {
    if (sessionId) renameWorkspace(sessionId, renameValue.trim() || undefined);
    setRenaming(false);
  };

  // All four three-variants are considered the same "button" in the picker —
  // the cycle order lets the user click the same Columns3 icon repeatedly to
  // rotate: left → right → top → bottom → left. The icon rotates too so
  // the current orientation is visible at a glance.
  const THREE_CYCLE: Layout[] = ['three', 'three-right', 'three-bottom', 'three-top'];
  const isThree = layout === 'three' || layout === 'three-right' || layout === 'three-top' || layout === 'three-bottom';
  const threeButtonIcon = (() => {
    // Columns3 is sideways by default (three vertical columns). Rotate it
    // so it visually matches the current orientation.
    const rot =
      layout === 'three'         ? 0   // tall on left — matches icon's natural orientation closest
      : layout === 'three-right' ? 180
      : layout === 'three-top'   ? -90
      : layout === 'three-bottom'?  90
      : 0;
    return <Columns3 size={13} style={{ transform: `rotate(${rot}deg)`, transition: 'transform 0.15s' }} />;
  })();
  const threeButtonTitle = isThree
    ? `3 panes — ${
        layout === 'three'         ? 'tall left'
      : layout === 'three-right'   ? 'tall right'
      : layout === 'three-top'     ? 'wide top'
      : /* three-bottom */            'wide bottom'
      } (click to rotate)`
    : '3 panes (1 + 2)';
  const handleThreeClick = () => {
    if (!onLayoutChange) return;
    if (!isThree) { onLayoutChange('three'); return; }
    const idx = THREE_CYCLE.indexOf(layout as Layout);
    const next = THREE_CYCLE[(idx + 1) % THREE_CYCLE.length] ?? 'three';
    onLayoutChange(next);
  };

  const layoutButtons = onLayoutChange && layout && (
    <div
      className="flex items-center shrink-0"
      style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}
    >
      {([
        { l: 'single' as Layout, icon: <Minus size={13} />, title: 'Single' },
        { l: 'horizontal' as Layout, icon: <SplitSquareHorizontal size={13} />, title: 'Split horizontal' },
        { l: 'vertical' as Layout, icon: <SplitSquareVertical size={13} />, title: 'Split vertical' },
      ] as const).map(({ l, icon, title }) => (
        <button
          key={l}
          title={title}
          onClick={() => onLayoutChange(l)}
          style={{
            display: 'flex', alignItems: 'center', padding: '2px 5px',
            background: layout === l ? 'var(--accent)' : 'none',
            border: 'none', borderRight: '1px solid var(--border)',
            cursor: 'pointer',
            color: layout === l ? 'var(--foreground)' : 'var(--muted-foreground)',
          }}
        >
          {icon}
        </button>
      ))}
      {/* Three-pane button: click to set 'three'; when already in a three
          variant, click rotates to the next orientation. */}
      <button
        title={threeButtonTitle}
        onClick={handleThreeClick}
        style={{
          display: 'flex', alignItems: 'center', gap: 3, padding: '2px 5px',
          background: isThree ? 'var(--accent)' : 'none',
          border: 'none', borderRight: '1px solid var(--border)',
          cursor: 'pointer',
          color: isThree ? 'var(--foreground)' : 'var(--muted-foreground)',
        }}
      >
        {threeButtonIcon}
        {isThree && <RotateCw size={9} style={{ opacity: 0.5 }} />}
      </button>
      <button
        title="2\u00d72 grid"
        onClick={() => onLayoutChange('quad')}
        style={{
          display: 'flex', alignItems: 'center', padding: '2px 5px',
          background: layout === 'quad' ? 'var(--accent)' : 'none',
          border: 'none',
          cursor: 'pointer',
          color: layout === 'quad' ? 'var(--foreground)' : 'var(--muted-foreground)',
        }}
      >
        <Grid2x2 size={13} />
      </button>
    </div>
  );

  const currentZoom = fontSize;
  const zoomButtons = sessionId && (
    <div
      className="flex items-center shrink-0"
      style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}
    >
      <button
        title="Zoom out (\u2318-)"
        onClick={() => adjustFontSize(-1)}
        style={{
          display: 'flex', alignItems: 'center', padding: '2px 5px',
          background: 'none', border: 'none',
          borderRight: '1px solid var(--border)',
          cursor: 'pointer', color: 'var(--muted-foreground)',
        }}
      >
        <Minus size={13} />
      </button>
      <button
        title={`Font size ${currentZoom}px — click to reset (\u23180)`}
        onClick={() => resetFontSize()}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minWidth: 28, padding: '2px 4px',
          background: 'none', border: 'none',
          borderRight: '1px solid var(--border)',
          cursor: 'pointer', color: 'var(--muted-foreground)',
          fontSize: 10, fontVariantNumeric: 'tabular-nums',
        }}
      >
        {currentZoom}
      </button>
      <button
        title="Zoom in (\u2318+)"
        onClick={() => adjustFontSize(1)}
        style={{
          display: 'flex', alignItems: 'center', padding: '2px 5px',
          background: 'none', border: 'none',
          cursor: 'pointer', color: 'var(--muted-foreground)',
        }}
      >
        <Plus size={13} />
      </button>
    </div>
  );

  // Right-side cluster: the active workspace name (click to rename) and a
  // Notes toggle. Lives in the formerly-empty right half of the bar.
  const nameControl = workspaceName && (
    renaming ? (
      <input
        autoFocus
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitRename();
          if (e.key === 'Escape') setRenaming(false);
        }}
        placeholder="Workspace name"
        style={{
          fontSize: 11, padding: '2px 7px', borderRadius: 5,
          border: '1px solid var(--ring)', background: '#0c0c0c',
          color: 'var(--foreground)', outline: 'none', width: 140, fontFamily: 'inherit',
        }}
      />
    ) : (
      <button
        onClick={() => { setRenameValue(sessionId ? useStore.getState().workspaces[sessionId]?.title ?? '' : ''); setRenaming(true); }}
        title="Click to rename workspace"
        className="hover:text-foreground"
        style={{
          maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontSize: 12, fontWeight: 600, padding: '2px 4px', borderRadius: 4,
          background: 'none', border: 'none', cursor: 'pointer', color: 'var(--foreground)',
        }}
      >
        {workspaceName}
      </button>
    )
  );

  const knowledgeButton = (
    <button
      onClick={() => setKnowledgeOpen(!knowledgeOpen)}
      title="Knowledge"
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        fontSize: 11, padding: '3px 8px', borderRadius: 6,
        border: '1px solid var(--border)',
        background: knowledgeOpen ? 'var(--accent)' : 'none',
        color: knowledgeOpen ? 'var(--foreground)' : 'var(--muted-foreground)',
        cursor: 'pointer',
      }}
    >
      <BookOpen size={13} />Knowledge
    </button>
  );
  const newSessionButtons = onCreateSession && <>
    <button
      onClick={() => onCreateSession(false)}
      title="New session"
      style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'none', color: 'var(--muted-foreground)', cursor: 'pointer' }}
    >
      <SquarePlus size={13} />New
    </button>
    <button
      onClick={() => onCreateSession(true)}
      title={hasHeadlessSession ? 'Open headless session' : 'New headless session'}
      style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'none', color: 'var(--muted-foreground)', cursor: 'pointer' }}
    >
      <TerminalSquare size={13} />{hasHeadlessSession ? 'Open headless' : 'Headless'}
    </button>
    <button
      onClick={() => setSettingsOpen(true)}
      title="Settings"
      style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'none', color: 'var(--muted-foreground)', cursor: 'pointer' }}
    >
      <Settings size={13} />Settings
    </button>
  </>;

  // Desktop only (hidden on mobile, where splits/zoom aren't shown).
  // Left: workspace name + actions (Notes). Right: layout picker + zoom.
  return (
    <div
      className="hidden md:flex items-center gap-2 px-4 py-1.5 shrink-0 border-b"
      style={{ borderColor: 'var(--border)' }}
    >
      {nameControl}
      {nameControl && <div style={{ width: 1, height: 14, background: 'var(--border)', flexShrink: 0 }} />}
      {knowledgeButton}
      {newSessionButtons}
      <div style={{ flex: 1 }} />
      {layoutButtons && <div>{layoutButtons}</div>}
      {zoomButtons && <div>{zoomButtons}</div>}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
