import { useState } from 'react';
import { Activity, ScrollText, Keyboard, Sparkles, Zap, Palette, Moon, Sun } from 'lucide-react';
import { DialogHeader, DialogTitle } from './ui/dialog';
import ConfigDialog from './ConfigDialog';
import ViperIcon from './ViperIcon';
import { DiagnosticsContent } from './DiagnosticsDialog';
import { LogsContent } from './LogsModal';
import { ShortcutsContent } from './ShortcutsDialog';
import { AIFeaturesContent } from './AIFeaturesDialog';
import { CommandsContent } from './CommandsDialog';
import useStore from '../store';

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'ai', label: 'AI Features', icon: Sparkles },
  { id: 'commands', label: 'Commands', icon: Zap },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'logs', label: 'Server Logs', icon: ScrollText },
  { id: 'diagnostics', label: 'Diagnostics', icon: Activity },
] as const;

type TabId = typeof TABS[number]['id'];

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: TabId;
}

export default function SettingsDialog({ onClose, initialTab }: SettingsDialogProps) {
  const [tab, setTab] = useState<TabId>(initialTab ?? 'ai');
  const theme = useStore(s => s.theme);
  const setTheme = useStore(s => s.setTheme);

  return (
    <ConfigDialog open onClose={onClose}>
      <DialogHeader className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
          <ViperIcon size={15} color="var(--primary)" />
          Settings
        </DialogTitle>
      </DialogHeader>

      <div className="flex flex-1 min-h-0">
        {/* Vertical tab bar */}
        <nav className="flex flex-col shrink-0 border-r py-2" style={{ borderColor: 'var(--border)', width: 180 }}>
          {TABS.map(t => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="flex items-center gap-2.5 px-4 py-2 text-left text-xs transition-colors"
                style={{
                  color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
                  background: active
                    ? 'linear-gradient(135deg, #0074d9 0%, #009296 100%) right / 2px 100% no-repeat, var(--accent)'
                    : 'transparent',
                  fontWeight: active ? 600 : 400,
                  borderRight: '2px solid transparent',
                }}
              >
                <Icon size={14} />
                {t.label}
              </button>
            );
          })}
        </nav>

        {/* Tab content */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto">
          {tab === 'diagnostics' && <DiagnosticsContent />}
          {tab === 'logs' && <LogsContent />}
          {tab === 'shortcuts' && <ShortcutsContent />}
          {tab === 'commands' && <CommandsContent />}
          {tab === 'ai' && <AIFeaturesContent />}
          {tab === 'appearance' && (
            <div className="p-5">
              <h3 className="text-sm font-semibold mb-1">Appearance</h3>
              <p className="text-xs text-muted-foreground mb-4">Changes the app and standard ANSI terminal colours immediately, including running Claude Code sessions.</p>
              <div className="flex gap-3">
                {([
                  { id: 'dark' as const, label: 'Dark', icon: Moon, preview: '#111111' },
                  { id: 'light' as const, label: 'Light', icon: Sun, preview: '#f7f8fa' },
                ]).map(({ id, label, icon: Icon, preview }) => (
                  <button key={id} onClick={() => setTheme(id)} className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={{ borderColor: theme === id ? 'var(--primary)' : 'var(--border)', background: theme === id ? 'var(--accent)' : 'var(--card)', color: 'var(--foreground)' }}>
                    <span style={{ width: 18, height: 18, borderRadius: 4, background: preview, border: '1px solid var(--border)' }} />
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </ConfigDialog>
  );
}
