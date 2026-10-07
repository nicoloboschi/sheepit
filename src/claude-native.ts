/**
 * A pane's Claude Code session, read as a conversation instead of as a screen.
 *
 * This is what the pane's "native view" is made of, and the whole point of how
 * it is built: **it is the session already running in the pane**. Not a copy,
 * not a fork, not a second process. There is nothing to keep in step and
 * nothing to reimplement, so there is no Claude Code feature it can be missing
 * — slash commands, plan mode, `/compact`, skills, attachments, subagents,
 * permission modes, MCP, whatever ships next week — because none of them are
 * known about here. Two wires, and that is the whole design:
 *
 *   **in**  — the text is typed into the pane's PTY, exactly as a keyboard
 *             would. `DirectBridge.sendInput`, the same path a keystroke
 *             travels.
 *   **out** — the agent's own transcript is tailed, and its rows are drawn.
 *
 * An earlier cut spawned a second `claude` over its stream-json stdio protocol
 * and forked the conversation into it. That bought token-by-token streaming
 * and cost fidelity: a forked session is a different session, its transcript
 * is a different file, and every TUI-only affordance had to be rebuilt or
 * given up. The trade is the wrong way round for a view whose promise is
 * *this is your real session*, so it was deleted. What is given up instead is
 * streaming *within* a message — measured on a real turn, rows land as they
 * happen (`assistant/tool_use` before the tool runs, `user/tool_result` the
 * moment it returns, the answer when it is written), so the conversation is
 * live to about the latency of a file write; it simply arrives a message at a
 * time rather than a token at a time.
 *
 * ## What this view cannot show, and says so
 *
 * A dialog the TUI draws on screen — a permission prompt, the plan-mode
 * accept, a `/resume` picker — is **not in the transcript**, because it is not
 * part of the conversation. The native view cannot invent it. What it can do
 * is notice: sheepit already knows the pane is blocked, from the agent's own
 * hooks (that is what makes the sheep bleat), so the view says the pane is
 * waiting on something only the terminal can show, and offers the switch.
 * That is the honest answer, and it is one click from the real thing — which
 * is the whole reason the terminal stays mounted underneath.
 *
 * ## The transcript is not only the conversation
 *
 * It carries `attachment`, `queue-operation`, `last-prompt`, `atis-latch`,
 * `cost-state` and `system` rows alongside the real ones, and a sidechain
 * (subagent) conversation interleaved with the main one. Only `user` and
 * `assistant` rows that are not sidechain are messages; everything else is
 * bookkeeping — the same filter ⌘K's search already applies.
 */
import { createReadStream, existsSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { logger } from './server.js';

/** How a block of a turn is drawn. One of these per bubble in the UI. */
export type NativeMessage =
  | { id: string; kind: 'user'; text: string; at: number }
  | { id: string; kind: 'assistant'; text: string; at: number }
  | { id: string; kind: 'thinking'; text: string; at: number }
  | {
      id: string; kind: 'tool'; at: number;
      name: string;
      input?: unknown;
      /** Absent while the tool is still running — the result row has not
       *  landed yet, which is exactly how the UI knows to show a spinner. */
      result?: string;
      isError?: boolean;
    }
  | { id: string; kind: 'system'; text: string; at: number; level?: 'info' | 'error' };

export interface NativeState {
  sessionId: string;
  cwd: string;
  /** The file being tailed, or null when the pane has no agent yet. */
  transcriptPath: string | null;
  messages: NativeMessage[];
}

export type NativeEvent =
  | { type: 'init'; state: NativeState }
  | { type: 'message'; message: NativeMessage }
  /** The transcript was replaced — a `/clear`, or a resumed session writing a
   *  new file. The client throws away what it has and takes these. */
  | { type: 'reset'; messages: NativeMessage[]; transcriptPath: string | null };

const MAX_MESSAGES = 1500;
/** The tail we read for history. Transcripts reach hundreds of megabytes and
 *  this runs while somebody is waiting to see their conversation. */
const HISTORY_BYTES = 2 * 1024 * 1024;
/** Longest tool result forwarded. A `Read` of a large file is megabytes nobody
 *  scrolls through, and it would ride the socket in front of a keystroke. */
const MAX_RESULT_CHARS = 20_000;
/** How often the file is stat-ed. The transcript only moves when the agent
 *  does, so this is a stat per watched pane per tick and a read only when it
 *  grew — the same bargain `contextTokens` already makes in the session sweep. */
const POLL_MS = 400;

function clip(s: string, n = MAX_RESULT_CHARS): string {
  return s.length <= n ? s : s.slice(0, n) + `\n… [${s.length - n} more characters]`;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: Record<string, unknown>) => b?.type === 'text')
    .map((b: Record<string, unknown>) => String(b.text ?? ''))
    .join('')
    .trim();
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: Record<string, unknown>) =>
      b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : '')
    .join('\n')
    .trim();
}

