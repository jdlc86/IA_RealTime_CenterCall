import test from "node:test";
import assert from "node:assert/strict";
import {
  createGeminiMediaEdgeHmacCredentialIssuer,
  issueGeminiMediaEdgeHmacCredential,
} from "../.test-dist/gemini-media-edge-hmac-credential-issuer.js";

const secret = "x".repeat(32);
const input = Object.freeze({
  credentialId: "cred-issuer-1",
  provider: "GEMINI",
  tenantId: "tenant-a",
  callControlId: "call-a",
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  targetLegs: "self",
  notAfterEpochMs: 2_000_000_000_000,
});

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

test("issuer creates v1 credential with only the authenticated edge binding", async () => {
  const credential = await issueGeminiMediaEdgeHmacCredential(input, secret);
  const [version, payload, signature] = credential.split(".");
  assert.equal(version, "v1");
  assert.ok(payload);
  assert.ok(signature);

  const decoded = JSON.parse(decodeBase64Url(payload).toString("utf8"));
  assert.deepEqual(decoded, input);
  assert.equal(JSON.stringify(decoded).includes(secret), false);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(`${version}.${payload}`),
  );
  assert.equal(verified, true);
});

test("provisioning adapter injects a unique credential id and returns only stream auth", async () => {
  const issue = createGeminiMediaEdgeHmacCredentialIssuer(secret, () => "cred-provisioned-1");
  const result = await issue({
    provider: "GEMINI",
    tenantId: "tenant-a",
    callControlId: "call-a",
    edgeUrl: "wss://media.example.test/telnyx/gemini",
    targetLegs: "self",
    notAfterEpochMs: 2_000_000_000_000,
  });
  assert.deepEqual(Object.keys(result), ["streamAuthToken"]);
  const [, payload] = result.streamAuthToken.split(".");
  const decoded = JSON.parse(decodeBase64Url(payload).toString("utf8"));
  assert.equal(decoded.credentialId, "cred-provisioned-1");
  assert.equal(decoded.callControlId, "call-a");
});

test("issuer fails closed on weak secrets or invalid binding", async () => {
  await assert.rejects(
    issueGeminiMediaEdgeHmacCredential(input, "short"),
    /at least 32 bytes/,
  );
  await assert.rejects(
    issueGeminiMediaEdgeHmacCredential({ ...input, edgeUrl: "ws://media.example.test/telnyx/gemini" }, secret),
    /must use wss:\/\//,
  );
  await assert.rejects(
    issueGeminiMediaEdgeHmacCredential({ ...input, targetLegs: "caller" }, secret),
    /target legs are invalid/,
  );
});
