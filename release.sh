#!/usr/bin/env bash
#
# Cut a release. Bumps the version, commits, tags, and pushes — the push of the
# `v*` tag triggers .github/workflows/release.yml, which publishes to npm and
# creates the GitHub Release. Nothing is published from a laptop: the tag is
# the trigger, and CI is the only thing holding the npm token.
#
# The package is `@nicoloboschi/sheepit`, scoped because the bare `sheepit`
# name on npm belongs to an unrelated package from 2023. The BIN is still
# `sheepit`, so the scope only ever shows up in an install line.
#
# Usage:
#   ./release.sh            # patch bump (1.0.0 -> 1.0.1)
#   ./release.sh minor      # 1.0.0 -> 1.1.0
#   ./release.sh major      # 1.0.0 -> 2.0.0
#   ./release.sh 1.4.2       # explicit version
#
set -euo pipefail

BUMP="${1:-patch}"

# --- Pre-flight checks ---------------------------------------------------
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "✗ Releases must be cut from 'main' (you are on '$branch')." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is not clean — commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

echo "→ Fetching origin…"
git fetch --quiet origin
if [ "$(git rev-parse @)" != "$(git rev-parse '@{u}')" ]; then
  echo "✗ Local main is not in sync with origin/main — pull/push first." >&2
  exit 1
fi

# --- Verify before tagging ----------------------------------------------
echo "→ Running tests…"
npm test

echo "→ Building…"
npm run build

# --- Bump, tag, push -----------------------------------------------------
echo "→ Bumping version ($BUMP)…"
new_version=$(npm version "$BUMP" -m "v%s") # updates package.json + lock, commits, tags
echo "  new version: $new_version"

echo "→ Pushing commit and tag…"
git push origin main --follow-tags

# --- Android app ----------------------------------------------------------
# Built here, not in CI: the signing key (~/.sheepit/android-release.jks) lives
# on this machine and nowhere else, and every APK must carry the same key or
# Android refuses to install it over the old one. The local server serves this
# build at /download, which is what the app's self-update reads — so phones
# pick the release up as soon as this finishes. Also attached to the GitHub
# Release. A machine with no Android SDK skips this with a warning.
apk="ui/android/app/build/outputs/apk/release/app-release.apk"
echo "→ Building the Android app…"
if npm run android -- --build; then
  echo "→ Attaching the APK to the GitHub Release…"
  # Create the release if CI has not yet (it updates an existing one).
  gh release view "$new_version" >/dev/null 2>&1 \
    || gh release create "$new_version" --verify-tag --generate-notes --title "$new_version" >/dev/null
  named="$(mktemp -d)/sheepit-${new_version#v}.apk"
  cp "$apk" "$named"
  gh release upload "$new_version" "$named" --clobber \
    || echo "  ! upload failed — the APK is still served locally at /download"
else
  echo "  ! Android build failed or no SDK — skipped. npm and the desktop app are unaffected."
fi

cat <<EOF

✓ Pushed $new_version.
  GitHub Actions will now test, publish to npm, and create the release.
  Track it:  https://github.com/nicoloboschi/sheepit/actions
  Package:   https://www.npmjs.com/package/@nicoloboschi/sheepit
EOF
