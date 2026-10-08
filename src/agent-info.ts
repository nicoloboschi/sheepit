/**
 * What we know about the coding agent in a pane, read from its own transcript.
 *
 * Everything here comes out of the file the agent writes for itself. The rule
 * that [nothing reads the terminal as text] holds: scrollback is bytes to
 * render, and a pane's conversation is whatever its agent recorded.
 *
 * The hard part is not reading the file, it is deciding which rows are *you*.
 * Both agents write your prompts into the same row type they use for tool
 * results, background notifications and injected preambles, and the noise
 * outnumbers the signal by a lot — one real transcript holds 255 `user` rows
 * of which 5 were typed by a human. Listing the row type is not the feature;
 * telling the two apart is.
 */
import { closeSync, createReadStream, openSync, readSync, statSync } from 'fs';
import { createInterface } from 'readline';

/** One thing the human sent the agent. */
export interface AgentPrompt {
  /** What was typed. A slash command is rendered as `/name args`, not as the
   *  XML envelope Claude Code expands it into. */
  text: string;
  at: number | null;
  /** `command` is a slash command, `prompt` is prose. Worth separating: a list
   *  of twenty prompts with six `/clear`s in it reads differently when the
   *  commands are visibly commands. */
  kind: 'prompt' | 'command';
}

/** Something one of you pointed the other at — a url, or a path on this
 *  machine, which is how an agent hands over what it made ("wrote
 *  ~/Downloads/x.csv"). Deduped, keeping the first time it was mentioned. Tool
 *  calls and their results are deliberately not a source: a page the agent
 *  fetched, or every path in a directory listing it ran, was not shared with
 *  anybody. */
export interface AgentLink {
  url: string;
  /** `file` is a path on this machine, not something a browser can open. */
  kind: 'url' | 'file';
  from: 'me' | 'agent';
  at: number | null;
}

/** How full the context is. A count always; a percentage only when the agent
 *  says how big its window is — see `limit`. */
/**
 * **Is this transcript the pane's own agent, or one it spawned?**
 *
 * `SHEEPIT_SESSION_ID` lives in the pane's environment, so *every* Claude Code
 * started under it — a `claude -p` the agent runs, a tool that shells out to
 * one, Hindsight's repository survey — inherits it and reports through the
 * pane's hooks, handing over its own transcript path. The pane then describes
 * somebody else's conversation.
 *
 * Found on a real pane: the model read as `claude-haiku-4-5` when the agent
 * was on Opus, the native view showed a prompt nobody typed ("You are
 * performing a one-time structural survey of THIS repository…"), and a
 * SessionStart hook's output appeared as a message that is not in the real
 * session. One wrong path, three symptoms.
 *
 * Claude Code writes `entrypoint` on its user and assistant rows, and it is
 * exactly this distinction: `cli` for the interactive session a pane holds,
 * `sdk-cli` for one started programmatically. Checked against both on this
 * machine rather than taken from documentation.
 *
 * @returns true for the pane's own agent, false for a spawned one, and
 *          **null when the file cannot say yet** — a transcript with no
 *          conversation row in it is the normal state for a few hundred
 *          milliseconds after a session starts, and "do not know" has to be
 *          distinguishable from "no" or the pane's own first report is thrown
 *          away.
 */
export function isInteractiveTranscript(path: string): boolean | null {
  let head: string;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
    } finally { closeSync(fd); }
  } catch { return null; }

  for (const line of head.split('\n')) {
    // The last line of a bounded read is routinely half-written.
    if (!line.endsWith('}')) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    const entry = row.entrypoint;
    if (typeof entry === 'string' && entry) return entry === 'cli';
  }
  return null;
}

