import { useRef, useEffect, useState } from 'react';
import { Home, SquarePlus, Zap, TerminalSquare, Settings, ScrollText } from 'lucide-react';
import useStore from '../store';
import { tildefy } from '../utils';
import SessionList from './SessionList';
import CommandsDialog, { loadCommands } from './CommandsDialog';
import LogsModal from './LogsModal';
import DirectoryPicker from './DirectoryPicker';
import ViperIcon from './ViperIcon';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

interface MobileSheetProps {
  onConnect: (id: string) => void;
  send: (msg: Record<string, unknown>) => void;
}

export default function MobileSheet({ onConnect, send }: MobileSheetProps) {
  const sheetOpen = useStore(s => s.sheetOpen);
  const setSheetOpen = useStore(s => s.setSheetOpen);
  const sessions = useStore(s => s.sessions);
  const currentSessionId = useStore(s => s.currentSessionId);
  const [showCommands, setShowCommands] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [commands, setCommands] = useState(loadCommands);

  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dragStartYRef = useRef(0);

  useEffect(() => {
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    if (!sheet || !backdrop) return;

    sheet.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
    if (sheetOpen) {
      sheet.style.transform = 'translateY(0)';
      backdrop.style.opacity = '1';
      backdrop.style.pointerEvents = 'auto';
    } else {
      sheet.style.transform = 'translateY(100%)';
      backdrop.style.opacity = '0';
      backdrop.style.pointerEvents = 'none';
    }
  }, [sheetOpen]);

  const handleDragStart = (e: React.TouchEvent) => {
    dragStartYRef.current = e.touches[0]!.clientY;
    if (sheetRef.current) {
      sheetRef.current.style.transition = 'none';
    }
  };

  const handleDragMove = (e: React.TouchEvent) => {
    const dy = Math.max(0, e.touches[0]!.clientY - dragStartYRef.current);
    if (sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${dy}px)`;
    }
    if (backdropRef.current) {
      backdropRef.current.style.opacity = String(Math.max(0, 1 - dy / 200));
    }
  };

  const handleDragEnd = (e: React.TouchEvent) => {
    const dy = e.changedTouches[0]!.clientY - dragStartYRef.current;
    if (sheetRef.current) {
      sheetRef.current.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
    }
    if (dy > 80) {
      setSheetOpen(false);
    } else {
      setSheetOpen(true);
    }
  };

  const handleConnect = (id: string) => {
    onConnect(id);
    setSheetOpen(false);
  };

  return (
    <>
      <div
        ref={backdropRef}
        className="md:hidden fixed inset-0 z-40 pointer-events-none"
        style={{
          background: 'rgba(0,0,0,0.5)',
          opacity: 0,
          transition: 'opacity 0.3s',
        }}
        onClick={() => setSheetOpen(false)}
      />

      <div
        ref={sheetRef}
        id="bottom-sheet"
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex flex-col rounded-t-2xl border-t border-x"
        style={{
          background: 'var(--card)',
          borderColor: 'var(--border)',
          maxHeight: '70vh',
          transform: 'translateY(100%)',
          transition: 'transform 0.3s cubic-bezier(0.32,0.72,0,1)',
        }}
      >
        <div
          id="sheet-drag-handle"
          className="flex justify-center pt-3 pb-2 shrink-0 cursor-grab"
          onTouchStart={handleDragStart}
          onTouchMove={handleDragMove}
          onTouchEnd={handleDragEnd}
        >
          <div className="w-10 h-1 rounded-full" style={{ background: 'var(--border)' }} />
        </div>

        {showCommands && <CommandsDialog onClose={() => { setShowCommands(false); setCommands(loadCommands()); }} />}
        {showLogs && <LogsModal onClose={() => setShowLogs(false)} />}

        <div className="flex items-center justify-between px-4 pb-2 shrink-0">
          <div className="flex items-center gap-2">
            <span className="logo">Workspaces</span>
          </div>
          <div className="flex items-center gap-1">
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
                    if (currentSessionId) { send({ type: 'input', data: c.command + '\r' }); setSheetOpen(false); }
                  }}>
                    <TerminalSquare size={13} />
                    <span className="truncate text-xs">{c.name}</span>
                  </DropdownMenuItem>
                ))
              }
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowCommands(true)}>
                <Settings size={13} /> Manage commands{'\u2026'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" title="Settings" className="h-7 w-7 text-muted-foreground hover:text-foreground">
                <Settings size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-48">
              <DropdownMenuLabel className="text-xs flex items-center gap-1"><ViperIcon size={13} color="var(--primary)" /> <span className="brand-gradient-text">vipershell</span></DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowLogs(true)}>
                <ScrollText size={14} /> Server Logs
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" title="New session" className="h-7 w-7 text-muted-foreground hover:text-foreground">
                <SquarePlus size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-72 !overflow-hidden p-0">
              <div className="px-1 pt-1">
                <DropdownMenuItem onClick={() => { send({ type: 'create_session', path: null }); setSheetOpen(false); }}>
                  <Home size={14} />
                  <span className="text-xs">Home</span>
                </DropdownMenuItem>
              </div>
              {(() => {
                const username = sessions.find(s => s.username)?.username;
                const dirs = [...new Set(sessions.map(s => s.path).filter(Boolean))] as string[];
                return dirs.length > 0 && <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[10px] text-muted-foreground font-normal uppercase tracking-wider px-3 py-0.5">Recent</DropdownMenuLabel>
                  <div className="overflow-y-auto px-1" style={{ maxHeight: 100 }}>
                    {dirs.map(path => (
                      <DropdownMenuItem key={path} onClick={() => { send({ type: 'create_session', path }); setSheetOpen(false); }}>
                        <span className="truncate font-mono text-xs">{tildefy(path, username)}</span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                </>;
              })()}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] text-muted-foreground font-normal uppercase tracking-wider px-3 py-0.5">Browse</DropdownMenuLabel>
              <DirectoryPicker
                initialPath="~"
                onSelect={(path) => { send({ type: 'create_session', path }); setSheetOpen(false); }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>

        <SessionList
          id="sheet-session-list"
          onConnect={handleConnect}
          send={send}
        />
      </div>
    </>
  );
}
