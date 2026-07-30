import { useState, useRef, useEffect } from 'react';
import { SquareTerminal, ChevronDown, X, Maximize2, Minimize2, GripVertical, FolderOpen, Columns2, Bot } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import useStore from '../store';
import * as sharedWs from '../sharedWs';
import { useDndEnabled } from '../dndEnabled';
import StatChips from './StatChips';
import ClaudeIcon from './ClaudeIcon';
import OpenAIIcon from './OpenAIIcon';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';

/** Append U+FE0E (text presentation selector) so browsers don't color-swap symbols as emoji. */
const forceTextPresentation = (s: string) =>
  s.replace(/[\u2022-\u3299\u{1F000}-\u{1FAFF}]/gu, m => m + '\uFE0E');

interface PaneHeaderProps {
  sessionId: string;
  /** Workspace this pane belongs to. Used as the drag source id. */
  workspaceId: string;
  /** Position of this pane within its workspace's `cells` array. Used as
   *  the drag source index so the drop target knows which pane is moving. */
  paneIndex: number;
  isActive: boolean;
  /** True when this pane owns the grid's bookkeeping (cell 0). Closing it
   *  tears down the whole grid because every other cell depends on it, but
   *  the UI no longer calls it out as a "primary" — all panes read as equals. */
  isGridRoot: boolean;
  onClose: () => void;
  /** Per-pane view switch. When provided, the header shows a terminal/git/files
   *  toggle that controls what this pane renders below its status bar. */
  view?: 'terminal' | 'split' | 'working' | 'files' | 'log';
  onViewChange?: (view: 'terminal' | 'split' | 'working' | 'files' | 'log') => void;
}

/** Shared style for small icon buttons in the header row. */
const iconBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 18, height: 18, borderRadius: 4,
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--muted-foreground)', flexShrink: 0,
  transition: 'color 0.15s',
};

