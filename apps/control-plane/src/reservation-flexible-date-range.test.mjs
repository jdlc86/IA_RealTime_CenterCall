import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  CALLER_AUTHORIZED_RANGE,
  decideReservationSearchDateRange,
} from "../.test-dist/reservation-search-date-range-policy.js";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("same-date search remains compatible without range authority", () => {
  assert.deepEqual(decideReservationSearchDateRange({
    fromLocalDate: "2026-08-26",
    toLocalDate: "2026-08-26",
    dateScope: null,
  }), { action: "SAME_DATE" });
});

test("a caller-authorized week remains a range instead of collapsing to its first day", () => {
  assert.deepEqual(decideReservationSearchDateRange({
    fromLocalDate: "2026-08-24",
    toLocalDate: "2026-08-31",
    dateScope: CALLER_AUTHORIZED_RANGE,
  }), { action: "ALLOW_RANGE", daySpan: 7 });
});

test("cross-date search fails closed without semantic caller authority", () => {
  assert.deepEqual(decideReservationSearchDateRange({
    fromLocalDate: "2026-08-24",
    toLocalDate: "2026-08-31",
    dateScope: "EXACT_DATE",
  }), { action: "BLOCK_RANGE", reason: "CALLER_RANGE_AUTHORITY_REQUIRED" });
});

test("search range cannot expand beyond seven calendar days", () => {
  assert.deepEqual(decideReservationSearchDateRange({
    fromLocalDate: "2026-08-24",
    toLocalDate: "2026-09-01",
    dateScope: CALLER_AUTHORIZED_RANGE,
  }), { action: "BLOCK_RANGE", reason: "RANGE_TOO_WIDE" });
});

test("active policy routes flexible dates to range search without phrase catalogues", async () => {
  const [bootstrap, v26, v29, v31, v50] = await Promise.all([
    source("direct-agent-realtime-bootstrap.ts"),
    source("call-session-v26.ts"),
    source("call-session-v29.ts"),
    source("call-session-v31.ts"),
    source("call-session-v50-reservation-date-scope.ts"),
  ]);

  assert.match(bootstrap, /CALLER_AUTHORIZED_RANGE/);
  assert.match(bootstrap, /no elijas un día representativo/);
  assert.doesNotMatch(bootstrap, /required: \["party_size"\]/);
  assert.match(v26, /"restaurant_reservation_search"/);
  assert.match(bootstrap, /una hora aportada después se aplica como preferencia horaria dentro del rango/);
  assert.match(bootstrap, /aunque todavía falte el número de personas/);
  assert.match(bootstrap, /día de la semana, la fecha y la hora exactos/);
  assert.match(v29, /directAgentInstructions/);
  assert.match(v31, /search_criteria/);
  assert.match(v31, /no materialices una fecha concreta/);
  assert.match(v31, /normalizeReservationSearchBoundary\(fromRaw/);
  assert.match(v31, /normalizeReservationSearchBoundary\(requestedToRaw/);
  assert.match(v31, /callerAuthorizedRange\s*\?\s*rows/);
  assert.match(v31, /date_scope: callerAuthorizedRange \? "CALLER_AUTHORIZED_RANGE"/);
  assert.match(v50, /RESERVATION_DATE_RANGE_DELEGATED_V50/);
  assert.doesNotMatch(`${bootstrap}\n${v29}`, /cualquier día de la semana que viene/i);
});
