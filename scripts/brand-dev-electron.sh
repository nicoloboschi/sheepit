#!/usr/bin/env bash
#
# Make the *dev* app say Sheepit.
#
# Packaged, the bundle is Sheepit and carries its own icon — electron-builder
# builds it that way. In dev the binary is node_modules/electron's own
# Electron.app, so macOS reads that bundle's name and icon: the Dock, the app
# switcher and the menu bar all say "Electron". `app.setName()` cannot move
# any of them; the display name comes from the bundle's Info.plist.
#
# So this patches the bundle in node_modules: name, display name, and the
# sheep icon rendered from ui/public/icon-512.png. It is safe *because* it is
# in node_modules — `npm ci` throws the change away and this runs again before
# the next start.
#
# The bundle is ad-hoc signed, and on Apple Silicon a modified signed bundle is
# killed on launch, so it is re-signed ad-hoc afterwards. Idempotent: if the
# name is already Sheepit there is nothing to do, which is the common case.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
app="$root/node_modules/electron/dist/Electron.app"
png="$root/ui/public/icon-512.png"
plist="$app/Contents/Info.plist"

[ -d "$app" ] || exit 0          # no dev electron installed; nothing to brand
[ "$(uname)" = "Darwin" ] || exit 0

current=$(/usr/libexec/PlistBuddy -c "Print :CFBundleName" "$plist" 2>/dev/null || echo "")
[ "$current" = "Sheepit" ] && exit 0

echo "→ Branding the dev Electron bundle as Sheepit…"

# The icon: rendered from the same PNG the PWA and the packaged app use, under
# the bundle's existing icon name so Info.plist needs no change for it.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -f "$png" ]; then
  set -- 16 32 64 128 256 512
  mkdir -p "$work/sheepit.iconset"
  for size in "$@"; do
    sips -z "$size" "$size" "$png" --out "$work/sheepit.iconset/icon_${size}x${size}.png" >/dev/null 2>&1
    double=$((size * 2))
    sips -z "$double" "$double" "$png" --out "$work/sheepit.iconset/icon_${size}x${size}@2x.png" >/dev/null 2>&1
  done
  if iconutil -c icns "$work/sheepit.iconset" -o "$work/sheepit.icns" 2>/dev/null; then
    cp "$work/sheepit.icns" "$app/Contents/Resources/electron.icns"
  fi
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleName Sheepit" "$plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleName string Sheepit" "$plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Sheepit" "$plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Sheepit" "$plist"

# Re-sign, or macOS kills the modified bundle on launch.
codesign --force --sign - "$app" >/dev/null 2>&1 || echo "  (could not re-sign; the app may refuse to launch)" >&2

# Nudge LaunchServices, which caches the old name against the bundle path.
touch "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$app" >/dev/null 2>&1 || true

echo "  done — the dev window is Sheepit now."
