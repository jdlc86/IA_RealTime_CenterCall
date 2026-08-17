import test from "node:test";
import assert from "node:assert/strict";
import { hasUsablePresenceTranscript } from "../.test-dist/presence-overlap-evidence-policy.js";

test("completed overlapping transcript with caller text counts as presence evidence", () => {
  assert.equal(hasUsablePresenceTranscript("Sí, sigo aquí"), true);
  assert.equal(hasUsablePresenceTranscript("vale"), true);
});

test("empty or punctuation-only overlap is not presence evidence", () => {
  assert.equal(hasUsablePresenceTranscript("   "), false);
  assert.equal(hasUsablePresenceTranscript("..."), false);
  assert.equal(hasUsablePresenceTranscript(null), false);
});
