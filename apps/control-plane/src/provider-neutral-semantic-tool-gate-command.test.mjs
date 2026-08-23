import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { OpenAIRealtimeCommandAdapter } from "../.test-dist/openai-realtime-command-adapter.js";
import { GeminiLiveCommandAdapter } from "../.test-dist/gemini-live-command-adapter.js";

const gatePortSource = readFileSync(new URL("./semantic-tool-gate-port.ts", import.meta.url), "utf8");

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("semantic tool gate core boundary does not depend on session-policy tool choice", () => {
  assert.doesNotMatch(gatePortSource, /updateSessionPolicy/);
  assert.doesNotMatch(gatePortSource, /toolChoice/);
  assert.match(gatePortSource, /setSemanticToolGate\(true\)/);
  assert.match(gatePortSource, /setSemanticToolGate\(false\)/);
});

test("OpenAI translates the neutral semantic gate only at its wire edge", () => {
  const h = host();
  const adapter = new OpenAIRealtimeCommandAdapter(h);

  adapter.setSemanticToolGate(true);
  adapter.setSemanticToolGate(false);

  assert.deepEqual(h.events, [
    {
      type: "session.update",
      session: { type: "realtime", tool_choice: "required" },
    },
    {
      type: "session.update",
      session: { type: "realtime", tool_choice: "auto" },
    },
  ]);
});

test("Gemini refuses to fake the semantic gate through Live session mutation", () => {
  const h = host();
  const adapter = new GeminiLiveCommandAdapter(h);

  assert.throws(
    () => adapter.setSemanticToolGate(true),
    /semantic tool gate has no proven neutral mapping before provider-specific semantic gate conformance/,
  );
  assert.deepEqual(h.events, []);
});

test("direct REQUIRED session tool choice is fenced to the four inherited legacy layers", () => {
  const srcDir = new URL("./", import.meta.url);
  const offenders = readdirSync(srcDir)
    .filter((name) => /^call-session-v.*\.ts$/.test(name))
    .filter((name) => /toolChoice:\s*["']REQUIRED["']/.test(readFileSync(new URL(name, srcDir), "utf8")))
    .sort();

  assert.deepEqual(offenders, [
    "call-session-v11.ts",
    "call-session-v13.ts",
    "call-session-v5.ts",
    "call-session-v7.ts",
  ]);
});
