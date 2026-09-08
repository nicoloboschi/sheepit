/**
 * The smallest CDP client that will do — a request/response map and an event
 * emitter over one WebSocket.
 *
 * Puppeteer and Playwright both do this and much more, and both bring a
 * ~300 MB browser download with them that we do not want: the machine already
 * has a Chromium on it, and the whole value of the live browser is that its
 * profile is a real one that keeps your logins. So this talks to that browser
 * directly. It is about 100 lines because we use six domains, not sixty.
 *
 * Everything is "flat" mode (`sessionId` on the message rather than a nested
 * connection per target), which is what `Target.attachToTarget({flatten:true})`
 * gives and what makes one socket enough for every pane.
 */
import WebSocket from 'ws';

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Set<Handler>>();
  private closed = false;
  readonly ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', err => reject(err));
    });
    this.ws.on('message', raw => this.onMessage(String(raw)));
    this.ws.on('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
      this.emit('__closed__', {});
    });
    // A browser that goes away is not an exception anyone can act on here; the
    // owner notices through '__closed__' and relaunches.
    this.ws.on('error', () => { /* surfaced via close */ });
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === 'number') {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${msg.error.message ?? 'CDP error'} (${msg.method ?? ''})`));
      else waiter.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') this.emit(msg.method, msg.params ?? {}, msg.sessionId);
  }

  private emit(method: string, params: Record<string, unknown>, sessionId?: string) {
    for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId);
  }

  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) { set = new Set(); this.handlers.set(method, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload), err => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  /** Fire and forget. Input events are sent per mousemove; awaiting each one
   *  would serialise the pointer behind a round-trip and make dragging lurch. */
  post(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    this.send(method, params, sessionId).catch(() => { /* input is best-effort */ });
  }

  close(): void {
    this.closed = true;
    try { this.ws.close(); } catch { /* already gone */ }
  }

  get isOpen(): boolean { return !this.closed && this.ws.readyState === WebSocket.OPEN; }
}
