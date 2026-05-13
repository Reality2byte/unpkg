#!/usr/bin/env bash
set -euo pipefail

container_name="${ESM_SH_CONTAINER_NAME:-unpkg-esm-sh-baseline}"
host_port="${ESM_SH_PORT:-8081}"
image="${ESM_SH_IMAGE:-ghcr.io/esm-dev/esm.sh:v137_3@sha256:13c442cf17ef8f583f240e6ddbb310a1fa0b29d2aa313a9de346fd985cd6460c}"
storage_dir="${ESM_SH_STORAGE_DIR:-$PWD/.reports/esm-sh-baseline}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required to run the pinned esm.sh baseline, but the Docker daemon is not available." >&2
  echo "Start Docker, then rerun: pnpm vendor:esm-sh" >&2
  exit 1
fi

mkdir -p "$storage_dir"

if docker ps -a --format '{{.Names}}' | grep -qx "$container_name"; then
  docker rm -f "$container_name" >/dev/null
fi

exec docker run --rm \
  --name "$container_name" \
  --pull missing \
  -p "127.0.0.1:${host_port}:80" \
  -e ACCESS_LOG=false \
  -e COMPRESS=false \
  -e LOG_LEVEL=info \
  -e MINIFY=true \
  -e NPM_QUERY_CACHE_TTL=600 \
  -e NPM_REGISTRY=https://registry.npmjs.org/ \
  -e SOURCEMAP=true \
  -e STORAGE_ENDPOINT=/esm/.esmd/storage \
  -e STORAGE_TYPE=fs \
  -v "$storage_dir:/esm/.esmd" \
  "$image"
