import { useState, useEffect } from 'react';
import { Check, Loader, RotateCw, Tag } from 'lucide-react';
import ConfigDialog from './ConfigDialog';
import { Button } from './ui/button';

/**
 * What is left to configure now that nothing calls a model.
 *
 * A pane is named from the title Claude Code writes into its own transcript,
 * so there is no provider to pick and no CLI to point at — only whether to
 * take the title, and how often to look for a new one.
 */
interface NamingConfig {
  autoNaming: boolean;
  autoNamingIntervalSecs: number;
}

type AsyncState = 'idle' | 'loading' | 'ok' | 'error';

interface AIFeaturesDialogProps {
  onClose: () => void;
}

export function AIFeaturesContent() {
  const [cfg, setCfg] = useState<NamingConfig | null>(null);
  const [saveState, setSaveState] = useState<AsyncState>('idle');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    fetch('/api/ai/config')
      .then(r => r.json())
      .then(setCfg)
      .catch(() => {});
  }, []);

  async function save() {
    if (!cfg) return;
    setSaveState('loading');
    setSaveError('');
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const data = await res.json();
      if (!data.ok) { setSaveState('error'); setSaveError(data.error || 'Save failed'); return; }
      setSaveState('ok');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (e) {
      setSaveState('error'); setSaveError(`Request failed: ${e}`);
    }
  }

  return (
    <div className="p-5 flex flex-col gap-4 min-h-[180px] flex-1 overflow-y-auto">
      {!cfg ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader size={13} className="animate-spin" /> Loading&hellip;
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Tag size={13} className="text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">Pen names</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Claude Code titles its own session and writes that title into its transcript.
              Sheepit reads it and names the pen after it — no model call, and it keeps up
              as the work moves on. PR numbers, issue numbers, uuids and commit hashes are
              taken out: the pane bar already shows the PR.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Codex writes no title, so a Codex pen keeps the name it has until you change it.
            </p>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={cfg.autoNaming}
                onChange={e => setCfg({ ...cfg, autoNaming: e.target.checked })}
                className="rounded"
              />
              <span className="text-xs font-medium text-foreground">Name pens from the agent's title</span>
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-foreground">Check every</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={5}
                max={600}
                value={cfg.autoNamingIntervalSecs}
                onChange={e => setCfg({ ...cfg, autoNamingIntervalSecs: Number(e.target.value) })}
                className="text-xs px-2 py-1.5 rounded border border-border bg-background text-foreground font-mono w-20"
              />
              <span className="text-xs text-muted-foreground">seconds</span>
            </div>
          </div>

          {saveState === 'error' && (
            <p className="text-xs text-destructive">{saveError}</p>
          )}

          <Button
            size="sm"
            className="self-start flex items-center gap-2 mt-1"
            onClick={save}
            disabled={saveState === 'loading'}
          >
            {saveState === 'loading' && <Loader size={13} className="animate-spin" />}
            {saveState === 'ok' && <Check size={13} />}
            {(saveState === 'idle' || saveState === 'error') && <RotateCw size={13} />}
            {saveState === 'loading' ? 'Saving…'
              : saveState === 'ok' ? 'Saved'
              : 'Save & Apply'}
          </Button>
        </>
      )}
    </div>
  );
}

export default function AIFeaturesDialog({ onClose }: AIFeaturesDialogProps) {
  return (
    <ConfigDialog open onClose={onClose}>
      <AIFeaturesContent />
    </ConfigDialog>
  );
}
