import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  installRealtimeToolResultPolicy,
  installRealtimeToolResultTransform,
  realtimeCommandPortFor,
} from "../.test-dist/realtime-provider-runtime.js";
import {
  formatMadridReservationSpeech,
  formatMadridReservationTime,
  localizeReservationSearchToolResult,
} from "../.test-dist/reservation-search-output-localization.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

function asObject(value) {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value;
}

test("reservation search formatter uses authoritative Europe/Madrid daylight time", () => {
  assert.equal(formatMadridReservationTime("2026-08-20T18:00:00.000Z"), "2026-08-20T20:00");
  assert.equal(formatMadridReservationSpeech("2026-08-20T18:00:00.000Z"), "jueves, 20 de agosto, a las 20:00");
  assert.equal(formatMadridReservationTime("not-a-date"), null);
  assert.equal(formatMadridReservationSpeech("not-a-date"), null);
});

test("reservation search localization is scoped, immutable, and preserves UTC", () => {
  const output = {
    ok: true,
    status: "SUGGESTIONS_AVAILABLE",
    options: [{ starts_at: "2026-08-20T18:00:00.000Z", allocation_mode: "SINGLE" }],
  };
  const request = {
    callId: "search-a",
    toolName: "restaurant_reservation_search",
    output,
  };

  const localized = localizeReservationSearchToolResult(request);
  assert.notEqual(localized, request);
  assert.notEqual(localized.output, output);
  assert.deepEqual(output, {
    ok: true,
    status: "SUGGESTIONS_AVAILABLE",
    options: [{ starts_at: "2026-08-20T18:00:00.000Z", allocation_mode: "SINGLE" }],
  });

  const localizedOutput = asObject(localized.output);
  assert.equal(localizedOutput.timezone, "Europe/Madrid");
  assert.match(localizedOutput.instruction, /starts_at_spoken/);
  assert.match(localizedOutput.instruction, /día de la semana, fecha y hora/);
  assert.deepEqual(localizedOutput.options[0], {
    starts_at: "2026-08-20T18:00:00.000Z",
    allocation_mode: "SINGLE",
    starts_at_utc: "2026-08-20T18:00:00.000Z",
    starts_at_local: "2026-08-20T20:00",
    starts_at_spoken: "jueves, 20 de agosto, a las 20:00",
    timezone: "Europe/Madrid",
  });
});

test("reservation search localization passes unrelated results through unchanged", () => {
  const wrongTool = { toolName: "restaurant_reservation_create", output: { status: "SUGGESTIONS_AVAILABLE", options: [] } };
  const wrongStatus = { toolName: "restaurant_reservation_search", output: { status: "NOT_FOUND", options: [] } };
  const nonObject = { toolName: "restaurant_reservation_search", output: "not-an-object" };
  assert.equal(localizeReservationSearchToolResult(wrongTool), wrongTool);
  assert.equal(localizeReservationSearchToolResult(wrongStatus), wrongStatus);
  assert.equal(localizeReservationSearchToolResult(nonObject), nonObject);
});

test("tool-result transforms compose before the downstream result policy", () => {
  const h = host();
  const order = [];
  let observed = null;

  installRealtimeToolResultTransform(h, (request) => {
    order.push("first");
    return { ...request, output: { ...request.output, first: true } };
  });
  installRealtimeToolResultTransform(h, (request) => {
    order.push("second");
    return { ...request, output: { ...request.output, second: true } };
  });
  installRealtimeToolResultPolicy(h, (request) => {
    order.push("policy");
    observed = request;
    return { action: "PASS" };
  });

  realtimeCommandPortFor(h).submitToolResult({
    callId: "search-b",
    toolName: "restaurant_reservation_search",
    output: { ok: true },
  });

  assert.deepEqual(order, ["first", "second", "policy"]);
  assert.deepEqual(observed.output, { ok: true, first: true, second: true });
});

test("v32 no longer intercepts provider wire messages", async () => {
  const source = await readFile(new URL("./call-session-v32.ts", import.meta.url), "utf8");
  assert.match(source, /installRealtimeToolResultTransform/);
  assert.match(source, /localizeReservationSearchToolResult/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
  assert.doesNotMatch(source, /session\.send/);
  assert.doesNotMatch(source, /JSON\.parse/);
  assert.doesNotMatch(source, /currentSend|original\(message\)/);
});
