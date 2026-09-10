import { useCallback } from 'react';
import useStore from './store';
import * as sharedWs from './sharedWs';
import { useDog } from './flock';

/**
 * The one way to reach the sheepdog, shared by every button that offers it —
 * the desktop workspace bar and the mobile header. It lived inside the desktop
 * bar, which is hidden below the md breakpoint, so on a phone there was no way
 * to the dog at all: the feature whose point is "check the flock from
 * somewhere else" could not be opened from somewhere else.
 *
 * One implementation because the rules below are easy to get wrong twice.
 */

/** Module-level, not a ref: the desktop bar and the mobile header are separate
 *  components, and a guard per instance would let the two of them start two
 *  dogs. A second dog is not a harmless duplicate — the first loses the
 *  appointment, stops being hidden, and reappears in the sidebar as an
 *  ordinary pane called "sheepdog". */
let starting = false;

const post = (path: string, body: unknown) => fetch(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Make a pane, appoint it, then run Hermes in it — in that order, because
 * the order is load-bearing:
 *
 *   1. The profile first. It carries the MCP server, so writing it before the
 *      harness starts is the difference between a dog that can see the flock
 *      and one that comes up with no tools and no way to say so.
 *   2. The pane, then the appointment, then Hermes: a harness that comes up in
 *      a pane the server does not yet consider the dog would sit there being
 *      told nothing.
 *
 * `hermes -p sheepit-sheepdog` is typed into the shell rather than being the
 * pane's command, so when the harness exits you get a prompt back instead of
 * a dead pane.
 */
async function createSheepdog(): Promise<void> {
  const profileRes = await post('/api/sheepdog/profile', {});
  const { command } = await profileRes.json() as { command?: string };

  const res = await post('/api/sessions', {});
  const { session_id: id } = await res.json() as { session_id?: string };
  if (!id) return;
  await post('/api/sheepdog', { session_id: id });
  await post(`/api/sessions/${encodeURIComponent(id)}/rename`, { name: 'sheepdog' });
  sharedWs.send({ type: 'input', session_id: id, data: `${command ?? 'hermes'}\r` });
  // It has no pen, so zen is where it is seen — same as headless.
  useStore.getState().toggleZen(id);
}

/** Open the dog if there is one, start one if there is not.
 *
 *  Asks the server rather than trusting the store: the store only learns
 *  about a new pane on the next session sweep, so for up to two seconds after
 *  a start it still says there is no dog. */
async function startOrOpen(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    const existing = await (await fetch('/api/sheepdog')).json() as { sessionId?: string | null };
    if (existing.sessionId) {
      const store = useStore.getState();
      if (store.zenSessionId !== existing.sessionId) store.toggleZen(existing.sessionId);
      return;
    }
    await createSheepdog();
  } finally {
    starting = false;
  }
}

export function useSheepdog() {
  const dog = useDog();

  /** Zen, never the grid: the dog has no pen to select. Pressing it while the
   *  dog is already open is how you put it away again. */
  const toggle = useCallback(() => {
    const store = useStore.getState();
    if (dog && store.zenSessionId === dog.sessionId) { store.exitZen(); return; }
    void startOrOpen();
  }, [dog]);

  const label = !dog
    ? 'Start the sheepdog — a Hermes pane that watches the flock'
    : dog.state === 'alerting' ? 'The sheepdog is calling you' : 'Go to the sheepdog';

  return { dog, toggle, label };
}
