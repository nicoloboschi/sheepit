/**
 * sheepit as an MCP server.
 *
 * This is the whole of sheepit's side of the sheepdog: an agent that can ask
 * what the flock is doing and act on it. Everything else the dog needs —
 * Telegram, a schedule, a goal — belongs to the harness running in its pane,
 * not here.
 *
 * **Transport is Streamable HTTP on the server's own port**, mounted at
 * `/mcp`. Hermes takes a remote server as a `url:` in `~/.hermes/config.yaml`,
 * so there is no subprocess to spawn, no second lifetime to manage, and the
 * endpoint is alive exactly as long as sheepit is. Written by hand rather than
 * pulled from the SDK for the same reason `live-browser.ts` speaks CDP by
 * hand: the protocol surface actually used here is `initialize`, `tools/list`
 * and `tools/call`, and a dependency that big earns its place by doing more
 * than three verbs.
 *
 * A client may ask for its answer as JSON or as an SSE stream; both are legal
 * and different clients pick differently, so both are implemented. There is no
 * session state — every request stands alone, which is what makes the endpoint
 * survivable across a server restart without the client noticing.
 *
 * ## What the tools may and may not do
 *
 * **Reading a pane means reading the agent's transcript, never the terminal.**
 * `read_pane` returns the exchanges the agent itself recorded. Scrollback is
 * bytes to render — full of escape sequences, redrawn spinners and half-built
 * frames — and handing that to a model is how you get confident nonsense. The
 * rule that nothing reads the terminal as text holds here too.
 *
 * **The write tools are the dangerous ones and they are meant to be filtered.**
 * Hermes supports `tools: { include: [...] }` per server, so a dog can be given
 * the read half and nothing else. Do that first. An agent reachable from a
 * chat app, holding a tool that opens shells, that also reads other agents'
 * transcripts and pull-request text — both of which can contain instructions
 * written by someone else — is prompt injection with a shell on the end.
 */
import type { Request, Response } from 'express';
import type { DirectBridge } from './direct-bridge.js';
import { isDog, getDogSessionId } from './sheepdog.js';

export const MCP_PATH = '/mcp';

/** The revision of the spec this speaks. Clients send their own in a header
 *  and we answer with ours; mismatches are the client's to reconcile. */
