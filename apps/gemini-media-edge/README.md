# Gemini Media Edge

Production-oriented media-plane container for the Gemini realtime provider.

## Responsibility

This service is the continuous audio hot path only:

`Telnyx Media WebSocket <-> Gemini Media Edge <-> Gemini Live WebSocket`

It validates the Telnyx stream format, reorders inbound media by `media.chunk`, converts RTP L16 network byte order to Gemini PCM16 little-endian at 16 kHz, and converts Gemini PCM16 24 kHz output back to Telnyx L16/16 kHz through one stateful resampler per call.

Cloudflare remains the control plane and Gemini remains traffic-disabled until the product readiness gates are satisfied.

## Admission security

The media edge no longer accepts a process-wide static ingress bearer. Each WebSocket upgrade must present a signed, short-lived `v1` credential whose authenticated claims bind exactly one provider/tenant/call/edge URL/target-leg set and expiry.

Admission is deliberately split in two phases:

1. the Bearer credential is authenticated on WebSocket upgrade, but is **not consumed**;
2. the first Telnyx `start` identity frame must contain the exact bound `start.call_control_id` and mono `L16/16000` format;
3. only after that identity check succeeds is the credential consumed atomically;
4. only after successful one-shot consumption is the Gemini Live WebSocket opened.

A malformed or wrong-call Telnyx start therefore cannot burn a valid credential, while replay of a correctly bound credential is rejected before Gemini is opened.

The current executable uses an in-memory one-shot consumer and therefore **requires an explicitly single-instance deployment**. Startup fails unless `MEDIA_EDGE_SINGLE_INSTANCE=true`. This is suitable only for the first controlled single-instance canary. Before horizontal scaling, replace it with a durable shared atomic consumer; do not remove the startup guard as a shortcut.

Required environment variables:

- `GEMINI_API_KEY`
- `MEDIA_EDGE_CREDENTIAL_HMAC_SECRET` (at least 32 bytes; must match the credential issuer)
- `MEDIA_EDGE_PUBLIC_URL` (exact `wss://` URL bound into issued credentials)
- `MEDIA_EDGE_SINGLE_INSTANCE=true`

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

Do not enable Gemini traffic merely because this container builds. Remaining work includes the matching control-plane credential issuer, immutable session bootstrap from the control plane, authoritative STT/VAD composition, tool/control-plane event transport, lifecycle/hangup wiring, durable replay consumption for multi-instance deployment, and E2E validation.
