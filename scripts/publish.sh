#!/usr/bin/env bash
# Manual release fallback (used when GitHub Actions is unavailable).
# Publishes the current version to npm AND pushes the Docker image to GHCR.
#
# Prereqs:
#   npm login                      (publishing rights for `ldrouter`)
#   docker login ghcr.io           (use a GitHub PAT with write:packages)
#
# Usage: bash scripts/publish.sh   (from the repo root)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
IMAGE="ghcr.io/lethinh26/ldrouter"

echo "==> Gates: lint / typecheck / test / build"
pnpm lint
pnpm typecheck
pnpm test
pnpm build

echo "==> npm publish (ldrouter@${VERSION})"
npm publish --access public

echo "==> docker build + push ${IMAGE}:${VERSION} + :latest"
docker build --build-arg APP_VERSION="${VERSION}" -t "${IMAGE}:${VERSION}" -t "${IMAGE}:latest" .
docker push "${IMAGE}:${VERSION}"
docker push "${IMAGE}:latest"

echo "==> Done. npm + Docker are on ${VERSION}."
