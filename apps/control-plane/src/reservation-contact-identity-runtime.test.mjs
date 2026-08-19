import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("V52 rejects ambiguous alternate contact without executing lower reservation flow", () => {
  const v52 = readFileSync(new URL("./call-session-v52-trusted-reservation-contact.ts", import.meta.url), "utf8");
  assert.match(v52, /CONTACT_PHONE_REQUIRES_COUNTRY_CODE/);
  assert.match(v52, /reservation_created:\s*false/);
  assert.match(v52, /tools:\s*"DISABLED"/);
  assert.match(v52, /port\.submitToolResult/);
  assert.match(v52, /port\.speak/);
  assert.match(v52, /return;\s*\n\s*}/);
});

test("V52 remains layered above V51 and adds no timing heuristic", () => {
  const v52 = readFileSync(new URL("./call-session-v52-trusted-reservation-contact.ts", import.meta.url), "utf8");
  assert.match(v52, /call-session-v51-malformed-tool-authority/);
  assert.match(v52, /rewriteReservationCreateContactEvent/);
  assert.doesNotMatch(v52, /setTimeout|sleep\s*\(|delay\s*\(/);
});
