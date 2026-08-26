import { useState } from 'react';
import { Activity, ScrollText, Keyboard, Sparkles, Zap, Palette, Plug } from 'lucide-react';
import { DialogHeader, DialogTitle } from './ui/dialog';
import ConfigDialog from './ConfigDialog';
import SheepIcon from './SheepIcon';
import { DiagnosticsContent } from './DiagnosticsDialog';
import { LogsContent } from './LogsModal';
import { ShortcutsContent } from './ShortcutsDialog';
import { AIFeaturesContent } from './AIFeaturesDialog';
import { CommandsContent } from './CommandsDialog';
import { PluginContent } from './PluginDialog';
import { AppearanceContent } from './AppearanceSettings';

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'ai', label: 'AI Features', icon: Sparkles },
  { id: 'commands', label: 'Commands', icon: Zap },
  { id: 'plugin', label: 'Agent Plugin', icon: Plug },
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

  return (
    <ConfigDialog open onClose={onClose}>
      <DialogHeader className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
          <SheepIcon size={15} color="var(--primary)" />
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
                    ? 'linear-gradient(135deg, #9cbc7f 0%, #6fa98c 100%) right / 2px 100% no-repeat, var(--accent)'
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
          {tab === 'plugin' && <PluginContent />}
          {tab === 'appearance' && <AppearanceContent />}
        </div>
      </div>
    </ConfigDialog>
  );
}
