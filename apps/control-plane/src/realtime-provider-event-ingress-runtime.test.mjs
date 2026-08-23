import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverRealtimeProviderEvents,
  installRealtimeProviderEventIngress,
  realtimeProviderEventsFromTrustedBatch,
  removeRealtimeProviderEventIngress,
  trustedRealtimeProviderEventBatch,
} from "../.test-dist/realtime-provider-event-ingress-runtime.js";

test("provider event ingress serializes normalized events one at a time", async () => {
  const host = {};
  const received = [];
  const ingress = async (events) => { received.push(events); };
  installRealtimeProviderEventIngress(host, ingress);
  await deliverRealtimeProviderEvents(host, [
    { type: "CALLER_SPEECH_STARTED", itemId: "c1" },
    { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "c1", transcript: "Hola" },
  ]);
  assert.deepEqual(received, [
    [{ type: "CALLER_SPEECH_STARTED", itemId: "c1" }],
    [{ type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "c1", transcript: "Hola" }],
  ]);
  removeRealtimeProviderEventIngress(host, ingress);
  await assert.rejects(deliverRealtimeProviderEvents(host, [{ type: "CALLER_SPEECH_STOPPED" }]), /not installed/);
});

test("only runtime-minted event batches can bypass provider wire parsing", () => {
  const events = [{ type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "c2", transcript: "Mesa" }];
  const trusted = trustedRealtimeProviderEventBatch(events);
  assert.deepEqual(realtimeProviderEventsFromTrustedBatch(trusted), events);
  assert.equal(realtimeProviderEventsFromTrustedBatch({ events }), null);
});

test("provider event ingress is single-owner per session host", () => {
  const host = {};
  const first = () => {};
  const second = () => {};
  installRealtimeProviderEventIngress(host, first);
  assert.throws(() => installRealtimeProviderEventIngress(host, second), /already installed/);
  assert.throws(() => removeRealtimeProviderEventIngress(host, second), /ownership mismatch/);
  removeRealtimeProviderEventIngress(host, first);
});
