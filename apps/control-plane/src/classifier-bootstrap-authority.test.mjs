import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  claimClassifierBootstrap,
  classifierBootstrapOwner,
  ownsClassifierBootstrap,
} from "../.test-dist/classifier-bootstrap-authority.js";

test("highest composed classifier authority owns bootstrap regardless of claim order", () => {
  const olderFirst = {};
  claimClassifierBootstrap(olderFirst, "RESERVATION_V5");
  claimClassifierBootstrap(olderFirst, "CORE_INTENT_V13");
  claimClassifierBootstrap(olderFirst, "DIRECT_AGENT_V26");
  assert.equal(classifierBootstrapOwner(olderFirst), "DIRECT_AGENT_V26");

  const newerFirst = {};
  claimClassifierBootstrap(newerFirst, "DIRECT_AGENT_V26");
  claimClassifierBootstrap(newerFirst, "CORE_INTENT_V13");
  claimClassifierBootstrap(newerFirst, "RESERVATION_V5");
  assert.equal(classifierBootstrapOwner(newerFirst), "DIRECT_AGENT_V26");
  assert.equal(ownsClassifierBootstrap(newerFirst, "CORE_INTENT_V13"), false);
});

test("legacy classifier layers coordinate through bootstrap authority, not private generation flags", async () => {
  const sourceRoot = new URL("./", import.meta.url);
  const files = await Promise.all(
    [5, 6, 7, 11, 13, 26].map((version) =>
      readFile(new URL(`call-session-v${version}.ts`, sourceRoot), "utf8"),
    ),
  );
  const joined = files.join("\n");

  assert.match(joined, /claimClassifierBootstrap/);
  assert.match(joined, /ownsClassifierBootstrap/);
  assert.doesNotMatch(joined, /\(this as any\)\.(?:reservationSessionUpdateSent|reservationSessionUpdateV6Sent|marketingSessionUpdateV7Sent|querySessionUpdateV11Sent|coreIntentSessionUpdateV13Sent)\s*=/);
});
