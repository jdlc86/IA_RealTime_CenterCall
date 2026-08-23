import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const ingress = readFileSync(new URL("./index-v4.ts", import.meta.url), "utf8");
const openaiBootstrap = readFileSync(new URL("./index-v2.ts", import.meta.url), "utf8");
const sessionSelection = readFileSync(new URL("./call-session-v49-provider-selection.ts", import.meta.url), "utf8");

test("Telnyx ingress selects provider before choosing transport and propagates affinity", () => {
  assert.match(ingress, /selectRealtimeProvider\(config, kv\)/);
  assert.match(ingress, /requireInboundRealtimeRouteReady\(selection\)/);
  assert.match(ingress, /buildTrustedCallerTransferHeaders[\s\S]*provider: selection\.provider[\s\S]*source: selection\.source/);
  assert.match(ingress, /fallback_provider_used: false/);
  assert.doesNotMatch(ingress, /fallbackProvider|failoverProvider|switchProvider/);
});

test("OpenAI webhook preserves signed SIP affinity into CallSession start", () => {
  assert.match(openaiBootstrap, /REALTIME_PROVIDER_HEADER/);
  assert.match(openaiBootstrap, /REALTIME_PROVIDER_SOURCE_HEADER/);
  assert.match(openaiBootstrap, /parseRealtimeProviderAffinity\(providerHeader, providerSourceHeader\)/);
  assert.match(openaiBootstrap, /affinity\.provider !== "OPENAI"/);
  assert.match(openaiBootstrap, /realtime_provider: affinity\.provider/);
  assert.match(openaiBootstrap, /realtime_provider_source: affinity\.source/);
  assert.match(openaiBootstrap, /fallback_provider_used: false/);
});

test("CallSession consumes propagated affinity before any compatibility re-resolution", () => {
  assert.match(sessionSelection, /realtime_provider\?: unknown/);
  assert.match(sessionSelection, /parseRealtimeProviderAffinity/);
  assert.match(sessionSelection, /bindRealtimeProvider\(this as any, provider\)/);
  assert.doesNotMatch(sessionSelection, /fallbackProvider|failoverProvider|switchProvider/);
});