/**
 * Turns transcript rows into messages, in order, keeping just enough state to
 * fold a tool result onto the call it belongs to.
 *
 * Used for the first read and for every later tail, which is the point: a
 * message must not be built one way on load and another way live, or the
 * conversation changes shape when you reload it.
 */
class RowReader {
  /** tool_use id → the message we drew it as, so its result can find it. */
  private tools = new Map<string, Extract<NativeMessage, { kind: 'tool' }>>();

  /** @returns the messages this row added, and any it changed in place. */
  read(row: Record<string, any>): { added: NativeMessage[]; changed: NativeMessage[] } {
    const added: NativeMessage[] = [];
    const changed: NativeMessage[] = [];
    // A subagent's exchange belongs to the subagent. Same rule as ⌘K's search;
    // without it a Task tool's whole inner conversation lands in the pane's.
    if (row.isSidechain === true) return { added, changed };
    if (row.type !== 'user' && row.type !== 'assistant') return { added, changed };

    const at = Date.parse(row.timestamp ?? '') || Date.now();
    const content = row.message?.content;
    const uuid: string = row.uuid ?? randomUUID();

    if (row.type === 'user') {
      // A `user` row is either something a person typed or a tool coming back.
      let sawResult = false;
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type !== 'tool_result') continue;
        sawResult = true;
        const call = this.tools.get(b.tool_use_id);
        const text = clip(resultText(b.content));
        if (call) {
          call.result = text;
          call.isError = !!b.is_error;
          changed.push(call);
        } else {
          added.push({
            id: `t-${b.tool_use_id}`, kind: 'tool', at,
            name: 'tool', result: text, isError: !!b.is_error,
          });
        }
      }
      if (sawResult) return { added, changed };
      const text = textOf(content);
      // Claude Code puts its own notices through as user rows wrapped in
      // <...> tags — a hook's stdout, a command's expansion, a reminder. They
      // are not something anybody typed, and drawn as a user bubble they read
      // as the person shouting machine output at the agent.
      if (text && !/^<[a-z-]+>/i.test(text)) {
        added.push({ id: `u-${uuid}`, kind: 'user', text, at });
      }
      return { added, changed };
    }

    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) {
        added.push({ id: `a-${uuid}-${added.length}`, kind: 'assistant', text: b.text, at });
      } else if (b?.type === 'thinking' && String(b.thinking ?? '').trim()) {
        added.push({ id: `a-${uuid}-think-${added.length}`, kind: 'thinking', text: b.thinking, at });
      } else if (b?.type === 'tool_use') {
        const m: Extract<NativeMessage, { kind: 'tool' }> = {
          id: `t-${b.id}`, kind: 'tool', at, name: b.name, input: b.input,
        };
        this.tools.set(b.id, m);
        added.push(m);
      }
    }
    return { added, changed };
  }
}

/**
 * One pane's conversation: tail its transcript, type into its PTY.
 *
 * Owns no process. The agent is the one the pane was already running, so
 * closing this closes a reader and nothing else.
 */
