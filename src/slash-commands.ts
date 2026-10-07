/**
 * What `/` can mean in a pane, for the native view's completion menu.
 *
 * **The menu is an accelerator, not a gate.** The native view types into the
 * real TUI, so whatever you write reaches the agent whether or not it is
 * listed here, and the agent is the one that answers for an unknown command —
 * exactly as it would if you had typed it at the keyboard. That is what makes
 * an incomplete list acceptable; it is also why nothing here may be *wrong*
 * about a command it does list.
 *
 * Everything the user added is read off disk, which is both complete and
 * verifiable — and it is the half worth having, since nobody forgets `/clear`
 * but everybody forgets what they called the skill they wrote in March.
 *
 * The built-ins are a static list, and that is a deliberate retreat. Claude
 * Code ships as a 233MB compiled binary with no machine-readable command list;
 * scraping its strings was tried and produced 355 candidates that were mostly
 * filesystem paths and minified identifiers (`/usr`, `/tmp`, `/jsx-dev-runtime`,
 * `/zfn5`). A clever source that is wrong a third of the time is worse than a
 * short list that is honest about being short.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename, extname } from 'path';
import { homedir } from 'os';

export interface SlashCommand {
  /** Without the leading slash. */
  name: string;
  description?: string;
  /** Where it came from, so the menu can group and the reader can tell a
   *  built-in from something in their own repo. */
  source: 'built-in' | 'user' | 'project' | 'plugin';
}

/**
 * The built-ins this menu offers. Not the complete set, and it cannot be: see
 * the note above. Typing one that has been renamed fails the same way typing
 * it at the keyboard would, which is the cheapest failure available.
 */
const BUILT_INS: Array<[string, string]> = [
  ['clear', 'Clear the conversation and start fresh'],
  ['compact', 'Summarise the conversation to free up context'],
  ['context', 'Show what is using the context window'],
  ['cost', 'Show token usage and cost for this session'],
  ['model', 'Change the model for this session'],
  ['agents', 'Manage subagents'],
  ['memory', 'Edit CLAUDE.md memory files'],
  ['init', 'Create a CLAUDE.md for this repository'],
  ['review', 'Review a pull request'],
  ['resume', 'Resume a previous conversation'],
  ['rewind', 'Go back to an earlier point in the conversation'],
  ['export', 'Export this conversation'],
  ['config', 'Open settings'],
  ['permissions', 'Manage tool permissions'],
  ['hooks', 'Manage hooks'],
  ['mcp', 'Manage MCP servers'],
  ['plugin', 'Manage plugins'],
  ['doctor', 'Check the health of this installation'],
  ['status', 'Show the current session status'],
  ['help', 'List the commands this version actually has'],
  ['login', 'Sign in'],
  ['logout', 'Sign out'],
  ['upgrade', 'Upgrade Claude Code'],
  ['exit', 'End the session'],
];

/** `---\nname: x\ndescription: y\n---` at the head of a skill or command. */
function frontmatter(path: string): Record<string, string> {
  try {
    // Bounded: a SKILL.md can be long, and only its head is ever frontmatter.
    const head = readFileSync(path, 'utf8').slice(0, 4096);
    if (!head.startsWith('---')) return {};
    const end = head.indexOf('\n---', 3);
    if (end < 0) return {};
    const out: Record<string, string> = {};
    const lines = head.slice(3, end).split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n]!;
      const i = line.indexOf(':');
      if (i <= 0 || /^\s/.test(line)) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      // A YAML block scalar — `description: >` or `: |`, with the text on the
      // indented lines below. Taking the line as written gave every plugin
      // skill a description of ">", which is worse than none at all.
      if (/^[>|][-+]?$/.test(val)) {
        const parts: string[] = [];
        while (n + 1 < lines.length && /^\s+\S/.test(lines[n + 1]!)) parts.push(lines[++n]!.trim());
        val = parts.join(' ');
      } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && val) out[key] = val;
    }
    return out;
  } catch { return {}; }
}

/** `description = "..."` at the head of a plugin command's TOML. */
function tomlDescription(path: string): string | undefined {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 2048);
    const m = head.match(/^\s*description\s*=\s*"((?:[^"\\]|\\.)*)"/m);
    return m ? m[1]!.replace(/\\"/g, '"') : undefined;
  } catch { return undefined; }
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path).filter(d => {
      try { return statSync(join(path, d)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }
}

function files(path: string): string[] {
  try {
    return readdirSync(path).filter(f => {
      try { return statSync(join(path, f)).isFile(); } catch { return false; }
    });
  } catch { return []; }
}

/** `<root>/skills/<name>/SKILL.md` → one command each. */
function skillsIn(root: string, source: SlashCommand['source'], prefix = ''): SlashCommand[] {
  const base = join(root, 'skills');
  if (!existsSync(base)) return [];
  const out: SlashCommand[] = [];
  for (const d of dirs(base)) {
    const file = join(base, d, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = frontmatter(file);
    out.push({ name: prefix + (fm.name || d), description: fm.description, source });
  }
  return out;
}

/** `<root>/commands/<name>.md|.toml` → one command each. */
function commandsIn(root: string, source: SlashCommand['source'], prefix = ''): SlashCommand[] {
  const base = join(root, 'commands');
  if (!existsSync(base)) return [];
  const out: SlashCommand[] = [];
  for (const f of files(base)) {
    const ext = extname(f);
    if (ext !== '.md' && ext !== '.toml') continue;
    const name = basename(f, ext);
    const path = join(base, f);
    const description = ext === '.toml' ? tomlDescription(path) : frontmatter(path).description;
    out.push({ name: prefix + name, description, source });
  }
  return out;
}

/**
 * Every `/` thing this pane could mean, built-ins first and then whatever the
 * machine and the repository add.
 *
 * `cwd` is the pane's directory, which is what makes a project's own skills and
 * commands show up in the pane that is standing in it.
 */
export function listSlashCommands(cwd: string): SlashCommand[] {
  const home = homedir();
  const out: SlashCommand[] = BUILT_INS.map(([name, description]) => ({
    name, description, source: 'built-in' as const,
  }));

  const userRoot = join(home, '.claude');
  out.push(...skillsIn(userRoot, 'user'), ...commandsIn(userRoot, 'user'));

  if (cwd) {
    const projRoot = join(cwd, '.claude');
    out.push(...skillsIn(projRoot, 'project'), ...commandsIn(projRoot, 'project'));
  }

  // Plugins live at ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.
  // A plugin's skills are addressed `plugin:skill`; its commands are addressed
  // by their own name, which is why only the former is prefixed.
  const cache = join(userRoot, 'plugins', 'cache');
  for (const market of dirs(cache)) {
    for (const plugin of dirs(join(cache, market))) {
      const versions = dirs(join(cache, market, plugin)).sort();
      const latest = versions[versions.length - 1];
      if (!latest) continue;
      const root = join(cache, market, plugin, latest);
      out.push(...skillsIn(root, 'plugin', `${plugin}:`), ...commandsIn(root, 'plugin'));
    }
  }

  // Two sources can name the same command — a project skill shadowing a user
  // one, most often. The first wins, which is the order they were added in.
  const seen = new Set<string>();
  return out.filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}
