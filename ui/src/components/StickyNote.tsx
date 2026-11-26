import { useState } from 'react';
import { StickyNote as StickyNoteIcon } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { preferences } from '../preferences';

// One plain-text note, saved in the synced profile so every device sees it.
// ponytail: last write wins, no live update while open; fine for one person's scratch note.
const KEY = 'sheepit:note';

export default function StickyNote() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button title="Note" aria-label="Note" className="stats-action"
          style={{ background: 'none', color: 'var(--muted-foreground)' }}>
          <StickyNoteIcon size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-2" style={{ width: 360 }}>
        <NoteText />
      </PopoverContent>
    </Popover>
  );
}

// Mounted only while open, so it reads the latest saved text each time.
function NoteText() {
  const [text, setText] = useState(() => preferences.getItem(KEY) ?? '');
  return (
    <textarea
      autoFocus
      value={text}
      spellCheck={false}
      placeholder="Quick note…"
      onChange={e => { setText(e.target.value); preferences.setItem(KEY, e.target.value); }}
      className="w-full resize-y rounded-md border p-2 text-sm outline-none"
      style={{
        height: 240, fontFamily: 'var(--font-mono)',
        background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--foreground)',
      }}
    />
  );
}
