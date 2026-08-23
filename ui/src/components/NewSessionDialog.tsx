import { useState, useRef, useEffect, useMemo } from 'react';
import { Search, FolderGit2, GitBranch, ChevronDown, ChevronRight, FolderOpen, Sparkles } from 'lucide-react';
import useStore, { type Session } from '../store';
import { relativeTime } from '../utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import DirectoryPicker from './DirectoryPicker';

interface NewSessionDialogProps {
  onClose: () => void;
  onSelect: (path: string | null) => void;
  title: string;
  icon?: React.ReactNode;
}

interface ProjectGroup {
  name: string;
  mainPath: string;
  branch?: string;
  dirty?: boolean;
  lastActivity: number | null;
  variants: { path: string; label: string }[];
}

function groupProjects(dirs: string[], sessions: Session[], username?: string): ProjectGroup[] {
  // Build a map of path → best session info (most recent)
  const pathInfo = new Map<string, { branch?: string; dirty?: boolean; lastActivity?: number }>();
  for (const s of sessions) {
    if (!s.path) continue;
    const existing = pathInfo.get(s.path);
    if (!existing || (s.last_activity ?? 0) > (existing.lastActivity ?? 0)) {
      pathInfo.set(s.path, { branch: s.gitBranch, dirty: s.gitDirty, lastActivity: s.last_activity });
    }
  }

  const groups = new Map<string, { paths: string[]; basePath: string }>();
  for (const dir of dirs) {
    const name = dir.split('/').pop() ?? dir;
    const base = name.replace(/(-wt\d+)+$/, '');
    const parentDir = dir.split('/').slice(0, -1).join('/');
    const key = parentDir + '/' + base;
    if (!groups.has(key)) {
      groups.set(key, { paths: [], basePath: dir });
    }
    groups.get(key)!.paths.push(dir);
    if (dir.length < groups.get(key)!.basePath.length) {
      groups.get(key)!.basePath = dir;
    }
  }

  const result: ProjectGroup[] = [];
  for (const [, { paths, basePath }] of groups) {
    const name = basePath.split('/').pop() ?? basePath;
    const info = pathInfo.get(basePath);
    // Find the most recent activity across all variants
    let bestActivity: number | null = null;
    for (const p of paths) {
      const a = pathInfo.get(p)?.lastActivity;
      if (a && (!bestActivity || a > bestActivity)) bestActivity = a;
    }
    const variants = paths
      .sort((a, b) => a.length - b.length)
      .map(p => ({
        path: p,
        label: p === basePath ? 'main' : (p.split('/').pop() ?? p),
      }));
    result.push({
      name,
      mainPath: basePath,
      branch: info?.branch,
      dirty: info?.dirty,
      lastActivity: bestActivity ? Math.round(bestActivity * 1000) : null,
      variants,
    });
  }

  // Sort by most recent activity
  result.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return result;
}

