import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./call-session-v50-reservation-date-scope.ts", import.meta.url), "utf8");

test("V50 consumes reservation date-change authority through the shared semantic tool port", () => {
  assert.match(source, /publicRestaurantToolAuthorizationPortFor/);
  assert.match(source, /\.decide\(\{/);
  assert.match(source, /result\.allowed && !result\.ignored && !result\.directedIgnoreRejected/);
  assert.match(source, /duplicate_of: result\.duplicateOf/);
  assert.doesNotMatch(source, /authorizePublicRestaurantTool\s*\(/);
  assert.doesNotMatch(source, /from "\.\/semantic-turn-coordinator\.js"/);
});

test("V50 keeps date-scope state in the neutral runtime", () => {
  assert.match(source, /reservationDateScopeRuntimeFor\(this\)/);
  assert.match(source, /runtime\.stagePendingChange/);
  assert.match(source, /runtime\.accept\(decision\)/);
  assert.match(source, /state_owner: "reservation_date_scope_runtime"/);
});

test("V50 blocks a stale or ambiguous relative date through the authoritative temporal port before business effects", () => {
  assert.match(source, /enforceReservationRelativeDateAuthority/);
  assert.match(source, /requestedLocalDate/);
  assert.match(source, /authorizeSemanticTool: \(\) => this\.authorizeBlockedDateToolV50\(toolEvent\)/);
  assert.match(source, /temporalAuthority\.handled/);
  assert.doesNotMatch(source, /session\.update/);
  assert.doesNotMatch(source, /clientContent/);
  assert.doesNotMatch(source, /realtimeInput/);
});

test("V50 validates a cross-date search against authoritative range semantics before delegation", () => {
  assert.match(source, /enforceReservationRelativeDateRangeAuthority/);
  assert.match(source, /requestedFromLocalDate: fromLocalDate/);
  assert.match(source, /requestedToLocalDateExclusive: toLocalDate/);
  assert.match(source, /temporalRangeAuthority\.handled/);
  assert.match(source, /RESERVATION_DATE_RANGE_DELEGATED_V50/);
  assert.ok(
    source.indexOf("temporalRangeAuthority.handled") < source.indexOf("RESERVATION_DATE_RANGE_DELEGATED_V50"),
    "relative range authority must run before lower range delegation",
  );
});
