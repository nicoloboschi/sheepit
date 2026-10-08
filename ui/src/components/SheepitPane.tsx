/**
 * What *sheepit* knows about this pane, as opposed to what the pane knows.
 *
 * Every other tab on the rail is about the work — the repository, the
 * conversation, a page. This one is about the plumbing: the session id, the
 * pen it stands in, the files on disk that hold its scrollback and its
 * conversation, and what the agent last reported through its hooks.
 *
 * It exists because those things were reachable only by reading the URL,
 * guessing, or asking the API by hand — and they are exactly what you need
 * when something is wrong with a pane rather than wrong with the code in it.
 * `sessionId` especially: it names the pane in `curl /api/sessions/<id>/…`,
 * in `~/.config/sheepit/sessions/<id>.json`, in the hook trace and in every
 * log line, and it was written down nowhere you could copy it from.
 *
 * Deliberately read-only and deliberately last on the rail: nothing here is
 * part of doing the work, and a tab that can change a pane's identity is a
 * tab somebody will change a pane's identity with by accident.
 */
import { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import useStore, { type Workspace } from '../store';
import { apiUrl } from '../serverUrl';

/** One fact. Monospace value, because every one of these is an id or a path
 *  and the thing you do with it is paste it somewhere. */
function Row({ label, value, mono = true }: { label: string; value?: string | number | null; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = value === undefined || value === null || value === '' ? null : String(value);
  return (
    <div className="shp-row">
      <div className="shp-label">{label}</div>
      {text === null
        // Absent is said, not left blank: a missing row reads as a bug in this
        // panel, where "—" reads as a fact about the pane.
        ? <div className="shp-value shp-absent">—</div>
        : (
          <button
            className={`shp-value${mono ? ' shp-mono' : ''}`}
            title="Copy"
            onClick={() => {
              try {
                // `navigator.clipboard` is secure-context only and sheepit is
                // routinely reached over plain http on a LAN — the same reason
                // the browser pane's screenshot copy falls back.
                void navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
              } catch { fallbackCopy(text); }
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            <span className="shp-text">{text}</span>
            {copied ? <Check size={11} className="shp-copied" /> : <Copy size={11} className="shp-copy" />}
          </button>
        )}
    </div>
  );
}

function fallbackCopy(text: string): void {
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.select();
  try { document.execCommand('copy'); } catch { /* nothing else to try */ }
  el.remove();
}

interface AgentFacts {
  agent?: string | null;
  agentSessionId?: string;
  transcriptPath?: string;
  model?: string;
  version?: string;
  turns?: number;
  context?: { used?: number; limit?: number };
}

export default function SheepitPane({ sessionId }: { sessionId: string }): React.ReactElement {
  const session = useStore(s => s.sessionMap[sessionId]);
  const workspaces = useStore(s => s.workspaces);
  const [agent, setAgent] = useState<AgentFacts | null>(null);

  /**
   * The agent half is the server's answer, not the store's: the transcript
   * path and the agent's own session id are not on the session object, and
   * this is the one place that wants them.
   *
   * **Re-asked, because `null` means "not yet" far more often than "never".**
   * A pane's transcript is handed over by a hook, so there is a window — after
   * a server restart, or before the agent's next turn — where the answer is
   * null for a conversation that plainly exists. Asking once at mount landed
   * in that window and then showed dashes beside a panel full of messages,
   * which is the same lie the splash used to tell. One small request every
   * few seconds, only while this tab is open, and it stops once an answer
   * arrives — the ids and paths in it do not change for the life of a
   * conversation.
   */
  useEffect(() => {
    let gone = false;
    const ask = async () => {
      try {
        const r = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/agent`));
        if (!r.ok || gone) return false;
        const body = await r.json();
        if (gone || !body) return false;
        setAgent(body);
        return true;
      } catch { return false; }
    };
    void ask().then(got => { if (got) clearInterval(timer); });
    const timer = setInterval(() => void ask().then(got => { if (got) clearInterval(timer); }), 4000);
    return () => { gone = true; clearInterval(timer); };
  }, [sessionId]);

  // Which pen holds it, and where in that pen. Membership lives on the pen,
  // so this is a scan — of at most a few dozen, once per render of a panel
  // nobody leaves open.
  const pen = (Object.values(workspaces) as Workspace[]).find(w => w.cells.includes(sessionId));
  const paneIndex = pen ? pen.cells.indexOf(sessionId) : -1;

  return (
    <div className="shp-pane">
      <div className="shp-group">The pane</div>
      <Row label="Session id" value={sessionId} />
      <Row label="Name" value={session?.name} mono={false} />
      <Row label="Directory" value={session?.path} />
      <Row label="Pen" value={pen ? (pen.title ? `${pen.title} · ${pen.id}` : pen.id) : null} />
      <Row label="Sheep" value={paneIndex >= 0 ? `${paneIndex + 1} of ${pen?.cells.length}` : null} mono={false} />
      {session?.sideOf && <Row label="Side terminal of" value={session.sideOf} />}

      <div className="shp-group">The agent</div>
      <Row label="Agent" value={agent?.agent ?? (session?.isClaudeCode ? 'claude' : null)} mono={false} />
      <Row label="Model" value={agent?.model} />
      <Row label="Version" value={agent?.version} />
      <Row label="Its session id" value={agent?.agentSessionId} />
      <Row label="Transcript" value={agent?.transcriptPath} />
      <Row
        label="Context"
        value={agent?.context?.used !== undefined
          ? `${agent.context.used.toLocaleString()}${agent.context.limit ? ` of ${agent.context.limit.toLocaleString()}` : ''} tokens`
          : null}
        mono={false}
      />
      <Row label="Turns" value={agent?.turns} mono={false} />

      <div className="shp-group">On disk</div>
      {/* Written out rather than linked: these are paths you use from a shell
          on the machine running sheepit, which is not necessarily this one. */}
      <Row label="State" value={`~/.config/sheepit/sessions/${sessionId}.json`} />
      <Row label="Scrollback" value={`~/.config/sheepit/ring-buffers/${sessionId}.buf`} />
      <Row label="API" value={`/api/sessions/${sessionId}`} />
    </div>
  );
}
