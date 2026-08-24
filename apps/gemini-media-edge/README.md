# Gemini Media Edge

Production-oriented media-plane container for the Gemini realtime provider.

## Responsibility

This service is the continuous audio hot path only:

`Telnyx Media WebSocket <-> Gemini Media Edge <-> Gemini Live WebSocket`

It validates the Telnyx stream format, reorders inbound media by `media.chunk`, preserves Telnyx WebSocket L16 as headerless PCM16 little-endian at 16 kHz, and converts Gemini PCM16 24 kHz output back to the same Telnyx L16/16 kHz wire representation through one stateful resampler per call.

Cloudflare remains the control plane and Gemini remains traffic-disabled until the product readiness gates are satisfied.

## Admission security

The media edge no longer accepts a process-wide static ingress bearer. Each WebSocket upgrade must present a signed, short-lived `v1` credential whose authenticated claims bind exactly one provider/tenant/call/edge URL/target-leg set and expiry.

Admission is deliberately split in phases:

1. the signed credential from Telnyx's `x-telnyx-streaming-auth-token` WebSocket header is authenticated on upgrade, but is **not consumed**;
2. the first Telnyx `start` identity frame must contain the exact bound `start.call_control_id` and mono `L16/16000` format;
3. only after that identity check succeeds is the credential consumed atomically;
4. the pre-registered immutable bootstrap must match the same credential/tenant/call/expiry and is consumed one-shot;
5. only then is the Gemini Live WebSocket opened.

A malformed or wrong-call Telnyx start therefore cannot burn a valid bootstrap, while replay of a correctly bound credential is rejected before Gemini is opened.

The current executable uses in-memory one-shot credential and bootstrap stores and therefore **requires an explicitly single-instance deployment**. Startup fails unless `MEDIA_EDGE_SINGLE_INSTANCE=true`. This is suitable only for the first controlled single-instance canary. Before horizontal scaling, replace both stores with durable shared atomic/session storage; do not remove the startup guard as a shortcut.

## Immutable Gemini bootstrap

The media edge does not own a copy of Lucía's instructions or public tool catalog. Before `streaming_start`, the Cloudflare control plane builds the canonical policy from `directAgentRealtimeBootstrapPolicy(...)` and registers it through `POST /internal/bootstrap`. That control endpoint requires a separate control-plane Bearer secret and never accepts bootstrap from the Telnyx caller channel.

After authorization, the Gemini socket sends exactly one `setup` as its first client message. That setup contains the registered system instruction and function declarations, requests AUDIO output and transcription evidence, and disables Gemini automatic activity detection so caller activity can remain under our explicit owner.

Telnyx audio may arrive while Gemini is connecting, but it stays in the bounded startup buffer. The edge does **not** forward any caller audio to Gemini until the explicit `setupComplete` protocol event arrives. No timeout, sleep, generation event or transcript chunk is treated as setup readiness.

Required environment variables:

- `GEMINI_API_KEY`
- `MEDIA_EDGE_CREDENTIAL_HMAC_SECRET` (at least 32 bytes; must match the credential issuer)
- `MEDIA_EDGE_CONTROL_PLANE_TOKEN` (at least 32 bytes; protects bootstrap registration)
- `MEDIA_EDGE_PUBLIC_URL` (exact `wss://` URL bound into issued credentials)
- `MEDIA_EDGE_SINGLE_INSTANCE=true`
- `GOOGLE_CLOUD_PROJECT_ID`
- `GOOGLE_SPEECH_LANGUAGE_CODES` (comma-separated BCP-47 codes)
- `GOOGLE_SPEECH_MODEL` (`telephony_short` for the short inbound telephone turns used here)
- `GOOGLE_TTS_VOICE_NAME`
- `MEDIA_EDGE_VAD_START_RMS`
- `MEDIA_EDGE_VAD_STOP_RMS`
- `MEDIA_EDGE_VAD_MIN_SPEECH_MS`
- `MEDIA_EDGE_VAD_MIN_SILENCE_MS`

Optional:

- `GEMINI_LIVE_MODEL` (defaults to `gemini-3.1-flash-live-preview`)
- `MEDIA_EDGE_MAX_BUFFERED_BYTES`
- `PORT` (defaults to `8080`)

`GET /ready` contains no credentials. The endpoint deliberately avoids Cloud
Run's reserved `/healthz` path.

The reproducible Google Cloud setup and real canary sequence are documented in
[`deploy/cloud-run/README.md`](deploy/cloud-run/README.md).

## Validation

```sh
npm test
npm run check
docker build .
```

The admitted ingress now composes bootstrap registration, the real CallSession,
authenticated sideband readiness and Telnyx `streaming_start` in that order. A
single exact tenant can therefore run a controlled real E2E. Horizontal scaling
still requires durable shared credential/bootstrap/session ownership, and the
single-instance canary must be validated before increasing traffic.
