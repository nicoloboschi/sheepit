import { useState } from 'react';
import { SquareTerminal, GitBranch, FolderOpen, SplitSquareHorizontal, SplitSquareVertical, Grid2x2, Columns3, Minus, Plus, RefreshCw, List, RotateCw } from 'lucide-react';
import { refreshAllTerminals, activeTerminalScrollToLine, getCommandHistory, clearCommandHistory, type CommandEntry, DEFAULT_FONT_SIZE } from '../store';
import useStore from '../store';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { NOTES_SESSION_ID } from './PaneTerminal';
import type { Layout } from './TerminalGrid';

interface SessionStatsBarProps {
  sessionId: string | null;
  activeTab: string;
  onTabChange?: ((tab: string) => void) | null;
  layout?: Layout;
  onLayoutChange?: (layout: Layout) => void;
}

export default function SessionStatsBar({ sessionId, activeTab, onTabChange, layout, onLayoutChange }: SessionStatsBarProps) {
  // `sessionId` here is the active workspace id — zoom is keyed per workspace.
  const sessionZoom  = useStore(s => sessionId ? s.workspaceZooms[sessionId] : undefined);
  const adjustSessionZoom = useStore(s => s.adjustSessionZoom);
  const resetSessionZoom  = useStore(s => s.resetSessionZoom);

  if (!sessionId || sessionId === NOTES_SESSION_ID) return null;

  const tabs = onTabChange ? [
    { id: 'terminal', icon: <SquareTerminal size={11} />, label: 'Terminal' },
    { id: 'diff',     icon: <GitBranch size={11} />,      label: 'Git' },
    { id: 'files',    icon: <FolderOpen size={11} />,     label: 'Files'    },
  ] : [];

  const tabBar = onTabChange && (
    <div
      className="flex items-center shrink-0"
      style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}
    >
      {tabs.map(({ id, icon, label }) => (
        <button
          key={id}
          title={label}
          onClick={() => onTabChange(id)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 11, padding: '2px 8px',
            background: activeTab === id ? 'var(--accent)' : 'none',
            color: activeTab === id ? 'var(--foreground)' : 'var(--muted-foreground)',
            border: 'none', borderRight: id !== 'files' ? '1px solid var(--border)' : 'none',
            cursor: 'pointer',
          }}
        >
          {icon}{label}
        </button>
      ))}
    </div>
  );

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

  const currentZoom = sessionZoom ?? DEFAULT_FONT_SIZE();
  const zoomButtons = sessionId && (
    <div
      className="flex items-center shrink-0"
      style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}
    >
      <button
        title="Zoom out (\u2318-)"
        onClick={() => adjustSessionZoom(sessionId, -1)}
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
        onClick={() => resetSessionZoom(sessionId)}
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
        onClick={() => adjustSessionZoom(sessionId, 1)}
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

  return (
    <>
      {/* Desktop: single row — grid-level toolbar only (session identity,
          path, stats, and close moved into per-pane headers). */}
      <div
        className="hidden md:flex items-center gap-2 px-4 py-1.5 shrink-0 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        {layoutButtons && <div>{layoutButtons}</div>}
        {activeTab === 'terminal' && zoomButtons && <div>{zoomButtons}</div>}
        <div className="flex-1" />
        {activeTab === 'terminal' && sessionId && (
          <CommandHistoryButton sessionId={sessionId} />
        )}
        {activeTab === 'terminal' && (
          <button
            title="Refresh all terminals"
            onClick={() => refreshAllTerminals()}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-white/5"
            style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
          >
            <RefreshCw size={12} />
          </button>
        )}
        {tabBar && <div>{tabBar}</div>}
      </div>

      {/* Mobile: tab bar only */}
      {onTabChange && (
        <div
          className="md:hidden flex items-center justify-center border-b shrink-0 py-1.5"
          style={{ borderColor: 'var(--border)' }}
        >
          {tabBar}
        </div>
      )}
    </>
  );
}

// ── Command History TOC ─────────────────────────────────────────────────────

function CommandHistoryButton({ sessionId }: { sessionId: string }) {
  const [entries, setEntries] = useState<CommandEntry[]>([]);

  function refresh() {
    setEntries(getCommandHistory(sessionId));
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          title="Command history"
          onClick={refresh}
          className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-white/5"
          style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
        >
          <List size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end">
        <div style={{ width: 340, maxHeight: 360, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 10, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
              Command History
            </span>
            {entries.length > 0 && (
              <button
                onClick={() => { clearCommandHistory(sessionId); setEntries([]); }}
                style={{ fontSize: 9, color: 'var(--muted-foreground)', background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6, textDecoration: 'underline' }}
              >
                clear
              </button>
            )}
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {entries.length === 0 ? (
              <div style={{ padding: '16px 10px', textAlign: 'center', fontSize: 11, color: 'var(--muted-foreground)', opacity: 0.5 }}>
                No commands recorded yet
              </div>
            ) : (
              [...entries].reverse().map((entry, i) => (
                <button
                  key={`${entry.ts}-${i}`}
                  onClick={() => activeTerminalScrollToLine.current(entry.line)}
                  style={{
                    display: 'flex', alignItems: 'baseline', gap: 8,
                    width: '100%', textAlign: 'left', padding: '5px 10px',
                    background: 'none', border: 'none', borderBottom: '1px solid var(--border)',
                    cursor: 'pointer', fontSize: 11, color: 'var(--foreground)',
                  }}
                  className="hover:bg-white/5"
                >
                  <span style={{
                    fontFamily: '"JetBrains Mono",monospace',
                    fontWeight: 500, flex: 1,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {entry.cmd}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--muted-foreground)', flexShrink: 0, opacity: 0.5 }}>
                    {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
