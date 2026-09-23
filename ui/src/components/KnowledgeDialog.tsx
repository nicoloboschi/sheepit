import { BookOpen } from 'lucide-react';
import FloatingPanel from './FloatingPanel';
import NotesPane from './NotesPane';

interface KnowledgeDialogProps {
  onClose: () => void;
}

/** Knowledge (notes) floats over the work, like the other globals — it is
 *  something you read and add to *while* working in a pane, and a full-screen
 *  dialog made it the opposite. */
export default function KnowledgeDialog({ onClose }: KnowledgeDialogProps) {
  return (
    <FloatingPanel
      title="Knowledge"
      icon={<BookOpen size={13} style={{ color: 'var(--primary)' }} />}
      onClose={onClose}
      width={880}
      height={620}
    >
      <NotesPane />
    </FloatingPanel>
  );
}
