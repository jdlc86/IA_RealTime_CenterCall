import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("v31 owns transient multi-table execution while shared reservation facts stay neutral", async () => {
  const v31 = await source("call-session-v31.ts");

  assert.match(v31, /reservationSessionRuntimeFor\(this\)\.snapshot\(\)\.draft/);
  assert.match(v31, /draft\.separate_tables_acceptable === true/);
  assert.match(v31, /draft\.tables_must_be_close === true/);
  assert.match(v31, /create_restaurant_reservation_multi/);
  assert.match(v31, /this\.planV31/);

  assert.doesNotMatch(v31, /multitablePlanV16/);
  assert.doesNotMatch(v31, /multitableKeyV16/);
  assert.doesNotMatch(v31, /separateTablesAcceptableV16/);
  assert.doesNotMatch(v31, /tablesMustBeCloseV16/);
  assert.doesNotMatch(v31, /reservationDraftV19/);
});

test("v31 consumes provider and semantic authority through neutral ports", async () => {
  const v31 = await source("call-session-v31.ts");
  const port = await source("semantic-tool-authorization-port.ts");
  const correctionRuntime = await source("malformed-tool-correction-runtime.ts");

  assert.match(v31, /adaptRealtimeProviderEvents/);
  assert.match(v31, /realtimeCommandPortFor/);
  assert.match(v31, /publicRestaurantToolAuthorizationPortFor/);
  assert.doesNotMatch(v31, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(v31, /conversation\.item\.create/);
  assert.doesNotMatch(v31, /BasePrototype\.sendFunctionOutputV19/);
  assert.doesNotMatch(v31, /this\.authorizePublicRestaurantToolV29/);

  assert.match(port, /malformedToolCorrectionRuntimeFor\(session\)\.preauthorize/);
  assert.match(port, /authorizePublicRestaurantTool\(session, request\)/);
  assert.doesNotMatch(port, /authorizePublicRestaurantToolV29/);
  assert.match(correctionRuntime, /decideMalformedToolCorrection/);
});
