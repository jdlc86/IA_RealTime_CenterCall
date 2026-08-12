import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTrustedCallerTransferHeaders,
  normalizeTrustedCallerNumber,
} from "../.test-dist/trusted-caller-propagation.js";

test("normalizes trusted Telnyx caller number", () => {
  assert.equal(normalizeTrustedCallerNumber("+34612345678", "+34910788224"), "+34612345678");
});

test("rejects called number as caller identity", () => {
  assert.equal(normalizeTrustedCallerNumber("+34910788224", "+34910788224"), null);
});

test("fails closed for malformed caller number", () => {
  assert.equal(normalizeTrustedCallerNumber("anonymous", "+34910788224"), null);
});

test("builds explicit trusted caller SIP header", () => {
  const headers = buildTrustedCallerTransferHeaders(
    "+34612345678",
    "restaurante-centro",
    "+34910788224",
    "called_number",
  );
  assert.deepEqual(headers.at(-1), { name: "X-IA-Caller-Number", value: "+34612345678" });
});
