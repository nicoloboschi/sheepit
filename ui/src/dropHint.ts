import { create } from 'zustand';

/** Where a sidebar drag would land: before or after one pen or sheep. Its own
 *  tiny store so a move re-renders only the item that gains or loses the line,
 *  never the list. App.tsx writes it while dragging; SessionItem reads it. */
export type DropSide = 'before' | 'after';
interface DropHint { id: string | null; side: DropSide }

export const useDropHintStore = create<DropHint>(() => ({ id: null, side: 'before' }));

export function setDropHint(id: string | null, side: DropSide = 'before'): void {
  const cur = useDropHintStore.getState();
  if (cur.id !== id || cur.side !== side) useDropHintStore.setState({ id, side });
}

/** The side the line is drawn on for this item, or null. */
export const useDropSide = (id: string): DropSide | null =>
  useDropHintStore(s => (s.id === id ? s.side : null));

/** A sorting strategy that moves nothing: the line says where it lands. */
export const noShift = (): null => null;
