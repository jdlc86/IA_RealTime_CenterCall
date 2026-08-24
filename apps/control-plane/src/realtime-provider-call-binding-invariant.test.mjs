import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  bindRealtimeProvider,
  realtimeCommandPortFor,
  realtimeProviderFor,
} from "../.test-dist/realtime-provider-runtime.js";

const runtimeSource = readFileSync(new URL("./realtime-provider-runtime.ts", import.meta.url), "utf8");
const selectionSource = readFileSync(new URL("./call-session-v49-provider-selection.ts", import.meta.url), "utf8");
const compositionSource = readFileSync(new URL("./realtime-provider-call-session-composition.ts", import.meta.url), "utf8");

function host() {
  return { send() {} };
}

test("provider identity is immutable for the whole call even after runtime creation", () => {
  const h = host();
  bindRealtimeProvider(h, "OPENAI");
  realtimeCommandPortFor(h);

  assert.throws(
    () => bindRealtimeProvider(h, "GEMINI"),
    /already bound as OPENAI/,
  );
  assert.equal(realtimeProviderFor(h), "OPENAI");
});

test("rebinding the same provider is idempotent and never creates a provider transition", () => {
  const h = host();
  bindRealtimeProvider(h, "OPENAI");
  const first = realtimeCommandPortFor(h);
  bindRealtimeProvider(h, "OPENAI");
  const second = realtimeCommandPortFor(h);

  assert.equal(first, second);
  assert.equal(realtimeProviderFor(h), "OPENAI");
});

test("tenant provider selection occurs only on call start before the inherited call bootstrap", () => {
  assert.match(selectionSource, /const isStart = request\.method === "POST"/);
  assert.match(selectionSource, /if \(isStart\) \{/);
  assert.match(selectionSource, /selectRealtimeProvider\(config, kv\)/);
  assert.match(selectionSource, /prepareRealtimeProviderCallSession\(this as any, selection, callControlId\)/);
  assert.match(compositionSource, /bindRealtimeProvider\(host, selection\.provider\)/);
  assert.match(compositionSource, /bindAdmittedRealtimeProvider\(host, selection, admission\)/);

  const bindIndex = selectionSource.indexOf("prepareRealtimeProviderCallSession(this as any, selection, callControlId)");
  const superIndex = selectionSource.indexOf("await super.fetch(request)");
  assert.ok(bindIndex >= 0 && superIndex >= 0 && bindIndex < superIndex);
});

test("runtime rejects cross-provider rebinding instead of implementing in-call failover", () => {
  assert.match(runtimeSource, /existingProvider && existingProvider !== provider/);
  assert.match(runtimeSource, /Realtime provider already bound as/);
  assert.doesNotMatch(runtimeSource, /fallbackProvider|failoverProvider|switchProvider|rebindProvider/);
});
