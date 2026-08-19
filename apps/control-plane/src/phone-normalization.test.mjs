import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhoneToE164, phonesEquivalent } from "../.test-dist/phone-normalization.js";

test("keeps canonical E.164 unchanged", () => {
  assert.equal(normalizePhoneToE164("+34642651015"), "+34642651015");
});

test("normalizes international 00 prefix and presentation punctuation", () => {
  assert.equal(normalizePhoneToE164("00 34 642-651-015"), "+34642651015");
});

test("normalizes Spanish national numbers using the explicit tenant default country code", () => {
  assert.equal(normalizePhoneToE164("642 651 015", { defaultCountryCallingCode: "+34" }), "+34642651015");
  assert.equal(normalizePhoneToE164("647947762", { defaultCountryCallingCode: "+34" }), "+34647947762");
});

test("does not guess the country for a national-format number without a default", () => {
  assert.throws(() => normalizePhoneToE164("642651015"), /country/i);
});

test("equivalence is based on canonical E.164, not raw formatting", () => {
  assert.equal(phonesEquivalent("+34 642 651 015", "642651015", { defaultCountryCallingCode: "+34" }), true);
  assert.equal(phonesEquivalent("+34642651015", "+34647944762", { defaultCountryCallingCode: "+34" }), false);
});

test("rejects malformed or implausible E.164 values", () => {
  for (const value of ["", "+34abc", "+0012345678", "1234"]) {
    assert.throws(() => normalizePhoneToE164(value, { defaultCountryCallingCode: "+34" }));
  }
});
