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
import { useEffect, useRef, useState, useCallback, useMemo, memo, createContext, useContext } from 'react';
import { Square, CornerDownLeft, ChevronRight, Wrench, AlertTriangle, Brain, SquareTerminal, ListChecks, ClipboardCheck, X, ChevronDown, Scissors, GitBranch, Search } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as sharedWs from '../sharedWs';
import useStore from '../store';
import { matchFilePaths } from '../utils';
import SheepIcon from './SheepIcon';
import { useSharedTick } from '../hooks/useSharedTick';
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

/* ── "Take me to that message" ─────────────────────────────────────────────
 * The Agent tab lists the prompts you wrote; clicking one should move the
 * conversation to it. The two panes are siblings inside one TerminalCell and
 * neither owns the other, so this is a tiny channel rather than a prop drilled
 * through both — the same shape the pane-mode preference uses above.
 *
 * Matched on the text, not on an id: the Agent tab reads the transcript
 * through `readAgentInfo` and the native view through its own reader, and
 * neither carries the other's identifiers. Both took the text from the same
 * row, so the text IS the identifier they share. */
const jumpListeners = new Set<(sessionId: string, text: string) => void>();

export function jumpToMessage(sessionId: string, text: string): void {
  for (const fn of jumpListeners) { try { fn(sessionId, text); } catch { /* ignore */ } }
}

export function subscribeJump(fn: (sessionId: string, text: string) => void): () => void {
  jumpListeners.add(fn);
  return () => { jumpListeners.delete(fn); };
}

export type NativeMessage =
  | { id: string; kind: 'user'; text: string; at: number }
  | { id: string; kind: 'command'; name: string; args: string; at: number }
  | { id: string; kind: 'assistant'; text: string; at: number }
  | { id: string; kind: 'thinking'; text: string; at: number }
  | { id: string; kind: 'tool'; at: number; name: string; input?: unknown; result?: string; isError?: boolean }
  | { id: string; kind: 'system'; text: string; at: number; level?: 'info' | 'error' }
  /** A compaction boundary — the summary the conversation restarted from. */
  | { id: string; kind: 'compact'; text: string; at: number };

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
    <div className={`nat-tool${m.isError ? ' nat-tool-error' : ''}${running ? ' nat-tool-running' : ''}`} data-mid={m.id}>
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
/**
 * Where a link in this view goes.
 *
 * **The same place a link in the terminal goes**, because it is the same pane
 * and the same intent — and the policy for that is already written once, in
 * `handleWebLink`: http(s) opens the pane's own browser, a GitHub pull request
 * or issue opens the pane's GitHub view, and a modifier-click or any other
 * scheme leaves for the real browser. Links here used to be plain
 * `target="_blank"`, which skipped all of it.
 *
 * Carried in a context rather than threaded through Markdown's renderer: it
 * has to reach an `<a>` that react-markdown builds, several layers below
 * components that are memoised on their text alone.
 */
const LinkHandler = createContext<((e: MouseEvent, url: string) => void) | null>(null);
/** Clicking a file path — the same Files panel the terminal opens. */
const FileHandler = createContext<((path: string) => void) | null>(null);

/**
 * Turn file paths in rendered Markdown into links.
 *
 * Claude Code colours paths in its own output and sheepit makes them clickable
 * there; in the conversation they were plain text, so the one thing you most
 * often want to open was the one thing you could not. This walks the rendered
 * tree and splits path matches out of text nodes.
 *
 * It uses `matchFilePaths`, the same rule the terminal's link provider uses —
 * tuned to keep prose out (`and/or`, `TCP/IP`) and to leave URLs to the web
 * link handler.
 *
 * Written as a small walk rather than a rehype plugin with a visitor
 * dependency: the tree is plain objects and this is the whole of it.
 */
function linkifyPaths(node: any, inside = false): void {
  if (!node || typeof node !== 'object') return;
  const tag = node.tagName;
  // Never inside a link (it is already one), and never inside a code block —
  // a diff or a log is full of path-shaped text that is content, not a target.
  const skip = inside || tag === 'a' || tag === 'pre';
  if (!Array.isArray(node.children)) return;
  if (!skip) {
    const next: any[] = [];
    for (const child of node.children) {
      if (child?.type !== 'text' || typeof child.value !== 'string') { next.push(child); continue; }
      const hits = matchFilePaths(child.value);
      if (!hits.length) { next.push(child); continue; }
      let at = 0;
      for (const h of hits) {
        if (h.index > at) next.push({ type: 'text', value: child.value.slice(at, h.index) });
        next.push({
          type: 'element',
          tagName: 'a',
          properties: { className: ['nat-path'], 'data-path': h.text, href: '#' },
          children: [{ type: 'text', value: h.text }],
        });
        at = h.index + h.text.length;
      }
      if (at < child.value.length) next.push({ type: 'text', value: child.value.slice(at) });
    }
    node.children = next;
  }
  for (const child of node.children) linkifyPaths(child, skip || tag === 'pre');
}

const rehypeFilePaths = () => (tree: any) => { linkifyPaths(tree); };

/** The pane's cwd, so a relative image path can be resolved to a file. */
const PaneCwd = createContext<string>('');

/**
 * The URL that shows this image, or null if it is not one.
 *
 * An agent names images constantly — a screenshot it just took, a diagram it
 * wrote, a failing visual test — and every one of them was a line of grey text
 * you had to go and open somewhere else. A path is a picture; show the picture.
 *
 * The extension test is written here rather than imported from `FileView`,
 * which exports the same list: that module pulls the syntax highlighter and
 * the lazy editor behind it, and importing one predicate from it would put all
 * of that in this chunk. Same reason `lang.ts` exists.
 */
