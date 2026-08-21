import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { conversationLifecyclePortFor } from "../.test-dist/conversation-lifecycle-port.js";

function hostWithState(state) {
  return {
    snapshotTurnLifecycleV18() { return { state }; },
  };
}

test("lifecycle port exposes one neutral terminal view for consolidation layers", () => {
  for (const state of ["LUCIA_SPEAKING", "WAITING_FOR_CALLER", "CALLER_SPEAKING", "PROCESSING_CALLER_TURN", "IGNORED_RECOVERY_SPEAKING"]) {
    assert.equal(conversationLifecyclePortFor(hostWithState(state)).isTerminal(), false, state);
  }
  for (const state of ["TERMINAL_SPEAKING", "HANDOFF", "CLOSING"]) {
    assert.equal(conversationLifecyclePortFor(hostWithState(state)).isTerminal(), true, state);
  }
});

test("lifecycle port preserves legacy terminal behavior only when no lifecycle owner is installed", () => {
  assert.equal(conversationLifecyclePortFor({ state: "closing" }).isTerminal(), true);
  assert.equal(conversationLifecyclePortFor({ hangupStarted: true }).isClosing(), true);
  assert.equal(conversationLifecyclePortFor({ state: "active", hangupStarted: false }).isTerminal(), false);
  assert.equal(conversationLifecyclePortFor({
    state: "closing",
    snapshotTurnLifecycleV18() { return { state: "WAITING_FOR_CALLER" }; },
  }).isTerminal(), false);
});

test("lifecycle port hides historical tool-turn method names from callers", () => {
  const calls = [];
  const lifecycle = conversationLifecyclePortFor({
    validateUserTurnV18(source) { calls.push(["validate", source]); },
    suspendForToolV18(tool) { calls.push(["suspend", tool]); },
    observeSemanticIgnoredV18(reason) { calls.push(["ignored", reason]); },
  });
  lifecycle.validateUserTurn("agent_tool");
  lifecycle.suspendForTool("restaurant_reservation_query");
  lifecycle.semanticIgnored("BACKGROUND_AUDIO");
  assert.deepEqual(calls, [
    ["validate", "agent_tool"],
    ["suspend", "restaurant_reservation_query"],
    ["ignored", "BACKGROUND_AUDIO"],
  ]);
});

test("v40 derives liveness terminality from lifecycle authority instead of raw session flags", async () => {
  const source = await readFile(new URL("./call-session-v40-rebuild.ts", import.meta.url), "utf8");
  assert.match(source, /conversationLifecyclePortFor/);
  assert.match(source, /\.isTerminal\(\)/);
  assert.doesNotMatch(source, /hangupStarted/);
  assert.doesNotMatch(source, /\.state\s*===\s*["']closing["']/);
  assert.doesNotMatch(source, /\.state\s*==\s*["']closing["']/);
});
