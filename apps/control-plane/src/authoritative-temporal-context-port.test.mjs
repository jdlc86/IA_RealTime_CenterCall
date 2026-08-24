import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductOwnedAuthoritativeTemporalContextCapability,
  createRealtimeBackedAuthoritativeTemporalContextPort,
} from "../.test-dist/authoritative-temporal-context-port.js";

function fakeRealtime() {
  const policies = [];
  return {
    policies,
    speak() {},
    requestTextDecision() {},
    createSemanticResponse() {},
    submitToolResult() {},
    updateSessionPolicy(update) { policies.push(update); },
    createDefaultResponse() {},
    cancelResponse() {},
    clearPlayback() {},
    clearInput() {},
    discardInputItem() {},
    suspendInputDetection() {},
    beginNonInterruptingListening() {},
    restoreInputDetection() {},
  };
}

test("OpenAI temporal context preserves current authoritative instruction behavior behind the semantic port", () => {
  const realtime = fakeRealtime();
  const port = createRealtimeBackedAuthoritativeTemporalContextPort("OPENAI", realtime);
  port.refresh({
    baseInstructions: "Eres Lucía.",
    now: new Date("2026-08-23T11:05:00Z"),
    callerTurn: { itemId: "caller-1", transcript: "mañana a las nueve" },
  });

  assert.equal(realtime.policies.length, 1);
  assert.match(realtime.policies[0].instructions, /^Eres Lucía\./);
  assert.match(realtime.policies[0].instructions, /\[AUTHORITATIVE_NOW_V48\]/);
  assert.match(realtime.policies[0].instructions, /Europe\/Madrid/);
  assert.deepEqual(port.decideReservationDate("2026-08-24"), {
    action: "ALLOW",
    itemId: "caller-1",
    authoritativeLocalDate: "2026-08-24",
  });
});

test("Gemini temporal context fails before writing to Live until a provider-specific strategy is proven", () => {
  const realtime = fakeRealtime();
  const port = createRealtimeBackedAuthoritativeTemporalContextPort("GEMINI", realtime);

  assert.throws(
    () => port.refresh({ baseInstructions: "Eres Lucía." }),
    /GEMINI lacks required capabilities: authoritativeTemporalContext/,
  );
  assert.deepEqual(realtime.policies, []);
});

test("product-owned temporal context detects a stale Gemini date after Madrid rollover without Live writes", () => {
  const capability = createProductOwnedAuthoritativeTemporalContextCapability();
  capability.port.refresh({
    baseInstructions: "Eres Lucía.",
    now: new Date("2026-08-23T22:01:00Z"),
    callerTurn: { itemId: "gemini-caller-9", transcript: "mañana a las nueve" },
  });

  assert.deepEqual(capability.port.decideReservationDate("2026-08-24"), {
    action: "BLOCK_MISMATCH",
    itemId: "gemini-caller-9",
    authoritativeLocalDate: "2026-08-25",
    requestedLocalDate: "2026-08-24",
  });
  assert.deepEqual(capability.port.decideReservationDate("2026-08-25"), {
    action: "ALLOW",
    itemId: "gemini-caller-9",
    authoritativeLocalDate: "2026-08-25",
  });

  capability.close();
  assert.throws(() => capability.port.decideReservationDate("2026-08-25"), /is closed/);
});

test("product-owned temporal context validates flexible range endpoints with the same caller-turn clock", () => {
  const capability = createProductOwnedAuthoritativeTemporalContextCapability();
  capability.port.refresh({
    baseInstructions: "Eres Lucía.",
    now: new Date("2026-08-23T22:01:00Z"),
    callerTurn: { itemId: "gemini-range-1", transcript: "hoy o mañana" },
  });

  assert.deepEqual(capability.port.decideReservationDateRange("2026-08-23", "2026-08-25"), {
    action: "BLOCK_RANGE_MISMATCH",
    itemId: "gemini-range-1",
    requestedFromLocalDate: "2026-08-23",
    requestedToLocalDateExclusive: "2026-08-25",
    authoritativeFromLocalDate: "2026-08-24",
    authoritativeToLocalDateExclusive: "2026-08-26",
  });
  assert.equal(
    capability.port.decideReservationDateRange("2026-08-24", "2026-08-26").action,
    "ALLOW_RANGE",
  );
  capability.close();
});
