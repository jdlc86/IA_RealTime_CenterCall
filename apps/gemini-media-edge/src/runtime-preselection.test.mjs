import assert from "node:assert/strict";
import test from "node:test";
import { preselectAndCommitDeferredCallerTurn } from "./runtime.mjs";
import { GeminiSemanticToolGate } from "./semantic-tool-gate.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("caller audio stays deferred until isolated semantic preselection succeeds", async () => {
  const gate = new GeminiSemanticToolGate();
  const decision = deferred();
  const commits = [];
  const execution = preselectAndCommitDeferredCallerTurn({
    semanticGate: gate,
    itemId: "item-1",
    turn: { itemId: "item-1", transcript: "quiero reservar", mediaPayloads: ["AAE="] },
    semanticPreselect: async () => decision.promise,
    assertStillActive() {},
    commit() { commits.push("commit"); },
  });

  assert.equal(gate.snapshot().armed, true);
  assert.equal(gate.snapshot().preselectedTool, null);
  assert.deepEqual(commits, []);

  decision.resolve({ selectedTool: "restaurant_conversation", directModelOutputAllowed: true });
  const result = await execution;
  assert.deepEqual(result, { selectedTool: "restaurant_conversation", directModelOutputAllowed: true });
  assert.equal(gate.snapshot().preselectedTool, "restaurant_conversation");
  assert.deepEqual(commits, ["commit"]);
});

test("invalid or failed isolated decision never commits caller audio", async () => {
  const gate = new GeminiSemanticToolGate();
  const commits = [];
  await assert.rejects(
    preselectAndCommitDeferredCallerTurn({
      semanticGate: gate,
      itemId: "item-2",
      turn: { itemId: "item-2", transcript: "hola", mediaPayloads: ["AAE="] },
      semanticPreselect: async () => { throw new Error("classifier failed"); },
      commit() { commits.push("commit"); },
    }),
    /classifier failed/,
  );
  assert.deepEqual(commits, []);
  assert.equal(gate.snapshot().selectedCallId, null);
});

test("session liveness is checked after classification and before caller audio commit", async () => {
  const gate = new GeminiSemanticToolGate();
  let committed = false;
  await assert.rejects(
    preselectAndCommitDeferredCallerTurn({
      semanticGate: gate,
      itemId: "item-3",
      turn: { itemId: "item-3", transcript: "hola", mediaPayloads: ["AAE="] },
      semanticPreselect: async () => ({ selectedTool: "restaurant_conversation", directModelOutputAllowed: true }),
      assertStillActive() { throw new Error("session closed"); },
      commit() { committed = true; },
    }),
    /session closed/,
  );
  assert.equal(committed, false);
});
