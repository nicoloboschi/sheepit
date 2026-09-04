import { apiUrl } from './serverUrl';

type PreferenceValues = Record<string, string>;

let values: PreferenceValues = {};
let pending: PreferenceValues = {};
/** Keys sent to the server but not yet acknowledged — see scheduleFlush. */
let inFlight: PreferenceValues = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * This tab's identity, sent with every write.
 *
 * The server echoes each patch to every other client so their snapshot cannot
 * go stale; it echoes it to us too, and applying our own write back is how a
 * value we changed while the request was in flight gets reverted to the one we
 * sent. Ignoring the echo by origin is cheaper than versioning every key.
 */
const ORIGIN = Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Notified with the keys that changed underneath us — another tab, another
 *  browser, or a resync after the socket came back. */
const externalListeners = new Set<(keys: string[]) => void>();

/* Every stored preference is namespaced `sheepit:` (a handful of older ones
 * use `sheepit-`). The server-side profile validates the same prefix, so the
 * two must stay in step — see the key check in src/api.ts. */
const SERVER_URL_KEY = 'sheepit:server-url';

function isPreferenceKey(key: string): boolean {
  return key !== SERVER_URL_KEY && (key.startsWith('sheepit:') || key.startsWith('sheepit-'));
}

function legacyValues(): PreferenceValues {
  const migrated: PreferenceValues = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !isPreferenceKey(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) migrated[key] = value;
  }
  return migrated;
}

async function writePatch(patch: PreferenceValues): Promise<void> {
  const response = await fetch(apiUrl('/api/preferences'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: patch, origin: ORIGIN }),
  });
  if (!response.ok) throw new Error(`Could not save preferences (${response.status})`);
}

async function writeMigration(valuesToMigrate: PreferenceValues): Promise<void> {
  // Send one stored key at a time during first-run migration. This tolerates
  // large historical workspace/tabs blobs and lets a successful key remain
  // migrated if a later legacy entry is malformed.
  for (const [key, value] of Object.entries(valuesToMigrate)) {
    await writePatch({ [key]: value });
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const patch = pending;
    pending = {};
    // A key stays "ours" until the server has it. Between the send and the
    // response it is in neither `pending` nor the server's answer, and a
    // broadcast arriving in that window would put the old value back locally
    // while our write lands remotely — the two would then disagree for good,
    // since our own echo is ignored by origin.
    inFlight = patch;
    void writePatch(patch)
      .then(() => { inFlight = {}; })
      .catch(() => {
        // Keep the latest values locally in memory and retry with the next write.
        inFlight = {};
        pending = { ...patch, ...pending };
      });
  }, 200);
}

/**
 * Load the shared profile before mounting React, then migrate any keys still
 * sitting in this browser that the server does not have yet.
 *
 * Must complete before anything reads a preference. It used to be possible to
 * read one earlier — the old implementation patched Storage.prototype, so a
 * module that touched localStorage at import time silently saw an empty store
 * and then wrote its emptiness back. That is how a set of workspace layouts
 * was once replaced by one blank workspace per session.
 *
 * The server URL stays in real localStorage: it is what tells us which server
 * to ask for these values, so it cannot live in them.
 */
export async function initializePreferences(): Promise<void> {
  const response = await fetch(apiUrl('/api/preferences'));
  if (!response.ok) throw new Error(`Could not load preferences (${response.status})`);
  const data = await response.json() as { values?: PreferenceValues };
  values = data.values ?? {};

  const legacy = legacyValues();
  const migration: PreferenceValues = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (values[key] === undefined) migration[key] = value;
  }
  if (Object.keys(migration).length > 0) {
    await writeMigration(migration);
    values = { ...values, ...migration };
  }

  // Once a key is safely present server-side, remove its browser-local copy.
  for (const key of Object.keys(legacy)) {
    if (values[key] !== undefined) localStorage.removeItem(key);
  }
}

/**
 * Take in values written somewhere else.
 *
 * A key this tab has a write pending for is skipped: ours is the newer
 * intention, it is already in `values`, and the flush is about to make it the
 * server's answer too. Everything else lands and the listeners are told which
 * keys moved, so a store holding a copy can re-read exactly those.
 */
function mergeRemote(incoming: PreferenceValues): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (key in pending || key in inFlight) continue;
    const next = value === '' ? undefined : value;
    if ((values[key] ?? undefined) === next) continue;
    if (next === undefined) delete values[key]; else values[key] = next;
    changed.push(key);
  }
  return changed;
}

function notifyExternal(changed: string[]): void {
  if (changed.length === 0) return;
  for (const fn of externalListeners) {
    try { fn(changed); } catch { /* a bad listener must not stop the rest */ }
  }
}

/** Apply a patch the server broadcast. Our own echo is dropped by origin. */
export function applyRemotePreferences(incoming: unknown, origin?: string): void {
  if (origin === ORIGIN) return;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return;
  const patch: PreferenceValues = {};
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    if (typeof value === 'string') patch[key] = value;
  }
  notifyExternal(mergeRemote(patch));
}

/**
 * Re-read the whole profile.
 *
 * The broadcast is the fast path and it only reaches a tab that is connected;
 * a tab that was asleep, or whose socket dropped for a minute, missed every
 * patch sent meanwhile. Called on every reconnect, so "I have been away" and
 * "I have just started" are the same code path.
 */
export async function resyncPreferences(): Promise<void> {
  const response = await fetch(apiUrl('/api/preferences'));
  if (!response.ok) return;
  const data = await response.json() as { values?: PreferenceValues };
  const server = data.values ?? {};
  // Deliberately values only, never deletions. A resync cannot tell a key
  // someone removed from a profile that came back short — a half-written file,
  // a server that restarted mid-read — and inferring deletion from absence
  // turns one bad answer into "throw away every pen you have". Real deletions
  // arrive as a broadcast, which says so explicitly.
  notifyExternal(mergeRemote(server));
}

/** Watch for values changed by another tab or browser. */
export function subscribePreferences(fn: (keys: string[]) => void): () => void {
  externalListeners.add(fn);
  return () => { externalListeners.delete(fn); };
}

export const preferences = {
  getItem(key: string): string | null {
    return values[key] ?? null;
  },

  /** Every key currently held under `prefix`. The workspace store keys one
   *  entry per pen, so it has to enumerate rather than know the ids up front. */
  keys(prefix: string): string[] {
    return Object.keys(values).filter(key => key.startsWith(prefix));
  },

  setItem(key: string, value: string): void {
    values[key] = value;
    pending[key] = value;
    scheduleFlush();
  },

  removeItem(key: string): void {
    delete values[key];
    pending[key] = '';
    scheduleFlush();
  },
};
