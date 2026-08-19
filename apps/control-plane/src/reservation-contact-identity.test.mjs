import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveReservationContactIdentity,
  rewriteReservationCreateContactEvent,
} from "../../.test-dist/reservation-contact-identity.js";

test("trusted caller remains authoritative when model emits national-format phone", () => {
  const result = resolveReservationContactIdentity({
    trustedCallerPhone: "+93642651015",
    suppliedPhone: "642651015",
  });
  assert.deepEqual(result, { phone: "+93642651015", source: "TRUSTED_CALLER" });
});

test("trusted caller remains authoritative when use_caller_phone=true", () => {
  const result = resolveReservationContactIdentity({
    trustedCallerPhone: "+34642651015",
    suppliedPhone: "+93642651015",
    useCallerPhone: true,
  });
  assert.deepEqual(result, { phone: "+34642651015", source: "TRUSTED_CALLER" });
});

test("explicit alternate contact must be internationally unambiguous", () => {
  assert.throws(() => resolveReservationContactIdentity({
    trustedCallerPhone: "+34642651015",
    suppliedPhone: "642651015",
    useCallerPhone: false,
  }), /explicit country calling code/i);

  assert.deepEqual(resolveReservationContactIdentity({
    trustedCallerPhone: "+34642651015",
    suppliedPhone: "00 93 642651015",
    useCallerPhone: false,
  }), { phone: "+93642651015", source: "EXPLICIT_OTHER_CONTACT" });
});

test("legacy omitted boolean accepts only explicit international alternate contact", () => {
  assert.deepEqual(resolveReservationContactIdentity({
    trustedCallerPhone: "+34642651015",
    suppliedPhone: "+93642651015",
  }), { phone: "+93642651015", source: "EXPLICIT_OTHER_CONTACT" });
});

test("reservation_create wire event is rewritten before lower reservation controller", () => {
  const wire = JSON.stringify({
    type: "response.function_call_arguments.done",
    name: "restaurant_reservation_create",
    call_id: "call_1",
    arguments: JSON.stringify({
      party_size: 15,
      customer_name: "Efrain",
      customer_phone: "642651015",
      confirm: true,
    }),
  });
  const rewritten = rewriteReservationCreateContactEvent(wire, "+34642651015");
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.source, "TRUSTED_CALLER");
  const event = JSON.parse(rewritten.data);
  const args = JSON.parse(event.arguments);
  assert.equal(args.customer_phone, "+34642651015");
  assert.equal(args.use_caller_phone, true);
});

test("malformed tool arguments are left to V51/V25 recovery", () => {
  const wire = JSON.stringify({
    type: "response.function_call_arguments.done",
    name: "restaurant_reservation_create",
    call_id: "call_2",
    arguments: '{"party_size":15,"customer_phone":',
  });
  const rewritten = rewriteReservationCreateContactEvent(wire, "+34642651015");
  assert.equal(rewritten.changed, false);
  assert.equal(rewritten.data, wire);
});
