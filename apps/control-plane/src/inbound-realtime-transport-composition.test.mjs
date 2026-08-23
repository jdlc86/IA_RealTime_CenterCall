import assert from "node:assert/strict";
import test from "node:test";
import { createAuthoritativeCallerTranscriptionPort } from "../.test-dist/authoritative-caller-transcription-port.js";
import { composeGeminiInboundMediaTransport } from "../.test-dist/gemini-inbound-media-transport.js";
import { planInboundRealtimeRoute } from "../.test-dist/inbound-realtime-route.js";
import {
  composePlannedInboundRealtimeTransport,
  requireInboundRealtimeTransportReady,
} from "../.test-dist/inbound-realtime-transport-composition.js";

function selection(provider) {
  return { tenantId: "tenant-a", provider, source: "TENANT_CONFIG", overrideKey: "unused" };
}

function host() {
  const sent = [];
  return { sent, send(message) { sent.push(message); } };
}

function geminiSetup() {
  return {
    model: "models/gemini-live-test",
    responseModalities: ["AUDIO"],
    manualActivityDetection: true,
    manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  };
}

function vadConfig() {
  return {
    startRms: 0.10,
    stopRms: 0.04,
    minSpeechMs: 20,
    minSilenceMs: 20,
  };
}

test("planned Gemini topology is composable without enabling traffic", () => {
  const route = planInboundRealtimeRoute(selection("GEMINI"));
  const invoked = [];

  const result = composePlannedInboundRealtimeTransport(route, {
    OPENAI_DIRECT_SIP() {
      invoked.push("OPENAI");
      return "openai";
    },
    GEMINI_MEDIA_BRIDGE(geminiRoute) {
      invoked.push("GEMINI");
      assert.equal(geminiRoute.provider, "GEMINI");
      assert.equal(geminiRoute.transport, "GEMINI_MEDIA_BRIDGE");
      return "gemini";
    },
  });

  assert.equal(result, "gemini");
  assert.deepEqual(invoked, ["GEMINI"]);
});

test("traffic-disabled Gemini fails before any transport factory can create effects", () => {
  const invoked = [];

  assert.throws(
    () => requireInboundRealtimeTransportReady(selection("GEMINI"), {
      OPENAI_DIRECT_SIP() {
        invoked.push("OPENAI");
        return "openai";
      },
      GEMINI_MEDIA_BRIDGE() {
        invoked.push("GEMINI");
        return "gemini";
      },
    }),
    /registered but not enabled for traffic: GEMINI/,
  );

  assert.deepEqual(invoked, [], "admission must precede every transport side-effect factory");
});

test("enabled OpenAI invokes only its admitted transport factory", () => {
  const invoked = [];
  const result = requireInboundRealtimeTransportReady(selection("OPENAI"), {
    OPENAI_DIRECT_SIP(route) {
      invoked.push(route.transport);
      return route.provider;
    },
    GEMINI_MEDIA_BRIDGE() {
      invoked.push("GEMINI_MEDIA_BRIDGE");
      return "GEMINI";
    },
  });

  assert.equal(result, "OPENAI");
  assert.deepEqual(invoked, ["OPENAI_DIRECT_SIP"]);
});

test("transport composition rejects provider/transport mismatches before factory invocation", () => {
  let invoked = false;
  assert.throws(
    () => composePlannedInboundRealtimeTransport({
      provider: "OPENAI",
      source: "TENANT_CONFIG",
      transport: "GEMINI_MEDIA_BRIDGE",
    }, {
      OPENAI_DIRECT_SIP() {
        invoked = true;
      },
      GEMINI_MEDIA_BRIDGE() {
        invoked = true;
      },
    }),
    /route\/provider mismatch: OPENAI\/GEMINI_MEDIA_BRIDGE/,
  );
  assert.equal(invoked, false);
});

test("Gemini media bundle construction is inert and owns deferred input coordinator", () => {
  const route = planInboundRealtimeRoute(selection("GEMINI"));
  const gemini = host();
  const telnyx = host();
  const transcription = createAuthoritativeCallerTranscriptionPort({
    async transcribe(request) {
      return { itemId: request.itemId, transcript: "caller transcript" };
    },
  });

  const bundle = composePlannedInboundRealtimeTransport(route, {
    OPENAI_DIRECT_SIP() {
      throw new Error("unexpected OpenAI route");
    },
    GEMINI_MEDIA_BRIDGE(geminiRoute) {
      return composeGeminiInboundMediaTransport(geminiRoute, {
        geminiHost: gemini,
        telnyxHost: telnyx,
        initialSetup: geminiSetup(),
        transcription,
        vadConfig: vadConfig(),
      });
    },
  });

  assert.equal(bundle.route.provider, "GEMINI");
  assert.equal(bundle.route.transport, "GEMINI_MEDIA_BRIDGE");
  assert.deepEqual(gemini.sent, [], "construction must not start Gemini");
  assert.deepEqual(telnyx.sent, [], "construction must not command Telnyx");
  assert.equal(bundle.coordinator.snapshot().session.session.state, "NEW");

  bundle.coordinator.start();
  assert.equal(gemini.sent.length, 1, "explicit start owns the first Gemini setup effect");
  assert.deepEqual(telnyx.sent, []);
});
