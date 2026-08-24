import test from "node:test";
import assert from "node:assert/strict";
import {
  initialResponseOwnerSnapshot,
  reduceResponseOwner,
} from "../.test-dist/realtime-response-owner.js";

function step(snapshot, event) {
  return reduceResponseOwner(snapshot, event);
}

test("confirmed barge-in waits for correlated response.done before replacement create", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "caller_speech_started" }));
  const interrupted = step(s, { type: "barge_in_interrupt" });
  assert.equal(interrupted.snapshot.state, "CALLER_TURN_READY");
  assert.equal(interrupted.snapshot.callerResponsePending, true);
  assert.equal(interrupted.snapshot.activeResponseId, "old");
  assert.deepEqual(interrupted.effects, [
    { type: "cancel_response", responseId: "old" },
    { type: "clear_playback" },
  ]);

  const released = step(interrupted.snapshot, { type: "assistant_response_done", responseId: "old" });
  assert.equal(released.snapshot.state, "CALLER_TURN_READY");
  assert.equal(released.snapshot.activeResponseId, null);
  assert.equal(released.snapshot.callerResponsePending, false);
  assert.deepEqual(released.effects, [{ type: "create_caller_response" }]);
});

test("confirmed barge-in creates immediately when provider response already ended and consumes pending authority", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "caller_speech_started" }));
  ({ snapshot: s } = step(s, { type: "assistant_response_done", responseId: "old" }));
  const r = step(s, { type: "barge_in_interrupt" });
  assert.equal(r.snapshot.activeResponseId, null);
  assert.equal(r.snapshot.callerResponsePending, false);
  assert.deepEqual(r.effects, [
    { type: "clear_playback" },
    { type: "create_caller_response" },
  ]);
});

test("released caller response cannot self-loop on its own response.done", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "caller_speech_started" }));
  ({ snapshot: s } = step(s, { type: "barge_in_interrupt" }));

  const released = step(s, { type: "assistant_response_done", responseId: "old" });
  assert.equal(released.snapshot.callerResponsePending, false);
  assert.deepEqual(released.effects, [{ type: "create_caller_response" }]);

  const started = step(released.snapshot, { type: "assistant_response_started", responseId: "replacement" });
  assert.equal(started.snapshot.state, "ASSISTANT_ACTIVE");
  assert.equal(started.snapshot.callerResponsePending, false);
  assert.equal(started.snapshot.activeResponseId, "replacement");

  const done = step(started.snapshot, { type: "assistant_response_done", responseId: "replacement" });
  assert.equal(done.snapshot.activeResponseId, null);
  assert.equal(done.snapshot.callerResponsePending, false);
  assert.deepEqual(done.effects, []);
});

test("stale response.done cannot release a pending caller response", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "caller_speech_started" }));
  ({ snapshot: s } = step(s, { type: "barge_in_interrupt" }));
  const stale = step(s, { type: "assistant_response_done", responseId: "other" });
  assert.equal(stale.snapshot.activeResponseId, "old");
  assert.equal(stale.snapshot.callerResponsePending, true);
  assert.deepEqual(stale.effects, []);
});

test("late response start preserves pending caller turn until its correlated done", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "caller_speech_started" }));
  ({ snapshot: s } = step(s, { type: "barge_in_interrupt" }));

  const late = step(s, { type: "assistant_response_started", responseId: "provider-late" });
  assert.equal(late.snapshot.state, "CALLER_TURN_READY");
  assert.equal(late.snapshot.activeResponseId, "provider-late");
  assert.equal(late.snapshot.callerResponsePending, true);
  assert.deepEqual(late.effects, [{
    type: "response_ownership_conflict",
    previousResponseId: "old",
    newResponseId: "provider-late",
  }]);

  const staleOldDone = step(late.snapshot, { type: "assistant_response_done", responseId: "old" });
  assert.equal(staleOldDone.snapshot.activeResponseId, "provider-late");
  assert.deepEqual(staleOldDone.effects, []);

  const released = step(staleOldDone.snapshot, { type: "assistant_response_done", responseId: "provider-late" });
  assert.equal(released.snapshot.activeResponseId, null);
  assert.equal(released.snapshot.callerResponsePending, false);
  assert.deepEqual(released.effects, [{ type: "create_caller_response" }]);
});

