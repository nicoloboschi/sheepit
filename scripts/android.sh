#!/usr/bin/env bash
#
# Build the sheepit Android app and put it on a phone — one command.
#
#   npm run android            build, and install on whatever is attached
#   npm run android -- --build only build; just print where the APK is
#   npm run android -- --debug an unsigned debug APK (no keystore needed)
#
# What it does, in order: build the web UI, copy it into the Android project,
# assemble a signed release APK, and install it over adb.
#
# Why this exists at all: every one of those steps was a thing to remember, and
# the one that was forgotten was the version — the APK sat at 1.5.3 shipping an
# August build of the UI while sheepit was on 1.15.0. There is nothing to
# remember now; the version comes from package.json (see app/build.gradle).
#
# Upgrading in place works because the APK is signed with the same key every
# time (~/.sheepit/android-release.jks). Android refuses an update signed with
# a different key, so that keystore is the one thing here worth backing up —
# losing it means uninstall/reinstall on every device.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/ui"
ANDROID="$UI/android"

BUILD_ONLY=0
VARIANT=release
for arg in "$@"; do
  case "$arg" in
    --build) BUILD_ONLY=1 ;;
    --debug) VARIANT=debug ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# The SDK's own tools are not on anyone's PATH by default, and `sdk.dir` in
# local.properties is where Android Studio already wrote the answer.
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ] && [ -f "$ANDROID/local.properties" ]; then
  SDK="$(sed -n 's/^sdk\.dir=//p' "$ANDROID/local.properties" | head -1)"
fi
SDK="${SDK:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"

VERSION="$(node -p "require('$ROOT/package.json').version")"
# The commit is what identifies a build; the release number does not. See the
# note in app/build.gradle. Computed here so the script, the APK and the
# download page cannot disagree about what was built.
SHA="$(git -C "$ROOT" rev-parse --short=8 HEAD 2>/dev/null || true)"
if [ -n "$SHA" ] && [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
  SHA="$SHA-dirty"
fi
FULL_VERSION="$VERSION${SHA:+ +$SHA}"
FULL_VERSION="${FULL_VERSION// /}"
echo "==> sheepit $FULL_VERSION -> Android ($VARIANT)"

echo "==> building the web UI"
(cd "$UI" && npm run build)

# Copies ui/dist into the APK's assets and refreshes the native plugin wiring.
# `copy` alone would skip the second half, which is how a newly added plugin
# ends up missing from a build that otherwise looks fine.
echo "==> syncing into the Android project"
(cd "$UI" && npx cap sync android)

echo "==> assembling the APK"
if [ "$VARIANT" = debug ]; then
  (cd "$ANDROID" && ./gradlew --quiet -PsheepitVersionName="$FULL_VERSION" assembleDebug)
  APK="$ANDROID/app/build/outputs/apk/debug/app-debug.apk"
else
  (cd "$ANDROID" && ./gradlew --quiet -PsheepitVersionName="$FULL_VERSION" assembleRelease)
  APK="$ANDROID/app/build/outputs/apk/release/app-release.apk"
fi
[ -f "$APK" ] || { echo "gradle produced no APK at $APK" >&2; exit 1; }
# A sidecar beside the APK, so /download reports the version of the file it is
# actually serving rather than of whatever the checkout happens to be at now.
printf '%s' "$FULL_VERSION" > "$APK.version"
echo "    $APK ($(du -h "$APK" | cut -f1))"

if [ "$BUILD_ONLY" = 1 ]; then exit 0; fi

if [ ! -x "$ADB" ]; then
  echo "==> no adb at $ADB — install it by hand from the path above"
  exit 0
fi

# -d lists devices one per line; anything before the first blank/header is noise.
DEVICES="$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')"
if [ -z "$DEVICES" ]; then
  echo "==> nothing attached. Plug a phone in with USB debugging on, or start"
  echo "    an emulator, then: $ADB install -r \"$APK\""
  exit 0
fi

for dev in $DEVICES; do
  echo "==> installing on $dev"
  # -r replaces in place and keeps the app's data, which is the whole point of
  # an upgrade: the dataplane address you typed in once survives it.
  "$ADB" -s "$dev" install -r "$APK"
done
echo "==> done"
