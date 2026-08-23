import { useShallow } from 'zustand/react/shallow';
import useStore from './store';

/**
 * The flock vocabulary.
 *
 * sheepit talks about its sessions the way a shepherd talks about sheep — see
 * the glossary in /CLAUDE.md. The mapping to the store's own terms is:
 *
 *   pen      → workspace (a sidebar row)
 *   flock    → every workspace, together
 *   bleating → a pane that wants you (sessionNeedsAttention)
 *   grazing  → a pane working away on its own (sessionBusy)
 *
 * A pane that is neither bleating nor grazing is just standing there, and gets
 * no word of its own.
 */
export interface FlockCounts {
  /** Panes across every workspace. */
  panes: number;
  /** Workspaces. */
  pens: number;
  /** Panes waiting for your input. */
  bleating: number;
  /** Panes with a command still running. */
  grazing: number;
}

/** Counts for the whole flock, or for one pen when `workspaceId` is given. */
export function useFlockCounts(workspaceId?: string | null): FlockCounts {
  // Shallow-compared: the selector builds a fresh object every call, so
  // without this the hook would re-render on every unrelated store write.
  return useStore(useShallow(s => {
    const ids = workspaceId
      ? [workspaceId].filter(id => !!s.workspaces[id])
      : s.workspaceOrder.filter(id => !!s.workspaces[id]);

    let panes = 0, bleating = 0, grazing = 0;
    for (const id of ids) {
      for (const cell of s.workspaces[id]!.cells) {
        if (!cell) continue;
        panes++;
        // A pane that wants you is only ever bleating — never also grazing —
        // so the two counts always add up to at most `panes`.
        if (s.sessionNeedsAttention[cell]) bleating++;
        else if (s.sessionBusy[cell]) grazing++;
      }
    }
    return { panes, pens: ids.length, bleating, grazing };
  }));
}

/** `3 panes` / `1 pane` — the flock's units, pluralised. */
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}
