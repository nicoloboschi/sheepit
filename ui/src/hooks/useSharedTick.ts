import { useEffect, useState } from 'react';

/**
 * One timer for every component that only needs to know "time has passed".
 *
 * The sidebar rows re-render on a clock so their relative timestamps stay
 * honest ("48s", "1h"). Each row owning its own interval means N timers waking
 * the main thread at N unrelated moments, and N separate renders — for a pen
 * count that grows with how much you have going on. Subscribers share a single
 * interval instead, so every row re-renders on the same tick.
 *
 * Like usePoll, it stops while the tab is hidden: nobody is reading a timestamp
 * they cannot see. Showing the tab ticks once immediately, so the first thing
 * you look at is not a stale age.
 */
interface Ticker {
  timer: ReturnType<typeof setInterval> | null;
  subscribers: Set<() => void>;
  onVisibility: () => void;
}

const tickers = new Map<number, Ticker>();

function getTicker(intervalMs: number): Ticker {
  let t = tickers.get(intervalMs);
  if (t) return t;

  const ticker: Ticker = {
    timer: null,
    subscribers: new Set(),
    onVisibility: () => {
      if (document.hidden) {
        stopTimer(ticker);
      } else {
        fire(ticker);
        startTimer(ticker, intervalMs);
      }
    },
  };
  tickers.set(intervalMs, ticker);
  return ticker;
}

function fire(t: Ticker): void {
  for (const notify of t.subscribers) notify();
}

function startTimer(t: Ticker, intervalMs: number): void {
  if (t.timer !== null || document.hidden) return;
  t.timer = setInterval(() => fire(t), intervalMs);
}

function stopTimer(t: Ticker): void {
  if (t.timer === null) return;
  clearInterval(t.timer);
  t.timer = null;
}

export function useSharedTick(intervalMs: number): number {
  const [, setTick] = useState(0);

  useEffect(() => {
    const ticker = getTicker(intervalMs);
    const notify = () => setTick(n => n + 1);

    if (ticker.subscribers.size === 0) {
      document.addEventListener('visibilitychange', ticker.onVisibility);
    }
    ticker.subscribers.add(notify);
    startTimer(ticker, intervalMs);

    return () => {
      ticker.subscribers.delete(notify);
      if (ticker.subscribers.size === 0) {
        stopTimer(ticker);
        document.removeEventListener('visibilitychange', ticker.onVisibility);
        tickers.delete(intervalMs);
      }
    };
  }, [intervalMs]);

  return 0;
}

export default useSharedTick;