const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Write tools are the ones worth allowlisting away. Reported in the
   *  description so an operator reading `tools/list` can see which is which. */
  write?: boolean;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export function createMcpTools(bridge: DirectBridge): ToolDef[] {
  /** Two of these answers are assembled in `api.ts` out of ripgrep, `gh` and a
   *  coalescing cache, and reimplementing that here would give the dog a
   *  second opinion that drifts from the one the UI shows. Asking our own API
   *  over loopback keeps one implementation — the same reason the browser pane
   *  points Chromium at 127.0.0.1 rather than re-reading files itself. */
  const api = async (path: string): Promise<unknown> => {
    const res = await fetch(`http://127.0.0.1:${bridge.getListenPort()}/api${path}`);
    if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
    return res.json();
  };

  /** Every pane except the dog itself. A dog that can see itself in the flock
   *  reports on its own reporting. */
  const flock = async () => {
    const dogId = getDogSessionId();
    const sessions = await bridge.listSessions();
    return sessions.filter(s => s.id !== dogId);
  };

  /** The shape a pane takes when the dog looks at it. Deliberately the facts
   *  that answer "does this need me", and not one field more — a model given
   *  CPU percentages will find a reason to talk about CPU percentages. */
  const describe = (s: Awaited<ReturnType<typeof flock>>[number]) => {
    const agent = s.isClaudeCode ? 'claude' : s.isCodex ? 'codex' : s.isHermes ? 'hermes'
      : s.isOpencode ? 'opencode' : s.isCopilot ? 'copilot' : s.isGrok ? 'grok'
      : s.isCursor ? 'cursor' : s.isAntigravity ? 'antigravity' : null;
    return {
      id: s.id,
      name: s.name,
      path: s.path,
      agent,
      state: bridge.agentStateOf(s.id),
      busy: Boolean(s.busy),
      branch: s.gitBranch ?? null,
      dirty: Boolean(s.gitDirty),
      pr: s.prNum ? { num: s.prNum, state: s.prState ?? null, url: s.prUrl ?? null } : null,
      refs: (s.prRefs ?? []).map(r => `${r.kind}#${r.num}`),
    };
  };

  const turnsOf = (id: string, limit: number) =>
    bridge.getAgentTurns(id).slice(-limit).map(t => ({
      at: new Date(t.at).toISOString(),
      you: t.prompt ?? null,
      agent: t.response ?? null,
    }));

  return [
    {
      name: 'list_flock',
      title: 'List every pane',
      description:
        'Every terminal session sheepit is holding, with what it is running, where, ' +
        'what state its agent reported, and its git branch and pull request. ' +
        'The sheepdog\'s own pane is excluded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => (await flock()).map(describe),
    },
    {
      name: 'who_needs_me',
      title: 'Which panes are waiting on a human',
      description:
        'Only the panes whose agent reported that it is blocked on you — a permission ' +
        'prompt, a question, an approval. This is the question the flock exists to answer, ' +
        'so ask it here rather than filtering list_flock yourself.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const all = await flock();
        return all
          .filter(s => bridge.agentStateOf(s.id) === 'waiting')
          .map(s => ({ ...describe(s), lastExchange: turnsOf(s.id, 1)[0] ?? null }));
      },
    },
    {
      name: 'read_pane',
      title: 'Read what a pane has been doing',
      description:
        'The recent exchanges an agent recorded in its own transcript: what it was asked ' +
        'and what it answered. This is not the terminal — scrollback is bytes for a screen, ' +
        'full of escape sequences and redrawn frames, and reading it produces confident nonsense.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Pane id, from list_flock.' },
          limit: { type: 'number', description: 'How many recent exchanges. Default 5, max 30.' },
        },
        required: ['session_id'],
        additionalProperties: false,
      },
      run: (args) => {
        const id = str(args.session_id);
        if (!id) throw new Error('session_id is required');
        if (!bridge.hasSession(id)) throw new Error(`no pane with id ${id}`);
        const limit = Math.min(30, Math.max(1, num(args.limit) ?? 5));
        const turns = turnsOf(id, limit);
        return {
          session_id: id,
          transcript: bridge.resolveAgentTranscript(id) ?? null,
          exchanges: turns,
          note: turns.length ? undefined
            : 'This pane has reported no exchanges. It may be a plain shell, or an agent whose hooks are not installed.',
        };
      },
    },
    {
      name: 'search_flock',
      title: 'Search every pane',
      description:
        'Answers "which pane is working on this". Searches pane names, directories, git ' +
        'branches, the pull requests each pane\'s hooks reported, and both agents\' own ' +
        'transcripts. A pull request number is the strongest possible query here.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Free text, or a PR number like "3993".' } },
        required: ['query'],
        additionalProperties: false,
      },
      run: async (args) => {
        const query = str(args.query);
        if (!query) throw new Error('query is required');
        return api(`/search?q=${encodeURIComponent(query)}`);
      },
    },
    {
      name: 'pane_git',
      title: 'Git state for one pane',
      description:
        'Branch, dirty state, ahead/behind and the pull request for a pane\'s own directory.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
        additionalProperties: false,
      },
      run: async (args) => {
        const id = str(args.session_id);
        if (!id) throw new Error('session_id is required');
        if (!bridge.hasSession(id)) throw new Error(`no pane with id ${id}`);
        return api(`/git/${encodeURIComponent(id)}`);
      },
    },

    /* ── Write. Filter these out of a dog you have not yet learned to trust. ── */
    {
      name: 'open_pen',
      title: 'Open a new pane',
      description:
        'WRITE. Starts a new terminal session in a directory, optionally running a command ' +
        'in it — which is how you start an agent on a piece of work. The command is typed ' +
        'into a real shell, so it can do anything you could do at that prompt.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to start in. Defaults to the home directory.' },
          command: { type: 'string', description: 'Optional command to run once the shell is up.' },
          name: { type: 'string', description: 'Optional name for the pane.' },
        },
        additionalProperties: false,
      },
      run: async (args) => {
        const id = await bridge.createSession(str(args.path));
        const name = str(args.name);
        if (name) await bridge.renameSession(id, name);
        const command = str(args.command);
        // sendKeys is the same path a new pane's init command takes from the
        // UI: it waits for the shell to finish sourcing its rc files, so the
        // command does not land on a half-drawn prompt.
        if (command) await bridge.sendKeys(id, command);
        return { session_id: id, path: str(args.path) ?? null, command: command ?? null };
      },
    },
    {
      name: 'tell_pane',
      title: 'Type into a pane',
      description:
        'WRITE. Types text into a running pane and presses return — which is how you answer ' +
        'an agent that is waiting, or give one a new instruction. It goes to whatever is ' +
        'running there, so check the pane is actually waiting before you answer it.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          text: { type: 'string', description: 'What to type. A newline is added for you.' },
        },
        required: ['session_id', 'text'],
        additionalProperties: false,
      },
      run: (args) => {
        const id = str(args.session_id);
        const text = str(args.text);
        if (!id || !text) throw new Error('session_id and text are required');
        if (!bridge.hasSession(id)) throw new Error(`no pane with id ${id}`);
        if (isDog(id)) throw new Error('the sheepdog cannot type into its own pane');
        bridge.sendInput(id, text + '\r');
        return { ok: true, session_id: id };
      },
    },
    {
      name: 'rename_pane',
      title: 'Rename a pane',
      description: 'WRITE. Gives a pane a name, which is what you see in the flock list.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' }, name: { type: 'string' } },
        required: ['session_id', 'name'],
        additionalProperties: false,
      },
      run: async (args) => {
        const id = str(args.session_id);
        const name = str(args.name);
        if (!id || !name) throw new Error('session_id and name are required');
        await bridge.renameSession(id, name);
        return { ok: true, session_id: id, name };
      },
    },
  ];
}

