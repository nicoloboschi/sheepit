/**
 * "There is an app for this" — and, once there is, "there is a newer one".
 *
 * One strip, two jobs, because they are the same sentence at different times:
 * a phone browser is told the app exists, and the app is told when the server
 * is serving a build it is not running.
 *
 * **The comparison is on the commit, not the release number.** The APK's
 * `versionName` is `1.15.0+<sha>` (see scripts/android.sh), and twenty APKs
 * come out of 1.15.0 in a day — a release number cannot tell you whether the
 * app in your hand is the code on the machine. That is the whole reason the
 * sha is in there.
 *
 * Drawn only where it can be acted on:
 *
 *  - **Android only.** An iPhone cannot install an APK and a desktop has no
 *    use for one. A banner offering what the device cannot do is worse than
 *    no banner.
 *  - **Only when there is an APK to serve.** `/download/version` answers
 *    `available: false` on a checkout nobody has built for Android, rather
 *    than 404 — the app asks on every launch, and a plain "no" needs no
 *    interpreting.
 *  - **Only when the versions actually differ**, inside the app. An update
 *    banner that is always there is a banner you stop seeing.
 *
 * Dismissal is remembered **per device and per version**: dismissing "update
 * to X" must not hide "update to Y" three commits later, or the one time it
 * matters is the time it is silent.
 */
import { useEffect, useState } from 'react';
import { X, Smartphone, ArrowDownToLine } from 'lucide-react';
import { isNativeApp } from '../platform';
import { keyedUrl } from '../serverUrl';

const DISMISSED_KEY = 'sheepit:android-banner-dismissed';
/** The version we last started installing by ourselves. Automatic once per
 *  version: if you back out of Android's install sheet, the banner stays for
 *  a manual tap, and the app does not nag on every launch. */
const AUTO_KEY = 'sheepit:android-auto-update';
/** Sent to Android's "install unknown apps" switch: carry on when back. */
let awaitingPermission = false;

/** Download the served APK and open Android's installer (UpdaterPlugin.java).
 *  Android always shows its own Install sheet; the first time it also asks to
 *  allow sheepit to install apps. */
async function installUpdate(): Promise<string | null> {
  try {
    const { registerPlugin } = await import('@capacitor/core');
    const Updater = registerPlugin<{ install(o: { url: string }): Promise<{ started?: boolean; needsPermission?: boolean }> }>('Updater');
    const r = await Updater.install({ url: keyedUrl('/download/sheepit.apk') });
    if (r.needsPermission) { awaitingPermission = true; return 'Allow sheepit to install apps — the update continues when you come back'; }
    return null;
  } catch (e) {
    // An older app without the plugin: the plain download link still works
    // in the phone's browser.
    return e instanceof Error ? e.message : 'Update failed';
  }
}

/** The APK's own versionName, or null outside the app. */
async function installedVersion(): Promise<string | null> {
  if (!isNativeApp()) return null;
  try {
    const { App } = await import('@capacitor/app');
    return (await App.getInfo()).version ?? null;
  } catch {
    // Older shells, or the plugin missing. Not knowing our version is a reason
    // to say nothing, never a reason to claim an update.
    return null;
  }
}

export default function AndroidInstallBanner(): React.ReactElement | null {
  const [state, setState] = useState<{ kind: 'install' | 'update'; version: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = async () => {
    setBusy(true); setNote('Downloading the update…');
    const err = await installUpdate();
    setBusy(false); setNote(err);
  };

  useEffect(() => {
    if (!isNativeApp() && !/Android/i.test(navigator.userAgent)) return;
    let gone = false;
    let lastCheck = 0;

    const check = () => void (async () => {
      lastCheck = Date.now();
      let served: { available?: boolean; version?: string | null };
      try {
        const r = await fetch('/download/version');
        // A single-page app answers 200 to every unknown path with its own
        // index.html, so the status says nothing — the content type does.
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return;
        served = await r.json();
      } catch { return; }
      if (gone || !served.available || !served.version) return;

      const mine = await installedVersion();
      if (gone) return;

      // In a browser: there is an app and you are not using it.
      // In the app: there is a build and it is not the one you are running.
      const kind = mine === null ? 'install' : mine === served.version ? null : 'update';
      if (!kind) return;
      try {
        if (localStorage.getItem(DISMISSED_KEY) === served.version) return;
      } catch { /* private window — show it */ }
      setState({ kind, version: served.version });
      // In the app, an update installs itself: download, then Android's sheet.
      if (kind === 'update') {
        let tried = false;
        try { tried = localStorage.getItem(AUTO_KEY) === served.version; localStorage.setItem(AUTO_KEY, served.version); } catch { /* */ }
        if (!tried) void (async () => { setNote('Downloading the update…'); setNote(await installUpdate()); })();
      }
    })();
    check();
    // The app is rarely relaunched (it resumes), so look again when it comes
    // back on screen — at most every ten minutes.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (awaitingPermission) {
        awaitingPermission = false;
        void (async () => { setNote('Downloading the update…'); setNote(await installUpdate()); })();
        return;
      }
      if (Date.now() - lastCheck > 600_000) check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => { gone = true; document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  if (!state) return null;
  const isUpdate = state.kind === 'update';

  return (
    <div className="apk-banner">
      {isUpdate ? <ArrowDownToLine size={15} /> : <Smartphone size={15} />}
      <div className="apk-banner-text">
        {isUpdate && isNativeApp() ? (
          <button className="apk-banner-get" disabled={busy} onClick={() => void update()}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
            Update the sheepit app
          </button>
        ) : (
          <a className="apk-banner-get" href="/download/sheepit.apk" download>
            {isUpdate ? 'Update the sheepit app' : 'Install the sheepit app'}
          </a>
        )}
        <span className="apk-banner-more">
          {note ? note : isUpdate
            // Said plainly, because "will I lose my settings" is the question
            // that stops people updating, and the answer is no.
            ? `${state.version} · installs over the top, keeps your server and password`
            : 'How to install'}
        </span>
      </div>
      <button
        className="apk-banner-x"
        aria-label="Dismiss"
        onClick={() => {
          setState(null);
          // Per version: dismissing this update must not hide the next one.
          try { localStorage.setItem(DISMISSED_KEY, state.version); } catch { /* private */ }
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