export class NativeSession {
  private subs = new Set<(e: NativeEvent) => void>();
  private messages: NativeMessage[] = [];
  private reader = new RowReader();
  private timer: ReturnType<typeof setInterval> | null = null;
  private path: string | null = null;
  /** Bytes consumed, and the half-line left over from the last read. */
  private offset = 0;
  private partial = '';
  private reading = false;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    /** Re-asked every poll: a `/clear` starts a new file, and the pane's own
     *  hooks are what know about it. */
    private resolvePath: () => string | null,
    private write: (data: string) => void,
  ) {}

  get state(): NativeState {
    return {
      sessionId: this.sessionId, cwd: this.cwd,
      transcriptPath: this.path, messages: this.messages,
    };
  }

  subscribe(fn: (e: NativeEvent) => void): () => void {
    this.subs.add(fn);
    fn({ type: 'init', state: this.state });
    if (!this.timer) this.timer = setInterval(() => void this.poll(), POLL_MS);
    return () => { this.subs.delete(fn); };
  }

  get subscriberCount(): number { return this.subs.size; }

  private emit(e: NativeEvent): void {
    for (const fn of this.subs) {
      try { fn(e); } catch (err) { logger.debug(`native subscriber threw: ${err}`); }
    }
  }

  /**
   * Send a turn by typing it, because that is the only way into a running
   * agent — the same channel the sheepdog and the resume-after-reboot path
   * already use, and for the same reason: you can watch it happen. Open the
   * pane's terminal and the message is in the scrollback.
   *
   * Wrapped in **bracketed paste** so the agent's input box takes a multi-line
   * message as one block. Without it the first newline submits a half-written
   * prompt and the rest lands as a second one.
   */
  send(text: string): void {
    const body = text.replace(/\r\n?/g, '\n');
    if (!body.trim()) return;
    this.write(`\x1b[200~${body}\x1b[201~`);
    // Enter as its own write, after the paste has closed. Inside the brackets
    // it is just a character in the pasted text.
    this.write('\r');
  }

  /**
   * Stop the turn — a real interrupt, not a kill.
   *
   * Escape is what interrupts Claude Code at the keyboard, so it is what this
   * sends. The session survives, its context survives, and the agent records
   * the interruption in its own transcript like everything else.
   */
  interrupt(): void { this.write('\x1b'); }

  /** Raw keys, for the TUI dialogs this view cannot draw. The UI offers the
   *  terminal for those; this is the seam through which a future yes/no card
   *  could answer one without leaving. */
  raw(data: string): void { this.write(data); }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subs.clear();
  }

  /** Fill from the transcript before the first subscriber sees anything. */
  async load(): Promise<void> { await this.rewind(this.resolvePath()); }

  /** Read from scratch — on open, and whenever the file underneath changes. */
  private async rewind(path: string | null): Promise<void> {
    this.path = path;
    this.reader = new RowReader();
    this.messages = [];
    this.offset = 0;
    this.partial = '';
    if (!path || !existsSync(path)) {
      this.emit({ type: 'reset', messages: [], transcriptPath: path });
      return;
    }
    let size = 0;
    try { size = statSync(path).size; } catch { /* vanished under us */ }
    // Far enough back to fill the window — and when that lands mid-file, the
    // first line it lands in is half a row and is dropped.
    const from = Math.max(0, size - HISTORY_BYTES);
    this.offset = size;
    await this.consume(path, from, size, from > 0, false);
    this.messages = this.messages.slice(-MAX_MESSAGES);
    this.emit({ type: 'reset', messages: this.messages, transcriptPath: path });
  }

  private async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const path = this.resolvePath();
      if (path !== this.path) { await this.rewind(path); return; }
      if (!path) return;
      let size = 0;
      try { size = statSync(path).size; } catch { return; }
      // Truncated or replaced in place — start again rather than read garbage.
      if (size < this.offset) { await this.rewind(path); return; }
      if (size === this.offset) return;
      const from = this.offset;
      this.offset = size;
      await this.consume(path, from, size, false, true);
    } catch (e) {
      logger.debug(`native poll failed: ${e}`);
    } finally {
      this.reading = false;
    }
  }

  /** Read [from, to) and turn whatever whole rows it holds into messages. */
  private consume(path: string, from: number, to: number, dropFirstLine: boolean, live: boolean): Promise<void> {
    return new Promise(resolve => {
      if (to <= from) return resolve();
      let buf = this.partial;
      this.partial = '';
      const s = createReadStream(path, { start: from, end: to - 1 });
      s.on('error', () => resolve());
      s.on('data', c => { buf += c; });
      s.on('end', () => {
        const lines = buf.split('\n');
        // The tail piece is only a whole row if the chunk ended on a newline.
        // Keep it either way: the agent writes rows as it goes, so a read
        // routinely catches one half-written.
        this.partial = lines.pop() ?? '';
        let first = true;
        for (const line of lines) {
          const skip = first && dropFirstLine;
          first = false;
          if (skip || !line.trim()) continue;
          let row: Record<string, any>;
          try { row = JSON.parse(line); } catch { continue; }
          const { added, changed } = this.reader.read(row);
          for (const m of added) {
            this.messages.push(m);
            if (live) this.emit({ type: 'message', message: m });
          }
          // A tool result mutates a block that is already on screen, so the
          // client is sent it again under the same id and replaces it in place.
          if (live) for (const m of changed) this.emit({ type: 'message', message: m });
        }
        if (this.messages.length > MAX_MESSAGES) {
          this.messages.splice(0, this.messages.length - MAX_MESSAGES);
        }
        resolve();
      });
    });
  }
}

/**
 * One reader per pane, made on demand.
 *
 * These are cheap — a timer and a file offset — so they are kept while anyone
 * is watching and dropped when the last one leaves. Nothing is lost by that:
 * the conversation is the transcript, and reopening re-reads it. That is the
 * difference a process would have made, and it no longer owns one.
 */
export class NativeSessions {
  private byPane = new Map<string, NativeSession>();

  get(sessionId: string): NativeSession | undefined { return this.byPane.get(sessionId); }

  async open(
    sessionId: string,
    cwd: string,
    resolvePath: () => string | null,
    write: (data: string) => void,
  ): Promise<NativeSession> {
    const existing = this.byPane.get(sessionId);
    if (existing) return existing;
    const s = new NativeSession(sessionId, cwd, resolvePath, write);
    this.byPane.set(sessionId, s);
    await s.load();
    return s;
  }

  /** Called when a watcher leaves; drops the reader once nobody is left. */
  release(sessionId: string): void {
    const s = this.byPane.get(sessionId);
    if (!s || s.subscriberCount > 0) return;
    s.dispose();
    this.byPane.delete(sessionId);
  }

  close(sessionId: string): void {
    this.byPane.get(sessionId)?.dispose();
    this.byPane.delete(sessionId);
  }

  closeAll(): void {
    for (const id of [...this.byPane.keys()]) this.close(id);
  }
}