export default function PaneHeader({ sessionId, workspaceId, paneIndex, isActive, isGridRoot, onClose, view, onViewChange }: PaneHeaderProps) {
  const session     = useStore(s => s.sessionMap[sessionId]);
  const showConfirm = useStore(s => s.showConfirm);
  const isZen       = useStore(s => s.zenSessionId === sessionId);
  const toggleZen   = useStore(s => s.toggleZen);
  const [editing, setEditing]     = useState(false);
  const [draftName, setDraftName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  async function commitRename() {
    setEditing(false);
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === session?.name) return;
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
  }

  async function handleClose(e: React.MouseEvent) {
    e.stopPropagation();
    // In zen (fullscreen) mode the X exits zen rather than closing the
    // session — matches the "fullscreen → close = leave fullscreen" expectation.
    if (isZen) { toggleZen(sessionId); return; }
    const name = session?.name ?? 'pane';
    const msg = isGridRoot
      ? `Close "${name}" and all its panes?`
      : `Close pane "${name}"?`;
    const confirmed = await showConfirm(msg);
    if (!confirmed) return;
    onClose();
  }

  // StatChips wants a `send` callback it uses to spawn new sessions from worktrees.
  // The shared WebSocket is the canonical channel for that in the rest of the app.
  const send = (msg: Record<string, unknown>) => sharedWs.send(msg);

  // Drag handle — dnd-kit useDraggable. The same `kind: 'pane'` payload as
  // sidebar PaneCards, so the central onDragEnd in App.tsx handles drops
  // uniformly regardless of which surface initiated the drag. Disabled on
  // mobile (and the grip icon is hidden entirely).
  const dndEnabled = useDndEnabled();
  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `pane-source:header:${workspaceId}:${paneIndex}`,
    data: { kind: 'pane', sessionId, workspaceId, paneIdx: paneIndex },
    disabled: !dndEnabled,
  });

  if (!session) {
    // Loading placeholder — matches real header height so layout doesn't jump.
    return <div style={{ height: 42, flexShrink: 0, borderBottom: '1px solid var(--border)', background: '#0a0a0a' }} />;
  }

  return (
    <div
      className={`pane-header${isActive ? ' pane-header-active' : ''}`}
      style={{
        display: 'flex', flexDirection: 'column',
        flexShrink: 0, minWidth: 0,
        borderBottom: isActive
          ? '2px solid var(--primary)'
          : '1px solid var(--border)',
        background: isActive
          ? 'linear-gradient(135deg, rgba(0,116,217,0.18) 0%, rgba(0,146,150,0.14) 100%), #0d1117'
          : '#0a0a0a',
        transition: 'background 0.15s ease, border-color 0.15s ease',
        userSelect: 'none',
        color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)',
      }}
    >
      {/* Row 1: identity + actions */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: isActive ? '5px 6px 3px 4px' : '3px 6px 2px 4px',
        minHeight: isActive ? 28 : 22, minWidth: 0,
        fontSize: isActive ? 12 : 11,
        transition: 'padding 0.15s ease, min-height 0.15s ease, font-size 0.15s ease',
      }}>
        {/* Drag handle — hidden entirely on mobile where dnd-kit is off. */}
        {dndEnabled && (
          <span
            ref={setDragRef}
            {...dragAttributes}
            {...dragListeners}
            onClick={(e) => e.stopPropagation()}
            title="Drag to move or swap this pane"
            className="pane-header-grip"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 14, height: 18, flexShrink: 0,
              color: 'var(--muted-foreground)', opacity: isDragging ? 0.2 : 0.5,
              cursor: isDragging ? 'grabbing' : 'grab',
            }}
          >
            <GripVertical size={11} />
          </span>
        )}
        {/* Session kind icon */}
        <span className={`pane-header-kind-badge${isActive ? ' pane-header-kind-badge-active' : ''}`}>
          {session.isClaudeCode ? <ClaudeIcon size={15} />
            : session.isCodex    ? <OpenAIIcon size={15} />
            : session.isOpencode ? <Bot size={15} />
            : <SquareTerminal size={15} />}
        </span>

        {/* Session name popover — rename */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '1px 4px', borderRadius: 3,
                color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)',
                fontSize: isActive ? 12 : 11,
                fontFamily: 'inherit', flexShrink: 0,
                fontWeight: isActive ? 600 : 400,
                transition: 'font-size 0.15s ease',
              }}
              className="hover:bg-white/5"
              title="Session info"
            >
              <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {forceTextPresentation(session.name ?? '')}
              </span>
              <ChevronDown size={9} style={{ opacity: 0.4, flexShrink: 0 }} />
            </button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start">
            <div style={{ width: 280, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, opacity: 0.6 }}>
                  Session name
                </div>
                {editing ? (
                  <input
                    ref={inputRef}
                    value={draftName}
                    onChange={e => setDraftName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                      if (e.key === 'Escape') setEditing(false);
                    }}
                    style={{
                      fontSize: 12, color: 'var(--foreground)', background: 'var(--input)',
                      border: '1px solid var(--ring)', borderRadius: 4, padding: '3px 8px',
                      outline: 'none', fontFamily: 'inherit', width: '100%',
                    }}
                  />
                ) : (
                  <button
                    onClick={() => { setDraftName(session.name ?? ''); setEditing(true); }}
                    className="hover:bg-white/5"
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      fontSize: 12, color: 'var(--foreground)', background: 'none',
                      border: '1px solid transparent', borderRadius: 4, padding: '3px 8px',
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                    title="Click to rename"
                  >
                    {forceTextPresentation(session.name ?? '')}
                  </button>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {/* cwd */}
        {session.path && (
          <span
            style={{
              fontSize: 10, fontFamily: '"JetBrains Mono",monospace',
              color: 'var(--muted-foreground)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              flexShrink: 1, minWidth: 0, fontWeight: 600,
            }}
            title={session.path}
          >
            {session.path.replace(/^\/Users\/[^/]+/, '~')}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Per-pane view switch — terminal / git / files, scoped to this pane. */}
        {onViewChange && (
          // Top-level switch: Terminal vs. the unified Git view. The Git view's
          // own Working / Files / Git Log sub-switcher lives inside it.
          // Filled brand-gradient pill so this primary navigation control reads
          // as clearly distinct from the bare zen/close action icons to its right.
          <div
            style={{
              display: 'flex', alignItems: 'center', flexShrink: 0,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {([
              { id: 'terminal', icon: <SquareTerminal size={12} />, title: 'Terminal', active: view === 'terminal' },
              { id: 'split',    icon: <Columns2 size={12} />,       title: 'Terminal + Files', active: view === 'split' },
              { id: 'git',      icon: <FolderOpen size={12} />,     title: 'Files / Git', active: view !== 'terminal' && view !== 'split' },
            ] as const).map(({ id, icon, title, active }) => (
              <button
                key={id}
                title={title}
                // Terminal/Split map directly; the Git button opens the working
                // tree, or keeps the current git sub-view if one is showing.
                onClick={(e) => {
                  e.stopPropagation();
                  onViewChange(
                    id === 'terminal' ? 'terminal'
                      : id === 'split' ? 'split'
                      : (view && view !== 'terminal' && view !== 'split' ? view : 'working'),
                  );
                }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 26, height: 20,
                  background: active ? 'var(--primary-gradient)' : 'none',
                  border: 'none',
                  borderRight: id !== 'git' ? '1px solid var(--border)' : 'none',
                  cursor: 'pointer',
                  color: active ? '#fff' : 'var(--muted-foreground)',
                }}
              >
                {icon}
              </button>
            ))}
          </div>
        )}

        {/* Divider separating the view-switch pill from the action icons. */}
        <div style={{ width: 1, height: 14, background: 'var(--border)', flexShrink: 0, margin: '0 1px' }} />

        {/* Zen toggle — enters/exits distraction-free fullscreen */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleZen(sessionId); }}
          title={isZen ? 'Exit zen mode' : 'Zen mode (fullscreen)'}
          className="hover:bg-white/5"
          style={iconBtnStyle}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--primary)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--muted-foreground)'; }}
        >
          {isZen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
        </button>

        {/* Close — on the grid's root cell, confirms and tears down the
            whole grid; on other cells, removes just that pane. */}
        <button
          onClick={handleClose}
          title={isZen ? 'Exit zen mode' : 'Close pane'}
          className="hover:bg-white/5"
          style={iconBtnStyle}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--destructive)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--muted-foreground)'; }}
        >
          <X size={12} />
        </button>
      </div>

      {/* Row 2: git + system stats — single compact row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 8px 2px 10px',
        height: 18, minWidth: 0,
        fontSize: 10,
      }}>
        <StatChips sessionId={sessionId} send={send} />
      </div>
    </div>
  );
}
