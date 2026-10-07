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

const DISMISSED_KEY = 'sheepit:android-banner-dismissed';

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

  useEffect(() => {
    if (!isNativeApp() && !/Android/i.test(navigator.userAgent)) return;
    let gone = false;

    void (async () => {
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
    })();

    return () => { gone = true; };
  }, []);

  if (!state) return null;
  const update = state.kind === 'update';

  return (
    <div className="apk-banner">
      {update ? <ArrowDownToLine size={15} /> : <Smartphone size={15} />}
      <div className="apk-banner-text">
        <a className="apk-banner-get" href="/download/sheepit.apk" download>
          {update ? 'Update the sheepit app' : 'Install the sheepit app'}
        </a>
        <span className="apk-banner-more">
          {update
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
