#!/usr/bin/env bash
#
# Cut a release. Bumps the version, commits, tags, and pushes — the push of the
# `v*` tag triggers .github/workflows/release.yml, which publishes to npm and
# creates the GitHub Release.
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

cat <<EOF

✓ Pushed $new_version.
  GitHub Actions will now test, publish to npm, and create the release.
  Track it: https://github.com/nicoloboschi/sheepit/actions
EOF
