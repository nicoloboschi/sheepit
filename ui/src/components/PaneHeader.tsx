import { useState, useRef, useEffect } from 'react';
import { SquareTerminal, X, Maximize2, Minimize2, FolderOpen, Columns2 } from 'lucide-react';
import useStore from '../store';
import SheepStatus, { type SheepState } from './SheepStatus';
import StatChips from './StatChips';
import VoiceInputButton from './VoiceInputButton';
import * as sharedWs from '../sharedWs';
import ClaudeIcon from './ClaudeIcon';
import OpenAIIcon from './OpenAIIcon';
import OpenCodeIcon from './OpenCodeIcon';
import AntigravityIcon from './AntigravityIcon';
import GitHubCopilotIcon from './GitHubCopilotIcon';
import GrokIcon from './GrokIcon';
import CursorIcon from './CursorIcon';

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


export default function PaneHeader({ sessionId, workspaceId, paneIndex, isActive, isGridRoot, onClose, view, onViewChange }: PaneHeaderProps) {
  const session     = useStore(s => s.sessionMap[sessionId]);
  // The pane's own sheep, in the same four states and the same precedence as
  // the sidebar's — bleating over grazing, live over idle. There is room for
  // a bigger animal here than in a pen card, which is the point: the head
  // actually reads, and the status is where you are already looking.
  const busy           = useStore(s => !!s.sessionBusy[sessionId]);
  const needsAttention = useStore(s => !!s.sessionNeedsAttention[sessionId]);
  const unseen         = useStore(s => !!s.sessionHasUnseen[sessionId]);
  const sheepState: SheepState =
    needsAttention ? 'bleating'
      : busy ? 'grazing'
      : unseen ? 'unread'
      : 'idle';
  // Moved up from the old footer bar along with the path itself.
  const [showFullPath, setShowFullPath] = useState(false);
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

  if (!session) {
    // Loading placeholder — matches real header height so layout doesn't jump.
    return <div style={{ height: 30, flexShrink: 0, borderBottom: '1px solid var(--border)', background: 'var(--card)' }} />;
  }

  return (
    <div
      className={`pane-header${isActive ? ' pane-header-active' : ''}`}
      style={{
        display: 'flex', flexDirection: 'column',
        flexShrink: 0, minWidth: 0,
        borderBottom: isActive
          ? '1px solid rgba(156, 188, 127, 0.65)'
          : '1px solid rgba(140, 148, 132, 0.16)',
        // Shared with the pane's footer bar so the two halves of the frame
        // match; the light-theme variants live on the tokens (see style.css).
        background: isActive ? 'var(--pane-chrome-active)' : 'var(--pane-chrome)',
        borderRadius: '2px 2px 0 0',
        boxShadow: isActive ? 'inset 0 1px rgba(199, 217, 186, 0.10)' : 'inset 0 1px rgba(255, 255, 255, 0.035)',
        transition: 'background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease',
        userSelect: 'none',
        color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)',
      }}
    >
      {/* The pane bar. Two lines tall, always: the identity block on the
          left stacks the name over its path, and everything else is centred
          against it on the right. Same height active or not — see the note
          on .pane-bar-row in style.css for why that matters. */}
      <div className="pane-bar-row">
        {/* The sheep leads the bar. It is the pane's status, and status is
            what you scan a wall of panes for — the agent's logo is not, since
            you already know what you started. The two swapped places. */}
        <SheepStatus state={sheepState} />

        {/* ── Identity: the name, with the path as its subtitle ──────────
            The path used to be a separate field on the far right of the bar,
            competing with the actions for the same edge. It belongs to the
            name — "which sheepit is this one" — so it sits under it as a
            subtitle, and the two together make the bar two lines tall
            without anything having to wrap. */}
        <div className="pane-bar-title-block">
          {editing ? (
            /* Inline, not a popover. Renaming a pane is a one-field edit; a
               280px dialog to hold one input was three clicks of ceremony
               for a thing you can type over in place. */
            <input
              ref={inputRef}
              className="pane-bar-title-input"
              value={draftName}
              onChange={e => setDraftName(e.target.value)}
              onBlur={commitRename}
              onClick={e => e.stopPropagation()}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
              }}
            />
          ) : (
            <button
              className="pane-bar-title"
              title="Click to rename"
              onClick={(e) => {
                e.stopPropagation();
                setDraftName(session.name ?? '');
                setEditing(true);
              }}
            >
              {forceTextPresentation(session.name ?? '')}
            </button>
          )}
          {session.path && (
            <div className="pane-bar-identity">
              <button
                type="button"
                className="pane-bar-path"
                title="Show full absolute path"
                onClick={(e) => { e.stopPropagation(); setShowFullPath(v => !v); }}
              >
                {session.path.replace(/^\/Users\/[^/]+/, '~')}
              </button>
              {showFullPath && (
                <div className="pane-bar-path-popover" onClick={e => e.stopPropagation()}>
                  {session.path}
                </div>
              )}
            </div>
          )}
        </div>

        {/* The agent's mark sits with the git info rather than leading the
            bar — what is driving this pane and what it is pushing to are the
            same kind of fact, and neither is what you scan for. */}
        <span className={`pane-header-kind-badge${isActive ? ' pane-header-kind-badge-active' : ''}`}>
          {session.isClaudeCode ? <ClaudeIcon size={15} />
            : session.isCodex    ? <OpenAIIcon size={15} />
            : session.isOpencode ? <OpenCodeIcon size={15} />
            : session.isAntigravity ? <AntigravityIcon size={15} />
            : session.isCopilot  ? <GitHubCopilotIcon size={15} />
            : session.isGrok     ? <GrokIcon size={15} />
            : session.isCursor   ? <CursorIcon size={15} />
            : <SquareTerminal size={15} />}
        </span>

        {/* Branch / PR sits OUTSIDE the action cluster, because it is the one
            thing here made of arbitrary-length text. Inside a flex-shrink:0
            group a long branch name is unshrinkable, and it crushed the title
            block — the most important field on the bar — down to nothing. */}
        <StatChips sessionId={sessionId} send={sharedWs.send} />

        {/* Three groups, ruled apart: what this pane is connected to (agent
            mark, git, links), what it is showing (the view switch), and what
            you can do to it (mic, zen, close). */}
        <div className="pane-bar-actions">
        {/* Per-pane view switch — terminal / git / files, scoped to this pane.
            Shed on a very narrow pane; see the container queries in style.css.
            Its leading divider goes with it, or a pane without a view switch
            would show two rules in a row. */}
        {onViewChange && <div className="pane-bar-divider" />}
        {onViewChange && (
          // Top-level switch: Terminal vs. the unified Git view. The Git view's
          // own Working / Files / Git Log sub-switcher lives inside it.
          // A tinted pill rather than a filled one: the pane header sits right
          // on top of the terminal, and a solid brand fill up here shouts over
          // the content it is framing.
          <div
            className="pane-bar-views"
            style={{
              display: 'flex', alignItems: 'center', flexShrink: 0, height: 22,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden',
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
                  width: 26, height: 22,
                  background: active ? 'color-mix(in srgb, var(--primary) 22%, transparent)' : 'none',
                  border: 'none',
                  borderRight: id !== 'git' ? '1px solid var(--border)' : 'none',
                  cursor: 'pointer',
                  color: active ? 'var(--primary)' : 'var(--muted-foreground)',
                }}
              >
                {icon}
              </button>
            ))}
          </div>
        )}
        {/* Divider separating the view-switch pill from the button cluster. */}
        <div className="pane-bar-divider" />

        {isActive && (
          <span className="pane-bar-voice">
            <VoiceInputButton sessionId={sessionId} />
          </span>
        )}

        {/* Zen toggle — enters/exits distraction-free fullscreen */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleZen(sessionId); }}
          title={isZen ? 'Exit zen mode' : 'Zen mode (fullscreen)'}
          className="pane-bar-btn"
        >
          {isZen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
        </button>

        {/* Close — on the grid's root cell, confirms and tears down the
            whole grid; on other cells, removes just that pane. */}
        <button
          onClick={handleClose}
          title={isZen ? 'Exit zen mode' : 'Close pane'}
          className="pane-bar-btn pane-bar-btn-danger"
        >
          <X size={12} />
        </button>
        </div>{/* /.pane-bar-actions */}
      </div>

    </div>
  );
}
