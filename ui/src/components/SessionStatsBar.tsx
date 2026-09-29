import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, BookOpen, Search, SquarePlus, TerminalSquare, Settings, Dog, FolderOpen, Github, ListPlus } from 'lucide-react';
import useStore from '../store';
import { useFlockCounts, sheepCount } from '../flock';
import { useSheepdog } from '../useSheepdog';
import SettingsDialog from './SettingsDialog';
import FilesDialog from './FilesDialog';
import GithubDialog from './GithubDialog';
import TerminalsDialog from './TerminalsDialog';

// Pen-level toolbar: the pen's name (click to rename) and its actions on the
// left; add-a-sheep and zoom on the right. The terminal/git/files switch lives
// per-pane (see PaneHeader).
interface SessionStatsBarProps {
  sessionId: string | null;
  /** Put another sheep in this pen. Replaces the layout picker that used to
   *  sit here: with one pane on screen, "split" and "add" were always the same
   *  action wearing eight icons. */
  onAddSheep?: () => void;
  onCreateSession?: (headless: boolean) => void;
}

export default function SessionStatsBar({ sessionId, onAddSheep, onCreateSession }: SessionStatsBarProps) {
  // Terminal font size is a single global value shared by every pane.
  const fontSize          = useStore(s => s.fontSize);
  const adjustFontSize    = useStore(s => s.adjustFontSize);
  const resetFontSize     = useStore(s => s.resetFontSize);
  const renameWorkspace   = useStore(s => s.renameWorkspace);
  const sheepdog          = useSheepdog();
  // Publish where the bar ends, for anything that floats under it.
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const publish = () => document.documentElement.style.setProperty(
      '--topbar-bottom', `${el.offsetHeight ? el.getBoundingClientRect().bottom : 0}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty('--topbar-bottom'); };
  }, [sessionId == null]); // the bar is not rendered without a session
  const knowledgeOpen     = useStore(s => s.knowledgeOpen);
  const setKnowledgeOpen  = useStore(s => s.setKnowledgeOpen);
  const headlessCount = useStore(s => s.sessions.filter(session => session.isHeadless).length);
  const pipSessionId = useStore(s => s.pipSessionId);
  // Display name for the active workspace: its title, else its root pane's name.
  const workspaceName = useStore(s => {
    const ws = sessionId ? s.workspaces[sessionId] : undefined;
    if (!ws) return undefined;
    const root = ws.cells[0];
    return ws.title || (root ? s.sessionMap[root]?.name : undefined) || 'Pen';
  });
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen,    setFilesOpen]    = useState(false);
  const [githubOpen,   setGithubOpen]   = useState(false);
  const [terminalsOpen, setTerminalsOpen] = useState(false);
  // How the pen next to the name is doing. Hooks run before the early return.
  const { sheep, bleating, grazing } = useFlockCounts(sessionId);

  if (!sessionId) return null;

  const commitRename = () => {
    if (sessionId) renameWorkspace(sessionId, renameValue.trim() || undefined);
    setRenaming(false);
  };

  const addSheepButton = onAddSheep && (
    <button
      className="flex items-center shrink-0"
      title="Another sheep in this pen"
      onClick={onAddSheep}
      style={{
        padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 6,
        background: 'none', cursor: 'pointer', color: 'var(--muted-foreground)',
      }}
    >
      <ListPlus size={13} />
    </button>
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
        placeholder="Pen name"
        style={{
          fontSize: 11, padding: '2px 7px', borderRadius: 5,
          border: '1px solid var(--ring)', background: 'var(--background)',
          color: 'var(--foreground)', outline: 'none', width: 140, fontFamily: 'inherit',
        }}
      />
    ) : (
      <button
        onClick={() => { setRenameValue(sessionId ? useStore.getState().workspaces[sessionId]?.title ?? '' : ''); setRenaming(true); }}
        title="Click to rename this pen"
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

  // Reads next to the pen name, the way the sidebar band reads over the flock:
  // how many panes are in here, and whether any of them wants you.
  const penCounts = (
    <span className="pen-counts">
      <span>{sheepCount(sheep)}</span>
      {bleating > 0 && <>
        <span className="pen-counts-sep">&middot;</span>
        <span style={{ color: 'var(--bleating)', fontWeight: 600 }}>{bleating} bleating</span>
      </>}
      {bleating === 0 && grazing > 0 && <>
        <span className="pen-counts-sep">&middot;</span>
        <span style={{ color: 'var(--grazing)' }}>{grazing} grazing</span>
      </>}
    </span>
  );

  /**
   * The toolbar's actions: an icon each, with the name in the tooltip.
   *
   * They carried their labels beside them, which spent most of the bar's width
   * on five words that never change — and the bar's job is to say which pen you
   * are in, which is the one thing on it that does. The icons are the same
   * ones the menus use, and `title` still names them for anyone who needs it.
   */
  const action = (
    key: string, icon: React.ReactNode, label: string,
    onClick: () => void, on = false,
  ) => (
    <button
      key={key}
      onClick={onClick}
      title={label}
      aria-label={label}
      className="stats-action"
      // Selection is a background, never a size: a toolbar that reflowed when
      // you opened a panel would move the next button out from under the
      // cursor.
      style={{
        background: on ? 'var(--accent)' : 'none',
        color: on ? 'var(--foreground)' : 'var(--muted-foreground)',
      }}
    >
      {icon}
    </button>
  );

  const searchButton = action(
    'search', <Search size={14} />, 'Search the flock (\u2318K)',
    () => useStore.getState().setSearchOpen(true),
  );

  /* The file browser, over the whole app rather than inside one pane —
     what you would otherwise leave sheepit for a Finder window to do. */
  const filesButton = action(
    'files', <FolderOpen size={14} />, 'Browse files',
    () => setFilesOpen(v => !v), filesOpen,
  );

  /* GitHub over the whole app, not one pane: pull requests and issues for the
     repositories the flock is in, plus the ones you keep. */
  const githubButton = action(
    'github', <Github size={14} />, 'Pull requests and issues',
    () => setGithubOpen(v => !v), githubOpen,
  );

  const knowledgeButton = action(
    'knowledge', <BookOpen size={14} />, 'Knowledge',
    () => setKnowledgeOpen(!knowledgeOpen), knowledgeOpen,
  );

  /* The sheepdog sits beside New session because that is what it makes: a
     pane, with Hermes started in it, appointed as the dog. Appointing an
     existing pane is still on a pen's own menu — but nobody's first sheepdog
     should have to be assembled by hand. Once there is one, this goes to it,
     and it turns the colour of a bleating sheep when the dog is calling. */
  // Pressed means *this panel is up*, not "a dog exists" — the same thing the
  // other panel buttons mean, and what makes double-clicking a panel away read
  // as the button popping out.
  const sheepdogButton = action(
    'sheepdog',
    <Dog size={14} style={sheepdog.dog?.state === 'alerting' ? { color: 'var(--bleating)' } : undefined} />,
    sheepdog.label,
    sheepdog.toggle,
    !!sheepdog.dog && pipSessionId === sheepdog.dog.sessionId,
  );

  const newSessionButtons = onCreateSession && <>
    {sheepdogButton}
    {action('new', <SquarePlus size={14} />, 'New session', () => onCreateSession(false))}
    {/* The scratch terminals, in their own panel — up to four of them. It
        opens the panel rather than making a shell: with more than one, "open"
        and "make another" are different things, and the second belongs inside
        the panel where you can see how many you already have. The first one
        is made there too, by the empty state's own button. */}
    {action('headless', <TerminalSquare size={14} />,
      headlessCount ? `Terminals (${headlessCount})` : 'Terminals',
      () => setTerminalsOpen(v => !v), terminalsOpen)}
    {action('settings', <Settings size={14} />, 'Settings', () => setSettingsOpen(true))}
  </>;

  // Desktop only (hidden on mobile, where splits/zoom aren't shown).
  // Left: the pen's name + actions. Right: add a sheep + zoom.
  // The bar wears the same neutral graphite as the sidebar: the two are one
  // frame around the panes, and the frame is what is in view all day — see the
  // chrome tokens in style.css.
  return (
    <div
      ref={barRef}
      className="workspace-bar hidden md:flex items-center gap-2 px-4 py-1.5 shrink-0 border-b"
      style={{ borderColor: 'var(--chrome-line)', background: 'var(--chrome)' }}
    >
      {nameControl}
      {penCounts}
      <div style={{ width: 1, height: 14, background: 'var(--border)', flexShrink: 0 }} />
      {searchButton}
      {filesButton}
      {githubButton}
      {knowledgeButton}
      {newSessionButtons}
      <div style={{ flex: 1 }} />
      {addSheepButton && <div>{addSheepButton}</div>}
      {zoomButtons && <div>{zoomButtons}</div>}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {filesOpen && <FilesDialog onClose={() => setFilesOpen(false)} />}
      {githubOpen && <GithubDialog onClose={() => setGithubOpen(false)} />}
      {terminalsOpen && <TerminalsDialog onClose={() => setTerminalsOpen(false)} />}
    </div>
  );
}