test("caller speech without assistant ownership is not classified as barge-in", () => {
  const s = initialResponseOwnerSnapshot();
  const r = step(s, { type: "caller_speech_started" });
  assert.equal(r.snapshot.state, "IDLE");
  assert.equal(r.snapshot.activeResponseId, null);
  assert.deepEqual(r.effects, []);
});

test("late assistant response start cannot destroy an active barge-in classification", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "caller_speech_started" }));
  const late = step(s, { type: "assistant_response_started", responseId: "new" });
  assert.equal(late.snapshot.state, "BARGE_IN_CLASSIFYING");
  assert.equal(late.snapshot.activeResponseId, "new");
  assert.equal(late.snapshot.playbackCleared, false);
});

test("SIP-cleared playback and active response are independent", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "assistant_playback_cleared" }));
  ({ snapshot: s } = step(s, { type: "caller_speech_started" }));
  const r = step(s, { type: "barge_in_interrupt" });
  assert.deepEqual(r.effects, [
    { type: "cancel_response", responseId: "old" },
  ]);
});

test("ignored SIP-cleared candidate preserves the authoritative response without synthetic continuation", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "assistant_playback_cleared" }));
  ({ snapshot: s } = step(s, { type: "caller_speech_started" }));
  const ignored = step(s, { type: "barge_in_ignore" });
  assert.equal(ignored.snapshot.state, "ASSISTANT_ACTIVE");
  assert.equal(ignored.snapshot.activeResponseId, "old");
  assert.equal(ignored.snapshot.playbackCleared, true);
  assert.deepEqual(ignored.effects, []);

  const done = step(ignored.snapshot, { type: "assistant_response_done", responseId: "old" });
  assert.equal(done.snapshot.activeResponseId, null);
  assert.equal(done.snapshot.playbackCleared, true);
  assert.deepEqual(done.effects, []);
});

test("ignored candidate with no active response never synthesizes a replacement", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "assistant_playback_cleared" }));
  ({ snapshot: s } = step(s, { type: "assistant_response_done", responseId: "old" }));
  s = { ...s, state: "BARGE_IN_CLASSIFYING" };
  const r = step(s, { type: "barge_in_ignore" });
  assert.equal(r.snapshot.state, "ASSISTANT_ACTIVE");
  assert.equal(r.snapshot.activeResponseId, null);
  assert.deepEqual(r.effects, []);
});

test("ignored candidate without playback clear remains non-destructive", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "caller_speech_started" }));
  const ignored = step(s, { type: "barge_in_ignore" });
  assert.equal(ignored.snapshot.state, "ASSISTANT_ACTIVE");
  assert.equal(ignored.snapshot.activeResponseId, "old");
  assert.equal(ignored.snapshot.playbackCleared, false);
  assert.deepEqual(ignored.effects, []);
});

test("second response.created is reconciled deterministically and surfaces conflict", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  const r = step(s, { type: "assistant_response_started", responseId: "new" });
  assert.equal(r.snapshot.activeResponseId, "new");
  assert.equal(r.snapshot.state, "ASSISTANT_ACTIVE");
  assert.deepEqual(r.effects, [{
    type: "response_ownership_conflict",
    previousResponseId: "old",
    newResponseId: "new",
  }]);
});

test("stale response.done can never clear the current active response", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "new" }));
  const stale = step(s, { type: "assistant_response_done", responseId: "old" });
  assert.equal(stale.snapshot.activeResponseId, "new");
  assert.deepEqual(stale.effects, []);
  const current = step(stale.snapshot, { type: "assistant_response_done", responseId: "new" });
  assert.equal(current.snapshot.activeResponseId, null);
});

test("terminal state is absorbing", () => {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = step(s, { type: "assistant_response_started", responseId: "old" }));
  ({ snapshot: s } = step(s, { type: "terminal" }));
  const r = step(s, { type: "caller_speech_started" });
  assert.equal(r.snapshot.state, "TERMINAL");
  assert.deepEqual(r.effects, []);
});
