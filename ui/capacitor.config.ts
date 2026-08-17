import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Android build of the vipershell UI.
 *
 * The app ships the built web assets inside the APK and connects to a
 * user-supplied dataplane address (entered once on the ConnectScreen), so the
 * only thing that travels over the network is /api + /ws traffic.
 *
 * Two settings carry most of the weight:
 *
 *  - `androidScheme: 'http'` — the WebView origin becomes `http://localhost`
 *    rather than the default `https://localhost`. A page on an https origin
 *    may not talk to a plaintext `http://192.168.x.x:4445` dataplane (mixed
 *    content), and vipershell servers are plain http on the LAN, so an https
 *    origin would block every request. See also `usesCleartextTraffic` in
 *    AndroidManifest.xml.
 *
 *  - `CapacitorHttp.enabled` — patches fetch()/XMLHttpRequest to run through
 *    native Android HTTP instead of the WebView network stack. That sidesteps
 *    CORS entirely: the vipershell backend sends no Access-Control-* headers,
 *    so a cross-origin fetch from the WebView would otherwise be rejected.
 *    Doing it this way means the APK works against an unmodified vipershell
 *    server, and we don't have to loosen the server for browsers as well.
 *    WebSockets are unaffected — they are not subject to CORS.
 */
const config: CapacitorConfig = {
  appId: 'com.nicoloboschi.vipershell',
  appName: 'Vipershell',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
  },
  android: {
    // Terminal output is dark; match it so there is no white flash on launch.
    backgroundColor: '#0c0c0c',
  },
  backgroundColor: '#0c0c0c',
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_vipershell',
      iconColor: '#0074d9',
    },
  },
};

export default config;
