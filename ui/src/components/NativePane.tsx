/**
 * Claude Code, drawn by sheepit.
 *
 * **The same session the pane is running** — not a copy and not a fork. The
 * server types into that pane's PTY and tails the agent's own transcript (see
 * src/claude-native.ts), so every Claude Code feature is present by
 * construction: slash commands, plan mode, `/compact`, skills, subagents, MCP.
 * None of them are known about here, which is why none of them can be missing.
 *
 * What a TUI in a pane cannot do, and this can: wrap and select text like a
 * document, collapse a 2,000-line tool result to one line, keep its scroll
 * position when the pane resizes, and let a phone's own keyboard write into it.
 *
 * Two things follow from being a view rather than a client, and both are
 * visible in here:
 *
 *  - **A turn arrives a message at a time, not a token at a time.** The
 *    transcript is written per message. Liveness comes from the pane's own
 *    busy flag — the hooks sheepit already reads — so the view knows the agent
 *    is working before it knows what it will say.
 *  - **A dialog the TUI draws is not in the transcript**, because it is not
 *    part of the conversation: a permission prompt, the plan-mode accept, a
 *    `/resume` picker. This view cannot invent them. It notices instead — the
 *    pane is bleating — says so, and offers the terminal, which is one click
 *    away because it never went anywhere.
 */
import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import { Square, CornerDownLeft, ChevronRight, Wrench, AlertTriangle, Brain, SquareTerminal, ListChecks, ClipboardCheck } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as sharedWs from '../sharedWs';
import useStore from '../store';
import { perf } from '../perf';

/* ── How this device reads a pane ─────────────────────────────────────────
 * One setting for the whole app: having chosen the conversation view, every
 * pane you move to keeps it. Device-local rather than in the shared profile,
 * because a phone and a laptop want different answers — see DEVICE_LOCAL in
 * preferences.ts. Panes in the same window follow each other through the
 * listener set, so the app is in one mode rather than in as many modes as it
 * has mounted panes. */
const PANE_MODE_KEY = 'sheepit:pane-mode';
type PaneMode = 'terminal' | 'native';
const modeListeners = new Set<(m: PaneMode) => void>();

export function readPaneMode(): PaneMode {
  try { return localStorage.getItem(PANE_MODE_KEY) === 'native' ? 'native' : 'terminal'; }
  catch { return 'terminal'; }   // private window, blocked storage
}

export function writePaneMode(mode: PaneMode): void {
  try { localStorage.setItem(PANE_MODE_KEY, mode); } catch { /* quota, private */ }
  for (const fn of modeListeners) { try { fn(mode); } catch { /* ignore */ } }
}

export function subscribePaneMode(fn: (m: PaneMode) => void): () => void {
  modeListeners.add(fn);
  return () => { modeListeners.delete(fn); };
}

export type NativeMessage =
  | { id: string; kind: 'user'; text: string; at: number }
  | { id: string; kind: 'assistant'; text: string; at: number }
  | { id: string; kind: 'thinking'; text: string; at: number }
  | { id: string; kind: 'tool'; at: number; name: string; input?: unknown; result?: string; isError?: boolean }
  | { id: string; kind: 'system'; text: string; at: number; level?: 'info' | 'error' };

interface NativeState {
  sessionId: string;
  cwd: string;
  transcriptPath: string | null;
  messages: NativeMessage[];
}

type NativeEvent =
  | { type: 'init'; state: NativeState }
  | { type: 'message'; message: NativeMessage }
  | { type: 'reset'; messages: NativeMessage[]; transcriptPath: string | null };

/**
 * The one line a tool call is worth before you open it.
 *
 * A tool block is the commonest thing in a transcript and the least worth
 * reading in full — a wall of JSON per call is how a chat log becomes
 * unreadable. Each tool gets the one field that says *which* call this was,
 * which is the only question you ask while scrolling.
 */
function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof i[k] === 'string' ? i[k] as string : '');
  switch (name) {
    case 'Bash': return s('command');
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return s('file_path');
    case 'Glob': return s('pattern') + (s('path') ? ` in ${s('path')}` : '');
    case 'Grep': return s('pattern') + (s('path') ? ` in ${s('path')}` : '');
    case 'WebFetch': case 'WebSearch': return s('url') || s('query');
    case 'Task': case 'Agent': return s('description') || s('subagent_type');
    case 'TodoWrite': return Array.isArray(i.todos) ? `${(i.todos as unknown[]).length} items` : '';
    default: {
      // An MCP tool, or one added since this was written. The first string
      // argument is nearly always the subject, and a wrong guess here costs a
      // worse one-liner, never a wrong result.
      const first = Object.values(i).find(v => typeof v === 'string') as string | undefined;
      return first ?? '';
    }
  }
}

