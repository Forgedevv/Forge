#!/usr/bin/env bash
#
# Builds the sandbox and egress proxy images and prints their content-addressed IDs,
# to put in FORGE_SANDBOX_IMAGE and FORGE_SANDBOX_PROXY_IMAGE. The runner refuses any
# image reference that is not pinned (sha256 image ID or name@sha256 digest).
#
# Usage: apps/builder/docker/build-images.sh   (from anywhere)
set -euo pipefail

DOCKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILDER_DIR="$(cd "${DOCKER_DIR}/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

docker build --pull=false -f "${DOCKER_DIR}/sandbox.Dockerfile" \
  --iidfile "${TMP}/sandbox.iid" "${DOCKER_DIR}"
docker build --pull=false -f "${DOCKER_DIR}/egress-proxy.Dockerfile" \
  --iidfile "${TMP}/proxy.iid" "${BUILDER_DIR}"

echo
echo "FORGE_SANDBOX_IMAGE=$(cat "${TMP}/sandbox.iid")"
echo "FORGE_SANDBOX_PROXY_IMAGE=$(cat "${TMP}/proxy.iid")"
