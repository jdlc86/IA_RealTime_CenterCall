import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { malformedToolCorrectionRuntimeFor } from "../.test-dist/malformed-tool-correction-runtime.js";
import { publicRestaurantToolAuthorizationPortFor } from "../.test-dist/semantic-tool-authorization-port.js";
import { semanticTurnRuntimeFor } from "../.test-dist/semantic-turn-runtime.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("malformed JSON reaches lower validation without consuming semantic authority", () => {
  const session = host();
  const port = publicRestaurantToolAuthorizationPortFor(session);
  const decision = port.decide({
    name: "restaurant_reservation_create",
    call_id: "call-malformed",
    arguments: '{"party_size":',
  });

  assert.deepEqual(decision, {
    allowed: true,
    ignored: false,
    duplicateOf: null,
    directedIgnoreRejected: false,
  });
  assert.equal(semanticTurnRuntimeFor(session).snapshot().selectedTool, null);
  assert.equal(malformedToolCorrectionRuntimeFor(session).snapshot().pendingMalformedTool, "restaurant_reservation_create");
});

test("same-tool correction is released to semantic authority exactly once", () => {
  const session = host();
  const port = publicRestaurantToolAuthorizationPortFor(session);
  port.decide({
    name: "restaurant_reservation_create",
    call_id: "call-malformed",
    arguments: '{"party_size":',
  });

  const corrected = port.decide({
    name: "restaurant_reservation_create",
    call_id: "call-corrected",
    arguments: '{"party_size":2}',
  });
  assert.equal(corrected.allowed, true);
  assert.equal(corrected.ignored, false);
  assert.equal(semanticTurnRuntimeFor(session).snapshot().selectedTool, "restaurant_reservation_create");
  assert.equal(malformedToolCorrectionRuntimeFor(session).snapshot().pendingMalformedTool, null);

  const duplicate = port.decide({
    name: "restaurant_reservation_create",
    call_id: "call-duplicate",
    arguments: '{"party_size":2}',
  });
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.duplicateOf, "restaurant_reservation_create");
});

test("cross-tool correction is rejected before semantic authority can consume it", () => {
  const session = host();
  const port = publicRestaurantToolAuthorizationPortFor(session);
  port.decide({
    name: "restaurant_reservation_create",
    call_id: "call-malformed",
    arguments: '{"party_size":',
  });

  const rejected = port.decide({
    name: "restaurant_reservation_cancel",
    call_id: "call-cross-tool",
    arguments: '{"confirm":true}',
  });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.ignored, false);
  assert.equal(semanticTurnRuntimeFor(session).snapshot().selectedTool, null);
  assert.equal(malformedToolCorrectionRuntimeFor(session).snapshot().recoveryRequired, true);
  assert.equal(session.events.some((event) => event?.type === "conversation.item.create"), true);
});

test("boolean authorization remains compatible for consumers that do not need detailed semantics", () => {
  const session = host();
  const port = publicRestaurantToolAuthorizationPortFor(session);
  assert.equal(port.authorize({
    name: "restaurant_business_info",
    call_id: "call-info",
    arguments: '{}',
  }), true);
});

test("V29 and V31 share the same neutral authorization boundary", () => {
  const v29 = readFileSync(new URL("./call-session-v29.ts", import.meta.url), "utf8");
  const v31 = readFileSync(new URL("./call-session-v31.ts", import.meta.url), "utf8");
  const port = readFileSync(new URL("./semantic-tool-authorization-port.ts", import.meta.url), "utf8");

  assert.match(v29, /publicRestaurantToolAuthorizationPortFor\(this\)\.decide\(event\)/);
  assert.match(v31, /publicRestaurantToolAuthorizationPortFor\(this\)\.authorize/);
  assert.doesNotMatch(v29, /authorizePublicRestaurantTool\(this/);
  assert.match(port, /malformedToolCorrectionRuntimeFor\(session\)\.preauthorize/);
  assert.match(port, /authorizePublicRestaurantTool\(session, request\)/);
});
