import assert from "node:assert/strict";
import { test } from "node:test";
import { extractE164FromSipIdentity, extractTrustedCallerPhone } from "../.test-dist/caller-id.js";

test("extracts E.164 from SIP From identity", () => {
  assert.equal(extractE164FromSipIdentity('"Juan" <sip:+34612345678@example.com>;tag=abc'), "+34612345678");
});

test("prefers P-Asserted-Identity over From", () => {
  const result = extractTrustedCallerPhone([
    { name: "From", value: "<sip:+34611111111@example.com>" },
    { name: "P-Asserted-Identity", value: "<sip:+34622222222@example.com>" },
  ]);
  assert.equal(result, "+34622222222");
});

test("falls back to From when asserted identity is absent", () => {
  const result = extractTrustedCallerPhone([{ name: "From", value: "<tel:+34633333333>" }]);
  assert.equal(result, "+34633333333");
});

test("unparseable SIP identity fails closed", () => {
  assert.equal(extractTrustedCallerPhone([{ name: "From", value: "anonymous" }]), null);
});
