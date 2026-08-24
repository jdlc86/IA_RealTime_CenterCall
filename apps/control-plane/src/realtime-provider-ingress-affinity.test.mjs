import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const ingress = readFileSync(new URL("./index-v4.ts", import.meta.url), "utf8");
const openaiBootstrap = readFileSync(new URL("./index-v2.ts", import.meta.url), "utf8");
const sessionSelection = readFileSync(new URL("./call-session-v49-provider-selection.ts", import.meta.url), "utf8");
const sessionComposition = readFileSync(new URL("./realtime-provider-call-session-composition.ts", import.meta.url), "utf8");

test("Telnyx ingress selects provider before choosing transport and propagates affinity", () => {
  assert.match(ingress, /selectRealtimeProvider\(config, kv\)/);
  assert.match(ingress, /authorizeRealtimeProviderTraffic\(selection/);
  assert.match(ingress, /requireInboundRealtimeRouteReady\(selection, admission\)/);
  assert.match(ingress, /buildTrustedCallerTransferHeaders[\s\S]*provider: selection\.provider[\s\S]*source: selection\.source/);
  assert.match(ingress, /fallback_provider_used: false/);
  assert.doesNotMatch(ingress, /fallbackProvider|failoverProvider|switchProvider/);
});

test("active Gemini ingress finishes admission before the only streaming_start effect", () => {
  const tenant = ingress.indexOf("resolveInboundRealtime(repository, calledNumber");
  const immutableProvider = ingress.indexOf("admitGeminiMediaEdgeInboundCall({");
  const callerSecurity = ingress.indexOf("evaluateCallerSecurity()", immutableProvider);
  const credential = ingress.indexOf("issueCredential,", callerSecurity);
  const bootstrap = ingress.indexOf("registerBootstrap(input)", credential);
  const callSession = ingress.indexOf("startCallSession(input)", bootstrap);
  const sideband = ingress.indexOf("requireSidebandReady(input)", callSession);
  const answer = ingress.indexOf("answerCall(request)", sideband);
  const streaming = ingress.indexOf("startStreaming(request)", answer);

  assert.ok(tenant >= 0);
  assert.ok(immutableProvider > tenant);
  assert.ok(callerSecurity > immutableProvider);
  assert.ok(credential > callerSecurity);
  assert.ok(bootstrap > credential);
  assert.ok(callSession > bootstrap);
  assert.ok(sideband > callSession);
  assert.ok(answer > sideband);
  assert.ok(streaming > answer);
  assert.match(ingress, /streaming\.answer\(request\)/);
  assert.match(ingress, /return streaming\.start\(request\)/);
  assert.doesNotMatch(ingress, /realtime_transport_unavailable/);
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
  assert.match(sessionSelection, /prepareRealtimeProviderCallSession\(this as any, selection, callControlId\)/);
  assert.match(sessionComposition, /bindAdmittedRealtimeProvider\(host, selection, admission\)/);
  assert.match(sessionComposition, /connectGeminiMediaEdgeSidebandToProviderHost/);
  assert.doesNotMatch(sessionSelection, /fallbackProvider|failoverProvider|switchProvider/);
});
