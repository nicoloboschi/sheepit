import { useEffect, useRef } from 'react';

/**
 * Poll while the tab is visible, and only then.
 *
 * Every polling hook here feeds something you can see — a branch name, a PR
 * state, a process count. In a background tab nobody is looking at any of it,
 * but the timers keep firing: sheepit left open behind other windows was still
 * forking `git status` per pane every 5s and calling the GitHub API every 30s,
 * all day, for pixels nobody was rendering. Chrome's own timer throttling does
 * not save you here — a page holding an open WebSocket is largely exempt.
 *
 * So: stop on hide, and fetch immediately on show rather than waiting out the
 * interval, which is what makes the pause invisible in use — you come back to
 * the tab and the bar is already current.
 *
 * Live state does not depend on this. Attention, busy and output all arrive
 * over the WebSocket, which stays connected and keeps the sidebar honest while
 * the tab is hidden.
 */
export function usePoll(
  fn: () => void | Promise<void>,
  intervalMs: number,
  /** Restart the cycle — and fetch at once — when this changes. Callers key on
   *  the session id: switching panes has to re-ask immediately, not sit on the
   *  previous pane's answer until the next tick. */
  key: string | number | null = null,
  enabled = true,
): void {
  // Kept in a ref so a caller can pass an inline closure without restarting
  // the timer on every render.
  const saved = useRef(fn);
  useEffect(() => { saved.current = fn; });

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => { void saved.current(); };

    const start = () => {
      if (timer !== null) return;
      run();
      timer = setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => { if (document.hidden) stop(); else start(); };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [intervalMs, enabled, key]);
}

export default usePoll;
