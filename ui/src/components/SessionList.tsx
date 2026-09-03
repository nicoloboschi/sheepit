import { useState } from 'react';
import { SquarePlus } from 'lucide-react';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useDroppable, useDndMonitor } from '@dnd-kit/core';
import useStore, { type Workspace } from '../store';
import SessionItem from './SessionItem';
import { ScrollArea } from './ui/scroll-area';
import { useDndEnabled } from '../dndEnabled';

interface SessionListProps {
  onConnect: (id: string) => void;
  send: (msg: Record<string, unknown>) => void;
  id?: string;
}

/** Drop zone that sits in the gap between workspace rows (and at the start
 *  and end of each section). Registered as a dnd-kit droppable so it
 *  receives pane drags. Dropping a pane here extracts it into a brand-new
 *  workspace at this position; App.tsx's onDragEnd handles the action.
 *
 *  Idle: invisible. Pane drag in flight: faint dashed line. Hovered while
 *  the active drag is over this gap: solid blue glow line + a "Drop to
 *  extract" hint. */
function GapDropZone({
  prevId, nextId, anyPaneDragActive,
}: {
  prevId: string | null;
  nextId: string | null;
  anyPaneDragActive: boolean;
}): React.ReactElement {
  const dropId = `gap:${prevId ?? 'start'}->${nextId ?? 'end'}`;
  const { setNodeRef, isOver } = useDroppable({
    id: dropId,
    data: { kind: 'gap', prevId, nextId },
  });
  return (
    <div
      ref={setNodeRef}
      className={[
        'gap-drop-zone',
        anyPaneDragActive ? 'gap-drop-zone-armed' : '',
        isOver ? 'gap-drop-zone-hover' : '',
      ].filter(Boolean).join(' ')}
      data-prev={prevId ?? ''}
      data-next={nextId ?? ''}
    >
      <div className="gap-drop-zone-line" />
      {anyPaneDragActive && (
        <div className="gap-drop-zone-label">
          <SquarePlus size={14} />
          <span>Drop to open a new pen</span>
        </div>
      )}
    </div>
  );
}

export default function SessionList({ onConnect, send, id }: SessionListProps) {
  const workspaces = useStore(s => s.workspaces);
  const workspaceOrder = useStore(s => s.workspaceOrder);
  const currentSessionId = useStore(s => s.currentSessionId);
  const dndEnabled = useDndEnabled();

  // Track whether a *pane* drag is currently in flight in the global
  // DndContext so the gap zones can light up only when relevant. We use
  // dnd-kit's useDndMonitor — it works because SessionList renders inside
  // App.tsx's DndContext.
  const [anyPaneDragActive, setAnyPaneDragActive] = useState(false);
  useDndMonitor({
    onDragStart(e) {
      const data = e.active.data.current as { kind?: string } | undefined;
      if (data?.kind === 'pane') setAnyPaneDragActive(true);
    },
    onDragEnd() { setAnyPaneDragActive(false); },
    onDragCancel() { setAnyPaneDragActive(false); },
  });

  // Resolve workspaces in the order the store reports, skipping any that
  // might have been deleted mid-render.
  const allWs: Workspace[] = workspaceOrder
    .map(id => workspaces[id])
    .filter((w): w is Workspace => !!w);

  if (allWs.length === 0) {
    return (
      <ScrollArea id={id} className="session-list flex-1 py-2">
        <div className="empty-state">No pens yet</div>
      </ScrollArea>
    );
  }

  // Every pen, in workspaceOrder. There is no filter: a three-way toggle sat
  // above this list, and a sidebar that hides pens is a sidebar you have to
  // remember the state of — you go looking for a pen that is right there and
  // conclude it closed. The dot on each pen already says which are stirring,
  // and ⌘K finds one by what it is doing.
  const visible = allWs;
  const sortableIds = visible.map(w => w.id);
  const lastWsId = allWs[allWs.length - 1]?.id ?? null;

  return (
    <ScrollArea id={id} className="session-list flex-1" style={{ paddingTop: 4 }}>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        {visible.map(ws => (
          <SessionItem
            key={ws.id}
            workspace={ws}
            isActive={currentSessionId === ws.id}
            onConnect={onConnect}
            send={send}
          />
        ))}
      </SortableContext>

      {/* The single "create new workspace" drop target. Drops a pane here →
          extract to a new workspace appended at the end of workspaceOrder.
          Lights up only when a pane drag is in flight. Hidden on mobile
          (no drag there). */}
      {dndEnabled && (
        <GapDropZone
          prevId={lastWsId}
          nextId={null}
          anyPaneDragActive={anyPaneDragActive}
        />
      )}
    </ScrollArea>
  );
}
