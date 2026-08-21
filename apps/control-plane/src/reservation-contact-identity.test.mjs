import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeReservationCreateContactArguments,
  resolveReservationContactIdentity,
} from "../.test-dist/reservation-contact-identity.js";

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

test("omitted caller-contact flag never lets model replace operator identity", () => {
  const result = resolveReservationContactIdentity({
    trustedCallerPhone: "+34642651015",
    suppliedPhone: "+93642651015",
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

test("reservation create arguments are canonicalized without reconstructing provider wire", () => {
  const original = {
    party_size: 15,
    customer_name: "Efrain",
    customer_phone: "642651015",
    confirm: true,
  };
  const canonical = canonicalizeReservationCreateContactArguments(original, "+34642651015");
  assert.equal(canonical.changed, true);
  assert.equal(canonical.source, "TRUSTED_CALLER");
  assert.equal(canonical.arguments.customer_phone, "+34642651015");
  assert.equal(canonical.arguments.use_caller_phone, true);
  assert.deepEqual(original, {
    party_size: 15,
    customer_name: "Efrain",
    customer_phone: "642651015",
    confirm: true,
  });
});

test("explicit globally unambiguous alternate contact remains authoritative", () => {
  const canonical = canonicalizeReservationCreateContactArguments({
    customer_phone: "00 93 642651015",
    use_caller_phone: false,
  }, "+34642651015");
  assert.equal(canonical.changed, true);
  assert.equal(canonical.source, "EXPLICIT_OTHER_CONTACT");
  assert.equal(canonical.arguments.customer_phone, "+93642651015");
  assert.equal(canonical.arguments.use_caller_phone, false);
});

test("without trusted caller identity the semantic arguments pass through unchanged", () => {
  const original = { customer_phone: "+34642651015" };
  const canonical = canonicalizeReservationCreateContactArguments(original, null);
  assert.equal(canonical.changed, false);
  assert.equal(canonical.arguments, original);
});
