import test from "node:test";
import assert from "node:assert/strict";
import { canonicalControlCommand, geminiControlEnvelope, InMemoryControlSidebandRegistry } from "./control-sideband.mjs";

const claims = { tenantId: "tenant-a", callControlId: "call-a" };

test("Gemini sideband preserves provider evidence while stripping audio bytes", () => {
  assert.deepEqual(geminiControlEnvelope({
    toolCall: { functionCalls: [{ id: "fc1", name: "restaurant_business_info", args: { topics: ["HOURS"] } }] },
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "secret-audio" } }] },
      inputTranscription: { text: "¿A qué hora abren?" },
      outputTranscription: { text: "Abrimos a las nueve" },
      generationComplete: true,
      turnComplete: true,
    },
  }), {
    type: "GEMINI_EVENT",
    message: {
      toolCall: { functionCalls: [{ id: "fc1", name: "restaurant_business_info", args: { topics: ["HOURS"] } }] },
      serverContent: {
        modelTurn: {},
        inputTranscription: { text: "¿A qué hora abren?" },
        outputTranscription: { text: "Abrimos a las nueve" },
        generationComplete: true,
        turnComplete: true,
      },
    },
  });
});

test("control command only admits correlated tool results", () => {
  assert.deepEqual(canonicalControlCommand({ type: "TOOL_RESULT", callId: "fc1", toolName: "restaurant_business_info", output: { ok: true } }), { type: "TOOL_RESULT", callId: "fc1", toolName: "restaurant_business_info", output: { ok: true } });
  assert.throws(() => canonicalControlCommand({ type: "SPEAK" }), /unsupported/);
});

test("sideband registry binds one control socket and active command sink", () => {
  const events = []; const commands = []; const registry = new InMemoryControlSidebandRegistry();
  const attached = registry.attach(claims, (event) => events.push(event));
  assert.equal(registry.bindCommandSink(claims, (command) => commands.push(command)), true);
  assert.equal(registry.emit(claims, { type: "GEMINI_EVENT", message: { setupComplete: {} } }), true);
  registry.command(claims, { type: "TOOL_RESULT", callId: "fc1", toolName: "x", output: { ok: true } });
  assert.deepEqual(events, [{ type: "GEMINI_EVENT", message: { setupComplete: {} } }]); assert.equal(commands[0].callId, "fc1");
  assert.throws(() => registry.attach(claims, () => {}), /already attached/);
  attached.detach(); assert.equal(registry.size(), 0);
});
