/**
 * `/download` — the Android app, from the server you are about to point it at.
 *
 * Getting an APK onto a phone needs either a cable and adb, or a URL. sheepit
 * is already a web server the phone can reach, and it is the *right* one: the
 * build it hands over is the build that came out of this checkout, so the app
 * and the server it will talk to cannot be different versions of each other.
 * Nothing is published anywhere for this to work.
 *
 * It serves straight out of Gradle's output rather than copying the APK
 * somewhere tidier, because a copy is a thing that goes stale: the page would
 * keep offering an APK from two weeks ago with no way to tell. Reading the
 * build output means the page is either current or honestly empty.
 *
 * **It is a plain file served to anyone who can reach this server**, which is
 * the same trust boundary everything else here has — see the security note in
 * CLAUDE.md. The APK holds no secrets: it is the UI, and it asks which
 * dataplane to talk to on first launch.
 */
import { Router } from 'express';
import { existsSync, statSync, createReadStream, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where `npm run android` leaves it. Release first: it is the signed one, and
 *  a debug APK will not install over a release build. */
function apkPath(): string | null {
  const root = join(__dirname, '..', 'ui', 'android', 'app', 'build', 'outputs', 'apk');
  for (const variant of ['release/app-release.apk', 'debug/app-debug.apk']) {
    const p = join(root, variant);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * The version of the APK **on disk**, not of the checkout as it stands now.
 *
 * `scripts/android.sh` writes it beside the file at build time, so a page
 * loaded after a dozen commits still names what it is actually serving. The
 * fallback to package.json is for an APK built before this existed, where the
 * release number is all there is.
 *
 * It carries the commit — `1.15.0+a1b2c3d4` — because a release number does
 * not identify a build: twenty APKs come out of 1.15.0 in a day, and "which
 * one is on my phone" is the question that gets asked.
 */
function version(apk: string | null): string {
  if (apk) {
    try { return readFileSync(`${apk}.version`, 'utf8').trim(); } catch { /* older build */ }
  }
  try {
    const pkg = join(__dirname, '..', 'package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? '';
  } catch { return ''; }
}

/** Safe in a URL and in a filename: `+` and `-dirty` both survive, a stray
 *  slash or space would not. */
function slug(v: string): string {
  return v.replace(/[^\w.+-]/g, '');
}

function page(apk: string | null, v: string, sizeMb: string, built: string): string {
  const name = `sheepit${v ? `-${slug(v)}` : ''}.apk`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>sheepit for Android</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100dvh;
    display: flex; align-items: center; justify-content: center;
    background: #0b0d0a; color: #e7eae3;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 24px;
  }
  main { max-width: 420px; width: 100%; text-align: center; }
  .sheep { font-size: 46px; line-height: 1; }
  h1 { font-size: 21px; margin: 12px 0 2px; font-weight: 650; }
  .v { color: #797e72; font-size: 13px; margin-bottom: 22px; }
  a.get {
    display: block; padding: 14px 18px; border-radius: 12px;
    background: linear-gradient(135deg, #9cbc7f 0%, #6fa98c 100%);
    color: #0b0d0a; font-weight: 700; text-decoration: none; font-size: 16px;
  }
  .meta { color: #797e72; font-size: 12px; margin-top: 10px; }
  ol { text-align: left; color: #a8ada0; font-size: 13.5px; padding-left: 20px; margin: 26px 0 0; }
  li { margin: 7px 0; }
  code {
    background: #151a13; border-radius: 4px; padding: 1px 5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; color: #cdd3c6;
  }
  .none { background: #151a13; border: 1px solid #242a20; border-radius: 12px; padding: 18px; text-align: left; }
  .none p { margin: 0 0 10px; color: #a8ada0; font-size: 13.5px; }
</style>
</head><body><main>
  <div class="sheep">\u{1F411}</div>
  <h1>sheepit for Android</h1>
  <div class="v">${v ? `version ${v}` : ''}</div>
  ${apk ? `
  <a class="get" href="/download/${name}" download>Download the APK</a>
  <div class="meta">${sizeMb} MB${built ? ` · built ${built}` : ''}</div>
  <ol>
    <li>Tap <b>Download</b>. Chrome will warn that this file type can harm your
      device — that is what it says about every APK; keep it.</li>
    <li>Open it, and allow installing from this browser if asked.</li>
    <li>On first launch it asks for a server address. Use the one in your
      address bar right now.</li>
  </ol>` : `
  <div class="none">
    <p>No APK has been built from this checkout yet.</p>
    <p>On the machine running sheepit:</p>
    <p><code>npm run android -- --build</code></p>
    <p>Then reload this page.</p>
  </div>`}
</main></body></html>`;
}

export function createDownloadRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const apk = apkPath();
    let sizeMb = '', built = '';
    if (apk) {
      try {
        const st = statSync(apk);
        sizeMb = (st.size / 1e6).toFixed(1);
        built = st.mtime.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      } catch { /* raced a rebuild */ }
    }
    res.type('html').send(page(apk, version(apk), sizeMb, built));
  });

  /**
   * What the server has, for an app that wants to know whether it is current.
   *
   * The app compares this against its own `versionName` — which carries the
   * commit, so this answers "is my build the build" rather than the much
   * weaker "is my release number the release number". Twenty APKs come out of
   * 1.15.0 in a day and the release number cannot tell them apart.
   *
   * `available: false` rather than a 404 when nothing has been built: the app
   * asks this on every launch, and an error is something a client has to
   * decide how to interpret, where a plain "no" is not.
   */
  router.get('/version', (_req, res) => {
    const apk = apkPath();
    res.json({ available: !!apk, version: apk ? version(apk) : null });
  });

  // The filename carries the version so a phone that already downloaded one
  // does not hand back a cached older build under the same name.
  router.get(/^\/sheepit(?:-[\w.+-]+)?\.apk$/, (_req, res) => {
    const apk = apkPath();
    if (!apk) return res.status(404).type('text').send('No APK built yet — run `npm run android -- --build`.');
    // Android only offers to install a file it is told is a package.
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="sheepit-${slug(version(apk))}.apk"`);
    try { res.setHeader('Content-Length', String(statSync(apk).size)); } catch { /* optional */ }
    createReadStream(apk).pipe(res);
  });

  return router;
}
