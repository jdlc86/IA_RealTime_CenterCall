import test from "node:test";
import assert from "node:assert/strict";
import { canonicalControlCommand, geminiControlEvents, InMemoryControlSidebandRegistry } from "./control-sideband.mjs";

const claims = { tenantId: "tenant-a", callControlId: "call-a" };

test("Gemini control events expose tools and transcripts without audio", () => {
  assert.deepEqual(geminiControlEvents({
    toolCall: { functionCalls: [{ id: "fc1", name: "restaurant_business_info", args: { topics: ["HOURS"] } }] },
    serverContent: { inputTranscription: { text: "¿A qué hora abren?" }, outputTranscription: { text: "Abrimos a las nueve" }, turnComplete: true },
  }), [
    { type: "TOOL_CALL", callId: "fc1", toolName: "restaurant_business_info", arguments: { topics: ["HOURS"] } },
    { type: "INPUT_TRANSCRIPTION", text: "¿A qué hora abren?" },
    { type: "OUTPUT_TRANSCRIPTION", text: "Abrimos a las nueve" },
    { type: "TURN_COMPLETE" },
  ]);
});

test("control command only admits correlated tool results", () => {
  assert.deepEqual(canonicalControlCommand({ type: "TOOL_RESULT", callId: "fc1", toolName: "restaurant_business_info", output: { ok: true } }), { type: "TOOL_RESULT", callId: "fc1", toolName: "restaurant_business_info", output: { ok: true } });
  assert.throws(() => canonicalControlCommand({ type: "SPEAK" }), /unsupported/);
});

test("sideband registry binds one control socket and active command sink", () => {
  const events = []; const commands = []; const registry = new InMemoryControlSidebandRegistry();
  const attached = registry.attach(claims, (event) => events.push(event)); attached.bindCommandSink((command) => commands.push(command));
  assert.equal(registry.emit(claims, { type: "SETUP_COMPLETE" }), true);
  registry.command(claims, { type: "TOOL_RESULT", callId: "fc1", toolName: "x", output: { ok: true } });
  assert.deepEqual(events, [{ type: "SETUP_COMPLETE" }]); assert.equal(commands[0].callId, "fc1");
  assert.throws(() => registry.attach(claims, () => {}), /already attached/);
  attached.detach(); assert.equal(registry.size(), 0);
});
