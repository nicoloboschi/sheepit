import { useState, useEffect, useCallback, useRef } from 'react';
import { PanelLeftClose } from 'lucide-react';
import SessionList from './SessionList';
import { FlockBand, FlockFooter } from './FlockChrome';
import { preferences } from '../preferences';

interface SidebarProps {
  onConnect: (id: string) => void;
  send: (msg: Record<string, unknown>) => void;
}

export default function Sidebar({ onConnect, send }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return preferences.getItem('sheepit:sidebar-collapsed') === '1'; } catch { return false; }
  });
  const [sidebarW, setSidebarW] = useState(() => {
    try { return parseInt(preferences.getItem('sheepit:sidebar-w') ?? '') || 256; } catch { return 256; }
  });
  const draggingRef = useRef(false);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = sidebarW;
    const handle = e.currentTarget as HTMLElement;
    handle.style.background = '#9cbc7f';
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      setSidebarW(Math.max(180, Math.min(500, startW + ev.clientX - startX)));
    };
    const onUp = () => {
      draggingRef.current = false;
      handle.style.background = 'transparent';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setSidebarW(w => { try { preferences.setItem('sheepit:sidebar-w', String(w)); } catch { /* ignore */ } return w; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sidebarW]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(c => {
      const next = !c;
      try { preferences.setItem('sheepit:sidebar-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Expose toggle so App can show a button when sidebar is collapsed
  useEffect(() => {
    (window as any).__sheepitToggleSidebar = toggleCollapse;
    return () => { delete (window as any).__sheepitToggleSidebar; };
  }, [toggleCollapse]);

  if (collapsed) {
    return (
      <aside
        className="sidebar-shell sidebar-shell-collapsed hidden md:flex flex-col shrink-0 items-center py-2"
        style={{ width: 36 }}
      >
        <button
          onClick={toggleCollapse}
          title="Expand sidebar"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--muted-foreground)', padding: 4, borderRadius: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          className="hover:text-foreground hover:bg-white/5"
        >
          <PanelLeftClose size={14} style={{ transform: 'scaleX(-1)' }} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="sidebar-shell hidden md:flex flex-col shrink-0"
      style={{ width: sidebarW, position: 'relative' }}
    >
      <div
        className="sidebar-resize-handle"
        onMouseDown={onDragStart}
        style={{
          position: 'absolute', top: 0, right: 0, width: 4, height: '100%',
          cursor: 'col-resize', zIndex: 20, background: 'transparent',
        }}
        onMouseEnter={e => { if (!draggingRef.current) (e.currentTarget as HTMLElement).style.background = '#9cbc7f'; }}
        onMouseLeave={e => { if (!draggingRef.current) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      />
      <div className="sidebar-header flex items-center justify-between px-4 py-3.5">
        <span className="logo"><span className="logo-sheep" aria-hidden>🐑</span> <span>sheepit</span></span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={toggleCollapse}
            title="Collapse sidebar"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted-foreground)', padding: 4, borderRadius: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            className="hover:text-foreground hover:bg-white/5"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      <FlockBand />

      <SessionList
        id="session-list"
        onConnect={onConnect}
        send={send}
      />

      <FlockFooter onConnect={onConnect} />
    </aside>
  );
}
