import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const projectRoot = new URL("../../../", import.meta.url);

async function workflow(name) {
  return readFile(new URL(`.github/workflows/${name}`, projectRoot), "utf8");
}

test("Fast canary synchronizes the same shared-secret selectors before deploying Cloud Run", async () => {
  const source = await workflow("gemini-fast-canary-deploy.yml");

  assert.match(source, /id: shared_secrets/);
  assert.match(source, /gcloud secrets versions access "\$CONTROL_TOKEN_SECRET_VERSION"/);
  assert.match(source, /gcloud secrets versions access "\$CREDENTIAL_SECRET_VERSION"/);
  assert.doesNotMatch(source, /gcloud secrets versions describe/);
  assert.match(source, /wrangler secret put MEDIA_EDGE_CONTROL_PLANE_TOKEN[\s\S]*--name "\$CONTROL_WORKER_NAME"/);
  assert.match(source, /wrangler secret put GEMINI_MEDIA_CONTROL_PLANE_TOKEN[\s\S]*--name "\$FAST_WORKER_NAME"/);
  assert.match(source, /wrangler secret put GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET[\s\S]*--name "\$FAST_WORKER_NAME"/);
  assert.match(source, /MEDIA_EDGE_CONTROL_PLANE_TOKEN=gemini-media-edge-control-plane-token:\$\{\{ steps\.shared_secrets\.outputs\.control_selector \}\}/);
  assert.match(source, /MEDIA_EDGE_CREDENTIAL_HMAC_SECRET=gemini-media-edge-credential-hmac-secret:\$\{\{ steps\.shared_secrets\.outputs\.credential_selector \}\}/);
});

test("Fast canary proves semantic-security authentication without persisting a caller signal", async () => {
  const source = await workflow("gemini-fast-canary-deploy.yml");

  assert.match(source, /\/internal\/fast-semantic-security-signal/);
  assert.match(source, /--data '\{\}'/);
  assert.match(source, /"\$STATUS" = "400"/);
  assert.match(source, /\.status == "INVALID_SECURITY_SIGNAL"/);
  assert.doesNotMatch(source, /callerPhoneE164.*fast-semantic-security-signal/s);
});

test("Manual Fast secret sync also updates the production Control Plane token", async () => {
  const source = await workflow("gemini-fast-worker-secret-sync.yml");

  assert.match(source, /CONTROL_WORKER_NAME: ia-realtime-centercall/);
  assert.match(source, /FAST_WORKER_NAME: ia-realtime-centercall-gemini-fast/);
  assert.match(source, /wrangler secret put MEDIA_EDGE_CONTROL_PLANE_TOKEN[\s\S]*--name "\$CONTROL_WORKER_NAME"/);
  assert.match(source, /wrangler secret put GEMINI_MEDIA_CONTROL_PLANE_TOKEN[\s\S]*--name "\$FAST_WORKER_NAME"/);
});
