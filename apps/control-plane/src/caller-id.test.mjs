import assert from "node:assert/strict";
import { test } from "node:test";
import { extractE164FromSipIdentity, extractTrustedCallerPhone } from "../.test-dist/caller-id.js";

test("extracts E.164 from SIP From identity", () => {
  assert.equal(extractE164FromSipIdentity('"Juan" <sip:+34612345678@example.com>;tag=abc'), "+34612345678");
});

test("prefers explicitly propagated caller header", () => {
  const result = extractTrustedCallerPhone([
    { name: "From", value: "<sip:+34910788224@example.com>" },
    { name: "X-IA-Caller-Number", value: "+34612345678" },
  ]);
  assert.equal(result, "+34612345678");
});

test("prefers P-Asserted-Identity over From when neither is excluded", () => {
  const result = extractTrustedCallerPhone([
    { name: "From", value: "<sip:+34611111111@example.com>" },
    { name: "P-Asserted-Identity", value: "<sip:+34622222222@example.com>" },
  ]);
  assert.equal(result, "+34622222222");
});

test("skips called number and continues to a different caller identity", () => {
  const result = extractTrustedCallerPhone([
    { name: "P-Asserted-Identity", value: "<sip:+34910788224@example.com>" },
    { name: "From", value: "<sip:+34633333333@example.com>" },
  ], ["+34910788224"]);
  assert.equal(result, "+34633333333");
});

test("fails closed when every available identity is the called number", () => {
  const result = extractTrustedCallerPhone([
    { name: "P-Asserted-Identity", value: "<sip:+34910788224@example.com>" },
    { name: "From", value: "<sip:+34910788224@example.com>" },
  ], ["+34910788224"]);
  assert.equal(result, null);
});

test("unparseable SIP identity fails closed", () => {
  assert.equal(extractTrustedCallerPhone([{ name: "From", value: "anonymous" }]), null);
});
