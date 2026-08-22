import test from "node:test";
import assert from "node:assert/strict";
import { ConversationTurnLifecycle } from "../.test-dist/conversation-turn-lifecycle.js";
import { adaptOpenAIRealtimeEvent } from "../.test-dist/openai-realtime-event-adapter.js";

function event(type, payload = {}) {
  return JSON.stringify({ type, ...payload });
}

test("barge-in transcript cancels silence epoch opened by cleared normal playback", () => {
  const lifecycle = new ConversationTurnLifecycle();
  lifecycle.dispatch({ type: "assistant_audio_started", kind: "NORMAL" });
  const clearEffects = lifecycle.dispatch({ type: "assistant_audio_cleared", kind: "NORMAL" });
  const epoch = lifecycle.snapshot().silenceEpoch;

  assert.equal(lifecycle.snapshot().state, "WAITING_FOR_CALLER");
  assert.equal(lifecycle.snapshot().silenceTimerArmed, true);
  assert.ok(clearEffects.some((effect) => effect.type === "ARM_SILENCE_TIMER"));

  const transcriptEffects = lifecycle.dispatch({ type: "transcript_usable" });
  assert.equal(lifecycle.snapshot().state, "PROCESSING_CALLER_TURN");
  assert.equal(lifecycle.snapshot().silenceTimerArmed, false);
  assert.ok(transcriptEffects.some((effect) => effect.type === "CANCEL_SILENCE_TIMER"));
  assert.deepEqual(lifecycle.dispatch({ type: "presence_deadline", epoch }), []);
  assert.deepEqual(lifecycle.dispatch({ type: "silence_close_deadline", epoch }), []);
});

test("legacy farewell response is classified terminal by its own response payload", () => {
  const [adapted] = adaptOpenAIRealtimeEvent(event("response.created", {
    response: {
      id: "resp_terminal",
      status: "in_progress",
      instructions: "Despídete ahora con una sola frase muy breve, natural y amable en español. No preguntes nada más ni ofrezcas más ayuda. Esta es la despedida final.",
    },
  }));

  assert.equal(adapted.type, "ASSISTANT_RESPONSE_STARTED");
  assert.equal(adapted.responseId, "resp_terminal");
  assert.equal(adapted.kind, "TERMINAL");
});

test("late normal response remains normal while terminal close is pending", () => {
  const [adapted] = adaptOpenAIRealtimeEvent(event("response.created", {
    response: {
      id: "resp_old_normal",
      status: "in_progress",
      instructions: "Comunica el resultado autorizado y pregunta si necesita algo más.",
    },
  }));

  assert.equal(adapted.type, "ASSISTANT_RESPONSE_STARTED");
  assert.equal(adapted.responseId, "resp_old_normal");
  assert.equal(adapted.kind, "NORMAL");
});

test("metadata terminal classification remains authoritative", () => {
  const [adapted] = adaptOpenAIRealtimeEvent(event("response.created", {
    response: {
      id: "resp_metadata_terminal",
      status: "in_progress",
      metadata: { purpose: "terminal_farewell" },
    },
  }));

  assert.equal(adapted.type, "ASSISTANT_RESPONSE_STARTED");
  assert.equal(adapted.kind, "TERMINAL");
});
