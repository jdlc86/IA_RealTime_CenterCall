import test from "node:test";
import assert from "node:assert/strict";
import { requireGeminiMediaEdgeTelnyxStart } from "../.test-dist/gemini-media-edge-telnyx-start-authority.js";

const binding = Object.freeze({
  provider: "GEMINI",
  tenantId: "tenant-madrid",
  callControlId: "call-authorized-123",
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  targetLegs: "self",
  notAfterEpochMs: 1_800_000_000_000,
});

function start(overrides = {}) {
  return {
    event: "start",
    stream_id: "stream-123",
    start: {
      call_control_id: "call-authorized-123",
      call_session_id: "session-123",
      media_format: {
        encoding: "L16",
        sample_rate: 16000,
        channels: 1,
      },
      ...overrides,
    },
  };
}

test("Telnyx start is accepted only when it proves the authorized call identity and media format", () => {
  const verified = requireGeminiMediaEdgeTelnyxStart(binding, start());

  assert.deepEqual(verified, {
    streamId: "stream-123",
    callControlId: "call-authorized-123",
    callSessionId: "session-123",
    encoding: "L16",
    sampleRate: 16000,
    channels: 1,
  });
  assert.equal(Object.isFrozen(verified), true);
});

test("a different Telnyx call_control_id fails closed before media can be accepted", () => {
  assert.throws(
    () => requireGeminiMediaEdgeTelnyxStart(binding, start({ call_control_id: "attacker-or-wrong-call" })),
    /does not match the authorized Gemini edge session/,
  );
});

test("missing call identity or stream identity fails closed", () => {
  assert.throws(
    () => requireGeminiMediaEdgeTelnyxStart(binding, start({ call_control_id: " " })),
    /start call_control_id is required/,
  );
  assert.throws(
    () => requireGeminiMediaEdgeTelnyxStart(binding, { ...start(), stream_id: "" }),
    /stream_id is required/,
  );
});

test("unsupported Telnyx media format fails closed even for the correct call", () => {
  assert.throws(
    () => requireGeminiMediaEdgeTelnyxStart(binding, start({
      media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
    })),
    /requires mono L16 at 16000 Hz/,
  );
});

test("connected or media frames cannot substitute for the Telnyx identity start frame", () => {
  assert.throws(
    () => requireGeminiMediaEdgeTelnyxStart(binding, { event: "connected", version: "1.0.0" }),
    /requires Telnyx start as the identity frame/,
  );
  assert.throws(
    () => requireGeminiMediaEdgeTelnyxStart(binding, {
      event: "media",
      stream_id: "stream-123",
      media: { track: "inbound", chunk: "1", payload: "AA==" },
    }),
    /requires Telnyx start as the identity frame/,
  );
});
