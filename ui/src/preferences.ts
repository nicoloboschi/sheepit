import { apiUrl } from './serverUrl';

type PreferenceValues = Record<string, string>;

let values: PreferenceValues = {};
let pending: PreferenceValues = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

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
    body: JSON.stringify({ values: patch }),
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
    void writePatch(patch).catch(() => {
      // Keep the latest values locally in memory and retry with the next write.
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

export const preferences = {
  getItem(key: string): string | null {
    return values[key] ?? null;
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