export default function NewSessionDialog({ onClose, onSelect, title, icon }: NewSessionDialogProps) {
  const sessions = useStore(s => s.sessions);
  const username = sessions.find(s => s.username)?.username;
  const dirs = useMemo(() => [...new Set(sessions.map(s => s.path).filter(Boolean))] as string[], [sessions]);
  const projects = useMemo(() => groupProjects(dirs, sessions, username), [dirs, sessions, username]);

  const [filter, setFilter] = useState('');
  const [showBrowse, setShowBrowse] = useState(false);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const pick = (path: string | null) => {
    onSelect(path);
    onClose();
  };

  const tilde = (p: string) => {
    if (!username) return p;
    for (const home of [`/Users/${username}`, `/home/${username}`]) {
      if (p.startsWith(home)) return '~' + p.slice(home.length);
    }
    return p;
  };

  const lowerFilter = filter.toLowerCase();
  const filtered = lowerFilter
    ? projects.filter(p =>
        p.name.toLowerCase().includes(lowerFilter) ||
        p.mainPath.toLowerCase().includes(lowerFilter) ||
        (p.branch?.toLowerCase().includes(lowerFilter)) ||
        p.variants.some(v => v.path.toLowerCase().includes(lowerFilter))
      )
    : projects;

  const maxShow = filter ? filtered.length : 8;
  const [showAll, setShowAll] = useState(false);
  const visible = showAll || filter ? filtered : filtered.slice(0, maxShow);
  const hasMore = !showAll && !filter && filtered.length > maxShow;

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent
        className="flex flex-col gap-0 p-0"
        style={{ width: 480, maxWidth: 'calc(100vw - 32px)', maxHeight: 'min(520px, calc(100vh - 64px))' }}
      >
        <DialogHeader className="px-4 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            {icon}
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
          {/* Search input */}
          <div className="px-4 pt-3 pb-2 shrink-0">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md" style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}>
              <Search size={12} className="text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Search projects…"
                spellCheck={false}
                className="flex-1 bg-transparent border-none outline-none text-xs"
                style={{ color: 'var(--foreground)', fontFamily: '"JetBrains Mono", monospace' }}
              />
            </div>
          </div>

          {/* Vibe session — random workspace */}
          <div className="px-4 pb-1">
            <button
              onClick={() => pick('__vibe__')}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left hover:bg-accent group"
              style={{ transition: 'background 0.1s', border: '1px dashed var(--border)' }}
            >
              <Sparkles size={13} className="text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-xs font-semibold" style={{ color: 'var(--foreground)' }}>
                  Vibe session
                </span>
                <div className="text-[10px] text-muted-foreground" style={{ opacity: 0.5 }}>
                  Fresh workspace in ~/.sheepit/vibe-sessions/
                </div>
              </div>
            </button>
          </div>

          {/* Recent projects */}
          {visible.length > 0 && (
            <div className="px-4 pb-1">
              <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider px-1 mb-1.5">
                Recent projects
              </div>
              <div className="flex flex-col gap-0.5">
                {visible.map(project => {
                  const hasVariants = project.variants.length > 1;
                  const isExpanded = expandedProject === project.mainPath;
                  const time = relativeTime(project.lastActivity);

                  return (
                    <div key={project.mainPath}>
                      <button
                        onClick={() => pick(project.mainPath)}
                        className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left hover:bg-accent group"
                        style={{ transition: 'background 0.1s' }}
                      >
                        <FolderGit2 size={13} className="text-primary shrink-0 opacity-60" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold truncate" style={{ color: 'var(--foreground)' }}>
                              {project.name}
                            </span>
                            {project.branch && (
                              <span className="flex items-center gap-1 text-[9px] shrink-0" style={{ color: 'var(--muted-foreground)', fontFamily: '"JetBrains Mono", monospace' }}>
                                <GitBranch size={8} strokeWidth={2} />
                                <span style={{ maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                                  {project.branch}
                                </span>
                                {project.dirty && <span style={{ color: 'var(--warning)', fontSize: 7 }}>{'\u25CF'}</span>}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground truncate font-mono" style={{ opacity: 0.5 }}>
                              {tilde(project.mainPath.split('/').slice(0, -1).join('/'))}
                            </span>
                            {time && (
                              <span className="text-[9px] text-muted-foreground shrink-0" style={{ opacity: 0.4 }}>
                                {time}
                              </span>
                            )}
                          </div>
                        </div>
                        {hasVariants && (
                          <span
                            className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px]"
                            style={{
                              background: 'rgba(255,255,255,0.05)',
                              color: 'var(--muted-foreground)',
                              fontFamily: '"JetBrains Mono", monospace',
                            }}
                            title={`${project.variants.length} worktrees`}
                            onClick={(e) => { e.stopPropagation(); setExpandedProject(isExpanded ? null : project.mainPath); }}
                          >
                            {project.variants.length} wt
                            {isExpanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                          </span>
                        )}
                      </button>
                      {hasVariants && isExpanded && (
                        <div className="ml-7 mt-0.5 mb-1 flex flex-col gap-0.5">
                          {project.variants.map(v => (
                            <button
                              key={v.path}
                              onClick={() => pick(v.path)}
                              className="flex items-center gap-2 px-2 py-1 rounded text-[11px] hover:bg-accent text-left font-mono"
                              style={{ color: 'var(--muted-foreground)' }}
                            >
                              <FolderOpen size={10} className="shrink-0 opacity-50" />
                              <span className="truncate">{v.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {hasMore && (
                <button
                  onClick={() => setShowAll(true)}
                  className="text-[10px] text-muted-foreground hover:text-foreground px-1 mt-1"
                  style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  Show {filtered.length - maxShow} more…
                </button>
              )}
            </div>
          )}

          {visible.length === 0 && filter && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground" style={{ opacity: 0.6 }}>
              No projects matching "{filter}"
            </div>
          )}
        </div>

        {/* Browse filesystem — pinned at bottom */}
        <div className="px-4 py-2 border-t shrink-0" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={() => setShowBrowse(b => !b)}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground uppercase tracking-wider font-semibold w-full"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
          >
            {showBrowse ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Browse filesystem
          </button>
          {showBrowse && (
            <div className="mt-1" style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              <DirectoryPicker
                initialPath="~"
                onSelect={(path) => pick(path)}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
