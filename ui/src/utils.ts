import { isNativeApp } from './platform';

export function tildefy(path: string | null | undefined, username?: string): string | null | undefined {
  if (!path) return path;
  if (!username) return path;
  for (const home of [`/Users/${username}`, `/home/${username}`]) {
    if (path === home) return '~';
    if (path.startsWith(home + '/')) return '~/' + path.slice(home.length + 1);
  }
  return path;
}

let _swRegistration: ServiceWorkerRegistration | null = null;

// The service worker exists to show notifications in a browser tab. Inside the
// Android app notifications go through Capacitor instead, and a stray worker
// would sit in front of CapacitorHttp's fetch patching, so skip registration.
if ('serviceWorker' in navigator && !isNativeApp()) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    _swRegistration = reg;
  }).catch(() => {});
}

/**
 * Set by native.ts inside the Android app. Android WebViews have no Web
 * Notification API, so without this every notify() call is a silent no-op.
 */
let _nativeNotifier: ((title: string, body: string) => void) | null = null;

/** Put text on this machine's clipboard.
 *
 *  `navigator.clipboard` is a secure-context API, and sheepit is routinely
 *  reached over plain http on a LAN — from a phone, from another laptop —
 *  where it is simply not there. The old `execCommand` route still works in
 *  that case, and a link nobody can copy is the whole feature missing.
 *
 *  Lives here rather than in the pane that first needed it: the browser bar
 *  copies a screenshot path and the GitHub view copies a pull request URL, and
 *  a second implementation of this is a second one to get the fallback wrong. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* insecure context, or the write was denied */ }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

export function setNativeNotifier(fn: (title: string, body: string) => void): void {
  _nativeNotifier = fn;
}

export function notify(title: string, body: string): void {
  // Same rule on both platforms: don't interrupt someone already looking at it.
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  if (_nativeNotifier) {
    _nativeNotifier(title, body);
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (_swRegistration) {
    _swRegistration.showNotification(title, { body });
  } else {
    new Notification(title, { body });
  }
}

export function relativeTime(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10)  return 'just now';
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function requestNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

/** A path found in terminal output, with its xterm link range (1-based,
 *  inclusive on both ends; `y` is a buffer line index + 1). */
export interface FileLinkMatch {
  text: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/**
 * Find file paths in one logical terminal line.
 *
 * Two shapes: (1) anchored paths starting with `~/ ./ ../ /`; and (2) bare
 * relative paths Claude Code prints — one or more `dir/` segments ending in a
 * `name.ext`.
 *
 * `rows` are the *untrimmed* rows of one logical line (a long path is wrapped
 * across several), so every row is exactly `cols` wide and a string index maps
 * back to a buffer position by plain arithmetic. Matching a single row instead
 * turns every wrapped path into a truncated one that opens nothing.
 */
/**
 * Where the file paths are in a run of text.
 *
 * **One definition of what a path looks like**, used by the terminal's link
 * provider and by the conversation view. They are the same question asked of
 * the same output; two regexes would drift, and the one thing this rule is
 * carefully tuned for — keeping prose out — is exactly what would rot.
 */
export function matchFilePaths(text: string): { text: string; index: number }[] {
  const FILE_RE = /((?:~\/|\.\.?\/|\/(?![\s/]))[\w./\-@~+%:]+|(?:[\w.\-@+%]+\/)+[\w.\-@+%]+\.[A-Za-z0-9]{1,8})/g;
  const out: { text: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = FILE_RE.exec(text)) !== null) {
    const raw = match[1]!;
    // A path never starts in the middle of a word, and this is what keeps
    // prose out: `and/or` and `TCP/IP` otherwise match as `/or` and `/IP`,
    // which — now that a plain click opens a file link — would hijack the pane
    // on a click in a sentence. It also drops the tail of a URL
    // (`https://x.dev/a` matches from its second slash), which the web-links
    // provider owns and is asked for first.
    if (raw.includes('://') || /[\w:/]/.test(text[match.index - 1] ?? ' ')) continue;
    out.push({ text: raw, index: match.index });
  }
  return out;
}

export function findFileLinks(rows: string[], cols: number, topRow: number): FileLinkMatch[] {
  const text = rows.join('');
  return matchFilePaths(text).map(({ text: raw, index }) => {
    const last = index + raw.length - 1;
    return {
      text: raw,
      start: { x: (index % cols) + 1, y: topRow + Math.floor(index / cols) + 1 },
      end:   { x: (last % cols) + 1,  y: topRow + Math.floor(last / cols) + 1 },
    };
  });
}
