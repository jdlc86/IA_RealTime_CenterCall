import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHORITATIVE_TEMPORAL_TOOL_RESULT_INSTRUCTION,
  withAuthoritativeTemporalToolResult,
} from "../.test-dist/authoritative-temporal-tool-result.js";

test("correlated tool result carries a fresh authoritative Madrid snapshot without mutating input", () => {
  const output = { ok: true, status: "CONVERSATION", mutation: false };
  const request = { callId: "conversation-1", toolName: "restaurant_conversation", output };
  const enriched = withAuthoritativeTemporalToolResult(request, new Date("2026-08-23T22:01:00Z"));

  assert.notEqual(enriched, request);
  assert.notEqual(enriched.output, output);
  assert.deepEqual(output, { ok: true, status: "CONVERSATION", mutation: false });
  assert.deepEqual(enriched.output, {
    ok: true,
    status: "CONVERSATION",
    mutation: false,
    authoritative_temporal_context: {
      timezone: "Europe/Madrid",
      now_iso: "2026-08-24T00:01:00+02:00",
      calendar_date: "24 de agosto de 2026",
      clock_time: "00:01",
      weekday: "lunes",
    },
    authoritative_temporal_instruction: AUTHORITATIVE_TEMPORAL_TOOL_RESULT_INSTRUCTION,
  });
});

test("non-object outputs retain exact compatibility", () => {
  const text = { toolName: "legacy", output: "legacy-output" };
  const list = { toolName: "legacy", output: ["legacy-output"] };
  assert.equal(withAuthoritativeTemporalToolResult(text), text);
  assert.equal(withAuthoritativeTemporalToolResult(list), list);
});