function imageUrl(raw: string | undefined, cwd: string): string | null {
  if (!raw) return null;
  if (!/\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(?:[?#]|$)/i.test(raw)) return null;
  if (/^(?:https?:|data:)/i.test(raw)) return raw;
  // Any other scheme is something we should not be fetching into an <img>.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const abs = raw.startsWith('/') || raw.startsWith('~') ? raw : `${cwd}/${raw.replace(/^\.\//, '')}`;
  return `/api/fs/raw?path=${encodeURIComponent(abs)}`;
}

/** The picture itself. Bounded, because a 4000px screenshot is not a message,
 *  and it stays out of the way when the file has gone (`onError`). */
function Thumb({ src, alt, onOpen }: { src: string; alt?: string; onOpen?: () => void }) {
  const [dead, setDead] = useState(false);
  if (dead) return null;
  return (
    <img
      className="nat-img"
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      title={onOpen ? 'Open' : undefined}
      onClick={onOpen}
      onError={() => setDead(true)}
    />
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const onLink = useContext(LinkHandler);
  const onFile = useContext(FileHandler);
  const cwd = useContext(PaneCwd);
  return (
    <div className="nat-text md-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeFilePaths]}
        components={{
          code: ({ node: _n, className, children, ...p }) => {
            // Most paths an agent prints arrive in backticks, and those text
            // nodes are skipped above so the span keeps its own styling. A
            // span whose whole content is a path becomes the link instead.
            const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
            const hit = !className && matchFilePaths(raw);
            if (hit && hit.length === 1 && hit[0]!.text === raw.trim()) {
              return (
                <code
                  {...p}
                  className="nat-path nat-path-code"
                  onClick={() => onFile?.(raw.trim())}
                  title={`Open ${raw.trim()}`}
                >
                  {children}
                </code>
              );
            }
            return <code {...p} className={className}>{children}</code>;
          },
          // `![](…)` — a local path needs routing through the raw-file
          // endpoint, or the browser asks the *viewing* device for it.
          img: ({ node: _n, src, alt }) => {
            const u = imageUrl(typeof src === 'string' ? src : undefined, cwd);
            return u ? <Thumb src={u} alt={alt} /> : null;
          },
          a: ({ node: _n, href, ...p }) => {
            // A path put here by rehypeFilePaths, or an ordinary link's href.
            const target = (p as Record<string, unknown>)['data-path'] as string | undefined;
            const img = imageUrl(target ?? href, cwd);
            return (
              <>
                <a
                  {...p}
                  href={href}
                  // Kept on the anchor so the URL is in the status bar, and so a
                  // middle-click or "copy link" still behaves — only the plain
                  // left click is taken.
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    if (e.button !== 0) return;
                    // A path, not a URL — opens the Files panel, as in the terminal.
                    const path = (e.currentTarget as HTMLAnchorElement).dataset.path;
                    if (path) { e.preventDefault(); onFile?.(path); return; }
                    if (!href || !onLink) return;
                    e.preventDefault();
                    onLink(e.nativeEvent, href);
                  }}
                />
                {/* The link stays — it is how you open the file, and it is what
                    the sentence around it reads as. The picture goes under it. */}
                {img && (
                  <Thumb
                    src={img}
                    alt={target ?? href}
                    onOpen={target && onFile
                      ? () => onFile(target)
                      : href && onLink
                        ? () => onLink(new MouseEvent('click'), href)
                        : undefined}
                  />
                )}
              </>
            );
          },
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
    <div className={`nat-choice${answered ? ' nat-choice-answered' : ''}`} data-mid={m.id}>
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

/** How long a local echo may wait for its real transcript row. Measured at
 *  about three seconds in practice, so this is an order of magnitude of
 *  headroom — it is a deadline for a placeholder, not a timeout anybody
 *  should reach. See the dedup effect in NativePane. */
const ECHO_TTL_MS = 60_000;

/**
 * What you asked, clamped to three lines.
 *
 * A prompt can be a paragraph or a pasted essay, and a long one pushes the
 * answer off the screen — while the first line is nearly always enough to
 * recognise which question it was. The clamp is CSS, so opening it is free and
 * nothing is lost from the text itself.
 *
 * **Only a bubble that is actually cut off says it can be opened.** Measuring
 * is the only way to know: a three-line message and a thirty-line one are the
 * same markup, and offering "more" on something already whole is a button that
 * does nothing.
 */
/**
 * The images a message of yours names.
 *
 * Attaching a picture types its path into the pane, so what came back in the
 * conversation was the path as grey text — you could see that you had sent
 * *something* and not what. Both shapes are taken:
 *
 *  - a bare path, by the same rule the output uses (`matchFilePaths`);
 *  - a **quoted** one, which is the shape a path with spaces arrives in —
 *    `"…/Screenshot 2026-10-07 at 15.11.49.png"` is exactly what a macOS
 *    screenshot is called, and the bare-path rule stops at the first space.
 *    Quotes make it unambiguous, so there is nothing to guess.
 */
function imagesIn(text: string, cwd: string): string[] {
  const out: string[] = [];
  for (const h of matchFilePaths(text)) {
    const u = imageUrl(h.text, cwd);
    if (u) out.push(u);
  }
  for (const m of text.matchAll(/["']([^"'\n]*\/[^"'\n]+)["']/g)) {
    const u = imageUrl(m[1], cwd);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Your own message, with its URLs and paths made clickable — and nothing else
 * touched.
 *
 * **It is still not Markdown.** What you typed is what you typed: a `*` is an
 * asterisk and a `#` is a hash, and re-interpreting the prompt would show you
 * something you did not write. But a link is not formatting, it is a thing
 * you named, and in a view where every link in the agent's half opens — in
 * the built-in browser, or the Files panel — the one place they stayed dead
 * was the half you wrote. "Check https://…" is the commonest kind of message
 * there is here.
 *
 * Both rules are the ones already in use: `matchFilePaths` for paths (the
 * same definition the terminal's link provider uses) and a plain http(s) run
 * for URLs. Paths and URLs cannot collide — `matchFilePaths` skips anything
 * containing `://`.
 */
function Linkified({ text }: { text: string }): React.ReactElement {
  const onLink = useContext(LinkHandler);
  const onFile = useContext(FileHandler);

  const parts = useMemo(() => {
    type Hit = { text: string; index: number; kind: 'url' | 'path' };
    const hits: Hit[] = [];
    // Trailing punctuation belongs to the sentence, not to the URL: "see
    // https://x.dev." should not open a page whose address ends in a stop.
    for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      hits.push({ text: m[0].replace(/[.,;:!?]+$/, ''), index: m.index, kind: 'url' });
    }
    for (const h of matchFilePaths(text)) {
      // **A slash command is not a path.** `/clear`, `/goals`, `/compact` all
      // pass the path rule — one slash and a word — and in a message somebody
      // typed that is overwhelmingly what they are. A real path worth opening
      // has a second segment or an extension, so requiring one of those keeps
      // `/tmp/x.png`, `./a`, `~/b` and `src/a.ts` and drops the commands. The
      // shared rule is left alone: in the terminal and in the agent's output
      // a bare `/usr` really is a directory.
      const bare = /^\/[\w.-]+$/.test(h.text) && !h.text.slice(1).includes('.');
      if (!bare) hits.push({ ...h, kind: 'path' });
    }
    hits.sort((a, b) => a.index - b.index);

    const out: (string | Hit)[] = [];
    let at = 0;
    for (const h of hits) {
      if (h.index < at) continue;   // overlapping, keep the first
      if (h.index > at) out.push(text.slice(at, h.index));
      out.push(h);
      at = h.index + h.text.length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }, [text]);

  return (
    <>
      {parts.map((p, i) => typeof p === 'string' ? p : (
        <a
          key={i}
          className={p.kind === 'path' ? 'nat-path' : undefined}
          href={p.kind === 'url' ? p.text : undefined}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            if (e.button !== 0) return;
            // The bubble itself toggles the clamp on click; a link means the
            // link, not "show more".
            e.stopPropagation();
            if (p.kind === 'path') { e.preventDefault(); onFile?.(p.text); return; }
            if (!onLink) return;
            e.preventDefault();
            onLink(e.nativeEvent, p.text);
          }}
        >{p.text}</a>
      ))}
    </>
  );
}

const UserBubble = memo(function UserBubble({ text }: { text: string }) {
  const cwd = useContext(PaneCwd);
  const images = useMemo(() => imagesIn(text, cwd), [text, cwd]);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 2);
    measure();
    // The pane resizes, and a reflow can turn four lines into three.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);

  const toggleable = clamped || open;
  return (
    <div
      className={`nat-bubble${toggleable ? ' nat-bubble-toggleable' : ''}`}
      onClick={() => { if (toggleable) setOpen(o => !o); }}
    >
      {/* The clamp and its fade live on the TEXT, not on the bubble: as one
          element the "show more" control was inside the clamped box and got
          cut off with the line it was advertising. */}
      <div ref={ref} className={`nat-bubble-body${open ? '' : ' nat-bubble-clamped'}`}><Linkified text={text} /></div>
      {toggleable && (
        <button className="nat-bubble-toggle" onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}>
          {open ? 'show less' : 'show more'}
        </button>
      )}
      {/* Outside the clamp: what you sent is the point of the message, and a
          three-line clamp would have hidden it along with the fourth line. */}
      {images.map(src => <Thumb key={src} src={src} />)}
    </div>
  );
});

/**
 * `3 mins ago` — written out rather than the sidebar's `3m`.
 *
 * The pen card is a dense list where every character is paid for forty times
 * over, so it abbreviates. This is one line at the end of a paragraph, read
 * once, and "3 mins ago" is what a person says.
 */
function agoOf(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * When a message landed, as a relative time that stays true.
 *
 * **Its own component, because it is the only thing the clock changes.** A
 * tick on the message would re-render the Markdown of every reply in the
 * conversation every few seconds to move one word — the mistake `PaneAge`
 * exists to avoid in the sidebar, at a larger scale here. `useSharedTick` is
 * one interval for every one of these, however many are mounted.
 *
 * The exact time is on the title, so the precise answer is a hover away
 * without spending a line on it.
 */
function When({ at, tookMs }: { at: number; tookMs?: number }) {
  // The hook is a re-render trigger, not a clock — it returns 0. The time is
  // read here, on each render it causes.
  useSharedTick(15_000);
  const now = Date.now();
  return (
    <time
      className="nat-when"
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
    >
      {agoOf(at, now)}
      {tookMs !== undefined && ` · took ${tookOf(tookMs)}`}
    </time>
  );
}

/** `451k`, the way every other count in sheepit is written. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** `2m 28s`, the way the terminal writes a turn's length. */
function tookOf(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * What a message is searched over.
 *
 * Everything the pane holds, not only the prose: the point of finding
 * something in a conversation is usually "which command did I run", "what did
 * that file say", "where did it edit this" — and all three live in tool calls.
 * A tool's result is in here too, which is the half the terminal's own
 * scrollback has and ⌘K does not.
 */
function searchText(m: NativeMessage): string {
  switch (m.kind) {
    case 'command': return `${m.name} ${m.args}`;
    case 'tool': return `${m.name} ${typeof m.input === 'string' ? m.input : JSON.stringify(m.input ?? '')} ${m.result ?? ''}`;
    default: return m.text;
  }
}

const MessageBlock = memo(function MessageBlock({ m, onOpenTerminal, tookMs }: {
  m: NativeMessage;
  onOpenTerminal?: () => void;
  /** Set on the message that ENDS a turn — how long the turn ran. */
  tookMs?: number;
}) {
  switch (m.kind) {
    case 'user':
      return <div className="nat-msg nat-user" data-mid={m.id} data-user-text={m.text}><UserBubble text={m.text} /></div>;
    case 'command':
      // The command, not its expansion — a skill's body is thousands of words
      // the agent received and you did not write.
      return (
        <div className="nat-cmd" data-mid={m.id}>
          <span className="nat-cmd-name">{m.name}</span>
          {m.args && <span className="nat-cmd-args">{m.args}</span>}
        </div>
      );
    case 'assistant':
      return (
        <div className="nat-msg nat-assistant" data-mid={m.id}>
          <Markdown text={m.text} />
          {/* When it was said. The terminal ends a turn with "done 10:23 AM"
              and that is genuinely useful — it is how you tell a reply that
              just landed from one you read twenty minutes ago. Quiet, at the
              end, so it never competes with the answer. */}
          <When at={m.at} tookMs={tookMs} />
        </div>
      );
    case 'thinking':
      return (
        <details className="nat-think" data-mid={m.id}>
          <summary><Brain size={11} /> thinking</summary>
          <div className="nat-text nat-think-body">{m.text}</div>
        </details>
      );
    case 'tool':
      return CHOICE_TOOLS.has(m.name)
        ? <ChoiceBlock m={m} onOpenTerminal={onOpenTerminal} />
        : <ToolBlock m={m} />;
    case 'compact':
      // The boundary the conversation restarted from, closed. The summary is
      // real content — it is what the agent is working from now — but it is
      // not a turn, so it does not get a bubble.
      return (
        <details className="nat-compact" data-mid={m.id}>
          <summary><Scissors size={11} /> Context compacted</summary>
          {/* The summary is Markdown the agent wrote — headings and lists,
              not a wall of asterisks. Same renderer as a reply. */}
          <div className="nat-compact-body"><Markdown text={m.text} /></div>
        </details>
      );
    case 'system':
      return <div className={`nat-system${m.level === 'error' ? ' nat-system-error' : ''}`} data-mid={m.id}>{m.text}</div>;
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
  // Fetched the first time a slash appears anywhere in the box.
  const wantList = /(^|\s)\//.test(draft);
  useEffect(() => {
    if (!wantList || all) return;
    let gone = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`)
      .then(r => r.json())
      .then(d => { if (!gone) setAll(d.commands ?? []); })
      .catch(() => { if (!gone) setAll([]); });
    return () => { gone = true; };
  }, [wantList, all, sessionId]);

  // **The token the cursor is in**, not the whole box. `/` only opens the menu
  // at the start of a word — so "run /ponytail" offers it and "src/components"
  // does not, which is the distinction that matters: a slash after a letter is
  // a path, a slash after a space is a command.
  const token = (() => {
    const m = draft.match(/(^|\s)(\/[^\s]*)$/);
    return m ? m[2]! : null;
  })();
  const open = token !== null;
  const query = open ? token.slice(1).toLowerCase() : '';
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

  return { open: open && matches.length > 0, matches, loading: open && !all, token };
}

export default function NativePane({ sessionId, onOpenTerminal, onOpenLink, onOpenFile, isActive }: {
  sessionId: string;
  /** Flip the pane back to the TUI — for the dialogs this view cannot draw. */
  onOpenTerminal?: () => void;
  /** The pane's own link policy — see LinkHandler. */
  onOpenLink?: (e: MouseEvent, url: string) => void;
  /** Clicking a file path — the Files panel, as in the terminal. */
  onOpenFile?: (path: string) => void;
  /** This is the pane on screen. Every sheep in a pen stays mounted, so
   *  without it a hidden pane would take the keyboard from the visible one. */
  isActive?: boolean;
}): React.ReactElement {
  const [state, setState] = useState<NativeState | null>(null);
  /**
   * **A half-typed message survives a reload.**
   *
   * In the terminal it already does, by construction: the characters are in
   * the agent's own input box, on the far side of a PTY, so the browser
   * reloading cannot touch them. Here the draft is React state, and in dev
   * the app reloads itself every time a file is saved — so a message you were
   * part way through was simply gone.
   *
   * Device-local, per pane, and read synchronously at mount so there is never
   * a frame with an empty box. It is **not** a preference: the profile is
   * shared by every browser looking at this machine (see "One key per pen"),
   * and a half-written sentence is nobody else's business — nor is it worth a
   * PATCH per keystroke. `isPreferenceKey` excludes the prefix for exactly
   * that reason.
   */
  const draftKey = `sheepit:draft:${sessionId}`;
  const [draft, setDraft] = useState(() => {
    try { return localStorage.getItem(draftKey) ?? ''; } catch { return ''; }
  });
  useEffect(() => {
    try {
      if (draft) localStorage.setItem(draftKey, draft);
      else localStorage.removeItem(draftKey);
    } catch { /* private window, or full — the draft is a convenience */ }
  }, [draft, draftKey]);
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
  /** Mirrors `atBottom` into state, because the button has to re-render and a
   *  ref does not. The ref stays the source of truth for the scroll-follow,
   *  which runs on every message and must not depend on React having caught
   *  up. */
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  /**
   * Which of your messages is above the top edge right now.
   *
   * A **binary search**, not a walk: the nodes are in document order so their
   * tops increase, and a conversation can hold hundreds of them while this
   * runs on every scroll event. Seven rect reads instead of three hundred.
   *
   * Rects rather than `offsetTop`, which is relative to the offset parent and
   * would be measuring against the wrong box the moment anything between the
   * message and the scroller grows a `position`.
   */
  const syncSticky = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const nodes = el.querySelectorAll<HTMLElement>('.nat-msg.nat-user');
    const top = el.getBoundingClientRect().top;
    let lo = 0, hi = nodes.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      // Gone past means its *bottom* is above the edge — a question half on
      // screen is still on screen, and naming it in the bar as well would be
      // the same sentence twice.
      if (nodes[mid]!.getBoundingClientRect().bottom <= top + 1) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const node = found >= 0 ? nodes[found] : null;
    const text = node?.dataset.userText ?? null;
    setSticky(prev => (prev?.text === text ? prev : text ? { text, top: node!.offsetTop } : null));
  }, []);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottom.current = near;
    setAwayFromBottom(!near);
    syncSticky();
  }, [syncSticky]);

  /**
   * **Arriving at a pane puts the cursor in the box.**
   *
   * The terminal focuses itself when a pane becomes the one on screen, and the
   * conversation should behave the same way — switching to a pane is almost
   * always a prelude to typing in it, and having to click the composer first
   * is a step that exists for no reason.
   *
   * Gated on `isActive` because every sheep in a pen stays mounted: without
   * it, a pane you cannot see would take the keyboard from the one you can.
   * It deliberately does not fire on every render, only when this pane becomes
   * the active one — stealing focus back while somebody is typing somewhere
   * else is worse than never taking it.
   */
  useEffect(() => {
    if (!isActive) return;
    // After the switch has laid out, or focus lands on an element about to move.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isActive, sessionId]);

  /**
   * **Clicking anywhere in the conversation puts the cursor back in the box.**
   *
   * Reading and typing are the same activity here — you click a message to
   * look at it and then you want to answer it, and the box is where every
   * keystroke was always going to end up. A terminal does this by construction
   * (there is nowhere else for a key to go); this view had a dozen places to
   * leave the focus, and every one of them cost a second click.
   *
   * Two things it must not take:
   *
   *  - **A selection.** Dragging across text ends in a click, and focusing a
   *    textarea collapses whatever was selected — so copying a path out of a
   *    reply would have cleared it the instant the mouse came up.
   *  - **A control.** A link, a tool row's disclosure, an image, the "show
   *    more" on a clamped message — those clicks mean the thing they landed
   *    on. Focusing afterwards is harmless for most of them, but `summary`
   *    and the buttons take focus themselves, and fighting them would move
   *    the ring somewhere the keyboard did not ask for.
   */
  const focusInput = useCallback((e: React.MouseEvent) => {
    if (window.getSelection()?.toString()) return;
    if ((e.target as HTMLElement).closest('a, button, summary, input, textarea, img, label')) return;
    // preventScroll: the list is often scrolled far from the composer, and
    // taking focus must not drag the conversation anywhere.
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const toBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    atBottom.current = true;
    setAwayFromBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
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

  /**
   * Images pasted or dropped onto the conversation.
   *
   * The terminal has handled this for a long time — upload into the pane's cwd
   * and type the path, because a path is what an agent can actually open — but
   * the composer is a plain textarea and silently dropped them, so a pasted
   * screenshot went nowhere with no sign it had.
   *
   * They are kept as *attachments* rather than pasted into the text as a path,
   * because the path is not what you want to read back: a thumbnail says what
   * you attached and a 90-character temp path does not. The paths are appended
   * to the message when it is sent, which is the form the agent needs.
   */
  const [attached, setAttached] = useState<{ path: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(0);
  /** An upload that did not land. Silence here reads as "the app ignored me",
   *  which is what it did: the old code swallowed every failure. */
  const [attachError, setAttachError] = useState<string | null>(null);
  /** Something is being dragged over the pane. */
  const [dropping, setDropping] = useState(false);

  const attach = useCallback(async (files: { blob: Blob; name: string }[]) => {
    if (!files.length) return;
    setUploading(n => n + files.length);
    const cwd = useStore.getState().sessionMap[sessionId]?.path || '/tmp';
    for (const { blob, name } of files) {
      try {
        const res = await fetch(
          `/api/fs/upload?dir=${encodeURIComponent(cwd)}&name=${encodeURIComponent(name)}`,
          { method: 'POST', body: blob },
        );
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok && body.path) {
          setAttached(a => [...a, { path: body.path, name }]);
          setAttachError(null);
        } else {
          // **Say so.** This used to be swallowed, so a screenshot that failed
          // to upload and one that was never picked up looked identical — and
          // both looked like the app ignoring you.
          setAttachError(`${name}: ${body.error ?? `upload failed (${res.status})`}`);
        }
      } catch (e) {
        setAttachError(`${name}: ${e instanceof Error ? e.message : 'upload failed'}`);
      }
      setUploading(n => n - 1);
    }
  }, [sessionId]);

  /** Both routes in, named the way the terminal names them so two screenshots
   *  pasted a second apart cannot overwrite each other. */
  const takeFiles = useCallback((files: File[]) => {
    const images = files.filter(f => f.type.startsWith('image/'));
    const rest = files.filter(f => !f.type.startsWith('image/'));
    const stamp = Date.now();
    void attach([
      ...images.map((f, i) => ({
        blob: f,
        name: f.name && f.name !== 'image.png'
          ? f.name
          : `pasted-${stamp}${images.length > 1 ? `-${i + 1}` : ''}.${(f.type.split('/')[1] || 'png')}`,
      })),
      ...rest.map(f => ({ blob: f, name: f.name })),
    ]);
  }, [attach]);

  /** The agent is sitting on a dialog only the terminal can draw. Its own
   *  report, through its hooks — see `agentWaiting` on the session. */
  const blocked = useStore(s => !!s.sessionMap[sessionId]?.agentWaiting);

  const submit = useCallback(() => {
    /**
     * **Nothing is typed into a pane that is holding a dialog.**
     *
     * A permission prompt is a *selector*: the keys it reads are arrows and
     * Enter, and the highlighted row is usually "1. Yes". So sending a
     * message into one did not merely fail to send — the Enter that follows
     * it picked whatever was highlighted, which is to say it could approve a
     * command the person never saw. The text went nowhere and the answer went
     * somewhere.
     *
     * `agentWaiting` is the agent's own report through its hooks (and, since
     * the subagent fix, one that a tool ping cannot erase). Deliberately not
     * the client's `sessionNeedsAttention`, which also means "finished while
     * you were elsewhere" — blocking on that would lock the composer of any
     * pane you came back to, with no way to type the thing that unlocks it.
     */
    if (blocked) return;
    const body = draft.trim();
    // The paths go with the message, because a path is what the agent can
    // open. An attachment with no words is a legitimate message — "look at
    // this" — so an empty draft with something attached still sends.
    const text = [body, ...attached.map(a => a.path)].filter(Boolean).join('\n');
    if (!text) return;
    sharedWs.send({ type: 'native_send', session_id: sessionId, text });
    setAttached([]);
    setPending(p => [...p, { id: `pending-${Date.now()}`, kind: 'user', text, at: Date.now() }]);
    setDraft('');
    atBottom.current = true;
  }, [draft, attached, sessionId, blocked]);

  /**
   * Drop an echo once the real row for it is in the conversation — **or once
   * it is too old to still be waiting for one.**
   *
   * The echo exists to cover the ~3 seconds between the TUI taking a message
   * and the agent flushing the row, and it was dropped by matching the text
   * exactly. That is right when it works and unbounded when it does not: any
   * message Claude Code records in a form we did not send — a path it expands,
   * an attachment it folds into content blocks, whitespace it normalises —
   * strands the echo for the rest of the session, and the message is on screen
   * **twice**, which is exactly how it was reported.
   *
   * So the match is now a floor, not the only exit. Two changes:
   *
   *  - **The first line is enough.** The paths of attachments are appended to
   *    what you typed, and those are the lines most likely to come back
   *    changed; the words you wrote do not.
   *  - **An echo expires.** `ECHO_TTL_MS` is many times the three seconds this
   *    is covering, so it cannot fire on a slow flush — and if it ever does,
   *    the message blinks out and arrives from the transcript a moment later,
   *    which is strictly better than standing there twice for ever. The
   *    transcript is the source of truth; the echo is a placeholder, and a
   *    placeholder with no deadline is a second copy.
   */
  useEffect(() => {
    if (!pending.length || !state) return;
    const firstLine = (t: string) => t.trim().split('\n', 1)[0]!.trim();
    const real = new Set(
      state.messages.filter(m => m.kind === 'user').map(m => firstLine((m as { text: string }).text)),
    );
    const now = Date.now();
    setPending(p => {
      const next = p.filter(m =>
        !real.has(firstLine((m as { text: string }).text)) && now - m.at < ECHO_TTL_MS);
      return next.length === p.length ? p : next;
    });
  }, [state?.messages, pending.length]);

  // An echo that outlived its deadline while nothing else re-rendered — the
  // effect above only runs when a message arrives or one is sent, and a lone
  // stuck echo is precisely the case where neither happens.
  useEffect(() => {
    if (!pending.length) return;
    const t = setTimeout(() => setPending(p => p.filter(m => Date.now() - m.at < ECHO_TTL_MS)), ECHO_TTL_MS);
    return () => clearTimeout(t);
  }, [pending]);

  /**
   * **The question you are currently reading the answer to.**
   *
   * A turn can run for minutes and produce pages of tool calls, so by the time
   * the answer arrives the question has scrolled away and you are reading a
   * reply without the thing it is replying to. The bar puts it back — and as
   * you scroll up through the history it follows, always naming the last
   * message of yours that has gone off the top. That makes it a section
   * header for wherever you happen to be standing, which is the whole of what
   * it is for; pinned to the newest question it was only ever right at the
   * bottom of the conversation.
   *
   * It is empty at the very top, where nothing has scrolled past yet: a bar
   * that is always present is one you stop reading.
   */
  const [sticky, setSticky] = useState<{ text: string; top: number } | null>(null);

  const shown = useMemo(
    () => (pending.length && state ? [...state.messages, ...pending] : state?.messages ?? []),
    [state?.messages, pending],
  );

  /**
   * **Find in this conversation.** Not ⌘K, which asks a different question —
   * *which sheep is working on this* — across every pane, from the server,
   * over ripgrep. This one is "where in the pane I am reading did that
   * happen", it is answered from the messages already in memory, and it
   * matches tool calls and their results as well as the prose.
   *
   * Nothing is fetched and nothing is parsed: every message this view can
   * show is already rendered (there is no windowing), so the match is a
   * substring over an array and the jump is a `scrollIntoView` on the element
   * carrying that message's id.
   */
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [hitIdx, setHitIdx] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as string[];
    return shown.filter(m => searchText(m).toLowerCase().includes(q)).map(m => m.id);
  }, [shown, query]);

  // Typing narrows, so the cursor goes back to the first match rather than
  // sitting past the end of a shorter list.
  useEffect(() => { setHitIdx(0); }, [query]);

  /** Scroll to one match and mark it. Centred, because a message is read with
   *  what surrounds it, and marked rather than flashed — with a list of hits
   *  you want to see which one you are standing on. */
  const goToHit = useCallback((i: number) => {
    const id = hits[i];
    const list = listRef.current;
    if (!id || !list) return;
    for (const el of Array.from(list.querySelectorAll('.nat-found'))) el.classList.remove('nat-found');
    const el = list.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
    if (!el) return;
    atBottom.current = false;   // we are deliberately not at the tail now
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('nat-found');
  }, [hits]);

  // The first match is shown as soon as there is one, so typing walks the
  // conversation rather than needing an Enter to start it.
  useEffect(() => { if (finding && hits.length) goToHit(hitIdx); }, [finding, hits, hitIdx, goToHit]);

  const step = useCallback((d: 1 | -1) => {
    if (!hits.length) return;
    setHitIdx(i => (i + d + hits.length) % hits.length);
  }, [hits.length]);

  const closeFind = useCallback(() => {
    setFinding(false);
    setQuery('');
    for (const el of Array.from(listRef.current?.querySelectorAll('.nat-found') ?? [])) el.classList.remove('nat-found');
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  /** ⌘F opens it, wherever the focus is in this pane — the composer holds it
   *  nearly always, so a listener on the field alone would be the only one
   *  that ever fired, and one on the window has to be gated on this being the
   *  pane on screen or every mounted pane would answer at once. */
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'f') return;
      e.preventDefault();
      setFinding(true);
      requestAnimationFrame(() => findRef.current?.select());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  /**
   * How long each turn ran, keyed on the message that ends it.
   *
   * The terminal closes a turn with "Sautéed for 2m 28s", and that number is
   * the first thing you want when you come back to a pane — it says whether
   * the thing you asked for was a moment's work or a long one. It is not in
   * the transcript as a field, but every row is stamped, so it is the distance
   * from the prompt to the last thing said in answer to it.
   */
  const turnTook = useMemo(() => {
    const out = new Map<string, number>();
    let askedAt: number | null = null;
    for (let i = 0; i < shown.length; i++) {
      const m = shown[i]!;
      if (m.kind === 'user') { askedAt = m.at; continue; }
      if (m.kind !== 'assistant' || askedAt === null) continue;
      // The last assistant message before the next prompt — or before the end.
      const next = shown.slice(i + 1).find(x => x.kind === 'user' || x.kind === 'assistant');
      if (next && next.kind === 'assistant') continue;
      out.set(m.id, Math.max(0, m.at - askedAt));
    }
    return out;
  }, [shown]);

  /**
   * **Empty means "nothing has been said", not "no rows".**
   *
   * A pane that has just been `/clear`ed holds exactly one row — the command
   * itself — so counting rows calls it a conversation and shows a lone pill
   * where the splash belongs. Commands and system notices are things that
   * happened *to* the pane; a conversation is what was said in it.
   */
  const hasConversation = useMemo(
    () => shown.some(m => m.kind === 'user' || m.kind === 'assistant' || m.kind === 'tool' || m.kind === 'thinking'),
    [shown],
  );

  /** The pane was emptied rather than never used — worth saying, because the
   *  two look identical and mean different things to whoever comes back. */
  const cleared = useMemo(
    () => !hasConversation && shown.some(m => m.kind === 'command' && m.name.startsWith('/clear')),
    [hasConversation, shown],
  );

  // The messages moved under a stationary viewport — new rows, an expanded
  // tool, a pane resize — so what is above the edge changed without anybody
  // scrolling.
  useEffect(() => { syncSticky(); }, [shown.length, syncSticky]);

  // Follow the tail, but only while the reader is already there — yanking
  // someone back down while they read a tool result further up is the worst
  // thing a chat log can do.
  useEffect(() => {
    if (!atBottom.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  /**
   * **Opening lands at the bottom, and stays there while the content settles.**
   *
   * Setting `scrollTop` once when the messages arrive is too early: the list is
   * mostly Markdown, and react-markdown's output reflows as it lays out, so the
   * scroll was computed against a height the list had not reached yet and
   * stopped short — which is why opening a pane put you part-way up a
   * conversation and you had to scroll down yourself.
   *
   * An observer on the content keeps it pinned for as long as the height is
   * still moving, and only while the reader has not scrolled away. It is one
   * observer per open pane, and it stops mattering the moment the layout is
   * stable.
   */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const pin = () => { if (atBottom.current) el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(pin);
    // The scroller's own box does not change; its contents do.
    for (const child of Array.from(el.children)) ro.observe(child);
    pin();
    return () => ro.disconnect();
  }, [shown.length]);

  /**
   * The Agent tab asked to be taken to a message. Find it by its text — see
   * `jumpToMessage` — scroll it into the middle rather than the top, because a
   * prompt is read with the answer that follows it, and flash it so "which
   * one" is answered without a permanent mark.
   */
  useEffect(() => subscribeJump((sid, text) => {
    if (sid !== sessionId) return;
    const el = listRef.current;
    if (!el) return;
    const want = text.trim();
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('.nat-msg.nat-user'));
    // The last match, not the first: the same question can be asked twice, and
    // the one you mean is almost always the most recent.
    const hit = nodes.reverse().find(n => (n.dataset.userText ?? '').trim() === want)
      ?? nodes.find(n => (n.dataset.userText ?? '').trim().startsWith(want.slice(0, 80)));
    if (!hit) return;
    atBottom.current = false;   // we are deliberately not at the tail now
    hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const bubble = hit.querySelector('.nat-bubble');
    if (bubble) {
      bubble.classList.remove('nat-jumped');
      void (bubble as HTMLElement).offsetWidth;   // restart the animation
      bubble.classList.add('nat-jumped');
    }
  }), [sessionId]);

  /** The pane's own flags, read from the same place the sheep reads them.
   *  There is deliberately no second liveness mechanism here: whether the
   *  agent is working is something sheepit already knows, from the agent's
   *  hooks, and a view that worked it out again could disagree with the sheep
   *  on the card beside it. */
  const busy = useStore(s => !!s.sessionBusy[sessionId]);
  const bleating = useStore(s => !!s.sessionNeedsAttention[sessionId]);

  /**
   * **Code here is set in the font you chose for the terminal.**
   *
   * The two halves of a pane are the same work, and a command in a tool row
   * rendering in one face while the same command in the terminal renders in
   * another is the kind of seam you notice without being able to name. It is
   * the same store value the xterm instance reads, so picking a font in
   * Appearance moves both at once with nothing to keep in step.
   *
   * **Prose is deliberately not monospaced.** This view exists because an
   * answer reads like a document, and 92 characters of monospace prose is a
   * worse document than the terminal it replaced. What takes the terminal's
   * font is what is actually code: tool rows, code blocks, inline spans.
   */
  /**
   * The pane's own status line: how full the context is, and which model.
   *
   * **The same source the Agent tab reads** — `/api/sessions/:id/agent`, which
   * is `readAgentInfo` over the transcript — so the two can never disagree
   * about a number. Those are the two facts you check before asking for
   * something big, and the TUI keeps them on screen the whole time.
   *
   * A percentage only when the agent records its window size. Claude Code
   * records none anywhere a transcript can be read from, so its panes show a
   * count: guessing 200k would report a real 1M session at 536k as 268% full —
   * wrong, and wrong in the alarming direction. See AgentContext.
   */
  const [status, setStatus] = useState<{ used?: number; limit?: number; model?: string } | null>(null);
  /**
   * The branch and the reference, read off the session object rather than
   * fetched. The sidebar and the pane bar already carry both — one poll on the
   * server feeds every reader — and each selector returns a primitive, so this
   * re-renders when the branch moves and not when anything else does.
   */
  const gitBranch = useStore(s => s.sessionMap[sessionId]?.gitBranch);
  const gitDirty = useStore(s => s.sessionMap[sessionId]?.gitDirty);
  const refs = useStore(s => s.sessionMap[sessionId]?.prRefs) as
    | { kind: 'pr' | 'issue'; num: number; url?: string; repo?: string }[]
    | undefined;
  // Most recently touched, not highest-numbered: a pane that has just checked
  // out #3672 is about #3672 whatever else it read. Same rule as the pane bar.
  const topRef = refs?.[0] ?? null;
  const topRefUrl = topRef
    ? topRef.url
      ?? (topRef.repo ? `https://github.com/${topRef.repo}/${topRef.kind === 'issue' ? 'issues' : 'pull'}/${topRef.num}` : null)
    : null;

  const terminalFont = useStore(s => s.terminalFontFamily);
  /** Its own size, not the terminal's — see DEFAULT_NATIVE_FONT_SIZE. */
  const nativeFontSize = useStore(s => s.nativeFontSize);

  // Re-read when the agent stops working, which is when the numbers moved.
  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/agent`);
        if (!r.ok || gone) return;
        const info = await r.json();
        if (gone) return;
        setStatus({ used: info?.context?.used, limit: info?.context?.limit, model: info?.model });
      } catch { /* the line simply does not draw */ }
    })();
    return () => { gone = true; };
  }, [sessionId, busy]);

  const slash = useSlashCommands(sessionId, draft);
  const [slashIdx, setSlashIdx] = useState(0);
  // The highlight follows the list, never outlives it: typing another letter
  // can shorten the matches under a cursor sitting past the end.
  useEffect(() => { setSlashIdx(0); }, [draft]);
  const pickSlash = useCallback((c: SlashCommand) => {
    // Replace the token being typed, wherever it is, rather than the whole
    // box — the menu opens mid-sentence now, so "ask it to run /pony" has to
    // complete to "ask it to run /ponytail " and keep the words before it.
    // The trailing space is what closes the menu and starts the argument.
    setDraft(d => d.replace(/(^|\s)(\/[^\s]*)$/, (_m, lead) => `${lead}/${c.name} `));
    inputRef.current?.focus();
  }, []);

  return (
    <LinkHandler.Provider value={onOpenLink ?? null}>
    <FileHandler.Provider value={onOpenFile ?? null}>
    <PaneCwd.Provider value={state?.cwd ?? ""}>
    <div
      className={`nat-pane${dropping ? ' nat-pane-dropping' : ''}`}
      /**
       * **A file dropped anywhere on the pane is attached.**
       *
       * This was on the composer, which is 51px of a 701px pane — measured.
       * So 93% of the place you are looking at silently swallowed the
       * screenshot you dragged onto it, which is the whole of "sometimes it
       * doesn't work": it depended on hitting a strip most people never aim
       * at. The terminal has always taken a drop anywhere in the pane.
       *
       * The outline is not decoration — without it a drop that lands is
       * indistinguishable from one that does not until the thumbnail appears.
       */
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer has actually left the pane: dragging across a
        // child fires dragleave for the child on the way past.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;
        e.preventDefault();
        takeFiles(files);
      }}
      style={{
        '--nat-code-family': terminalFont,
        '--nat-base': `${nativeFontSize}px`,
      } as React.CSSProperties}
    >
      {/* Pinned above the thread, not inside it: inside the scroller it would
          need `position: sticky` on a flex child that also has to scroll, and
          the list's own padding would show through behind it. */}
      {sticky && (
        <button
          className="nat-ask"
          title="Go to this message"
          onClick={() => {
            // The one the bar is naming, not the newest — the bar is a header
            // for where you are standing, so it has to take you back there.
            const list = listRef.current;
            const el = [...(list?.querySelectorAll<HTMLElement>('.nat-msg.nat-user') ?? [])]
              .find(n => n.offsetTop === sticky.top);
            if (el) { atBottom.current = false; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
          }}
        >
          <CornerDownLeft size={11} className="nat-ask-icon" />
          <span className="nat-ask-text">{sticky.text}</span>
        </button>
      )}

      {/* Above the thread, beside the sticky question, for the same reason:
          inside the scroller it would need to be sticky on a flex child that
          also scrolls, with the list's padding showing through behind it. */}
      {finding && (
        <div className="nat-find">
          <Search size={12} className="nat-find-icon" />
          <input
            ref={findRef}
            className="nat-find-input"
            value={query}
            autoFocus
            placeholder="Find in this conversation"
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
              // Enter walks the matches, Shift+Enter walks back — the contract
              // every find bar has, so nothing here has to be learned.
              else if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
              e.stopPropagation();
            }}
          />
          <span className="nat-find-count">
            {query.trim() ? (hits.length ? `${hitIdx + 1}/${hits.length}` : 'none') : ''}
          </span>
          <button className="nat-find-btn" title="Previous (Shift+Enter)" disabled={!hits.length} onClick={() => step(-1)}>
            <ChevronDown size={12} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button className="nat-find-btn" title="Next (Enter)" disabled={!hits.length} onClick={() => step(1)}>
            <ChevronDown size={12} />
          </button>
          <button className="nat-find-btn" title="Close (Esc)" onClick={closeFind}><X size={12} /></button>
        </div>
      )}

      <div className="nat-list" ref={listRef} onScroll={onScroll} onClick={focusInput}>
        {!state && <div className="nat-empty">Reading the conversation…</div>}
        {state && !hasConversation && (
          /* **An empty pen, not an empty box.** A blank panel with one grey
             sentence in it reads as something that failed to load. The mark is
             the app's own (SheepIcon — drawn, takes currentColor, no image to
             fetch, correct on a LAN with no internet route), and the line under
             it names the directory, because "which checkout am I about to talk
             to" is the one thing worth knowing before the first message. */
          <div className="nat-splash">
            <SheepIcon size={56} color="var(--primary)" className="nat-splash-mark" />
            <div className="nat-splash-line">Build something.</div>
            {state.cwd && <div className="nat-splash-where">{state.cwd.replace(/^\/Users\/[^/]+/, '~')}</div>}
            <div className="nat-splash-hint">
              {!state.transcriptPath
                ? 'Nothing has run here yet. Send a message to start, or check the terminal, which may be holding a dialog this view cannot show.'
                : cleared
                  ? 'Context cleared. It remembers nothing from before — / lists the commands and skills it has.'
                  : 'Ask it anything — / lists the commands and skills it has.'}
            </div>
          </div>
        )}
        {/* Nothing but a `/clear` is an empty pane, so the splash stands alone
            rather than under the command that emptied it. */}
        {hasConversation && shown.map(m => (
          <MessageBlock key={m.id} m={m} onOpenTerminal={onOpenTerminal} tookMs={turnTook.get(m.id)} />
        ))}
        {busy && <div className="nat-working"><span className="nat-tool-spin" /> working…</div>}

        {/* **The one thing this view cannot draw.** A permission prompt, the
            plan-mode accept, a `/resume` picker — none of them are in the
            transcript, because none of them are part of the conversation. The
            view does not guess at them: it notices the pane is blocked, which
            sheepit already knows from the agent's hooks, and hands over to the
            terminal. That is one click because the terminal never went away. */}
        {(bleating || blocked) && (
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

      {/* **Back to the tail.** Scrolling up stops the view following new
          output — which is right, and leaves you with no way back but a long
          drag. It appears only while you are away from the bottom, and says
          whether anything arrived while you were up there. */}
      {awayFromBottom && (
        <button className="nat-to-bottom" onClick={toBottom} title="Jump to the latest">
          <ChevronDown size={14} />
          {busy && <span className="nat-to-bottom-live" />}
        </button>
      )}

      {/* What you are about to send with the message. A thumbnail, because
          that is what says *which* screenshot; the path is what goes on the
          wire and is no use to read. */}
      {(attached.length > 0 || uploading > 0) && (
        <div className="nat-attach">
          {attached.map(a => (
            <div className="nat-attach-item" key={a.path} title={a.path}>
              <img src={`/api/fs/raw?path=${encodeURIComponent(a.path)}`} alt={a.name} />
              <button
                className="nat-attach-x"
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttached(list => list.filter(x => x.path !== a.path))}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          {uploading > 0 && <div className="nat-attach-item nat-attach-busy"><span className="nat-tool-spin" /></div>}
        </div>
      )}

      {attachError && (
        <button className="nat-attach-error" onClick={() => setAttachError(null)} title="Dismiss">
          <AlertTriangle size={12} /> {attachError}
        </button>
      )}

      {/* The status line, on the composer's top edge — where the TUI keeps it,
          and what you check before asking for something big. */}
      {(status?.used !== undefined || status?.model || gitBranch) && (
        <div className="nat-status">
          {status?.model && <span className="nat-status-model">{status.model}</span>}

          {/* **Clear is here because this is the line about the context.** It
              is the one thing you do *to* a context rather than with it, and
              the number beside it is what makes you want to. It types
              `/clear` into the pane, like everything else this view does —
              the agent clears its own session and the pane is renamed `-`
              until it titles itself again.

              It fires on the first click, by request. It did ask twice; the
              argument against that is simply that `/clear` typed in the
              terminal asks nothing either, and a button that needs two
              presses is a button you press twice every time to pay for the
              once you did not mean it. Nothing is destroyed that is not on
              disk: the transcript stays, and ⌘K still finds it. */}
          <button
            className="nat-status-clear"
            title="Clear this conversation — the agent starts fresh in the same pane"
            onClick={() => sharedWs.send({ type: 'native_send', session_id: sessionId, text: '/clear' })}
          >
            Clear
          </button>

          <button
            className="nat-status-clear"
            title="Find in this conversation (⌘F)"
            onClick={() => { setFinding(true); requestAnimationFrame(() => findRef.current?.select()); }}
          >
            <Search size={10} />
          </button>

          {/* Which checkout this pane is standing in, and what it is about.
              Both come off the session object the sidebar already reads — no
              second poll, and no second opinion about the branch. The pane bar
              says the same two things above the terminal; in this view there
              is no pane bar in sight once you have scrolled, and these are
              exactly the facts you want before you ask for a commit. */}
          {gitBranch && (
            <span className={`nat-status-branch${gitDirty ? ' nat-status-dirty' : ''}`} title={gitDirty ? `${gitBranch} — uncommitted changes` : gitBranch}>
              <GitBranch size={10} />{gitBranch}
            </span>
          )}
          {topRef && (
            <a
              className="nat-status-pr"
              href={topRefUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              title={`${topRef.kind === 'issue' ? 'Issue' : 'Pull request'} #${topRef.num}`}
              onClick={(e) => {
                if (e.button !== 0 || !topRefUrl || !onOpenLink) return;
                e.preventDefault();
                onOpenLink(e.nativeEvent, topRefUrl);
              }}
            >#{topRef.num}</a>
          )}

          {status?.used !== undefined && (
            <span
              className="nat-status-ctx"
              title={status.limit
                ? `${status.used.toLocaleString()} of ${status.limit.toLocaleString()} tokens`
                : `${status.used.toLocaleString()} tokens — this agent does not record its window size`}
            >
              {/* Remaining, not used: "how much room is left" is the question
                  asked before a big request. A count when the agent does not
                  record its window — see AgentContext.limit. */}
              {status.limit
                ? `${Math.max(0, 100 - Math.round((status.used / status.limit) * 100))}% context left`
                : `${fmtTokens(status.used)} context`}
            </span>
          )}
        </div>
      )}

      <div className="nat-compose">
        <textarea
          ref={inputRef}
          className="nat-input"
          value={draft}
          disabled={blocked}
          placeholder={
            // Says what to do about it, not just that it will not take one:
            // the terminal is where the dialog is, and it is one click away.
            blocked ? 'Answer the prompt in the terminal first…'
              : busy ? 'Claude is working — type the next one…'
                : 'Message Claude Code…  (/ for its own commands)'}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            // Grow with the text, to a ceiling: a composer that can take the
            // whole pane leaves nowhere to read the answer.
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onPaste={(e) => {
            // A screenshot arrives as a file on the clipboard, not as text, so
            // a textarea drops it silently. Text pastes are left alone.
            const files = Array.from(e.clipboardData.files);
            if (!files.length) return;
            e.preventDefault();
            takeFiles(files);
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
            /**
             * Never let a keystroke here reach the app's global shortcuts —
             * **except the two that walk the flock.** ⌘↑/⌘↓ is how you move
             * between sheep without leaving the keyboard, and the composer
             * holds the focus for the whole time this view is open, so
             * swallowing them here turned them off wherever the chat was on
             * screen. In a textarea the native meaning is jump to the start
             * or end of the field, which in a three-line box is nothing
             * anybody reaches for.
             *
             * The rest of the ⌘ chords stay swallowed on purpose: ⌘←/→ is
             * line start/end in a text field, which matters more here than
             * cycling the tools, and ⌘A/C/V/Z are the field's own.
             */
            const passThrough = (e.metaKey || e.ctrlKey)
              && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'f');
            if (!passThrough) e.stopPropagation();
          }}
        />
        {busy ? (
          /**
           * **Stop says Stop.** It was the send button's 34px square wearing a
           * different colour, which is the one control on this view you go
           * looking for in a hurry — and an unlabelled icon in the place the
           * send button normally sits is not a thing you find in a hurry.
           *
           * It sends Escape, exactly as the keyboard would. Measured against a
           * real turn: a Bash tool running two `python3` processes, both gone
           * three seconds after this button — the agent's own interrupt tears
           * down the whole subprocess tree, and the session, its context and
           * its transcript all survive. There is nothing here to kill by hand,
           * and killing one would be worse than the keystroke.
           */
          <button
            className="nat-send nat-stop-btn"
            title="Stop the turn"
            onClick={() => sharedWs.send({ type: 'native_interrupt', session_id: sessionId })}
          >
            <Square size={11} fill="currentColor" /> Stop
          </button>
        ) : (
          <button className="nat-send" title="Send (Enter)" onClick={submit} disabled={!draft.trim() && !attached.length}>
            <CornerDownLeft size={13} />
          </button>
        )}
      </div>
    </div>
    </PaneCwd.Provider>
    </FileHandler.Provider>
    </LinkHandler.Provider>
  );
}
