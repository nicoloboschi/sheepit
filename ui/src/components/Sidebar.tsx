import { useState, useEffect, useCallback, useRef } from 'react';
import { Settings, Zap, TerminalSquare, SquarePlus, PanelLeftClose, List, Activity, Star } from 'lucide-react';
import useStore, { activeTerminalSend } from '../store';
import SessionList from './SessionList';
import { loadCommands } from './CommandsDialog';
import ClaudeIcon from './ClaudeIcon';
import OpenAIIcon from './OpenAIIcon';
import NewSessionDialog from './NewSessionDialog';
import SettingsDialog from './SettingsDialog';
import ViperIcon from './ViperIcon';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

interface SidebarProps {
  onConnect: (id: string) => void;
  send: (msg: Record<string, unknown>) => void;
}

export default function Sidebar({ onConnect, send }: SidebarProps) {
  const currentSessionId = useStore(s => s.currentSessionId);
  const sessions = useStore(s => s.sessions);
  const workspaceFilter = useStore(s => s.workspaceFilter);
  const setWorkspaceFilter = useStore(s => s.setWorkspaceFilter);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewSession, setShowNewSession] = useState<{ initCommand?: string; title: string; icon?: React.ReactNode } | null>(null);
  const [commands, setCommands] = useState(loadCommands);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [claudeCommand, setClaudeCommand] = useState('claude');
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('vipershell:sidebar-collapsed') === '1'; } catch { return false; }
  });
  const [sidebarW, setSidebarW] = useState(() => {
    try { return parseInt(localStorage.getItem('vipershell:sidebar-w') ?? '') || 256; } catch { return 256; }
  });
  const draggingRef = useRef(false);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = sidebarW;
    const handle = e.currentTarget as HTMLElement;
    handle.style.background = '#0074d9';
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      setSidebarW(Math.max(180, Math.min(500, startW + ev.clientX - startX)));
    };
    const onUp = () => {
      draggingRef.current = false;
      handle.style.background = 'transparent';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setSidebarW(w => { try { localStorage.setItem('vipershell:sidebar-w', String(w)); } catch { /* ignore */ } return w; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sidebarW]);

  // Fetch AI config to show coding agent quick-launch button
  const fetchAIConfig = useCallback(() => {
    fetch('/api/ai/config')
      .then(r => r.json())
      .then(cfg => {
        setAiProvider(cfg.aiEnabled ? cfg.aiProvider : null);
        if (cfg.claudeCommand) setClaudeCommand(cfg.claudeCommand);
      })
      .catch(() => setAiProvider(null));
  }, []);
  useEffect(() => { fetchAIConfig(); }, [fetchAIConfig]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(c => {
      const next = !c;
      try { localStorage.setItem('vipershell:sidebar-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Expose toggle so App can show a button when sidebar is collapsed
  useEffect(() => {
    (window as any).__vipershellToggleSidebar = toggleCollapse;
    return () => { delete (window as any).__vipershellToggleSidebar; };
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
        onMouseEnter={e => { if (!draggingRef.current) (e.currentTarget as HTMLElement).style.background = '#0074d9'; }}
        onMouseLeave={e => { if (!draggingRef.current) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      />
      <div className="sidebar-header flex items-center justify-between px-4 py-3.5">
        <span className="logo"><ViperIcon size={15} color="var(--primary)" /> <span className="brand-gradient-text">vipershell</span></span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Workspace list filter — All / Active / Favourites. */}
          <div className="ws-filter-toggle">
            {([
              { id: 'all' as const,        icon: <List size={12} />,     title: 'All workspaces' },
              { id: 'active' as const,     icon: <Activity size={12} />, title: 'Active only (current, running, or new output)' },
              { id: 'favourites' as const, icon: <Star size={12} />,     title: 'Favourites only' },
            ]).map(({ id, icon, title }) => (
              <button
                key={id}
                title={title}
                onClick={() => setWorkspaceFilter(id)}
                className={workspaceFilter === id ? 'active' : ''}
              >
                {icon}
              </button>
            ))}
          </div>
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

      <SessionList
        id="session-list"
        onConnect={onConnect}
        send={send}
      />

      <div className="sidebar-footer flex items-center gap-2 px-4 py-2.5">
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="icon" title="New session" className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={() => setShowNewSession({ title: 'New Session', icon: <SquarePlus size={15} className="text-primary" /> })}
        >
          <SquarePlus size={14} />
        </Button>

        {aiProvider === 'claude-code' && (
          <Button variant="ghost" size="icon" title="New Claude Code session" className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setShowNewSession({ initCommand: claudeCommand, title: 'New Claude Code Session', icon: <ClaudeIcon size={15} /> })}
          >
            <ClaudeIcon size={14} />
          </Button>
        )}

        {aiProvider === 'codex' && (
          <Button variant="ghost" size="icon" title="New Codex session" className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setShowNewSession({ initCommand: 'codex', title: 'New Codex Session', icon: <OpenAIIcon size={15} /> })}
          >
            <OpenAIIcon size={14} />
          </Button>
        )}

        <DropdownMenu onOpenChange={(open) => { if (open) setCommands(loadCommands()); }}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" title="Saved commands" className="h-7 w-7 text-muted-foreground hover:text-foreground">
              <Zap size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-52">
            {commands.length === 0
              ? <DropdownMenuItem disabled><span className="text-xs text-muted-foreground">No saved commands</span></DropdownMenuItem>
              : commands.map(c => (
                <DropdownMenuItem key={c.id} onClick={() => {
                  activeTerminalSend.current({ type: 'input', data: c.command + '\r' });
                }}>
                  <TerminalSquare size={13} />
                  <span className="truncate text-xs">{c.name}</span>
                </DropdownMenuItem>
              ))
            }
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setShowSettings(true)}>
              <Settings size={13} /> Manage commands{'\u2026'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          title="Settings"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={() => setShowSettings(true)}
        >
          <Settings size={14} />
        </Button>
      </div>

      {showNewSession && (
        <NewSessionDialog
          title={showNewSession.title}
          icon={showNewSession.icon}
          onClose={() => setShowNewSession(null)}
          onSelect={(path) => send({
            type: 'create_session',
            path,
            from_session_id: currentSessionId,
            ...(showNewSession.initCommand ? { init_command: showNewSession.initCommand } : {}),
          })}
        />
      )}
      {showSettings && (
        <SettingsDialog
          onClose={() => { setShowSettings(false); fetchAIConfig(); }}
        />
      )}
    </aside>
  );
}
