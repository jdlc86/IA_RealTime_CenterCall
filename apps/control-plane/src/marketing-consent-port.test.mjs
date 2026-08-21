import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { marketingConsentPortFor } from "../.test-dist/marketing-consent-port.js";

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

test("marketing consent port delegates status queries to the existing persistence owner", async () => {
  const host = {
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
    },
  };

  await withFetch(async (url, options) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/rest/v1/marketing_consents");
    assert.equal(parsed.searchParams.get("tenant_id"), "eq.restaurante-centro");
    assert.equal(parsed.searchParams.get("phone"), "eq.+34612345678");
    assert.equal(options.method, "GET");
    return new Response(JSON.stringify([{ status: "VERIFIED" }]), { status: 200 });
  }, async () => {
    assert.equal(
      await marketingConsentPortFor(host).getLatestStatus("restaurante-centro", "+34612345678"),
      "VERIFIED",
    );
  });
});

test("V16 delegates marketing persistence without knowing the provider edge", () => {
  const v16 = readFileSync(new URL("./call-session-v16.ts", import.meta.url), "utf8");

  assert.match(v16, /marketingConsentPortFor/);
  assert.match(v16, /\.getLatestStatus\(tenantId, callerPhone\)/);

  assert.doesNotMatch(v16, /\bSupabaseMarketingConsentStore\b/);
  assert.doesNotMatch(v16, /\bSUPABASE_URL\b/);
  assert.doesNotMatch(v16, /\bSUPABASE_SECRET_KEY\b/);
  assert.doesNotMatch(v16, /\/rest\/v1\//);
  assert.doesNotMatch(v16, /\bfetch\s*\(/);
});

test("V7 delegates marketing status persistence without knowing the provider edge", () => {
  const v7 = readFileSync(new URL("./call-session-v7.ts", import.meta.url), "utf8");

  assert.match(v7, /marketingConsentPortFor\(this as any\)\.getLatestStatus\(tenantId, callerPhone\)/);
  assert.doesNotMatch(v7, /\bSupabaseMarketingConsentStore\b/);
  assert.doesNotMatch(v7, /\bSUPABASE_URL\b/);
  assert.doesNotMatch(v7, /\bSUPABASE_SECRET_KEY\b/);
  assert.doesNotMatch(v7, /\/rest\/v1\//);
});
