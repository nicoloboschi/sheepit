import { useState, useRef, useEffect } from 'react';
import { SquareTerminal, X, PanelRight, RotateCcw, Pi, Feather } from 'lucide-react';
import useStore from '../store';
import SheepStatus, { type SheepState } from './SheepStatus';
import DogStatus from './DogStatus';
import { useDog } from '../flock';
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
  /** The pen this pane stands in. Read to tell whether it is the last sheep
   *  in it, which is what makes closing it close the pen too. */
  workspaceId: string;
  isActive: boolean;
  onClose: () => void;
  /** Whether the tools (files, browser, git) are open beside the terminal.
   *  When a toggle is given, the header shows one button to show/hide them. */
  toolsOpen?: boolean;
  onToggleTools?: () => void;
}


export default function PaneHeader({ sessionId, workspaceId, isActive, onClose, toolsOpen, onToggleTools }: PaneHeaderProps) {
  const session     = useStore(s => s.sessionMap[sessionId]);
  // The pane's own sheep, in the same four states and the same precedence as
  // the sidebar's — bleating over grazing, live over idle. There is room for
  // a bigger animal here than in a pen card, which is the point: the head
  // actually reads, and the status is where you are already looking.
  // The sheepdog's pane shows a dog instead, and its posture reports on the
  // flock rather than on itself. See DogStatus.tsx.
  const dog            = useDog();
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
  // Closing the last sheep dissolves the pen, so the confirmation has to say
  // so. This was `sessionId === gridId` at the call site, which dated from
  // when a pen was keyed by its root pane's session id — pen ids are
  // synthetic now, so that test was simply always false.
  // False when there is no pen at all — a scratch terminal in the Terminals
  // panel has a synthetic `__headless__:` id that matches no workspace, and
  // `?? 1` would have called every one of them the last sheep in a pen it is
  // not standing in.
  const isLastSheep = useStore(s => {
    const ws = s.workspaces[workspaceId];
    return !!ws && ws.cells.length <= 1;
  });
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
    const name = session?.name ?? 'pane';
    // The last sheep in a pen takes the pen with it, so say so.
    const msg = isLastSheep
      ? `Close "${name}"? It is the last sheep in this pen.`
      : `Close "${name}"?`;
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
        {dog?.sessionId === sessionId
          ? <DogStatus state={dog.state} />
          : <SheepStatus state={sheepState} />}

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
            : session.isPi       ? <Pi size={15} />
            : session.isHermes   ? <Feather size={15} />
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
            mark, git, links), whether its tools are open, and what
            you can do to it (mic, close). */}
        <div className="pane-bar-actions">
        {/* Show/hide the tools beside the terminal. Which tool is showing is
            picked on the tools' own rail, not up here. */}
        {onToggleTools && <div className="pane-bar-divider" />}
        {onToggleTools && (
          <button
            className="pane-bar-btn pane-bar-views"
            title={toolsOpen ? 'Hide tools' : 'Show tools — files, browser, git'}
            onClick={(e) => { e.stopPropagation(); onToggleTools(); }}
            style={{ color: toolsOpen ? 'var(--primary)' : undefined }}
          >
            <PanelRight size={13} />
          </button>
        )}
        {/* Divider separating the tools toggle from the button cluster. */}
        <div className="pane-bar-divider" />

        {isActive && (
          <span className="pane-bar-voice">
            <VoiceInputButton sessionId={sessionId} />
          </span>
        )}

        {/* Headless only: kill this shell and start a fresh one.
            A headless session has no pen and no sibling panes, so there is no
            close-and-make-another path through the sidebar — and when it hangs
            that is exactly what you want. Server-side in one step; see the
            `restart` branch in server.ts for why the client cannot sequence
            it itself. */}
        {session.isHeadless && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              // `session_id` names the target: there are up to four scratch
              // shells now, so "the" headless session is no longer a thing the
              // server could work out for itself.
              //
              // `side_of` has to ride along for a SIDE terminal, or the
              // replacement comes back belonging to nobody: the old shell is
              // closed by id (it is headless, so it matches), and the new one
              // is made without an owner — so restarting a pane's terminal
              // silently moved it into the global Terminals panel.
              sharedWs.send({
                type: 'create_session', path: null, headless: true,
                restart: true, session_id: sessionId,
                ...(session.sideOf ? { side_of: session.sideOf } : {}),
              });
            }}
            title="Kill this headless shell and start a fresh one"
            className="pane-bar-btn pane-bar-btn-danger"
          >
            <RotateCcw size={11} />
          </button>
        )}

        {/* Close — kills this pane's session. The last one in a pen takes
            the pen with it, which the confirmation says. */}
        <button
          onClick={handleClose}
          title="Close pane"
          className="pane-bar-btn pane-bar-btn-danger"
        >
          <X size={12} />
        </button>
        </div>{/* /.pane-bar-actions */}
      </div>

    </div>
  );
}
