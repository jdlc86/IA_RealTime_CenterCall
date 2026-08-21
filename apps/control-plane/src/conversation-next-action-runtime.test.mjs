import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { conversationNextActionRuntimeFor } from "../.test-dist/conversation-next-action-runtime.js";

test("structured next action has one isolated runtime owner per conversation", () => {
  const firstConversation = {};
  const secondConversation = {};
  const first = conversationNextActionRuntimeFor(firstConversation);

  assert.equal(first.current(), "CONTINUE_WORKFLOW");
  first.update("ASK_CLOSE_CONFIRMATION");
  assert.equal(conversationNextActionRuntimeFor(firstConversation).current(), "ASK_CLOSE_CONFIRMATION");
  assert.equal(conversationNextActionRuntimeFor(secondConversation).current(), "CONTINUE_WORKFLOW");
});

test("V13 routing and V15 speech policy share capability state without generation-private access", async () => {
  const [v13, v15] = await Promise.all([
    readFile(new URL("./call-session-v13.ts", import.meta.url), "utf8"),
    readFile(new URL("./call-session-v15.ts", import.meta.url), "utf8"),
  ]);
  const joined = `${v13}\n${v15}`;

  assert.match(v13, /conversationNextActionRuntimeFor\(this\)/);
  assert.match(v15, /conversationNextActionRuntimeFor\(this\)\.current\(\)/);
  assert.doesNotMatch(joined, /conversationNextActionV13/);
});
