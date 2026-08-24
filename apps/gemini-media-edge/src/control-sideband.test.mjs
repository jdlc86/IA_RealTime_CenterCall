import test from "node:test";
import assert from "node:assert/strict";
import { canonicalControlCommand, geminiControlEnvelope, inputDetectionControlEnvelope, InMemoryControlSidebandRegistry } from "./control-sideband.mjs";

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

test("control command admits correlated tool results, playback bindings, drains and clears", () => {
  assert.deepEqual(canonicalControlCommand({ type: "TOOL_RESULT", callId: "fc1", toolName: "restaurant_business_info", output: { ok: true } }), { type: "TOOL_RESULT", callId: "fc1", toolName: "restaurant_business_info", output: { ok: true } });
  assert.deepEqual(canonicalControlCommand({ type: "PLAYBACK_BINDING", responseId: "gemini-response-7", kind: "NORMAL" }), { type: "PLAYBACK_BINDING", responseId: "gemini-response-7", kind: "NORMAL" });
  assert.deepEqual(canonicalControlCommand({ type: "PLAYBACK_DRAIN", responseId: "gemini-response-7" }), { type: "PLAYBACK_DRAIN", responseId: "gemini-response-7" });
  assert.deepEqual(canonicalControlCommand({ type: "PLAYBACK_CLEAR", responseId: "gemini-response-7" }), { type: "PLAYBACK_CLEAR", responseId: "gemini-response-7" });
  assert.throws(() => canonicalControlCommand({ type: "PLAYBACK_BINDING", responseId: "gemini-response-7", kind: "SEMANTIC" }), /unsupported/);
  assert.throws(() => canonicalControlCommand({ type: "SPEAK" }), /unsupported/);
});

test("governed speech control command requires bounded exact text and correlation", () => {
  assert.deepEqual(
    canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "speech-7", text: "  De acuerdo, no te transfiero.  ", purpose: " human_handoff_declined_v43 " }),
    { type: "GOVERNED_SPEECH", responseId: "speech-7", text: "De acuerdo, no te transfiero.", purpose: "human_handoff_declined_v43" },
  );
  assert.throws(() => canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "", text: "Hola" }), /response id is required/);
  assert.throws(() => canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "speech-7", text: "" }), /text is required/);
  assert.throws(() => canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "speech-7", text: "x".repeat(2001) }), /configured limit/);
  assert.throws(() => canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "speech-7", text: "Hola", purpose: "x".repeat(201) }), /configured limit/);
});

test("control protocol admits product-owned caller input lifecycle commands", () => {
  assert.deepEqual(canonicalControlCommand({ type: "CALLER_INPUT_CLEAR" }), { type: "CALLER_INPUT_CLEAR" });
  assert.deepEqual(canonicalControlCommand({ type: "INPUT_DETECTION_SUSPEND" }), { type: "INPUT_DETECTION_SUSPEND" });
  assert.deepEqual(canonicalControlCommand({ type: "INPUT_DETECTION_RESTORE" }), { type: "INPUT_DETECTION_RESTORE" });
  assert.deepEqual(inputDetectionControlEnvelope(false), {
    type: "INPUT_DETECTION_EVENT",
    event: { type: "INPUT_DETECTION_UPDATED", present: true, settings: null },
  });
  assert.deepEqual(inputDetectionControlEnvelope(true), {
    type: "INPUT_DETECTION_EVENT",
    event: {
      type: "INPUT_DETECTION_UPDATED",
      present: true,
      settings: { createResponse: false, interruptResponse: false },
    },
  });
});

test("control socket may attach before Gemini session command sink", () => {
  const events = []; const commands = []; const registry = new InMemoryControlSidebandRegistry();
  const socketAttachment = registry.attach(claims, (event) => events.push(event));
  const commandAttachment = registry.bindCommandSink(claims, (command) => commands.push(command));
  assert.equal(registry.emit(claims, { type: "GEMINI_EVENT", message: { setupComplete: {} } }), true);
  registry.command(claims, { type: "TOOL_RESULT", callId: "fc1", toolName: "x", output: { ok: true } });
  registry.command(claims, { type: "PLAYBACK_BINDING", responseId: "gemini-response-1", kind: "NORMAL" });
  registry.command(claims, { type: "PLAYBACK_DRAIN", responseId: "gemini-response-1" });
  assert.equal(commands[0].callId, "fc1");
  assert.equal(commands[1].responseId, "gemini-response-1");
  assert.equal(commands[2].type, "PLAYBACK_DRAIN");
  socketAttachment.detach(); commandAttachment.detach(); assert.equal(registry.size(), 0);
});

