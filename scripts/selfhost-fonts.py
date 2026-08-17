#!/usr/bin/env python3
"""Vendor the UI's webfonts into ui/public/fonts.

The UI used to pull Space Grotesk + JetBrains Mono from fonts.googleapis.com
with a render-blocking <link>. That costs a network round-trip on every cold
start, and the Android APK frequently runs against a dataplane on a LAN with no
route to the internet at all -- there the request simply stalls and the UI
falls back to system fonts.

This script downloads the woff2 files (latin + latin-ext) and writes a
fonts.css that points at the local copies. Run it to refresh the fonts:

    python3 scripts/selfhost-fonts.py

Then rebuild the UI (cd ui && npm run build).
"""
import pathlib
import re
import urllib.request

GOOGLE_CSS = (
    "https://fonts.googleapis.com/css2"
    "?family=Space+Grotesk:wght@400;500;600;700"
    "&family=JetBrains+Mono:wght@400;500;600;700"
    "&display=swap"
)

# A modern browser UA is required, otherwise Google serves legacy ttf instead
# of woff2.
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    )
}

# The other subsets Google offers (cyrillic, greek, vietnamese) would roughly
# triple the payload for glyphs this UI does not use.
KEEP_SUBSETS = {"latin", "latin-ext"}

OUT = pathlib.Path(__file__).resolve().parent.parent / "ui" / "public" / "fonts"

HEADER = """/*
 * Self-hosted Space Grotesk + JetBrains Mono (latin, latin-ext).
 *
 * GENERATED FILE -- do not edit by hand.
 * Regenerate with: python3 scripts/selfhost-fonts.py
 */

"""


def fetch(url: str) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA)).read()


def main() -> None:
    css = fetch(GOOGLE_CSS).decode()

    # Each @font-face in Google's CSS is preceded by a /* subset */ comment.
    blocks = re.findall(r"/\* ([a-z-]+) \*/\s*(@font-face \{.*?\})", css, re.S)
    if not blocks:
        raise SystemExit("could not parse Google Fonts CSS -- format changed?")

    OUT.mkdir(parents=True, exist_ok=True)
    out_css = [HEADER]
    seen: set[str] = set()

    for subset, block in blocks:
        if subset not in KEEP_SUBSETS:
            continue
        family = re.search(r"font-family: '([^']+)'", block).group(1)
        weight = re.search(r"font-weight: (\d+)", block).group(1)
        style = re.search(r"font-style: (\w+)", block).group(1)
        url = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)
        urange = re.search(r"unicode-range: ([^;]+);", block)

        name = f"{family.lower().replace(' ', '-')}-{weight}-{subset}.woff2"
        if name in seen:
            continue
        seen.add(name)

        (OUT / name).write_bytes(fetch(url))
        print(f"  {name}  {(OUT / name).stat().st_size // 1024}KB")

        out_css += [
            "@font-face {",
            f"  font-family: '{family}';",
            f"  font-style: {style};",
            f"  font-weight: {weight};",
            "  font-display: swap;",
            f"  src: url('/fonts/{name}') format('woff2');",
        ]
        if urange:
            out_css.append(f"  unicode-range: {urange.group(1).strip()};")
        out_css += ["}", ""]

    (OUT / "fonts.css").write_text("\n".join(out_css))

    # Drop any stale files from an earlier run with different subsets/weights.
    for stale in OUT.glob("*.woff2"):
        if stale.name not in seen:
            stale.unlink()
            print(f"  removed stale {stale.name}")

    total = sum(f.stat().st_size for f in OUT.glob("*.woff2"))
    print(f"\n{len(seen)} files, {total // 1024}KB total -> {OUT}")


if __name__ == "__main__":
    main()
