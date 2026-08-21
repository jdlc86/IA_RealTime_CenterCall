import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeMadridReservationIso,
  ReservationDatetimeRuntime,
  reservationDatetimeRuntimeFor,
} from "../.test-dist/reservation-datetime-runtime.js";

const NOW = Date.parse("2026-08-17T21:45:00Z");

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("Madrid local reservation time is normalized before reservation draft merge", () => {
  assert.equal(normalizeMadridReservationIso("2026-08-21T20:00"), "2026-08-21T20:00:00+02:00");
  const result = new ReservationDatetimeRuntime().canonicalizeCreate(host(), {
    callId: "call-future",
    nowEpochMs: NOW,
    arguments: { party_size: 2, starts_at: "2026-08-21T20:00" },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.arguments.starts_at, "2026-08-21T20:00:00+02:00");
});

test("past reservation datetime is rejected before availability", () => {
  const session = host();
  const result = new ReservationDatetimeRuntime().canonicalizeCreate(session, {
    callId: "call-past",
    nowEpochMs: NOW,
    arguments: { party_size: 2, starts_at: "2023-08-21T20:00" },
  });
  assert.deepEqual(result, { allowed: false });
  const output = JSON.parse(session.events[0].item.output);
  assert.equal(output.status, "RESERVATION_DATETIME_IN_PAST");
  assert.equal(output.reservation_created, false);
  assert.equal(output.availability_checked, false);
  assert.equal(session.events[1]?.type, "response.create");
});

test("invalid reservation datetime is rejected before availability", () => {
  const session = host();
  const result = new ReservationDatetimeRuntime().canonicalizeCreate(session, {
    callId: "call-invalid",
    nowEpochMs: NOW,
    arguments: { starts_at: "not-a-date" },
  });
  assert.equal(result.allowed, false);
  const output = JSON.parse(session.events[0].item.output);
  assert.equal(output.status, "INVALID_DATETIME");
  assert.equal(output.availability_checked, false);
});

test("datetime runtime is stable per session and isolated across sessions", () => {
  const a = {};
  const b = {};
  assert.equal(reservationDatetimeRuntimeFor(a), reservationDatetimeRuntimeFor(a));
  assert.notEqual(reservationDatetimeRuntimeFor(a), reservationDatetimeRuntimeFor(b));
});

test("V20 is a compatibility layer without realtime parsing or sending", () => {
  const v20 = readFileSync(new URL("./call-session-v20.ts", import.meta.url), "utf8");
  assert.match(v20, /call-session-v19/);
  assert.match(v20, /ReservationDatetimeRuntime/);
  assert.doesNotMatch(v20, /handleRealtimeMessage/);
  assert.doesNotMatch(v20, /readRealtimeText|TextDecoder/);
  assert.doesNotMatch(v20, /function_call_arguments/);
  assert.doesNotMatch(v20, /\.send\s*\?\./);
});

test("V19 applies datetime authority before ReservationSessionRuntime merges the draft", () => {
  const v19 = readFileSync(new URL("./call-session-v19.ts", import.meta.url), "utf8");
  const authority = v19.indexOf("reservationDatetimeRuntimeFor(this).canonicalizeCreate");
  const merge = v19.indexOf("runtime.mergeDraft(datetime.arguments, callerPhone)");
  assert.ok(authority >= 0 && merge > authority);
  assert.match(v19, /reservation_datetime_owner: "reservation_datetime_runtime"/);
  const runtime = readFileSync(new URL("./reservation-datetime-runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /decideReservationDatetimeValidity/);
  assert.match(runtime, /realtimeCommandPortFor/);
  assert.doesNotMatch(runtime, /\.send\s*\?\./);
});
