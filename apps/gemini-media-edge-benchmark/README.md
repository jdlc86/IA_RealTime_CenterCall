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

## Reproducible deployment

The deployment scripts under `deploy/` deliberately reject mutable image tags. `BENCHMARK_IMAGE` must use an immutable `@sha256:...` digest, and the **same digest** must be supplied to both candidates.

Cloud Run:

```bash
GCP_PROJECT=... \
BENCHMARK_IMAGE=europe-west9-docker.pkg.dev/PROJECT/REPO/IMAGE@sha256:... \
BENCHMARK_UPSTREAM_WSS=wss://REFERENCE-SINK/ws \
bash deploy/cloud-run.sh
```

The Cloud Run script fixes Paris `europe-west9`, 1 vCPU, 2 GiB, concurrency 25, exactly one warm instance and a 3600-second request timeout. `BENCHMARK_AUTH_TOKEN` is read from Secret Manager using `BENCHMARK_SECRET_NAME` (default `BENCHMARK_AUTH_TOKEN`).

Fly:

```bash
FLY_APP=... \
BENCHMARK_IMAGE=registry.example/IMAGE@sha256:... \
BENCHMARK_UPSTREAM_WSS=wss://REFERENCE-SINK/ws \
BENCHMARK_AUTH_TOKEN=... \
bash deploy/fly.sh
```

The Fly script deploys with `fly.toml.example`, provisions the runtime values as Fly secrets, and fixes the Machine count to one in Paris `cdg`. The config fixes `performance-1x`, 2 GB RAM and connection concurrency 25.

The Fly CLI can create two Machines by default for some first deployments, so the explicit final `flyctl scale count 1 --region cdg` is part of the benchmark contract rather than an optional optimization.

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
