import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MALFORMED_TOOL_RECOVERY_PURPOSE,
  MalformedToolCorrectionRuntime,
  malformedToolCorrectionRuntimeFor,
} from "../.test-dist/malformed-tool-correction-runtime.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("malformed correction runtime preserves invalid same-tool repair without consuming semantic authority", () => {
  const runtime = new MalformedToolCorrectionRuntime();
  const session = host();

  assert.equal(runtime.preauthorize(session, {
    name: "restaurant_reservation_create",
    call_id: "call-malformed",
    arguments: '{"party_size":',
  }), "ALLOW_INVALID_WITHOUT_CONSUMING");
  assert.equal(runtime.snapshot().pendingMalformedTool, "restaurant_reservation_create");
  assert.equal(session.events.length, 0);

  assert.equal(runtime.preauthorize(session, {
    name: "restaurant_reservation_create",
    call_id: "call-corrected",
    arguments: '{"party_size":2}',
  }), "PASS_TO_SEMANTIC_AUTHORITY");
  assert.equal(runtime.snapshot().pendingMalformedTool, null);
});

test("cross-tool correction is rejected once and affinity clears only after recovery plus a fresh caller turn", () => {
  const runtime = new MalformedToolCorrectionRuntime();
  const session = host();
  runtime.preauthorize(session, {
    name: "restaurant_reservation_create",
    call_id: "call-malformed",
    arguments: '{"party_size":',
  });

  assert.equal(runtime.preauthorize(session, {
    name: "restaurant_human_assistance",
    call_id: "call-cross-tool",
    arguments: '{}',
  }), "REJECT_CROSS_TOOL_CORRECTION");
  assert.equal(runtime.snapshot().recoveryRequired, true);
  assert.equal(session.events.some((event) => event?.type === "conversation.item.create"), true);
  assert.equal(session.events.some((event) => event?.type === "response.create" && event?.response?.metadata?.purpose === MALFORMED_TOOL_RECOVERY_PURPOSE), true);

  const responseCreatesBeforeRepeat = session.events.filter((event) => event?.type === "response.create").length;
  runtime.preauthorize(session, {
    name: "restaurant_business_info",
    call_id: "call-repeat-cross-tool",
    arguments: '{}',
  });
  assert.equal(session.events.filter((event) => event?.type === "response.create").length, responseCreatesBeforeRepeat);

  runtime.observe(session, {
    type: "ASSISTANT_RESPONSE_STARTED",
    responseId: "recovery-1",
    kind: "NORMAL",
    purpose: MALFORMED_TOOL_RECOVERY_PURPOSE,
  });
  runtime.observe(session, { type: "ASSISTANT_AUDIO_STOPPED", responseId: "recovery-1" });
  runtime.observe(session, { type: "CALLER_TRANSCRIPT_COMPLETED", transcript: "quiero cancelar", itemId: "turn-late" });
  assert.equal(runtime.snapshot().pendingMalformedTool, "restaurant_reservation_create");
  runtime.observe(session, { type: "CALLER_SPEECH_STARTED", itemId: "turn-new" });
  runtime.observe(session, { type: "CALLER_TRANSCRIPT_COMPLETED", transcript: "quiero cancelar", itemId: "turn-new" });
  assert.equal(runtime.snapshot().pendingMalformedTool, null);
});

test("malformed correction runtime is stable per session and isolated across sessions", () => {
  const a = {};
  const b = {};
  assert.equal(malformedToolCorrectionRuntimeFor(a), malformedToolCorrectionRuntimeFor(a));
  assert.notEqual(malformedToolCorrectionRuntimeFor(a), malformedToolCorrectionRuntimeFor(b));
});

test("v51 no longer exposes a historical V29 authorization hook", async () => {
  const v51 = await readFile(new URL("./call-session-v51-malformed-tool-authority.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("./semantic-tool-authorization-port.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("./malformed-tool-correction-runtime.ts", import.meta.url), "utf8");

  assert.match(v51, /malformedToolCorrectionRuntimeFor/);
  assert.match(v51, /runtime\.observe\(this, event\)/);
  assert.doesNotMatch(v51, /authorizePublicRestaurantToolV29/);
  assert.doesNotMatch(v51, /malformedToolCorrectionV51/);
  assert.doesNotMatch(v51, /malformedRecoveryResponseIdV51/);
  assert.doesNotMatch(v51, /realtimeCommandPortFor/);

  assert.match(port, /malformedToolCorrectionRuntimeFor\(session\)\.preauthorize/);
  assert.match(port, /authorizePublicRestaurantTool\(session, request\)/);
  assert.doesNotMatch(port, /LegacySemanticAuthoritySession/);
  assert.doesNotMatch(port, /authorizePublicRestaurantToolV29/);
  assert.match(runtime, /decideMalformedToolCorrection/);
  assert.match(runtime, /SEMANTIC_TOOL_CROSS_TOOL_CORRECTION_BLOCKED_V51/);
  assert.match(runtime, /tools:\s*"DISABLED"/);
});
