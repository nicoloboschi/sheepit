import { useShallow } from 'zustand/react/shallow';
import useStore from './store';

/**
 * The flock vocabulary.
 *
 * sheepit talks about its sessions the way a shepherd talks about sheep — see
 * the glossary in /CLAUDE.md. The mapping to the store's own terms is:
 *
 *   sheep    → pane (one terminal, backed by one session)
 *   pen      → workspace (a sidebar row, holding 1–4 sheep)
 *   flock    → every pen together
 *   bleating → a sheep that wants you (sessionNeedsAttention)
 *   grazing  → a sheep working away on its own (sessionBusy)
 *
 * A sheep that is neither bleating nor grazing is just standing there, and
 * gets no word of its own.
 *
 * These names appear in UI strings only. The store keeps `workspaces` and
 * `cells`, and the server keeps workspaces and panes — a shepherd's words are
 * for the shepherd, not for the wire.
 */
export interface FlockCounts {
  /** Sheep (panes) across every pen. */
  sheep: number;
  /** Pens (workspaces). */
  pens: number;
  /** Sheep waiting for your input. */
  bleating: number;
  /** Sheep with a command still running. */
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

    let sheep = 0, bleating = 0, grazing = 0;
    for (const id of ids) {
      for (const cell of s.workspaces[id]!.cells) {
        if (!cell) continue;
        sheep++;
        // A sheep that wants you is only ever bleating — never also grazing —
        // so the two counts always add up to at most `sheep`.
        if (s.sessionNeedsAttention[cell]) bleating++;
        else if (s.sessionBusy[cell]) grazing++;
      }
    }
    return { sheep, pens: ids.length, bleating, grazing };
  }));
}

/** `3 pens` / `1 pen` — the flock's units, pluralised. */
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `3 sheep` / `1 sheep`.
 *
 *  Its own function because "sheep" is its own plural, and `plural()` defaults
 *  to adding an s. Every count of sheep should come through here rather than
 *  each call site remembering to pass the plural twice. */
export function sheepCount(n: number): string {
  return plural(n, 'sheep', 'sheep');
}
