import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

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
  assert.match(source, /new Set\(rows\.map\(\(row\) => row\?\.name\)\)/);
  assert.match(source, /names\.has\(required\)/);
  assert.match(source, /apps\/gemini-control-plane\/src\/telnyx\/fast-incoming-runtime\.ts/);
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

test("Fast canary retires stale revision tags only after the new runtime passes every preflight", async () => {
  const source = await workflow("gemini-fast-canary-deploy.yml");

  assert.match(source, /Retire stale Fast canary tags after successful verification/);
  assert.match(source, /startswith\("fast-"\)/);
  assert.match(source, /--remove-tags="\$STALE_TAG_CSV"/);
  assert.match(source, /test "\$AFTER_ACTIVE" = "\$BEFORE_ACTIVE"/);
  assert.match(source, /test "\$CURRENT_REVISION" = '\$\{\{ steps\.deployed\.outputs\.revision \}\}'/);
  assert.match(source, /test "\$REMAINING_STALE" = "0"/);
  assert.ok(
    source.indexOf("Fast Worker runtime preflight: VERIFIED")
      < source.indexOf("Retire stale Fast canary tags after successful verification"),
    "stale tags must remain available until the new Worker-to-Media-Edge path is verified",
  );
});

test("Fast deploy promotes only the verified revision and proves the default production URL", async () => {
  const source = await workflow("gemini-fast-canary-deploy.yml");

  assert.match(source, /Promote verified Fast revision to general production traffic/);
  assert.match(source, /--to-revisions="\$\{REVISION\}=100"/);
  assert.match(source, /test "\$TAG_REVISION" = "\$REVISION"/);
  assert.match(source, /Verify default production URL serves only Gemini Fast/);
  assert.match(source, /npm run test:e2e:cloud-run -- '\$\{\{ steps\.production\.outputs\.edge_url \}\}'/);
  assert.ok(
    source.indexOf("Fast Worker runtime preflight: VERIFIED")
      < source.indexOf("Promote verified Fast revision to general production traffic"),
    "general traffic must move only after the tagged Fast runtime passes every preflight",
  );
  assert.ok(
    source.indexOf("Retire stale Fast canary tags after successful verification")
      < source.indexOf("Promote verified Fast revision to general production traffic"),
    "stale tagged revisions must be retired before the new Fast revision becomes general production",
  );
});

test("Manual Fast secret sync updates only Gemini-owned runtime secrets", async () => {
  const source = await workflow("gemini-fast-worker-secret-sync.yml");

  assert.match(source, /FAST_WORKER_NAME: ia-realtime-centercall-gemini-fast/);
  assert.match(source, /wrangler secret put GEMINI_MEDIA_CONTROL_PLANE_TOKEN[\s\S]*--name "\$FAST_WORKER_NAME"/);
  assert.match(source, /wrangler secret put CALLER_SECURITY_HMAC_SECRET[\s\S]*--name "\$FAST_WORKER_NAME"/);
  assert.match(source, /"CALLER_SECURITY_HMAC_SECRET",\s+"SUPABASE_SERVICE_ROLE_KEY"/);
  assert.match(source, /names\.has\(name\)/);
  assert.doesNotMatch(source, /apps\/control-plane/);
  assert.doesNotMatch(source, /CONTROL_WORKER_NAME|MEDIA_EDGE_CONTROL_PLANE_TOKEN/);
});

test("The integrated canary is the only automatic Fast deployment authority", async () => {
  const names = await readdir(new URL(".github/workflows/", projectRoot));
  assert.ok(names.includes("gemini-fast-canary-deploy.yml"));
  assert.ok(!names.includes("gemini-fast-worker-deploy.yml"));
});

test("Fast startup derives semantic security from the Gemini diagnostic origin", async () => {
  const source = await readFile(new URL("apps/gemini-media-edge/src/startup-fast.mjs", projectRoot), "utf8");
  assert.match(source, /process\.env\.FAST_SECURITY_CONTROL_URL \|\| new URL\(diagnosticSinkUrl\)\.origin/);
  assert.match(source, /terminateSemanticAttack:\s*securityControl\.terminateSemanticAttack/);
  assert.doesNotMatch(source, /ia-realtime-centercall\.julopezcardona\.workers\.dev/);
});
