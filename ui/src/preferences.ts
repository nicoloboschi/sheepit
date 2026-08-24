import { apiUrl } from './serverUrl';

type PreferenceValues = Record<string, string>;

let values: PreferenceValues = {};
let pending: PreferenceValues = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

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

/** Load the shared profile before mounting React, then migrate existing browser
 * keys that the server does not have yet. The native server URL remains local:
 * it is required to reach the preferences endpoint in standalone mode. */
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

/** Route the existing UI's storage calls through the shared profile. Keeping
 * this compatibility layer lets every established preference use the server
 * immediately, while the connection bootstrap key remains browser-local. */
export function installServerBackedStorage(): void {
  if (installed) return;
  installed = true;
  const nativeGet = Storage.prototype.getItem;
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;
  Storage.prototype.getItem = function(key: string): string | null {
    return isPreferenceKey(key) ? values[key] ?? null : nativeGet.call(this, key);
  };
  Storage.prototype.setItem = function(key: string, value: string): void {
    if (!isPreferenceKey(key)) return nativeSet.call(this, key, value);
    values[key] = value;
    pending[key] = value;
    scheduleFlush();
  };
  Storage.prototype.removeItem = function(key: string): void {
    if (!isPreferenceKey(key)) return nativeRemove.call(this, key);
    delete values[key];
    pending[key] = '';
    scheduleFlush();
  };
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
