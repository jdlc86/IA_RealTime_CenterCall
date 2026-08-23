#!/usr/bin/env bash
set -euo pipefail

: "${FLY_APP:?FLY_APP is required}"
: "${BENCHMARK_IMAGE:?BENCHMARK_IMAGE must be an immutable image reference}"
: "${BENCHMARK_UPSTREAM_WSS:?BENCHMARK_UPSTREAM_WSS is required}"
: "${BENCHMARK_AUTH_TOKEN:?BENCHMARK_AUTH_TOKEN is required for Fly secret provisioning}"

REGION="${BENCHMARK_REGION:-cdg}"
CONFIG="${BENCHMARK_FLY_CONFIG:-fly.toml.example}"

if [[ "${BENCHMARK_IMAGE}" != *@sha256:* ]]; then
  echo "BENCHMARK_IMAGE must be pinned by digest (@sha256:...), not a mutable tag" >&2
  exit 2
fi

if [[ "${BENCHMARK_UPSTREAM_WSS}" != wss://* ]]; then
  echo "BENCHMARK_UPSTREAM_WSS must use wss://" >&2
  exit 2
fi

# App creation is intentionally separate: this script must not silently create
# provider resources or accept Fly's first-deploy redundancy defaults.
flyctl status --app "${FLY_APP}" >/dev/null

flyctl secrets set \
  --app "${FLY_APP}" \
  "BENCHMARK_AUTH_TOKEN=${BENCHMARK_AUTH_TOKEN}" \
  "BENCHMARK_UPSTREAM_WSS=${BENCHMARK_UPSTREAM_WSS}"

flyctl deploy \
  --app "${FLY_APP}" \
  --config "${CONFIG}" \
  --image "${BENCHMARK_IMAGE}"

flyctl scale count 1 --app "${FLY_APP}" --region "${REGION}" --yes

printf 'Fly benchmark candidate deployed: app=%s region=%s image=%s\n' \
  "${FLY_APP}" "${REGION}" "${BENCHMARK_IMAGE}"