export interface AgentContext {
  /** Tokens in the prompt: fresh input + cache read + cache creation. The
   *  cached part is nearly all of it on a long session, so counting only the
   *  obvious field reports every real conversation as empty. */
  used: number;
  /** Present or absent, NEVER guessed. Codex writes `model_context_window`;
   *  Claude Code records no window size anywhere a transcript can be read
   *  from, and assuming 200k would report a real 1M session at 536k tokens as
   *  268% full — wrong, and wrong in the alarming direction. Absent means we
   *  do not know, never unlimited. */
  limit?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

/** What the plan allows and how much of it is spent. Codex only — it is the
 *  one that writes this down. */
export interface AgentRateLimit {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

/** Which harness wrote the transcript. `hermes` is deliberately absent: it
 *  keeps its conversation in a SQLite `state.db`, not in a JSONL anybody can
 *  tail, so there is no transcript here to read. */
export type AgentKind = 'claude' | 'codex' | 'pi';

export interface AgentInfo {
  agent: AgentKind | null;
  /** The agent's own id for this conversation, as it writes it down. */
  agentSessionId?: string;
  /** Claude Code writes a title for its own session every turn; the last one
   *  is current. Codex writes none — a null here is the normal case for half
   *  the flock, not a failure. */
  title?: string;
  model?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  context?: AgentContext;
  /** Claude's `service_tier`, Codex's `model_provider` — both answer "what is
   *  actually serving this". */
  serving?: string;
  /** Claude's reasoning effort for the last turn, when it records one. */
  effort?: string;
  approvalPolicy?: string;
  sandboxPolicy?: string;
  rateLimits?: { primary?: AgentRateLimit; secondary?: AgentRateLimit };
  /** Dollars the session has cost so far, when the agent prices its own
   *  turns. Pi does; Claude Code and Codex record no money anywhere a
   *  transcript can be read from, so this is absent for them — absent means
   *  "not reported", never "free". */
  costUsd?: number;
  /** Replies the agent finished. Counted from the rows rather than inferred
   *  from the prompt count: a turn can end without you having asked anything
   *  (a resumed session, a scheduled run). */
  turns?: number;
  firstAt?: number | null;
  lastAt?: number | null;
  /** Where this was read from, so the pane can say what it is showing. */
  transcriptPath: string;
  transcriptBytes: number;
  /** Rows we read, and prompts we kept — the ratio is the whole story of why
   *  this file exists, and it makes a wrong filter visible instead of silent. */
  rowsScanned: number;
  prompts: AgentPrompt[];
  /** Every url and path either side mentioned, newest last. */
  links: AgentLink[];
  /** True when the cap stopped us before the end of the file. */
  truncated: boolean;
}

/** A transcript is tens of megabytes and prompts are sparse, so the scan is
 *  bounded by rows rather than trusting the file to be sensible. */
const MAX_ROWS = 200_000;
/** Enough prompts that scrolling is the limit, not the cap. Oldest are dropped
 *  rather than newest: what you asked most recently is what you came to see. */
const MAX_PROMPTS = 500;
/** One prompt can be a pasted essay. The pane shows the start and offers the
 *  rest on click; the wire does not need the whole thing. */
const MAX_PROMPT_CHARS = 4000;
/** How much of a transcript's head is read for the opening prompt. Enough for
 *  the session row, the preamble and the first turn in every sample. */
const HEAD_BYTES = 256 * 1024;
/** Links are cheap to keep and the reason to look is usually a recent one. */
const MAX_LINKS = 300;
/** The cheap test that decides whether a row is worth parsing for mentions:
 *  a url, or a path with a slash in it. Not global, so it has no lastIndex. */
const MENTION_GATE = /https?:\/\/|[~.]?\/[\w.@+-]+\//;

/** Stops at whitespace and at the brackets and quotes that wrap a url in
 *  prose or in markdown, which is as far as a regex should go. */
const URL_RE = /https?:\/\/[^\s<>"'`()\[\]{}\\]+/g;
/** An absolute or home-relative path with at least two segments. Anchored on
 *  `/` or `~/` so prose never qualifies, and bounded by the same brackets and
 *  quotes as a url so a backticked path comes out clean. A relative path is
 *  deliberately not matched: `and/or` and `src/foo` are not a handover, and the
 *  thing being looked for here is the file the agent says it wrote. */
const PATH_RE = /(?:~|\.{0,2})\/[\w.@+-]+(?:\/[\w.@+-]+)+/g;
/** A path shaped like a sentence, which the regex cannot tell apart. */
const NOT_A_PATH = /^\/(?:and|or|to|in)\b/i;

/** First mention wins, so the map is only written when the target is new. */
function addLinks(into: Map<string, AgentLink>, text: string, from: 'me' | 'agent', at: number | null): void {
  if (into.size >= MAX_LINKS) return;
  const put = (raw: string, kind: 'url' | 'file'): boolean => {
    // Trailing punctuation belongs to the sentence, not to the target.
    const url = raw.replace(/[.,;:!?'"]+$/, '');
    if (url.length < 8 || into.has(url)) return true;
    into.set(url, { url, kind, from, at });
    return into.size < MAX_LINKS;
  };
  for (const m of text.matchAll(URL_RE)) if (!put(m[0], 'url')) return;
  // Urls hold paths too, and the host's own slashes would come back as files.
  for (const m of text.replace(URL_RE, ' ').matchAll(PATH_RE)) {
    if (NOT_A_PATH.test(m[0])) continue;
    if (!put(m[0], 'file')) return;
  }
}

/** What the agent itself said, for the links in it. Tool calls and their
 *  results are not here on purpose — see `AgentLink`. */
function agentText(row: Record<string, unknown>, kind: AgentKind): string {
  const texts = (v: unknown): string =>
    Array.isArray(v) ? (v as { type?: string; text?: string }[])
      .filter(b => b?.type === 'text' || b?.type === 'Text' || b?.type === 'output_text')
      .map(b => b.text ?? '').join('\n')
    : '';
  if (kind === 'pi') {
    if (row.type !== 'message') return '';
    const msg = row.message as { role?: string; content?: unknown } | undefined;
    return msg?.role === 'assistant' ? texts(msg.content) : '';
  }
  if (kind === 'codex') {
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload) return '';
    if (row.type === 'event_msg' && payload.type === 'item_completed') {
      const item = payload.item as { type?: string; content?: unknown } | undefined;
      return item?.type === 'AgentMessage' ? texts(item.content) : '';
    }
    if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      return texts(payload.content);
    }
    return '';
  }
  if (row.type !== 'assistant' || row.isSidechain === true) return '';
  const msg = row.message as { content?: unknown } | undefined;
  return texts(msg?.content);
}

const rowTime = (row: Record<string, unknown>): number | null => {
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return Number.isFinite(at) ? at : null;
};

const clip = (s: string): string =>
  s.length > MAX_PROMPT_CHARS ? s.slice(0, MAX_PROMPT_CHARS) + '…' : s;

/**
 * A slash command as Claude Code records it: the envelope it expands `/foo bar`
 * into. Shown as the command you typed, because that is what you typed — the
 * XML is an implementation detail of how it was sent.
 */
export function parseSlashCommand(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
  const n = (name[1] ?? '').trim();
  if (!n) return null;
  const a = (args?.[1] ?? '').trim();
  return a ? `${n} ${a}` : n;
}

/**
 * Is this Claude Code row a prompt the human typed?
 *
 * Measured against 40 real transcripts. The `user` type alone is useless — it
 * carries, in descending order of frequency: tool results, `<task-notification>`
 * injections from background tasks, `isMeta` caveats and image-dimension notes,
 * slash-command envelopes, and finally the prompts.
 *
 * `origin.kind === 'human'` is the explicit marker and the one to trust.
 * `turnOrigin` says the same thing and is checked too because `origin` is
 * absent on older rows — between them they cover every human row in the sample.
 * `promptSource` ('typed' | 'queued' | 'suggestion_accepted' | 'system') is
 * deliberately NOT the test: it is missing from older rows entirely, so keying
 * on it would silently hide the oldest half of a long conversation.
 */
export function claudePrompt(row: Record<string, unknown>): AgentPrompt | null {
  if (row.type !== 'user' || row.isSidechain === true) return null;
  // A subagent's exchange belongs to the subagent, and a caveat or an image
  // note was never typed by anybody.
  if (row.isMeta === true) return null;
  // The commonest row of all. `toolUseResult` is the cheap tell; the content
  // shape is the one that holds when it is absent.
  if (row.toolUseResult !== undefined) return null;

  const msg = row.message as { content?: unknown } | undefined;
  const content = msg?.content;

  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const blocks = content as { type?: string; text?: string }[];
    if (blocks.some(b => b?.type === 'tool_result')) return null;
    text = blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('');
  } else return null;

  if (!text.trim()) return null;

  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  const time = Number.isFinite(at) ? at : null;

  // A slash command may or may not carry a human origin — `/ship-it` does,
  // `/clear` does not — so it is matched on its shape before the origin test
  // rather than after it, or half the commands would be dropped.
  const command = parseSlashCommand(text);
  if (command) return { text: command, at: time, kind: 'command' };

  const origin = row.origin as { kind?: string } | undefined;
  const human = origin?.kind === 'human' || row.turnOrigin === 'human';
  if (!human) return null;

  // `[Request interrupted by user]` is an escape key, not a prompt.
  if (/^\[Request interrupted/.test(text.trim())) return null;

  return { text: clip(text.trim()), at: time, kind: 'prompt' };
}

/** Injected envelopes Codex sends as role `user`. They are indistinguishable
 *  from a prompt by role alone, and all of them open with a marker. */
const CODEX_ENVELOPE = /^\s*(<environment_context>|<recommended_plugins>|<user_instructions>|# AGENTS\.md instructions)/;

/**
 * Is this Codex row a prompt the human typed?
 *
 * Codex has no `origin` marker, but it has something better in its newer rows:
 * `event_msg` / `item_completed` carrying an item of type `UserMessage`, which
 * in the sample was human every single time and never a preamble. That is the
 * preferred source.
 *
 * The older `response_item` / `message` / role `user` shape is kept as a
 * fallback for rollouts written before that row existed, and there the
 * envelopes have to be filtered by hand. `developer`-role rows — the skills
 * and multi-agent preambles — are rejected by the role test itself.
 */
export function codexPrompt(row: Record<string, unknown>): AgentPrompt | null {
  const payload = row.payload as Record<string, unknown> | undefined;
  if (!payload) return null;
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  const time = Number.isFinite(at) ? at : null;

  if (row.type === 'event_msg' && payload.type === 'item_completed') {
    const item = payload.item as { type?: string; content?: { text?: string }[] } | undefined;
    if (item?.type !== 'UserMessage') return null;
    const text = (item.content ?? []).map(c => c?.text ?? '').join('').trim();
    return text ? { text: clip(text), at: time, kind: 'prompt' } : null;
  }

  if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    const blocks = (payload.content as { type?: string; text?: string }[] | undefined) ?? [];
    const texts = blocks.filter(b => b?.type === 'input_text').map(b => b.text ?? '');
    if (texts.length === 0) return null;
    // An injected turn is envelope-first with the real prompt after it; a typed
    // one is a single block. Taking the last block rather than joining is what
    // keeps the preamble out of the prompt it was attached to.
    const text = (texts[texts.length - 1] ?? '').trim();
    if (!text || CODEX_ENVELOPE.test(text)) return null;
    return { text: clip(text), at: time, kind: 'prompt' };
  }

  return null;
}

/**
 * Is this Pi row a prompt the human typed?
 *
 * Pi is the easy one, and it is worth saying why rather than leaving it
 * looking unfinished. It files a tool result under its own role
 * (`toolResult`), and it injects AGENTS.md, the tool list and the rules into
 * the **system** row rather than into a user turn — so unlike the other two
 * there is no envelope to tell apart from a prompt. `role === 'user'` is the
 * whole filter, and in the sample every one of them was typed by a person.
 */
export function piPrompt(row: Record<string, unknown>): AgentPrompt | null {
  if (row.type !== 'message') return null;
  const msg = row.message as { role?: string; content?: unknown } | undefined;
  if (msg?.role !== 'user') return null;
  const blocks = (msg.content as { type?: string; text?: string }[] | undefined) ?? [];
  const text = blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('').trim();
  if (!text) return null;
  // Pi has no slash-command envelope: what you typed is what is stored, so a
  // leading slash is the only thing that says it was a command.
  const kind = /^\/[a-z][\w-]*/i.test(text) ? 'command' : 'prompt';
  return { text: clip(text), at: rowTime(row), kind };
}

/**
 * The first thing the human asked, for a pane whose agent writes no title.
 *
 * Claude Code titles its own session every turn and that title is the name.
 * Codex and Pi write no title anywhere, so those panes used to keep whatever
 * the directory was called — which is the same name as every other pane in
 * the same checkout. The opening prompt is the next best description of the
 * work, and it has the property a name wants and a title does not: it never
 * changes, so the pane does not get renamed under you every turn.
 *
 * Read from the HEAD of the file rather than the tail, which is the opposite
 * of every other read here and is the point — the first prompt is at the top
 * of a file that may be 47MB. One bounded chunk, no streaming.
 */
export function readOpeningPrompt(transcriptPath: string): string | null {
  const kind = agentKindOf(transcriptPath);
  if (kind === 'claude') return null;   // it has a title of its own
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const lines = buf.toString('utf8', 0, read).split('\n');
    // The last line of a truncated head is half a row; JSON.parse rejects it
    // anyway, so there is nothing to drop by hand.
    for (const line of lines) {
      if (!line || line.length < 2) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      const prompt = kind === 'codex' ? codexPrompt(row) : piPrompt(row);
      // A command is not a description of the work: a pane whose first line
      // was `/clear` would be called "clear".
      if (prompt && prompt.kind === 'prompt') return prompt.text;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/** Which agent wrote this file, from where it lives. Each harness keeps its
 *  transcripts under its own home, and that is the only thing available before
 *  a single row has been parsed. */
export function agentKindOf(transcriptPath: string): AgentKind {
  if (transcriptPath.includes('/.codex/')) return 'codex';
  if (transcriptPath.includes('/.pi/')) return 'pi';
  return 'claude';
}

/**
 * Read a transcript and return what it says about its session.
 *
 * Forward, line by line, not the 256KB tail the title and context reads use:
 * those want the newest row of a kind that is written every turn, while this
 * wants every prompt in the conversation, and the first one is at the top of a
 * file that may be 47MB. Streaming keeps that off the heap, and a substring
 * test before `JSON.parse` keeps it off the CPU — the overwhelming majority of
 * rows are tool results that can be rejected without parsing.
 */
export async function readAgentInfo(transcriptPath: string): Promise<AgentInfo> {
  const kind = agentKindOf(transcriptPath);
  const isCodex = kind === 'codex', isPi = kind === 'pi';
  const info: AgentInfo = {
    agent: kind,
    transcriptPath,
    transcriptBytes: 0,
    rowsScanned: 0,
    prompts: [],
    links: [],
    truncated: false,
  };
  try { info.transcriptBytes = statSync(transcriptPath).size; } catch { /* reported as 0 */ }

  const links = new Map<string, AgentLink>();

  /** Codex's pre-`UserMessage` shape, kept aside — see the scan below. */
  const legacyPrompts: AgentPrompt[] = [];

  // Model and usage live on the agent's own reply rows, and only the LAST one
  // is current. Those rows are the biggest in the file — a 25MB transcript is
  // mostly them — so the line is kept as a string and parsed once at the end
  // rather than parsed on every pass. Same for Codex's token_count.
  let lastReply: string | null = null;
  let lastTokens: string | null = null;

  const rl = createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (info.rowsScanned++ >= MAX_ROWS) { info.truncated = true; break; }
      if (!line || line.length < 2) continue;

      if (isPi) {
        // Pi puts a usage block on every assistant row, like Claude Code, and
        // prices it as well — see readPiUsage.
        if (line.includes('"usage"') && line.includes('"assistant"')) lastReply = line;
        // A reply that stopped because it was finished rather than to call a
        // tool. Counted on a substring, for the reason Claude's is.
        if (line.includes('"stopReason":"stop"')) info.turns = (info.turns ?? 0) + 1;
      } else if (isCodex) {
        if (line.includes('"token_count"')) lastTokens = line;
        // Codex's end-of-turn row. Claude counts `end_turn` and Pi counts
        // `stop`; this is the same fact under a third name, and without it
        // every Codex pane reported no turns at all.
        if (line.includes('"task_complete"')) info.turns = (info.turns ?? 0) + 1;
      } else {
        if (line.includes('"usage"') && line.includes('"assistant"')) lastReply = line;
        // A finished reply, counted on a substring: parsing 1174 assistant rows
        // to add up 49 of them is the whole cost of the scan for one number.
        if (line.includes('"stop_reason":"end_turn"')) info.turns = (info.turns ?? 0) + 1;
      }

      // Cheap gates first. A tool-result row is the commonest thing in the
      // file and the most expensive to parse, so it is rejected on a substring.
      const maybePrompt = isCodex
        ? line.includes('"UserMessage"') || line.includes('"input_text"')
        : line.includes('"user"');
      const maybeMeta = isCodex
        ? line.includes('"session_meta"') || line.includes('"turn_context"')
        : isPi
          ? line.includes('"session"') || line.includes('_change"')
          : line.includes('"ai-title"');
      // ponytail: a reply row that mentions a url or a path is parsed for them,
      // which on a big transcript is most of the largest rows — a regex over the
      // line is still an order cheaper than JSON.parse, and the answer is cached
      // on the file's mtime. A false positive here only costs one parse, because
      // links are taken from the text blocks and never from a tool call.
      const maybeLink = MENTION_GATE.test(line);
      if (!maybePrompt && !maybeMeta && !maybeLink) continue;

      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }

      // Unconditional: a Claude `user` row carries cwd, version, gitBranch and
      // the session id, so the rows we are already parsing for prompts are also
      // where most of the session's description lives. Gating this on the
      // `ai-title` test would have left every field but the title empty.
      readMeta(row, info, kind);

      const prompt = isCodex ? codexPrompt(row) : isPi ? piPrompt(row) : claudePrompt(row);
      if (maybeLink) {
        if (prompt) addLinks(links, prompt.text, 'me', prompt.at);
        else {
          const said = agentText(row, kind);
          if (said) addLinks(links, said, 'agent', rowTime(row));
        }
      }
      if (prompt) {
        // A current Codex rollout records the same prompt TWICE — once as the
        // `UserMessage` item and once as the older `response_item` — so taking
        // both shows every prompt doubled. The older shape is a fallback for
        // rollouts written before `UserMessage` existed, not a second source,
        // so it is collected apart and used only if nothing modern turned up.
        const legacyShape = isCodex && row.type === 'response_item';
        const into = legacyShape ? legacyPrompts : info.prompts;
        into.push(prompt);
        // Keep the newest. Shifting here rather than slicing at the end bounds
        // the memory as well as the answer, which is the point on a 47MB file.
        if (into.length > MAX_PROMPTS) into.shift();
      }
    }
  } finally {
    rl.close();
  }

  if (info.prompts.length === 0 && legacyPrompts.length > 0) info.prompts = legacyPrompts;
  info.links = [...links.values()];
  if (lastReply) (isPi ? readPiUsage : readClaudeUsage)(lastReply, info);
  if (lastTokens) readCodexUsage(lastTokens, info);

  const times = info.prompts.map(p => p.at).filter((n): n is number => typeof n === 'number');
  if (times.length) { info.firstAt = times[0]!; info.lastAt = times[times.length - 1]!; }

  return info;
}

/** The session's own description of itself, wherever each agent puts it. */
function readMeta(row: Record<string, unknown>, info: AgentInfo, kind: AgentKind): void {
  if (kind === 'pi') {
    if (row.type === 'session') {
      if (typeof row.id === 'string') info.agentSessionId = row.id;
      if (typeof row.cwd === 'string') info.cwd = row.cwd;
    }
    // Both of these are *change* rows, so the newest is what the session is
    // set to now — the same "last one wins" Codex's turn_context gets.
    if (row.type === 'model_change') {
      if (typeof row.modelId === 'string') info.model = row.modelId;
      if (typeof row.provider === 'string') info.serving = row.provider;
    }
    if (row.type === 'thinking_level_change' && typeof row.thinkingLevel === 'string') {
      info.effort = row.thinkingLevel;
    }
    return;
  }
  if (kind === 'codex') {
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload) return;
    if (row.type === 'session_meta') {
      if (typeof payload.session_id === 'string') info.agentSessionId = payload.session_id;
      if (typeof payload.cwd === 'string') info.cwd = payload.cwd;
      if (typeof payload.cli_version === 'string') info.version = payload.cli_version;
      if (typeof payload.model_provider === 'string') info.serving = payload.model_provider;
      if (typeof payload.context_window === 'number') info.context = { used: 0, ...(info.context ?? {}), limit: payload.context_window };
      // The checkout it started in. Claude Code writes the branch on every
      // row; Codex writes it once, at the top, which is as good for a pane
      // whose branch is also on its own bar.
      const git = payload.git as { branch?: string } | undefined;
      if (typeof git?.branch === 'string') info.gitBranch = git.branch;
    }
    // Last one wins: the model can change mid-session, and what it is *now* is
    // the useful answer.
    if (row.type === 'turn_context') {
      if (typeof payload.model === 'string') info.model = payload.model;
      if (typeof payload.approval_policy === 'string') info.approvalPolicy = payload.approval_policy;
      // Codex's word for the reasoning level of the turn — the same fact
      // Claude files as `effort` and Pi as `thinkingLevel`.
      if (typeof payload.effort === 'string') info.effort = payload.effort;
      // `{"type":"read-only"}` is the shape a real rollout carries. `mode` was
      // an older spelling, and reading only that reported no sandbox at all.
      const sandbox = payload.sandbox_policy as { mode?: string; type?: string } | string | undefined;
      if (typeof sandbox === 'string') info.sandboxPolicy = sandbox;
      else if (sandbox?.type ?? sandbox?.mode) info.sandboxPolicy = sandbox.type ?? sandbox.mode;
    }
    return;
  }
  // Claude Code writes a fresh `ai-title` every turn, so the last is current.
  if (row.type === 'ai-title' && typeof row.aiTitle === 'string') info.title = row.aiTitle;
  if (typeof row.sessionId === 'string') info.agentSessionId = row.sessionId;
  if (typeof row.cwd === 'string') info.cwd = row.cwd;
  if (typeof row.version === 'string') info.version = row.version;
  if (typeof row.gitBranch === 'string') info.gitBranch = row.gitBranch;
}

/**
 * Claude Code's model and context, from the last reply it finished.
 *
 * The model is read off the reply row and nowhere else. The `cost-state` row at
 * the tail also names models, keyed `claude-opus-5[1m]`, and is tempting
 * because it carries the window size too — but it is undocumented, absent from
 * roughly half the live transcripts, and its keys include whatever model a
 * subagent happened to use. The reply row is on every turn and says what
 * actually answered.
 */
export function readClaudeUsage(line: string, info: AgentInfo): void {
  let row: Record<string, unknown>;
  try { row = JSON.parse(line); } catch { return; }
  const msg = row.message as Record<string, unknown> | undefined;
  if (!msg) return;
  if (typeof msg.model === 'string') info.model = msg.model;
  if (typeof row.effort === 'string') info.effort = row.effort;

  const u = msg.usage as Record<string, unknown> | undefined;
  if (!u) return;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const input = n(u.input_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const cacheWrite = n(u.cache_creation_input_tokens);
  info.context = {
    // The prompt is all three. `input_tokens` alone is 2 on a 950k session —
    // the cached part is nearly the whole thing.
    used: input + cacheRead + cacheWrite,
    input, cacheRead, cacheWrite,
    output: n(u.output_tokens),
    // No `limit`: Claude Code does not record one anywhere readable here.
  };
  if (typeof u.service_tier === 'string') info.serving = u.service_tier;
}

/**
 * Pi's model, context and bill, from the last reply it finished.
 *
 * Its usage block is Claude's facts under shorter names — `input`,
 * `cacheRead`, `cacheWrite`, `output` — plus the one thing neither of the
 * others records: a running `cost` in dollars, already summed at the
 * provider's prices. It writes no window size, so there is no limit here for
 * the same reason there is none for Claude: absent means we do not know.
 */
export function readPiUsage(line: string, info: AgentInfo): void {
  let row: Record<string, unknown>;
  try { row = JSON.parse(line); } catch { return; }
  const msg = row.message as Record<string, unknown> | undefined;
  if (!msg) return;
  if (typeof msg.model === 'string') info.model = msg.model;
  if (typeof msg.provider === 'string') info.serving = msg.provider;
  if (typeof msg.thinkingLevel === 'string') info.effort = msg.thinkingLevel;

  const u = msg.usage as Record<string, unknown> | undefined;
  if (!u) return;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const input = n(u.input), cacheRead = n(u.cacheRead), cacheWrite = n(u.cacheWrite);
  info.context = {
    // All three, same as Claude's: on a long session the cached part is nearly
    // all of it, and `input` alone reads as an empty window.
    used: input + cacheRead + cacheWrite,
    input, cacheRead, cacheWrite,
    output: n(u.output),
  };
  const cost = u.cost as Record<string, unknown> | undefined;
  if (typeof cost?.total === 'number') info.costUsd = cost.total;
}

/** Codex's context and what is left of the plan's allowance. */
export function readCodexUsage(line: string, info: AgentInfo): void {
  let row: Record<string, unknown>;
  try { row = JSON.parse(line); } catch { return; }
  const payload = row.payload as Record<string, unknown> | undefined;
  const i = payload?.info as Record<string, unknown> | undefined;
  const last = i?.last_token_usage as Record<string, unknown> | undefined;
  if (last) {
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
    info.context = {
      // Already summed by Codex — `cached_input_tokens` is a subset of
      // `input_tokens`, not an addition. And the LAST turn's figure, not the
      // total: `total_token_usage` is every turn added up, which is not what
      // is in the context.
      used: n(last.input_tokens),
      cacheRead: n(last.cached_input_tokens),
      output: n(last.output_tokens),
      ...(typeof i?.model_context_window === 'number' ? { limit: i.model_context_window } : {}),
    };
  }
  const rl = payload?.rate_limits as Record<string, unknown> | undefined;
  if (rl) {
    const one = (v: unknown): AgentRateLimit | undefined => {
      const o = v as Record<string, unknown> | undefined;
      if (!o || typeof o.used_percent !== 'number') return undefined;
      return {
        usedPercent: o.used_percent,
        ...(typeof o.window_minutes === 'number' ? { windowMinutes: o.window_minutes } : {}),
        ...(typeof o.resets_at === 'number' ? { resetsAt: o.resets_at * 1000 } : {}),
      };
    };
    const primary = one(rl.primary); const secondary = one(rl.secondary);
    if (primary || secondary) info.rateLimits = { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
  }
}
