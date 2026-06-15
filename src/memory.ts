import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { ChildProcess } from 'child_process';
import { logger } from './server.js';

const BANK_ID = 'vipershell';
const PROFILE = 'vipershell';
const LOG_PATH = join(homedir(), '.hindsight', 'profiles', `${PROFILE}.log`);

// ── Memory activity tracking ────────────────────────────────────────────────

/** Maximum bytes of payload/results we retain per activity entry. */
export const MAX_ACTIVITY_PAYLOAD_BYTES = 8 * 1024;

export interface MemoryActivity {
  ts: number;            // Date.now()
  type: 'retain' | 'recall';
  source: 'vipershell' | 'claude-code' | 'codex' | 'plugin';
  sessionId?: string;
  contentSize?: number;  // bytes for retain (full size, even if payload was truncated)
  resultCount?: number;  // number of results for recall
  context?: string;      // short summary line (≤120 chars) — kept for compact UI
  /** The endpoint subpath the call hit — e.g. "v1/default/banks/vipershell/memories". */
  subpath?: string;
  /** Full ingested content (retain) or full query (recall), capped at MAX_ACTIVITY_PAYLOAD_BYTES. */
  payload?: string;
  /** True if the payload was truncated to fit the byte cap. */
  payloadTruncated?: boolean;
  /** Metadata/tags carried with the call (session_id, tool, hook_event, etc). */
  metadata?: Record<string, string>;
  /** For recall: preview of the joined result texts returned to the hook (capped). */
  resultsPreview?: string;
  /** True if resultsPreview was truncated. */
  resultsPreviewTruncated?: boolean;
}

const MAX_ACTIVITY = 100;
const _activityLog: MemoryActivity[] = [];

/** Truncate `s` to at most `max` bytes (UTF-8 safe via slice on chars — close enough for caps). */
export function capPayload(s: string, max = MAX_ACTIVITY_PAYLOAD_BYTES): { value: string; truncated: boolean } {
  if (s.length <= max) return { value: s, truncated: false };
  return { value: s.slice(0, max), truncated: true };
}

export function logMemoryActivity(entry: MemoryActivity): void {
  _activityLog.push(entry);
  if (_activityLog.length > MAX_ACTIVITY) _activityLog.shift();
}

export function getMemoryActivity(): MemoryActivity[] {
  return [..._activityLog];
}

const CONFIG_PATH = join(homedir(), '.config', 'vipershell', 'config.json');

export interface MemoryConfig {
  hindsightEnabled: boolean;
  hindsightApiUrl: string;
  hindsightApiToken: string;
  retainChunkChars: number;
  observationsEnabled: boolean;
  uiPort: number;
}

const CONFIG_DEFAULTS: MemoryConfig = {
  hindsightEnabled: true,
  hindsightApiUrl: '',
  hindsightApiToken: '',
  retainChunkChars: 3000,
  observationsEnabled: false,
  uiPort: 18765,
};

