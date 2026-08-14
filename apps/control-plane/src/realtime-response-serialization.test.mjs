import assert from "node:assert/strict";
import { test } from "node:test";
import {
  armFunctionResponse,
  initialRealtimeResponseSerializationState,
  releaseAfterResponseDone,
  requestSpokenResponse,
} from "../.test-dist/realtime-response-serialization.js";

test("spoken response is sent immediately when no function response is active", () => {
  const initial = initialRealtimeResponseSerializationState();
  const requested = requestSpokenResponse(initial, "hola");
  assert.equal(requested.sendNow, true);
  assert.equal(requested.next.pendingInstructions, null);
});

test("spoken response waits until originating function response is done", () => {
  const armed = armFunctionResponse(initialRealtimeResponseSerializationState());
  const requested = requestSpokenResponse(armed, "resultado de la consulta");
  assert.equal(requested.sendNow, false);
  assert.equal(requested.next.pendingInstructions, "resultado de la consulta");

  const released = releaseAfterResponseDone(requested.next);
  assert.equal(released.releasedInstructions, "resultado de la consulta");
  assert.equal(released.next.waitingForResponseDone, false);
  assert.equal(released.next.pendingInstructions, null);
});

test("latest pending speech replaces an older one instead of creating concurrent responses", () => {
  const armed = armFunctionResponse(initialRealtimeResponseSerializationState());
  const first = requestSpokenResponse(armed, "primera");
  const second = requestSpokenResponse(first.next, "segunda");
  assert.equal(second.sendNow, false);
  assert.equal(second.replacedPending, true);
  assert.equal(releaseAfterResponseDone(second.next).releasedInstructions, "segunda");
});
