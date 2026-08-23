# Gemini Media Edge Benchmark Relay

This app is a benchmark-only WebSocket relay. It is **not** the production Gemini media edge and must not be wired to Telnyx production traffic.

## Purpose

Deploy the exact same container to two hosting candidates and run the canonical workload owned by `apps/control-plane/src/gemini-media-edge-benchmark-*`. The hosting adapter may collect raw observations, but workload identity, concurrency, call volume, percentiles and final evidence remain repository-owned.

Initial benchmark pair (verified against official provider documentation on 2026-08-23):

| Candidate | Region | Compute baseline | Warm instances | Connection limit |
| --- | --- | --- | ---: | ---: |
| Google Cloud Run | Paris `europe-west9` | 1 vCPU, 2 GiB | 1 | 25 |
| Fly Machines | Paris `cdg` | `performance-1x`, 2 GB | 1 | 25 |

Both candidates must use the **same** external `BENCHMARK_UPSTREAM_WSS` reference sink and the same benchmark auth token semantics. Do not place the reference sink inside one candidate platform in a way that gives that candidate a private or same-host shortcut.

## Runtime modes

`BENCHMARK_MODE=sink` echoes authenticated WebSocket frames byte-for-byte.

`BENCHMARK_MODE=relay` accepts the authenticated client WebSocket and opens one authenticated upstream WebSocket to `BENCHMARK_UPSTREAM_WSS`, forwarding frames in both directions. Compression is disabled and buffered writes are bounded.

Required environment:

- `BENCHMARK_MODE=sink|relay`
- `BENCHMARK_AUTH_TOKEN=<secret with at least 16 bytes>`
- `BENCHMARK_UPSTREAM_WSS=wss://.../ws` for relay mode
- optional `BENCHMARK_MAX_BUFFERED_BYTES` (default `1048576`)
- `PORT` (default `8080`)

Never put `BENCHMARK_AUTH_TOKEN` in a URL, committed file or log.

## Cloud Run baseline

Use the same built container image as Fly. The steady-state comparison uses one warm instance so cold-start variance does not become a hidden candidate-specific advantage.

Example deployment shape (replace project/image/service/secret identifiers):

```bash
gcloud run deploy gemini-media-edge-benchmark \
  --image europe-west9-docker.pkg.dev/PROJECT/REPO/IMAGE:SHA \
  --region europe-west9 \
  --cpu 1 \
  --memory 2Gi \
  --concurrency 25 \
  --min 1 \
  --max 1 \
  --timeout 3600 \
  --set-env-vars BENCHMARK_MODE=relay,BENCHMARK_UPSTREAM_WSS=wss://REFERENCE-SINK/ws \
  --set-secrets BENCHMARK_AUTH_TOKEN=BENCHMARK_AUTH_TOKEN:latest
```

Cloud Run WebSockets remain subject to the service request timeout. The baseline uses `3600` seconds; the canonical 120-second call workload is intentionally well below that ceiling.

## Fly baseline

Copy `fly.toml.example` to `fly.toml`, set a unique app name, and keep the Paris `cdg` region, one `performance-1x` Machine with 2 GB RAM, and connection concurrency 25.

Set secrets separately:

```bash
fly secrets set BENCHMARK_AUTH_TOKEN=... BENCHMARK_UPSTREAM_WSS=wss://REFERENCE-SINK/ws
fly deploy
fly scale count 1 --region cdg
```

`BENCHMARK_UPSTREAM_WSS` is not itself a credential, but setting it alongside secrets avoids accidental divergence between benchmark revisions.

## Valid run requirements

A result is invalid for platform comparison if any of these differ between candidates:

- container image digest;
- canonical workload fingerprint;
- reference sink URL/service revision;
- reference region;
- attempted call volume;
- concurrency;
- warm-instance policy;
- CPU/memory baseline;
- benchmark token/authentication semantics.

Provider/model semantic latency is not part of this transport-hosting benchmark. Gemini Live E2E latency is measured separately after a media-edge platform is selected.
