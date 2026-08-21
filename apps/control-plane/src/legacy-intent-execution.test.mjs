import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  executeLegacyIntent,
  LEGACY_INTENT_EXECUTOR,
} from "../.test-dist/legacy-intent-execution.js";

test("legacy intent capability preserves semantic arguments and correlation id", async () => {
  const received = [];
  const executorPrototype = {
    async [LEGACY_INTENT_EXECUTOR](selection) { received.push(selection); },
  };
  const selection = { argumentsJson: '{"intent":"CONTINUE"}', callId: "call-17" };

  await executeLegacyIntent(executorPrototype, {}, selection);
  assert.deepEqual(received, [selection]);
});

test("legacy intent capability fails closed when no executor owns the chain", async () => {
  await assert.rejects(
    executeLegacyIntent({}, {}, { callId: "missing" }),
    /Legacy intent executor is not installed/,
  );
});

test("legacy intent executors form an explicit semantic chain of responsibility", async () => {
  const order = [];
  const base = {
    async [LEGACY_INTENT_EXECUTOR](selection) { order.push(`base:${selection.callId}`); },
  };
  const specialized = Object.create(base);
  specialized[LEGACY_INTENT_EXECUTOR] = async function (selection) {
    order.push(`specialized:${selection.callId}`);
    await executeLegacyIntent(base, this, selection);
  };

  await executeLegacyIntent(specialized, {}, { callId: "chain" });
  assert.deepEqual(order, ["specialized:chain", "base:chain"]);
});

test("V13 delegates legacy execution without synthesizing provider wire events", async () => {
  const sourceRoot = new URL("./", import.meta.url);
  const v13 = await readFile(new URL("call-session-v13.ts", sourceRoot), "utf8");
  const executors = await Promise.all(
    [2, 5, 7, 9, 10, 11].map((version) =>
      readFile(new URL(`call-session-v${version}.ts`, sourceRoot), "utf8"),
    ),
  );

  assert.match(v13, /adaptRealtimeProviderEvents\(data\)/);
  assert.match(v13, /executeLegacyIntent\(BasePrototype, this/);
  assert.match(v13, /realtimeCommandPortFor\(this as any\)/);
  assert.match(v13, /conversationLifecyclePortFor\(this\)\.isTerminal\(\)/);
  assert.doesNotMatch(v13, /response\.function_call_arguments\.done|conversation\.item\.create|function_call_output|session\.update|TextDecoder|hangupStarted/);
  assert.doesNotMatch(v13, /BasePrototype\.handleRealtimeMessage\.call\(this,\s*JSON\.stringify/);
  for (const source of executors) assert.match(source, /\[LEGACY_INTENT_EXECUTOR\]/);
  for (const source of executors.slice(3)) {
    assert.match(source, /conversationLifecyclePortFor\(this\)\.isTerminal\(\)/);
    assert.doesNotMatch(source, /\(this as any\)\.(?:hangupStarted|state\s*={2,3}\s*["']closing["'])/);
  }
});

test("V11 query routing uses neutral realtime input and command ports", async () => {
  const sourceRoot = new URL("./", import.meta.url);
  const v11 = await readFile(new URL("call-session-v11.ts", sourceRoot), "utf8");

  assert.match(v11, /adaptRealtimeProviderEvents\(data\)/);
  assert.match(v11, /realtimeCommandPortFor\(this as any\)\.updateSessionPolicy/);
  assert.match(v11, /realtimeCommandPortFor\(this as any\)\.submitToolResult/);
  assert.match(v11, /this\[LEGACY_INTENT_EXECUTOR\]\(\{ argumentsJson: event\.arguments, callId: event\.callId \}\)/);
  assert.doesNotMatch(v11, /response\.function_call_arguments\.done|conversation\.item\.create|function_call_output|session\.update|TextDecoder/);
  assert.doesNotMatch(v11, /\(this as any\)\.send\(/);
});

test("V10 cancellation routing uses neutral realtime input and command ports", async () => {
  const sourceRoot = new URL("./", import.meta.url);
  const v10 = await readFile(new URL("call-session-v10.ts", sourceRoot), "utf8");

  assert.match(v10, /adaptRealtimeProviderEvents\(data\)/);
  assert.match(v10, /realtimeCommandPortFor\(this as any\)\.submitToolResult/);
  assert.match(v10, /this\[LEGACY_INTENT_EXECUTOR\]\(\{ argumentsJson: event\.arguments, callId: event\.callId \}\)/);
  assert.doesNotMatch(v10, /response\.function_call_arguments\.done|conversation\.item\.create|function_call_output|TextDecoder/);
  assert.doesNotMatch(v10, /\(this as any\)\.send\(/);
});

test("V9 workflow authority consumes neutral realtime input", async () => {
  const sourceRoot = new URL("./", import.meta.url);
  const v9 = await readFile(new URL("call-session-v9.ts", sourceRoot), "utf8");

  assert.match(v9, /adaptRealtimeProviderEvents\(data\)/);
  assert.match(v9, /realtimeCommandPortFor\(this as any\)\.submitToolResult/);
  assert.match(v9, /executeLegacyIntent\(BasePrototype, this/);
  assert.match(v9, /this\[LEGACY_INTENT_EXECUTOR\]\(\{ argumentsJson: event\.arguments, callId: event\.callId \}\)/);
  assert.doesNotMatch(v9, /response\.function_call_arguments\.done|conversation\.item\.create|function_call_output|TextDecoder/);
  assert.doesNotMatch(v9, /BasePrototype\.handleRealtimeMessage\.call\(this,\s*JSON\.stringify/);
});
