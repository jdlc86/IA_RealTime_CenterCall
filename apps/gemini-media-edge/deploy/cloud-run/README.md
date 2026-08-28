# Cloud Run canary runbook

This directory provisions and deploys the first real `gemini-media-edge` canary.
The topology is intentionally one warm instance because credential, bootstrap and
active-session ownership are still in memory.

## 1. Prerequisites

- A Google Cloud project with billing enabled.
- Google Cloud CLI installed and authenticated with `gcloud auth login`.
- Permission to enable APIs, create IAM/service accounts, Artifact Registry,
  Secret Manager secrets, Cloud Build builds and Cloud Run services.

From the repository root:

```powershell
./apps/gemini-media-edge/deploy/cloud-run/provision.ps1 -ProjectId YOUR_PROJECT_ID
```

The provisioner creates secret containers but never writes secret values. Add one
version to each secret without putting plaintext in the repository or command line:

```powershell
gcloud secrets versions add gemini-media-edge-gemini-api-key --project YOUR_PROJECT_ID --data-file=-
gcloud secrets versions add gemini-media-edge-credential-hmac-secret --project YOUR_PROJECT_ID --data-file=-
gcloud secrets versions add gemini-media-edge-control-plane-token --project YOUR_PROJECT_ID --data-file=-
```

The HMAC secret and control-plane token must each contain at least 32 bytes. Record
the numeric versions returned by Google Cloud.

Google Secret Manager is the source of truth for both shared values. The Fast
canary workflow resolves `latest` to numeric versions, synchronizes the control
token to both Cloudflare control planes, synchronizes the credential HMAC to the
Fast Worker, and deploys Cloud Run with those exact numeric versions. It then
proves semantic-security authentication using a malformed, non-persisting
preflight before changing the canary edge binding.

## 2. Build and deploy an immutable revision

```powershell
./apps/gemini-media-edge/deploy/cloud-run/deploy.ps1 `
  -ProjectId YOUR_PROJECT_ID `
  -GeminiApiKeySecretVersion 1 `
  -CredentialSecretVersion 1 `
  -ControlTokenSecretVersion 1
```

The script builds with Cloud Build, resolves the Artifact Registry digest, deploys
that immutable digest, pins numeric Secret Manager versions, uses a dedicated
service identity, and then binds the exact generated `wss://.../telnyx/gemini`
URL. Cloud Run is public because Telnyx must reach the WebSocket; media admission
still requires a per-call signed bearer and every internal endpoint retains its
application-layer bearer check.

The initial VAD values are the deterministic values already exercised by the edge
synthetic E2E. Treat them as canary calibration values and tune only from captured
non-PII timing/evidence.

## 3. Cloud Run security preflight

Use the `publicWebSocketUrl` printed by the deployment:

```powershell
Set-Location apps/gemini-media-edge
npm run test:e2e:cloud-run -- wss://SERVICE.run.app/telnyx/gemini
```

This proves health and verifies that bootstrap, media ingress and control sideband
all reject unauthenticated access. It does not consume a credential or start
Gemini/Telnyx traffic.

## 4. Production single-tenant E2E

Deploy the Worker code while `GEMINI_REALTIME_ENABLED` is absent. Then configure
the production Worker with these bindings, keeping the enable flag for last:

- `GEMINI_CANARY_TENANT_ID`: the exact test tenant.
- `GEMINI_MEDIA_EDGE_URL`: the printed Cloud Run WebSocket URL.
- `MEDIA_EDGE_CREDENTIAL_HMAC_SECRET`: same value/version as Cloud Run.
- `MEDIA_EDGE_CONTROL_PLANE_TOKEN`: same value/version as Cloud Run.
- `GEMINI_REALTIME_ENABLED=true`: set only after the other four bindings exist.

Select `GEMINI` for that tenant in its existing tenant configuration or operational
KV override. A real inbound call must then show this ordered trace:

`tenant -> immutable GEMINI -> caller security -> credential -> bootstrap -> CallSession -> sideband ready -> streaming_start`

Any failure rejects the call without an OpenAI fallback. Remove or set
`GEMINI_REALTIME_ENABLED=false` to stop new Gemini admissions immediately.
