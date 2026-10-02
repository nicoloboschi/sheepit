#!/usr/bin/env python3
"""
Read the UI's performance feed.

`ui/src/perf.ts` posts a snapshot every 10s to `POST /api/perf`; the server keeps
an hour. This is the other end of that: one command to read what the app has been
doing, and one to sit and watch for it getting worse.

    scripts/perf.py report [electron|browser] [minutes]
    scripts/perf.py watch

`report` folds the window into one answer, worst first. `watch` prints a line
only when something crosses a threshold, so it can be left running.

Two things it deliberately stays quiet about, because a watch nobody reads is
worse than no watch:

  * Frames blamed on `@react-refresh` or `/@vite/`. While anyone is editing,
    Vite re-executes modules inside the running window and produces the worst
    frames in the sample — reporting those sends you chasing your own keystrokes.
  * The known open items. `LONG_MS` sits *above* the current click cost on
    purpose; see "Hidden panes still do full React work" in CLAUDE.md. Lower it
    once that is fixed, or it will never tell you if it comes back.
"""
import json
import sys
import time
import urllib.request

BASE = "http://localhost:4445/api/perf"
HEALTH = "http://localhost:4445/api/diagnostics"

POLL = 60
LONG_MS = 200            # above the known click cost — see the note above
BLOCK_PER_MIN = 600      # sustained main-thread blocking
SPAN_MS_PER_SEC = 5.0    # a span eating 0.5% of the main thread
COOLDOWN = 600           # do not repeat one finding more often than this

# What a span costs when it is doing its job. `nativeBrowser:tick` only runs
# while a browser pane is on screen, and following a moving box per frame is the
# whole point of it — that is a floor, not a regression.
EXPECTED = {
    "nativeBrowser:tick": 9.0,
    "nativeBrowser:covered": 4.0,
    "commit:pane": 12.0,
    "commit:sidebar": 12.0,
    "commit:split": 12.0,
}


def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=8) as r:
            return json.load(r)
    except Exception:
        return None


def hot_reload(d):
    """Whether the worst frame in this sample is Vite re-executing modules."""
    worst = (d.get("loaf") or [{}])[0].get("script") or ""
    return "@react-refresh" in worst or "/@vite/" in worst


def report(shell="", minutes=""):
    d = fetch(f"{BASE}?spans=1&shell={shell}&minutes={minutes}")
    if not d or not d.get("windows"):
        print("no data — is the app open, and has a 10s window closed yet?")
        return
    print(f"shell={shell or 'all'} windows={d['windows']} secs={d['seconds']} fps={d['fps']}")
    print(f"slowFrames/min={d['slowFramesPerMin']} worstFrame={d['worstFrameMs']}ms "
          f"longTaskMs/min={d['longTaskMsPerMin']} worstLongTask={d['worstLongTaskMs']}ms")
    print(f"holding {d['holding']}")
    if len(d.get("pages", [])) > 1:
        print("\nSEVERAL PAGES REPORTING — a fold across them describes none of them:")
        for p in d["pages"]:
            print(" ", p)
    print("\nSPANS (ms/sec = share of the main thread)")
    for s in d["spans"][:14]:
        print(f"  {s['name']:26} n={s['n']:7} avg={s['avgMs']:8}ms max={s['maxMs']:8}ms "
              f"ms/sec={s['msPerSec']}")
    print("\nCOUNTS")
    for c in d["counts"][:10]:
        print(f"  {c['name']:28} {c['n']:10} {c['perSec']}/s")
    print("\nWORST FRAMES (what the browser blamed, not what we guessed)")
    for l in d["loaf"][:8]:
        print(f"  {l['durationMs']:5}ms script={l['scriptMs']:5}ms style+layout={l['styleAndLayoutMs']:4}ms "
              f"{l['script'][:48]} [{l.get('invoker')}]")
    if d.get("main"):
        print("\nMAIN PROCESS", json.dumps(d["main"]))


def watch():
    seen, fired, first = set(), {}, True

    def fire(key, msg):
        if time.time() - fired.get(key, 0) < COOLDOWN:
            return
        fired[key] = time.time()
        print(f"[perf] {msg}", flush=True)

    print("[perf] watching — quiet unless something regresses", flush=True)
    while True:
        d = fetch(f"{BASE}?spans=1&shell=electron&minutes=5")
        if not d or not d.get("windows"):
            if fetch(HEALTH) is None:
                fire("backend", "backend on 4445 is not answering")
            time.sleep(POLL)
            continue

        if not hot_reload(d):
            if d.get("worstLongTaskMs", 0) > LONG_MS:
                fire("longtask", f"long task {d['worstLongTaskMs']}ms "
                                 f"(worst frame {d.get('worstFrameMs')}ms)")
            worst = (d.get("loaf") or [{}])[0]
            if worst.get("durationMs", 0) > 400:
                fire("loaf", f"{worst['durationMs']}ms frame — {worst['script']} "
                             f"({worst['scriptMs']}ms script) [{worst.get('invoker')}]")
        if d.get("longTaskMsPerMin", 0) > BLOCK_PER_MIN:
            fire("blocking", f"main thread blocked {d['longTaskMsPerMin']}ms/min")

        for s in d.get("spans", []):
            name = s["name"]
            if name not in seen:
                seen.add(name)
                # The first poll only learns what is normally there; announcing
                # every span on startup is how an alert stops being read.
                if not first and d["seconds"] > 120:
                    fire(f"new:{name}", f"new span '{name}' — {s['msPerSec']} ms/sec, "
                                        f"max {s['maxMs']}ms")
            if s["msPerSec"] > EXPECTED.get(name, SPAN_MS_PER_SEC):
                fire(f"hot:{name}", f"'{name}' at {s['msPerSec']} ms/sec "
                                    f"(n={s['n']}, max {s['maxMs']}ms)")

        m = d.get("main")
        if m and m.get("stalls", 0) > 0:
            fire("mainstall", f"main process stalled {m['stalls']}x, worst {m['worstStallMs']}ms")

        first = False
        time.sleep(POLL)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "report"
    if mode == "watch":
        watch()
    else:
        report(*(sys.argv[2:4] if mode == "report" else [mode]))
