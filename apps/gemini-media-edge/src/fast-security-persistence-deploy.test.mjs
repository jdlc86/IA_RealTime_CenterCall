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
  assert.match(source, /wrangler secret put GEMINI_MEDIA_CONTROL_PLANE_TOKEN[\s\S]*--name "\$FAST_WORKER_NAME"/);
  assert.match(source, /wrangler secret put GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET[\s\S]*--name "\$FAST_WORKER_NAME"/);
  assert.match(source, /wrangler secret put CALLER_SECURITY_HMAC_SECRET[\s\S]*--name "\$FAST_WORKER_NAME"/);
  assert.match(source, /ACTUAL_CALLER_SECURITY_HMAC_SHA256[\s\S]*EXPECTED_CALLER_SECURITY_HMAC_SHA256/);
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
  assert.match(source, /"\$\{FAST_WORKER_ORIGIN\}\/internal\/fast-semantic-security-signal"/);
  assert.doesNotMatch(source, /ia-realtime-centercall\.julopezcardona\.workers\.dev/);
  assert.ok(
    source.indexOf("Point Gemini fast Worker at tagged canary")
      < source.indexOf("Verify Gemini semantic-security token parity without persistence"),
    "the Gemini-owned endpoint must be deployed before its first preflight",
  );
  assert.match(source, /wrangler queues create "\$queue"/);
});

test("Manual Fast secret sync updates only Gemini-owned runtime secrets", async () => {
  const source = await workflow("gemini-fast-worker-secret-sync.yml");

  assert.match(source, /FAST_WORKER_NAME: ia-realtime-centercall-gemini-fast/);
  assert.match(source, /wrangler secret put GEMINI_MEDIA_CONTROL_PLANE_TOKEN[\s\S]*--name "\$FAST_WORKER_NAME"/);
  assert.match(source, /wrangler secret put CALLER_SECURITY_HMAC_SECRET[\s\S]*--name "\$FAST_WORKER_NAME"/);
  assert.doesNotMatch(source, /apps\/control-plane/);
  assert.doesNotMatch(source, /CONTROL_WORKER_NAME|MEDIA_EDGE_CONTROL_PLANE_TOKEN/);
});

test("Fast startup derives semantic security from the Gemini diagnostic origin", async () => {
  const source = await readFile(new URL("apps/gemini-media-edge/src/startup-fast.mjs", projectRoot), "utf8");
  assert.match(source, /process\.env\.FAST_SECURITY_CONTROL_URL \|\| new URL\(diagnosticSinkUrl\)\.origin/);
  assert.doesNotMatch(source, /ia-realtime-centercall\.julopezcardona\.workers\.dev/);
});
