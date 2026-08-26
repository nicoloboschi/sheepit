import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { DialogHeader, DialogTitle } from './ui/dialog';
import ConfigDialog from './ConfigDialog';
import useStore from '../store';
import { TERMINAL_THEMES } from '../theme';

interface HistoryDialogProps {
  sessionId: string;
  onClose: () => void;
}

export default function HistoryDialog({ sessionId, onClose }: HistoryDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Shared with the live panes, so history honours the light theme too — it
  // used to carry its own copy of the dark palette.
  const theme = useStore(s => s.theme);
  const fontFamily = useStore(s => s.terminalFontFamily);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily,
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 50000,
      theme: TERMINAL_THEMES[theme],
      disableStdin: true,
      cursorBlink: false,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    fetch(`/api/sessions/${sessionId}/history`)
      .then(r => r.text())
      .then(text => {
        term.write(text);
        term.scrollToBottom();
      })
      .catch(e => {
        term.write(`\r\nFailed to load history: ${e.message}\r\n`);
      });

    const ro = new ResizeObserver(() => fitAddon.fit());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
    };
  }, [sessionId, theme, fontFamily]);

  return (
    <ConfigDialog open onClose={onClose}>
        <DialogHeader className="px-4 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <DialogTitle style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
            History &mdash; {sessionId}
          </DialogTitle>
        </DialogHeader>
        <div ref={containerRef} className="flex-1 min-h-0 p-2" style={{ background: 'var(--background)' }} />
    </ConfigDialog>
  );
}
