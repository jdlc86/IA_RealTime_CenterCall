# Gemini Media Edge

Production-oriented media-plane container for the Gemini realtime provider.

## Responsibility

This service is the continuous audio hot path only:

`Telnyx Media WebSocket <-> Gemini Media Edge <-> Gemini Live WebSocket`

It validates the Telnyx stream format, reorders inbound media by `media.chunk`, converts RTP L16 network byte order to Gemini PCM16 little-endian at 16 kHz, and converts Gemini PCM16 24 kHz output back to Telnyx L16/16 kHz through one stateful resampler per call.

Cloudflare remains the control plane and Gemini remains traffic-disabled until the product readiness gates are satisfied.

## Current security/runtime status

The first production skeleton deliberately requires a bearer ingress token and a Gemini API key from runtime environment variables. It does **not** log either secret. This is not yet the final control-plane-issued one-shot credential verifier; the existing control-plane credential/start-authorization contracts must be wired before canary traffic.

Required environment variables:

- `GEMINI_API_KEY`
- `MEDIA_EDGE_INGRESS_TOKEN`

Optional:

- `GEMINI_LIVE_MODEL` (defaults to `gemini-3.1-flash-live-preview`)
- `MEDIA_EDGE_MAX_BUFFERED_BYTES`
- `PORT` (defaults to `8080`)

`GET /healthz` contains no credentials.

## Validation

```sh
npm test
npm run check
docker build .
```

Do not enable Gemini traffic merely because this container builds. Remaining work includes the one-shot credential/start authorization integration, immutable session bootstrap from the control plane, authoritative STT/VAD composition, tool/control-plane event transport, lifecycle/hangup wiring, and E2E validation.
