/**
 * Native (Capacitor / Android APK) integration.
 *
 * Everything in here is inert in a browser: `isNative` is false and
 * `initNative()` returns immediately, so the web build behaves exactly as it
 * did before. The Capacitor plugin imports are dynamic so their code is split
 * into a chunk the browser build never downloads.
 */

import { Capacitor } from '@capacitor/core';
import { setNativeNotifier } from './utils';

/** True when running inside the Android app rather than a browser tab. */
export const isNative = Capacitor.isNativePlatform();

let initialized = false;

/**
 * Wire up the native shell: notifications, status bar, and keyboard behaviour.
 * Safe to call unconditionally and more than once.
 */
export async function initNative(): Promise<void> {
  if (!isNative || initialized) return;
  initialized = true;

  await Promise.all([
    initNotifications(),
    initStatusBar(),
    initKeyboard(),
  ]);
}

/**
 * Android WebViews do not implement the Web Notification API, which is why
 * notifications silently do nothing in a browser-tab-on-Android setup. Route
 * `notify()` through Capacitor's LocalNotifications instead so a finished
 * agent actually reaches the notification shade.
 */
async function initNotifications(): Promise<void> {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');

    let perm = await LocalNotifications.checkPermissions();
    if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') {
      perm = await LocalNotifications.requestPermissions();
    }
    if (perm.display !== 'granted') return;

    // Notification ids must be 32-bit ints and unique per pending notification.
    // Wrap well inside that range rather than growing without bound.
    let nextId = 1;

    setNativeNotifier((title, body) => {
      const id = nextId;
      nextId = (nextId % 100000) + 1;
      void LocalNotifications.schedule({
        notifications: [{
          id,
          title,
          body,
          smallIcon: 'ic_stat_vipershell',
          iconColor: '#0074d9',
          // No `schedule` field: deliver immediately.
        }],
      }).catch(() => { /* notification failures must never break the terminal */ });
    });
  } catch {
    // Plugin missing or permission flow failed — fall back to the web path,
    // which no-ops on Android. Not worth breaking startup over.
  }
}

async function initStatusBar(): Promise<void> {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // Deliberately NOT calling setOverlaysWebView({ overlay: false }) here:
    // the theme's windowOptOutEdgeToEdgeEnforcement already insets the window
    // below the status bar, and doing both offsets the WebView twice — which
    // left a status-bar-height strip of bare window background above the app.
    // Light glyphs on the dark terminal background. (setBackgroundColor is a
    // no-op from Android 15 on; the colour comes from styles.xml instead.)
    await StatusBar.setStyle({ style: Style.Dark });
  } catch {
    // Non-fatal: cosmetic only.
  }
}

async function initKeyboard(): Promise<void> {
  try {
    const { Keyboard, KeyboardResize } = await import('@capacitor/keyboard');
    // `None`: MainActivity already folds the IME inset into --safe-bottom,
    // which App.tsx subtracts from the app height. Letting the plugin resize
    // as well would shrink the terminal twice and leave a dead gap above the
    // keyboard. (Its `Native` mode relies on adjustResize, which is inert now
    // that the app draws edge-to-edge.)
    await Keyboard.setResizeMode({ mode: KeyboardResize.None });
    await Keyboard.setAccessoryBarVisible({ isVisible: false });
  } catch {
    // Non-fatal: the web viewport handling still applies.
  }
}