export class MemoryStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any | null = null;
  private uiProcess: ChildProcess | null = null;
  private _startedAt: number | null = null;

  get logPath(): string { return LOG_PATH; }
  private _resolvedUrl: string = '';

  get active(): boolean { return this.client !== null; }
  get apiUrl(): string { return this._resolvedUrl; }
  get startedAt(): number | null { return this._startedAt; }

  get retainChunkChars(): number {
    return this.getConfig().retainChunkChars;
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  getConfig(): MemoryConfig {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf8');
      const data = JSON.parse(raw);
      return {
        hindsightEnabled: data.hindsightEnabled ?? CONFIG_DEFAULTS.hindsightEnabled,
        hindsightApiUrl: data.hindsightApiUrl ?? CONFIG_DEFAULTS.hindsightApiUrl,
        hindsightApiToken: data.hindsightApiToken ?? CONFIG_DEFAULTS.hindsightApiToken,
        retainChunkChars: data.hindsightRetainChunkChars ?? CONFIG_DEFAULTS.retainChunkChars,
        observationsEnabled: data.hindsightObservationsEnabled ?? CONFIG_DEFAULTS.observationsEnabled,
        uiPort: data.hindsightUiPort ?? CONFIG_DEFAULTS.uiPort,
      };
    } catch {
      return { ...CONFIG_DEFAULTS };
    }
  }

  saveConfig(updates: Partial<MemoryConfig>): void {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* fresh */ }
    if ('hindsightEnabled' in updates) data.hindsightEnabled = updates.hindsightEnabled;
    if ('hindsightApiUrl' in updates) data.hindsightApiUrl = updates.hindsightApiUrl;
    if ('hindsightApiToken' in updates) data.hindsightApiToken = updates.hindsightApiToken;
    if ('retainChunkChars' in updates) data.hindsightRetainChunkChars = updates.retainChunkChars;
    if ('observationsEnabled' in updates) data.hindsightObservationsEnabled = updates.observationsEnabled;
    if ('uiPort' in updates) data.hindsightUiPort = updates.uiPort;
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Start Hindsight in the background. Does not block the caller. */
  startInBackground(): void {
    this.start().catch((e) => {
      logger.error(`Hindsight background start failed: ${e}`);
    });
  }

  async start(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.hindsightEnabled) return;

    const url = cfg.hindsightApiUrl;
    if (!url) {
      logger.warn('Hindsight requires an API URL — memory disabled');
      return;
    }

    let HindsightClient: new (opts: { baseUrl: string; apiKey?: string }) => unknown;
    try {
      const mod = await import('@vectorize-io/hindsight-client');
      HindsightClient = mod.HindsightClient;
    } catch {
      logger.warn('Hindsight client not installed — memory disabled. Run: npm install @vectorize-io/hindsight-client');
      return;
    }

    this._resolvedUrl = url.replace(/\/+$/, '');

    // Verify connectivity
    try {
      const resp = await fetch(`${this._resolvedUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) {
        logger.warn(`Hindsight API health check failed (${resp.status}) — memory disabled`);
        return;
      }
    } catch (e) {
      logger.warn(`Hindsight API unreachable at ${this._resolvedUrl} — memory disabled: ${e}`);
      return;
    }

    const clientOpts: { baseUrl: string; apiKey?: string } = { baseUrl: this._resolvedUrl };
    if (cfg.hindsightApiToken) clientOpts.apiKey = cfg.hindsightApiToken;
    this.client = new HindsightClient(clientOpts);
    this._startedAt = Date.now();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.client as any).createBank(BANK_ID, {
        name: 'vipershell',
        mission: 'Track terminal session activity and content for context recall.',
      });
    } catch { /* bank already exists */ }

    logger.info(`Hindsight memory ready at ${this._resolvedUrl} (bank=${BANK_ID})`);

    // Auto-start control plane UI
    this.startUi().catch(() => {});
  }

  async restart(): Promise<void> {
    this._stopUi();
    this.client = null;
    this._startedAt = null;
    await this.start();
  }

  close(): void {
    this._stopUi();
    this.client = null;
    this._startedAt = null;
  }

  // ── Control-plane UI ────────────────────────────────────────────────────────
  // The control plane is a separate process pointed at the configured API URL.

  async startUi(): Promise<string | null> {
    if (!this.client) return null;
    const cfg = this.getConfig();
    const uiUrl = `http://127.0.0.1:${cfg.uiPort}`;

    // Already reachable — nothing to do
    if (await this._isUiHealthy(cfg.uiPort)) return uiUrl;

    this._stopUi();
    this.uiProcess = spawn('npx', [
      '@vectorize-io/hindsight-control-plane',
      '--api-url', this._resolvedUrl,
      '--port', String(cfg.uiPort),
      '--hostname', '0.0.0.0',
    ], { stdio: 'ignore' });
    this.uiProcess.on('error', (e) => logger.warn(`Hindsight UI error: ${e.message}`));
    logger.info(`Hindsight control-plane UI spawned at ${uiUrl}`);
    return uiUrl;
  }

  private async _isUiHealthy(port: number): Promise<boolean> {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      return resp.ok;
    } catch {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
        return resp.ok;
      } catch { return false; }
    }
  }

  private _stopUi(): void {
    if (this.uiProcess) {
      try { this.uiProcess.kill(); } catch { /* ignore */ }
      this.uiProcess = null;
    }
  }

  // ── Memory operations ───────────────────────────────────────────────────────

  async retain(content: string, _documentId: string, tags: string[], context: string): Promise<void> {
    if (!this.client) return;
    const sessionTag = tags.find(t => t.startsWith('session:'));
    const sessionId = sessionTag?.split(':')[1];
    const metadata = Object.fromEntries(tags.map(t => {
      const [k, ...v] = t.split(':');
      return [k, v.join(':')];
    }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.client as any).retain(BANK_ID, content, {
        context,
        metadata,
        async: true,
      });
      const capped = capPayload(content);
      logMemoryActivity({
        ts: Date.now(), type: 'retain', source: 'vipershell',
        sessionId, contentSize: content.length, context,
        subpath: `v1/default/banks/${BANK_ID}/memories`,
        payload: capped.value,
        payloadTruncated: capped.truncated,
        metadata,
      });
    } catch (e) {
      logger.warn(`Hindsight retain failed: ${e}`);
    }
  }

  async recall(query: string): Promise<string[]> {
    if (!this.client) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await (this.client as any).recall(BANK_ID, query, { budget: 'low' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = (resp.results ?? []).map((r: any) => r.text as string);
      const cappedQuery = capPayload(query);
      const cappedResults = capPayload(results.join('\n---\n'));
      logMemoryActivity({
        ts: Date.now(), type: 'recall', source: 'vipershell',
        resultCount: results.length, context: query.slice(0, 100),
        subpath: `v1/default/banks/${BANK_ID}/recall`,
        payload: cappedQuery.value,
        payloadTruncated: cappedQuery.truncated,
        resultsPreview: cappedResults.value,
        resultsPreviewTruncated: cappedResults.truncated,
      });
      return results;
    } catch {
      return [];
    }
  }
}