/** A tool call: one line, opened on click. `memo` because a streaming turn
 *  re-renders the list on every token and a long conversation holds hundreds
 *  of these. */
const ToolBlock = memo(function ToolBlock({ m }: { m: Extract<NativeMessage, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(m.name, m.input);
  const running = m.result === undefined;
  return (
    <div className={`nat-tool${m.isError ? ' nat-tool-error' : ''}${running ? ' nat-tool-running' : ''}`}>
      <button className="nat-tool-head" onClick={() => setOpen(o => !o)}>
        <ChevronRight size={11} className={`nat-tool-chev${open ? ' nat-tool-chev-open' : ''}`} />
        {m.isError ? <AlertTriangle size={11} /> : <Wrench size={11} />}
        <span className="nat-tool-name">{m.name}</span>
        <span className="nat-tool-sum">{summary}</span>
        {running && <span className="nat-tool-spin" aria-label="running" />}
      </button>
      {open && (
        <div className="nat-tool-body">
          {m.input !== undefined && (
            <pre className="nat-pre">{JSON.stringify(m.input, null, 2)}</pre>
          )}
          {m.result !== undefined && <pre className="nat-pre nat-result">{m.result}</pre>}
        </div>
      )}
    </div>
  );
});

/**
 * What the agent wrote, as Markdown.
 *
 * It writes Markdown — that is what the TUI renders — so showing the source is
 * showing the wrong thing: `**Quality**` as literal asterisks, a table as
 * pipes, a code block as backticks. Plain text was the first cut and it read
 * as a diff of the answer rather than the answer.
 *
 * `react-markdown` + `remark-gfm` are already in the bundle for the GitHub
 * view, and `.md-preview` is already the style for "Markdown somebody else
 * wrote", so this is the same two lines that view uses rather than a second
 * renderer with its own opinions. Links leave for the real browser for the
 * same reason they do there: this panel cannot navigate back.
 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="nat-text md-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, href, ...p }) => (
            <a {...p} href={href} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * A question the agent is asking, drawn as the question it is.
 *
 * `AskUserQuestion` and `ExitPlanMode` are ordinary tool calls, so they were
 * landing in the generic one-line tool block — a collapsed row called
 * "AskUserQuestion" whose body was raw JSON. That is exactly backwards: it is
 * the one tool call that is *addressed to the person reading*, and the thing
 * they most need to see.
 *
 * **The options are read, never guessed.** The questions, their headers and
 * every option's label and description are in the tool's input, which is in
 * the transcript — nothing here infers anything from the screen.
 *
 * **It deliberately cannot be answered from here.** Picking an option in the
 * TUI means arrow keys and Enter against a list this view cannot see, and a
 * wrong guess answers a real question wrongly in somebody's session. So it
 * shows the question in full and hands over to the terminal, which is one
 * click. Answering in place needs the agent to expose the choice as something
 * better than keystrokes; until then, showing it honestly is the whole win.
 */
const ChoiceBlock = memo(function ChoiceBlock({ m, onOpenTerminal }: {
  m: Extract<NativeMessage, { kind: 'tool' }>;
  onOpenTerminal?: () => void;
}) {
  const input = (m.input ?? {}) as Record<string, any>;
  const answered = m.result !== undefined;
  const plan = m.name === 'ExitPlanMode';
  const questions: any[] = Array.isArray(input.questions) ? input.questions : [];

  return (
    <div className={`nat-choice${answered ? ' nat-choice-answered' : ''}`}>
      <div className="nat-choice-head">
        {plan ? <ClipboardCheck size={12} /> : <ListChecks size={12} />}
        {plan ? 'Plan — needs your approval' : answered ? 'Asked you' : 'Asking you'}
      </div>

      {plan && typeof input.plan === 'string' && <Markdown text={input.plan} />}

      {questions.map((q, qi) => (
        <div className="nat-q" key={qi}>
          <div className="nat-q-text">{q.question}</div>
          {Array.isArray(q.options) && q.options.map((o: any, oi: number) => (
            <div className="nat-opt" key={oi}>
              <span className="nat-opt-label">{o.label}</span>
              {o.description && <span className="nat-opt-desc">{o.description}</span>}
            </div>
          ))}
        </div>
      ))}

      {answered
        ? <div className="nat-choice-answer">{m.result}</div>
        : (
          <div className="nat-choice-foot">
            Answer this in the terminal — the picker is drawn there.
            {onOpenTerminal && (
              <button className="nat-needs-tui-btn" onClick={onOpenTerminal}>Open terminal</button>
            )}
          </div>
        )}
    </div>
  );
});

/** The tools that are a question for the reader rather than work for the
 *  agent, and so are drawn as one. */
const CHOICE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

const MessageBlock = memo(function MessageBlock({ m, onOpenTerminal }: {
  m: NativeMessage;
  onOpenTerminal?: () => void;
}) {
  switch (m.kind) {
    case 'user':
      return <div className="nat-msg nat-user"><div className="nat-bubble">{m.text}</div></div>;
    case 'assistant':
      return <div className="nat-msg nat-assistant"><Markdown text={m.text} /></div>;
    case 'thinking':
      return (
        <details className="nat-think">
          <summary><Brain size={11} /> thinking</summary>
          <div className="nat-text nat-think-body">{m.text}</div>
        </details>
      );
    case 'tool':
      return CHOICE_TOOLS.has(m.name)
        ? <ChoiceBlock m={m} onOpenTerminal={onOpenTerminal} />
        : <ToolBlock m={m} />;
    case 'system':
      return <div className={`nat-system${m.level === 'error' ? ' nat-system-error' : ''}`}>{m.text}</div>;
  }
});

interface SlashCommand { name: string; description?: string; source: 'built-in' | 'user' | 'project' | 'plugin' }

/**
 * The `/` completion menu.
 *
 * **An accelerator, not a gate.** Everything typed here goes to the real TUI,
 * so a command the list has never heard of still works, and the agent is what
 * answers for one that does not exist — exactly as it would at the keyboard.
 * That is what makes an incomplete list acceptable, and it is why nothing is
 * filtered *out* of the composer: the menu only ever offers.
 *
 * It opens only when `/` is the first character of the draft. A slash in the
 * middle of a sentence is a path or a date, and a menu that appeared over
 * `src/components` would be in the way of nearly every message this view
 * sends.
 */
function useSlashCommands(sessionId: string, draft: string) {
  const [all, setAll] = useState<SlashCommand[] | null>(null);

  // Fetched once per pane, lazily — nobody pays a directory walk for a view
  // they never type a slash into.
  const wantList = draft.startsWith('/');
  useEffect(() => {
    if (!wantList || all) return;
    let gone = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`)
      .then(r => r.json())
      .then(d => { if (!gone) setAll(d.commands ?? []); })
      .catch(() => { if (!gone) setAll([]); });
    return () => { gone = true; };
  }, [wantList, all, sessionId]);

  const open = wantList && !draft.includes('\n') && !draft.includes(' ');
  const query = open ? draft.slice(1).toLowerCase() : '';
  const matches = useMemo(() => {
    if (!open || !all) return [];
    // A prefix match is what you meant; a substring match is a reminder. Both
    // are offered, prefixes first, because "what was that skill called" is
    // most of why this menu exists and the answer is rarely the first letters.
    const pre: SlashCommand[] = [], sub: SlashCommand[] = [];
    for (const c of all) {
      const n = c.name.toLowerCase();
      if (n.startsWith(query)) pre.push(c);
      else if (query && n.includes(query)) sub.push(c);
    }
    return [...pre, ...sub].slice(0, 12);
  }, [open, all, query]);

  return { open: open && matches.length > 0, matches, loading: open && !all };
}

export default function NativePane({ sessionId, onOpenTerminal }: {
  sessionId: string;
  /** Flip the pane back to the TUI — for the dialogs this view cannot draw. */
  onOpenTerminal?: () => void;
}): React.ReactElement {
  const [state, setState] = useState<NativeState | null>(null);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Whether the list is parked at the bottom. Only then does new output
   *  scroll it: yanking someone back down while they are reading a tool result
   *  further up is the single worst thing a chat log can do. */
  const atBottom = useRef(true);

  useEffect(() => {
    // Open, then subscribe. The server answers with `init`, which carries the
    // conversation the TUI was having — read from its transcript, so switching
    // views shows the work already done rather than an empty window.
    sharedWs.send({ type: 'native_open', session_id: sessionId });
    const off = sharedWs.subscribeGlobal((msg: Record<string, unknown>) => {
      if (msg.type === '__ws_open__') {
        // The backend restarted or the socket dropped. Re-open — the agent
        // never went anywhere, only the reader did.
        sharedWs.send({ type: 'native_open', session_id: sessionId });
        return;
      }
      if (msg.type !== 'native_event' || msg.session_id !== sessionId) return;
      const ev = msg.event as NativeEvent;
      const end = perf.span('native:event');
      setState(prev => {
        switch (ev.type) {
          case 'init': return ev.state;
          case 'message': {
            if (!prev) return prev;
            const i = prev.messages.findIndex(m => m.id === ev.message.id);
            const messages = i >= 0
              ? prev.messages.map((m, j) => (j === i ? ev.message : m))
              : [...prev.messages, ev.message];
            return { ...prev, messages };
          }
          // The transcript underneath was replaced — a `/clear`, or a resumed
          // session writing a new file. Take the new one wholesale rather than
          // appending to a conversation that no longer exists.
          case 'reset':
            return prev ? { ...prev, messages: ev.messages, transcriptPath: ev.transcriptPath } : prev;
          default: return prev;
        }
      });
      end();
    });
    return () => {
      off();
      // Stops the reader. The agent is the pane's and is untouched by this.
      sharedWs.send({ type: 'native_close', session_id: sessionId });
    };
  }, [sessionId]);

  // Follow the tail, but only while the reader is already there.
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  /**
   * What you just sent, shown before the agent has written it down.
   *
   * The conversation is the transcript, and the transcript only gets your
   * message once the TUI has taken it and the agent has flushed the row —
   * measured at about three seconds. For three seconds the composer emptied
   * and *nothing happened*, which reads as a dropped message, so people send
   * it again. So the message goes on screen immediately and is dropped the
   * moment the real row for it arrives: the echo is a placeholder for a row we
   * know is coming, never a second copy of it.
   *
   * Matched on the text rather than an id, because the id is Claude Code's and
   * we will not know it until the row lands. Keyed by the exact string, which
   * is what the TUI was handed.
   */
  const [pending, setPending] = useState<NativeMessage[]>([]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    sharedWs.send({ type: 'native_send', session_id: sessionId, text });
    setPending(p => [...p, { id: `pending-${Date.now()}`, kind: 'user', text, at: Date.now() }]);
    setDraft('');
    atBottom.current = true;
  }, [draft, sessionId]);

  // Drop an echo as soon as the real row for it is in the conversation.
  useEffect(() => {
    if (!pending.length || !state) return;
    const real = new Set(state.messages.filter(m => m.kind === 'user').map(m => (m as { text: string }).text.trim()));
    setPending(p => {
      const next = p.filter(m => !real.has((m as { text: string }).text.trim()));
      return next.length === p.length ? p : next;
    });
  }, [state?.messages, pending.length]);

  const shown = useMemo(
    () => (pending.length && state ? [...state.messages, ...pending] : state?.messages ?? []),
    [state?.messages, pending],
  );

  // Follow the tail, but only while the reader is already there — yanking
  // someone back down while they read a tool result further up is the worst
  // thing a chat log can do.
  useEffect(() => {
    if (!atBottom.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  /** The pane's own flags, read from the same place the sheep reads them.
   *  There is deliberately no second liveness mechanism here: whether the
   *  agent is working is something sheepit already knows, from the agent's
   *  hooks, and a view that worked it out again could disagree with the sheep
   *  on the card beside it. */
  const busy = useStore(s => !!s.sessionBusy[sessionId]);
  const bleating = useStore(s => !!s.sessionNeedsAttention[sessionId]);

  const slash = useSlashCommands(sessionId, draft);
  const [slashIdx, setSlashIdx] = useState(0);
  // The highlight follows the list, never outlives it: typing another letter
  // can shorten the matches under a cursor sitting past the end.
  useEffect(() => { setSlashIdx(0); }, [draft]);
  const pickSlash = useCallback((c: SlashCommand) => {
    // A trailing space, because most of these take an argument and the ones
    // that do not ignore it. It also closes the menu, which is keyed on the
    // draft having no space in it.
    setDraft(`/${c.name} `);
    inputRef.current?.focus();
  }, []);

  return (
    <div className="nat-pane">
      <div className="nat-list" ref={listRef} onScroll={onScroll}>
        {!state && <div className="nat-empty">Reading the conversation…</div>}
        {state && shown.length === 0 && (
          <div className="nat-empty">
            {state.transcriptPath
              ? 'Nothing in this conversation yet — ask it something.'
              : 'No conversation in this pane yet. Send a message to start one — or check the terminal, which may be holding a dialog this view cannot show.'}
          </div>
        )}
        {shown.map(m => <MessageBlock key={m.id} m={m} onOpenTerminal={onOpenTerminal} />)}
        {busy && <div className="nat-working"><span className="nat-tool-spin" /> working…</div>}

        {/* **The one thing this view cannot draw.** A permission prompt, the
            plan-mode accept, a `/resume` picker — none of them are in the
            transcript, because none of them are part of the conversation. The
            view does not guess at them: it notices the pane is blocked, which
            sheepit already knows from the agent's hooks, and hands over to the
            terminal. That is one click because the terminal never went away. */}
        {bleating && (
          <div className="nat-needs-tui">
            <SquareTerminal size={14} />
            <div>
              <strong>Waiting for you in the terminal.</strong>
              <div>Claude Code is asking something this view cannot show — a permission
                prompt or a dialog. Switch to the terminal to answer it.</div>
              <div className="nat-needs-tui-note">Not every dialog raises this: a first-run
                trust prompt fires no hook and writes nothing, so it shows as a pane that
                simply says nothing. The terminal is always one click away on the bar.</div>
            </div>
            {onOpenTerminal && (
              <button className="nat-needs-tui-btn" onClick={onOpenTerminal}>Open terminal</button>
            )}
          </div>
        )}
      </div>

      {/* Above the composer, not below it: the composer sits on the pane's
          bottom edge, so a menu under it would be off-screen. */}
      {slash.open && (
        <div className="nat-slash">
          {slash.matches.map((c, i) => (
            <button
              key={c.name}
              className={`nat-slash-row${i === slashIdx ? ' nat-slash-on' : ''}`}
              // mousedown, not click: a click would blur the textarea first and
              // the menu would be gone before the handler ran.
              onMouseDown={(e) => { e.preventDefault(); pickSlash(c); }}
              onMouseEnter={() => setSlashIdx(i)}
            >
              <span className="nat-slash-name">/{c.name}</span>
              {c.description && <span className="nat-slash-desc">{c.description}</span>}
              <span className={`nat-slash-src nat-slash-src-${c.source}`}>{c.source}</span>
            </button>
          ))}
          <div className="nat-slash-foot">↑↓ to choose · Tab or Enter to insert · anything else you type still goes through</div>
        </div>
      )}

      <div className="nat-compose">
        <textarea
          ref={inputRef}
          className="nat-input"
          value={draft}
          placeholder={busy ? 'Claude is working — type the next one…' : 'Message Claude Code…  (/ for its own commands)'}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            // Grow with the text, to a ceiling: a composer that can take the
            // whole pane leaves nowhere to read the answer.
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            // The completion menu takes the keys it needs, and only while it is
            // open — so Enter still sends the moment there is nothing to pick.
            if (slash.open) {
              if (e.key === 'ArrowDown') {
                e.preventDefault(); setSlashIdx(i => (i + 1) % slash.matches.length); e.stopPropagation(); return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault(); setSlashIdx(i => (i - 1 + slash.matches.length) % slash.matches.length); e.stopPropagation(); return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                const c = slash.matches[slashIdx];
                if (c) { e.preventDefault(); pickSlash(c); e.stopPropagation(); return; }
              }
              if (e.key === 'Escape') {
                // Closes the menu by making the draft no longer look like a
                // bare command, rather than by a second piece of state that
                // could disagree with it.
                e.preventDefault(); setDraft(d => d + ' '); e.stopPropagation(); return;
              }
            }
            // Enter sends, Shift+Enter is a newline — the same contract the
            // agent's own prompt box has, so muscle memory survives the switch.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            // Never let a keystroke here reach the app's global shortcuts.
            e.stopPropagation();
          }}
        />
        {busy ? (
          <button
            className="nat-send nat-stop-btn"
            title="Interrupt (Esc)"
            onClick={() => sharedWs.send({ type: 'native_interrupt', session_id: sessionId })}
          >
            <Square size={13} />
          </button>
        ) : (
          <button className="nat-send" title="Send (Enter)" onClick={submit} disabled={!draft.trim()}>
            <CornerDownLeft size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