test("Gemini session command sink may bind before control socket", () => {
  const events = []; const commands = []; const registry = new InMemoryControlSidebandRegistry();
  const commandAttachment = registry.bindCommandSink(claims, (command) => commands.push(command));
  assert.equal(registry.emit(claims, { type: "GEMINI_EVENT", message: { setupComplete: {} } }), false);
  const socketAttachment = registry.attach(claims, (event) => events.push(event));
  assert.equal(registry.emit(claims, { type: "GEMINI_EVENT", message: { setupComplete: {} } }), true);
  registry.command(claims, { type: "TOOL_RESULT", callId: "fc2", toolName: "x", output: { ok: true } });
  assert.deepEqual(events, [{ type: "GEMINI_EVENT", message: { setupComplete: {} } }]);
  assert.equal(commands[0].callId, "fc2");
  socketAttachment.detach();
  assert.equal(registry.size(), 1);
  commandAttachment.detach();
  assert.equal(registry.size(), 0);
});

test("bounded commands issued after sideband attach drain in order when media binds", async () => {
  const commands = [];
  const registry = new InMemoryControlSidebandRegistry({ maxPendingCommands: 3 });
  const socketAttachment = registry.attach(claims, () => true);
  const first = registry.command(claims, { type: "INPUT_DETECTION_SUSPEND" });
  const second = registry.command(claims, { type: "CALLER_INPUT_CLEAR" });
  const commandAttachment = registry.bindCommandSink(claims, async (command) => { commands.push(command); });
  await Promise.all([first, second]);
  assert.deepEqual(commands, [
    { type: "INPUT_DETECTION_SUSPEND" },
    { type: "CALLER_INPUT_CLEAR" },
  ]);
  socketAttachment.detach();
  commandAttachment.detach();
});

test("pre-media command queue is bounded and rejected if sideband detaches", async () => {
  const registry = new InMemoryControlSidebandRegistry({ maxPendingCommands: 1 });
  const socketAttachment = registry.attach(claims, () => true);
  const pending = registry.command(claims, { type: "INPUT_DETECTION_SUSPEND" });
  assert.throws(
    () => registry.command(claims, { type: "CALLER_INPUT_CLEAR" }),
    /pending control command limit exceeded/,
  );
  socketAttachment.detach();
  await assert.rejects(pending, /detached before media session/);
});

test("a failed queued command prevents later pre-media commands from executing", async () => {
  const executed = [];
  const registry = new InMemoryControlSidebandRegistry();
  const socketAttachment = registry.attach(claims, () => true);
  const first = registry.command(claims, { type: "INPUT_DETECTION_SUSPEND" });
  const second = registry.command(claims, { type: "CALLER_INPUT_CLEAR" });
  const commandAttachment = registry.bindCommandSink(claims, async (command) => {
    executed.push(command);
    throw new Error("media command failed");
  });
  await assert.rejects(first, /media command failed/);
  await assert.rejects(second, /media command failed/);
  assert.deepEqual(executed, [{ type: "INPUT_DETECTION_SUSPEND" }]);
  socketAttachment.detach();
  commandAttachment.detach();
});

test("control registry propagates an attached sender that can no longer deliver", () => {
  const registry = new InMemoryControlSidebandRegistry();
  let open = true;
  const socketAttachment = registry.attach(claims, () => open, () => open);
  const sinkAttachment = registry.bindCommandSink(claims, () => {});
  assert.equal(registry.isActive(claims), true);
  open = false;
  assert.equal(registry.isActive(claims), false);
  assert.equal(registry.emit(claims, { type: "GOVERNED_EVENT", event: {} }), false);
  sinkAttachment.detach();
  socketAttachment.detach();
});

test("active control session requires exact identity plus both live endpoints", () => {
  const registry = new InMemoryControlSidebandRegistry();
  const otherCall = { tenantId: claims.tenantId, callControlId: "call-b" };
  const otherTenant = { tenantId: "tenant-b", callControlId: claims.callControlId };
  assert.equal(registry.isActive(claims), false);

  const socketAttachment = registry.attach(claims, () => {});
  assert.equal(registry.isActive(claims), false);
  assert.equal(registry.isActive(otherCall), false);
  assert.equal(registry.isActive(otherTenant), false);

  const commandAttachment = registry.bindCommandSink(claims, () => {});
  assert.equal(registry.isActive(claims), true);
  assert.equal(registry.isActive(otherCall), false);
  assert.equal(registry.isActive(otherTenant), false);

  socketAttachment.detach();
  assert.equal(registry.isActive(claims), false);
  commandAttachment.detach();
  assert.equal(registry.isActive(claims), false);
});

test("duplicate control socket and duplicate command sink fail closed", () => {
  const registry = new InMemoryControlSidebandRegistry();
  const socket = registry.attach(claims, () => {});
  const sink = () => {};
  const command = registry.bindCommandSink(claims, sink);
  assert.throws(() => registry.attach(claims, () => {}), /already attached/);
  assert.throws(() => registry.bindCommandSink(claims, () => {}), /already bound/);
  socket.detach(); command.detach();
});
