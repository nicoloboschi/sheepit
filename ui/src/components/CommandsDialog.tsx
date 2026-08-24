import { useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import ConfigDialog from './ConfigDialog';
import { Button } from './ui/button';

const STORAGE_KEY = 'sheepit-commands';

interface Command {
  id: number;
  name: string;
  command: string;
}

export function loadCommands(): Command[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); }
  catch { return []; }
}

function saveCommands(cmds: Command[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cmds));
}

interface CommandsDialogProps {
  onClose: () => void;
}

export function CommandsContent() {
  const [commands, setCommands] = useState<Command[]>(loadCommands);
  const [name, setName] = useState('');
  const [cmd, setCmd] = useState('');

  function add() {
    if (!name.trim() || !cmd.trim()) return;
    const next = [...commands, { id: Date.now(), name: name.trim(), command: cmd.trim() }];
    setCommands(next);
    saveCommands(next);
    setName('');
    setCmd('');
  }

  function remove(id: number) {
    const next = commands.filter(c => c.id !== id);
    setCommands(next);
    saveCommands(next);
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--background)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--foreground)',
    fontSize: 12,
    padding: '6px 10px',
    outline: 'none',
    width: '100%',
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {commands.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--muted-foreground)', textAlign: 'center', padding: '12px 0' }}>
            No saved commands yet.
          </p>
        )}
        {commands.map(c => (
          <div key={c.id} className="flex items-center gap-2 rounded-md px-3 py-2" style={{ background: 'var(--accent)' }}>
            <div className="flex-1 min-w-0">
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>{c.name}</div>
              <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--muted-foreground)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.command}</div>
            </div>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0" onClick={() => remove(c.id)}>
              <Trash2 size={12} />
            </Button>
          </div>
        ))}
      </div>

      <div className="border-t p-4 flex flex-col gap-2" style={{ borderColor: 'var(--border)' }}>
        <input
          style={inputStyle}
          placeholder="Name (e.g. Git status)"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
        />
        <input
          style={{ ...inputStyle, fontFamily: 'monospace' }}
          placeholder="Command (e.g. git status)"
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
        />
        <Button size="sm" onClick={add} disabled={!name.trim() || !cmd.trim()} className="self-end">
          <Plus size={13} /> Add
        </Button>
      </div>
    </>
  );
}

export default function CommandsDialog({ onClose }: CommandsDialogProps) {
  return (
    <ConfigDialog open onClose={onClose}>
      <CommandsContent />
    </ConfigDialog>
  );
}