/** A tool's answer, shaped the way `structuredContent` must be.
 *
 *  The spec says it is a JSON **object**, and clients enforce it — Hermes
 *  validates the result with pydantic and rejects the whole call otherwise.
 *  `list_flock` and `who_needs_me` answer with arrays, and `typeof [] ===
 *  'object'`, so the old guard waved them straight through: every list call
 *  failed in a real client while curl, which validates nothing, said it
 *  worked. Anything that is not a plain object is wrapped as `{ result }`.
 *  The text content carries the unwrapped value either way. */
export function toStructuredContent(out: unknown): Record<string, unknown> | undefined {
  if (out === undefined) return undefined;
  if (out !== null && typeof out === 'object' && !Array.isArray(out)) {
    return out as Record<string, unknown>;
  }
  return { result: out };
}

/** Express handler for `/mcp`. One endpoint, no session state. */
export function mcpHandler(bridge: DirectBridge, log: (m: string) => void) {
  const tools = createMcpTools(bridge);
  const byName = new Map(tools.map(t => [t.name, t]));

  async function dispatch(req: JsonRpcRequest): Promise<object | null> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0' as const, id: req.id ?? null, result });
    const fail = (code: number, message: string) =>
      ({ jsonrpc: '2.0' as const, id: req.id ?? null, error: { code, message } });

    switch (req.method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sheepit', version: process.env.npm_package_version ?? '0.0.0' },
          instructions:
            'sheepit is a terminal multiplexer. Each "pane" is a real shell on this machine, ' +
            'usually running a coding agent. Use who_needs_me to find panes blocked on a human, ' +
            'list_flock for everything, and read_pane to see what one has been doing.',
        });

      // Notifications carry no id and want no answer.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return reply({});

      case 'tools/list':
        return reply({
          tools: tools.map(t => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case 'tools/call': {
        const name = str(req.params?.name);
        const tool = name ? byName.get(name) : undefined;
        if (!tool) return fail(-32602, `unknown tool: ${name ?? '(none)'}`);
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const out = await tool.run(args);
          return reply({
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            structuredContent: toStructuredContent(out),
          });
        } catch (e) {
          // A failed tool is a result, not a transport error: the model has to
          // see what went wrong to pick something else.
          const message = e instanceof Error ? e.message : String(e);
          log(`mcp: ${name} failed — ${message}`);
          return reply({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
        }
      }

      default:
        return fail(-32601, `method not found: ${req.method}`);
    }
  }

  return async (httpReq: Request, httpRes: Response): Promise<void> => {
    const body = httpReq.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
    if (!body || typeof body !== 'object') {
      httpRes.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }

    const batch = Array.isArray(body) ? body : [body];
    const results = (await Promise.all(batch.map(dispatch))).filter((r): r is object => r !== null);

    httpRes.setHeader('MCP-Protocol-Version', PROTOCOL_VERSION);

    // Nothing to answer — every message was a notification.
    if (results.length === 0) {
      httpRes.status(202).end();
      return;
    }

    const payload = Array.isArray(body) ? results : results[0];

    // A client may ask for either shape, and different clients ask for
    // different ones, so answer in whichever it said it accepts.
    const accept = String(httpReq.headers.accept ?? '');
    if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
      httpRes.setHeader('Content-Type', 'text/event-stream');
      httpRes.setHeader('Cache-Control', 'no-cache');
      httpRes.setHeader('Connection', 'keep-alive');
      httpRes.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      httpRes.end();
      return;
    }
    httpRes.json(payload);
  };
}
