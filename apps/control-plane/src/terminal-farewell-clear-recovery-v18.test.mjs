import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ConversationTurnLifecycle } from "../.test-dist/conversation-turn-lifecycle.js";
import { adaptRealtimeTurnEvent } from "../.test-dist/realtime-turn-lifecycle-adapter.js";

function feed(machine, providerEvent) {
  const effects = [];
  for (const event of adaptRealtimeTurnEvent(providerEvent)) effects.push(...machine.dispatch(event));
  return effects;
}

function effectTypes(effects) {
  return effects.map((effect) => effect.type);
}

test("terminal farewell: provider clear is explicit lifecycle evidence and does not authorize hangup", () => {
  const events = adaptRealtimeTurnEvent({ type: "ASSISTANT_AUDIO_CLEARED", kind: "TERMINAL", responseId: "farewell-a" });
  assert.deepEqual(events, [{ type: "assistant_audio_cleared", kind: "TERMINAL" }]);

  const lifecycle = new ConversationTurnLifecycle();
  lifecycle.dispatch({ type: "end_call" });
  feed(lifecycle, { type: "ASSISTANT_AUDIO_STARTED", kind: "TERMINAL", responseId: "farewell-a" });

  const clearEffects = feed(lifecycle, { type: "ASSISTANT_AUDIO_CLEARED", kind: "TERMINAL", responseId: "farewell-a" });
  assert.deepEqual(clearEffects, []);
  assert.equal(lifecycle.snapshot().state, "TERMINAL_SPEAKING");

  feed(lifecycle, { type: "ASSISTANT_AUDIO_STARTED", kind: "TERMINAL", responseId: "farewell-b" });
  const stopEffects = feed(lifecycle, { type: "ASSISTANT_AUDIO_STOPPED", kind: "TERMINAL", responseId: "farewell-b" });
  assert.deepEqual(effectTypes(stopEffects), ["HANGUP"]);
  assert.equal(lifecycle.snapshot().state, "CLOSING");
});

test("terminal farewell: v18 re-arms only the same terminal response after clear without a timing heuristic", async () => {
  const v18 = await readFile(new URL("./call-session-v18.ts", import.meta.url), "utf8");

  assert.match(v18, /event\.type === "ASSISTANT_AUDIO_CLEARED"[\s\S]*?lifecycleState === "TERMINAL_SPEAKING"[\s\S]*?this\.terminalPlaybackActiveV18[\s\S]*?matchesTerminalIdentity/);
  assert.match(v18, /this\.terminalPlaybackActiveV18 = false;[\s\S]*?this\.terminalPlaybackPendingV18 = true;[\s\S]*?LIFECYCLE_TERMINAL_PLAYBACK_CLEARED_V18/);
  assert.match(v18, /terminal_playback_tracking: "rearmed_same_identity"/);
  assert.match(v18, /lifecycleEvent\.type === "assistant_audio_cleared"/);
  assert.match(v18, /responseId === this\.terminalResponseIdV18/);
  assert.match(v18, /binding_source: "provider_response_identity"/);
  assert.doesNotMatch(v18, /this\.terminalPlaybackPendingV18 \|\| correlatedKind === "TERMINAL"/);

  const clearStart = v18.indexOf('event.type === "ASSISTANT_AUDIO_CLEARED"');
  const stopStart = v18.indexOf('event.type === "ASSISTANT_AUDIO_STOPPED"', clearStart);
  assert.ok(clearStart >= 0 && stopStart > clearStart, "terminal clear branch must precede terminal stop branch");
  const clearBranch = v18.slice(clearStart, stopStart);
  assert.doesNotMatch(clearBranch, /setTimeout|sleep\s*\(/);
});
