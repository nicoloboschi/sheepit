#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Usage ──
if [ -z "${1:-}" ]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "  e.g. ./scripts/release.sh 0.2.0"
  echo ""
  echo "This will:"
  echo "  1. Set version in package.json + package-lock.json"
  echo "  2. Build (tsc + vite)"
  echo "  3. Commit, tag, and push to origin"
  echo "  4. Publish to npm"
  exit 1
fi

VERSION="$1"

# ── Load NPM token from .env ──
if [ -f .env ]; then
  export $(grep -E '^NPM_TOKEN=' .env | xargs)
fi

if [ -z "${NPM_TOKEN:-}" ]; then
  echo "Error: NPM_TOKEN not set. Add NPM_TOKEN=... to .env"
  exit 1
fi

# ── Safety: ensure .env is not tracked ──
if git ls-files --error-unmatch .env 2>/dev/null; then
  echo "Error: .env is tracked by git! Remove it first: git rm --cached .env"
  exit 1
fi

# ── Check for uncommitted changes ──
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: uncommitted changes. Commit or stash first."
  git status --short
  exit 1
fi

# ── Bump version ──
echo "Bumping to v${VERSION}..."
npm version "$VERSION" --no-git-tag-version
cd ui && npm version "$VERSION" --no-git-tag-version && cd ..

# ── Build ──
echo "Building..."
npm run build

# ── Commit + tag + push ──
echo "Committing v${VERSION}..."
git add package.json package-lock.json ui/package.json ui/package-lock.json
git commit -m "v${VERSION}"
git tag "v${VERSION}"
git push origin main --tags

# ── Publish to npm ──
echo "Publishing to npm..."
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc
trap 'rm -f .npmrc' EXIT
npm publish --access public

echo ""
echo "✓ sheepit@${VERSION} released"
echo "  npm: https://www.npmjs.com/package/sheepit"
echo "  git: v${VERSION} tag pushed to origin"
