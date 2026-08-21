import test from "node:test";
import assert from "node:assert/strict";
import { callerSecurityPortFor } from "../.test-dist/caller-security-port.js";
import { humanHandoffPersistencePortFor } from "../.test-dist/human-handoff-persistence-port.js";

function host() {
  return {
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
    },
  };
}

test("caller-security provider composition is stable per session host", () => {
  const session = host();
  assert.equal(callerSecurityPortFor(session), callerSecurityPortFor(session));
  assert.notEqual(callerSecurityPortFor(session), callerSecurityPortFor(host()));
});

test("human-handoff persistence composition is stable per session host", () => {
  const session = host();
  assert.equal(humanHandoffPersistencePortFor(session), humanHandoffPersistencePortFor(session));
  assert.notEqual(humanHandoffPersistencePortFor(session), humanHandoffPersistencePortFor(host()));
});
