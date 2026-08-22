import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OpenAIRealtimeCommandAdapter } from "../.test-dist/openai-realtime-command-adapter.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("restored VAD can listen without creating an assistant response before transcript authority", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.restoreInputDetection({
    threshold: 0.5,
    prefixPaddingMs: 300,
    silenceDurationMs: 500,
    idleTimeoutMs: 10000,
    createResponse: false,
    interruptResponse: true,
  });

  const turnDetection = h.events[0].session.audio.input.turn_detection;
  assert.equal(turnDetection.type, "server_vad");
  assert.equal(turnDetection.create_response, false);
  assert.equal(turnDetection.interrupt_response, true);
});

test("normal caller response creation belongs to completed transcript authority, not VAD", () => {
  const adapter = readFileSync(new URL("./openai-realtime-command-adapter.ts", import.meta.url), "utf8");
  const v29 = readFileSync(new URL("./call-session-v29.ts", import.meta.url), "utf8");

  assert.match(adapter, /create_response:\s*settings\.createResponse\s*\?\?\s*false/);
  assert.match(adapter, /interrupt_response:\s*settings\.interruptResponse\s*\?\?\s*true/);
  assert.match(v29, /realtime-provider-runtime\.js/);
  assert.match(v29, /TRANSCRIPT_AUTHORIZED_RESPONSE_REQUESTED_V29/);
  assert.match(v29, /if \(!higherLayerOwns\)/);
  assert.doesNotMatch(v29, /openai-realtime-command-adapter/);
});
