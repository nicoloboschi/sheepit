import { useState, type CSSProperties } from 'react';
import ConfigDialog from './ConfigDialog';
import useStore from '../store';
import { comboOf, comboLabel, DEFAULT_VOICE_SHORTCUT } from '../voiceShortcut';

interface Shortcut {
  keys: string[];
  desc: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ['\u2318', '\u2191 / \u2193'], desc: 'Navigate between sessions' },
  { keys: ['\u2318', '\u2190 / \u2192'], desc: 'Cycle views (Terminal \u00B7 Git Diff \u00B7 Files)' },
  { keys: ['\u2318', 'K'],      desc: 'Search the flock \u2014 find the sheep working on something' },
  { keys: ['\u2318', 'N'],      desc: 'New session in current directory' },
  { keys: ['\u2318', 'W'],      desc: 'Close current session' },
];

interface ShortcutsDialogProps {
  onClose: () => void;
}

const KBD: CSSProperties = {
  display: 'inline-block', padding: '1px 5px', borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--muted)',
  fontFamily: 'inherit', fontSize: 11,
};

/** The mic key: click, press the new combo; Escape cancels. */
function VoiceShortcutRow() {
  const combo = useStore(s => s.voiceShortcut);
  const setCombo = useStore(s => s.setVoiceShortcut);
  const [recording, setRecording] = useState(false);
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '8px 0', whiteSpace: 'nowrap', paddingRight: 16 }}>
        <button
          type="button"
          data-shortcut-recorder=""
          title="Click, then press the new keys"
          onClick={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onKeyDown={e => {
            if (!recording) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { setRecording(false); return; }
            const next = comboOf(e.nativeEvent);
            if (next) { setCombo(next); setRecording(false); }
          }}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' }}
        >
          {recording
            ? <kbd style={{ ...KBD, borderColor: 'var(--ring)' }}>Press keys…</kbd>
            : comboLabel(combo).map((k, i) => <span key={i}><kbd style={KBD}>{k}</kbd>{' '}</span>)}
        </button>
      </td>
      <td style={{ padding: '8px 0', color: 'var(--muted-foreground)' }}>
        Dictate: start the mic, again to stop and type it{' '}
        {combo !== DEFAULT_VOICE_SHORTCUT && (
          <button type="button" onClick={() => setCombo(DEFAULT_VOICE_SHORTCUT)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--primary)', font: 'inherit' }}>
            reset
          </button>
        )}
      </td>
    </tr>
  );
}

export function ShortcutsContent() {
  return (
    <div className="p-5">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>
          {SHORTCUTS.map(({ keys, desc }) => (
            <tr key={desc} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '8px 0', whiteSpace: 'nowrap', paddingRight: 16 }}>
                {keys.map((k, i) => (
                  <span key={i}>
                    <kbd style={{
                      display: 'inline-block', padding: '1px 5px', borderRadius: 4,
                      border: '1px solid var(--border)', background: 'var(--muted)',
                      fontFamily: 'inherit', fontSize: 11,
                    }}>{k}</kbd>
                    {i < keys.length - 1 && ' '}
                  </span>
                ))}
              </td>
              <td style={{ padding: '8px 0', color: 'var(--muted-foreground)' }}>{desc}</td>
            </tr>
          ))}
          <VoiceShortcutRow />
        </tbody>
      </table>
    </div>
  );
}

export default function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  return (
    <ConfigDialog open onClose={onClose}>
      <ShortcutsContent />
    </ConfigDialog>
  );
}
