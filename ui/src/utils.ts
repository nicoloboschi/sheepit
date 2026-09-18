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
