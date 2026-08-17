/**
 * Runtime platform detection, with no import of @capacitor/core.
 *
 * This lives apart from native.ts so that the earliest bootstrap code
 * (serverUrl.ts, utils.ts) can ask "are we in the Android app?" without
 * pulling the Capacitor runtime into the browser bundle's critical path.
 * Capacitor injects `window.Capacitor` before any app code runs.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

/** True inside the Capacitor Android/iOS shell, false in a browser tab. */
export function isNativeApp(): boolean {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform();
}

/**
 * True when the UI is running detached from the server that served it — an
 * installed PWA, an iOS home-screen app, or the Android APK. In all three the
 * user has to tell us which dataplane to talk to.
 */
export function isStandalone(): boolean {
  if (isNativeApp()) return true;
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
}
