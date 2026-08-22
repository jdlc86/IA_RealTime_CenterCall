import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ReservationContactIdentityRuntime,
  reservationContactIdentityRuntimeFor,
} from "../.test-dist/reservation-contact-identity-runtime.js";

function host() {
  const events = [];
  return {
    events,
    send(event) { events.push(event); },
  };
}

test("neutral contact identity runtime canonicalizes trusted caller before reservation draft merge", () => {
  const runtime = new ReservationContactIdentityRuntime();
  const session = host();
  const original = {
    customer_name: "Efrain",
    customer_phone: "642651015",
  };
  const result = runtime.canonicalizeCreate(session, {
    callId: "call-1",
    trustedCallerPhone: "+34642651015",
    arguments: original,
  });

  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.equal(result.arguments.customer_phone, "+34642651015");
  assert.equal(result.arguments.use_caller_phone, true);
  assert.equal(original.customer_phone, "642651015");
  assert.equal(session.events.length, 0);
});

test("ambiguous alternate contact is rejected before lower reservation execution", () => {
  const runtime = new ReservationContactIdentityRuntime();
  const session = host();
  const result = runtime.canonicalizeCreate(session, {
    callId: "call-2",
    trustedCallerPhone: "+34642651015",
    arguments: {
      customer_phone: "642651015",
      use_caller_phone: false,
    },
  });

  assert.deepEqual(result, { allowed: false });
  assert.equal(session.events.some((event) => event?.type === "conversation.item.create"), true);
  assert.equal(session.events.some((event) => event?.type === "response.create"), true);
});

test("contact identity runtime is stable per session and isolated across sessions", () => {
  const a = {};
  const b = {};
  assert.equal(reservationContactIdentityRuntimeFor(a), reservationContactIdentityRuntimeFor(a));
  assert.notEqual(reservationContactIdentityRuntimeFor(a), reservationContactIdentityRuntimeFor(b));
});

test("contact authority lives at the neutral V19 boundary and V53 skips retired V52", () => {
  const v19 = readFileSync(new URL("./call-session-v19.ts", import.meta.url), "utf8");
  const v53 = readFileSync(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("./reservation-contact-identity-runtime.ts", import.meta.url), "utf8");
  const policy = readFileSync(new URL("./reservation-contact-identity.ts", import.meta.url), "utf8");

  assert.match(v53, /call-session-v51-malformed-tool-authority/);
  assert.doesNotMatch(v53, /call-session-v52-trusted-reservation-contact/);

  assert.match(v19, /reservationContactIdentityRuntimeFor/);
  assert.match(v19, /canonicalizeCreate\(this/);
  assert.match(v19, /if \(!contactIdentity\.allowed\) return/);
  assert.match(runtime, /canonicalizeReservationCreateContactArguments/);
  assert.match(runtime, /CONTACT_PHONE_REQUIRES_COUNTRY_CODE/);
  assert.match(runtime, /reservation_created:\s*false/);
  assert.match(runtime, /port\.submitToolResult/);
  assert.match(runtime, /port\.speak/);
  assert.match(runtime, /tools:\s*"DISABLED"/);
  assert.doesNotMatch(runtime, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(policy, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(policy, /rewriteReservationCreateContactEvent/);
});
