import { BookOpen } from 'lucide-react';
import ConfigDialog from './ConfigDialog';
import NotesPane from './NotesPane';

interface KnowledgeDialogProps {
  onClose: () => void;
}

/** Knowledge (notes) opens as an overlay dialog over the current workspace, so
 *  it never replaces the active terminal/workspace context. The close button is
 *  provided by DialogContent (top-right), so we don't add our own. */
export default function KnowledgeDialog({ onClose }: KnowledgeDialogProps) {
  return (
    <ConfigDialog open onClose={onClose}>
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0"
        style={{
          borderColor: 'var(--border)',
          // Leave room on the right for DialogContent's built-in close button.
          paddingRight: 44,
          background: 'linear-gradient(135deg, rgba(0,116,217,0.10) 0%, rgba(0,146,150,0.07) 100%), #0d1117',
        }}
      >
        <BookOpen size={15} style={{ color: 'var(--primary)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>Knowledge</span>
      </div>
      <NotesPane />
    </ConfigDialog>
  );
}
