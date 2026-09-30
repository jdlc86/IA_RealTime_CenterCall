# Gemini Fast Cloud Run production runbook

Cloud Run runs a single warm `gemini-media-edge-fast` revision. The same verified
revision owns the default production URL and retains its `fast-<sha>` tag for the
Fast Worker. Credential, bootstrap and active-session ownership remain in memory,
so horizontal scaling is still forbidden.

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
canary workflow reads the configured selectors, synchronizes the control token
to both Cloudflare control planes, synchronizes the credential HMAC to the Fast
Worker, and deploys Cloud Run with those same selectors. Its authenticated
security preflight and the existing HMAC upgrade probe fail closed if a secret
rotates during deployment, before changing the canary edge binding.

## 2. Build, verify and promote an immutable Fast revision

Run the `Gemini Fast Canary Deploy` workflow. It builds an immutable Fast image,
deploys it initially with `--no-traffic`, verifies provider readiness, synchronizes
the Fast Worker, proves bootstrap/HMAC/WSS, retires stale tags, and only then moves
100% of general Cloud Run traffic to esa revisión exacta. No existe un script
alternativo de deploy: el antiguo despliegue genérico de 2 GiB y el script
manual Fast fueron retirados para evitar autoridades competidoras.

## 3. Cloud Run security preflight

Use the `publicWebSocketUrl` printed by the deployment:

```powershell
Set-Location apps/gemini-media-edge
npm run test:e2e:cloud-run -- wss://SERVICE.run.app/telnyx/gemini
```

This proves that the default URL serves `gemini-media-edge-fast`, validates the
real provider readiness measurements, and verifies that bootstrap, diagnostics
and media ingress reject unauthenticated access. It does not consume a credential
or start Telnyx traffic.

## 4. Production single-tenant E2E

The Gemini Fast Worker remains the call-entry authority and points
`GEMINI_FAST_CANARY_EDGE_URL` at the preserved tag of the same production
revision. A real inbound call must show this ordered trace:

`tenant -> immutable GEMINI -> caller security -> credential -> bootstrap -> CallSession -> sideband ready -> streaming_start`

Any failure rejects the call without a fallback. Do not reintroduce the retired
generic Media Edge workflow.
