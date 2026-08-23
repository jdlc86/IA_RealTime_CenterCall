#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT is required}"
: "${BENCHMARK_IMAGE:?BENCHMARK_IMAGE must be an immutable image reference}"
: "${BENCHMARK_UPSTREAM_WSS:?BENCHMARK_UPSTREAM_WSS is required}"

SERVICE="${BENCHMARK_SERVICE:-gemini-media-edge-benchmark}"
REGION="${BENCHMARK_REGION:-europe-west9}"
SECRET_NAME="${BENCHMARK_SECRET_NAME:-BENCHMARK_AUTH_TOKEN}"

if [[ "${BENCHMARK_IMAGE}" != *@sha256:* ]]; then
  echo "BENCHMARK_IMAGE must be pinned by digest (@sha256:...), not a mutable tag" >&2
  exit 2
fi

if [[ "${BENCHMARK_UPSTREAM_WSS}" != wss://* ]]; then
  echo "BENCHMARK_UPSTREAM_WSS must use wss://" >&2
  exit 2
fi

gcloud run deploy "${SERVICE}" \
  --project "${GCP_PROJECT}" \
  --image "${BENCHMARK_IMAGE}" \
  --region "${REGION}" \
  --cpu 1 \
  --memory 2Gi \
  --concurrency 25 \
  --min 1 \
  --max 1 \
  --timeout 3600 \
  --set-env-vars "BENCHMARK_MODE=relay,BENCHMARK_UPSTREAM_WSS=${BENCHMARK_UPSTREAM_WSS}" \
  --set-secrets "BENCHMARK_AUTH_TOKEN=${SECRET_NAME}:latest"

printf 'Cloud Run benchmark candidate deployed: service=%s region=%s image=%s\n' \
  "${SERVICE}" "${REGION}" "${BENCHMARK_IMAGE}"
