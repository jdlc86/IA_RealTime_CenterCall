import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const sourceDirectory = new URL("./", import.meta.url);

function activeCallSessionSources() {
  return readdirSync(sourceDirectory)
    .filter((name) => /^call-session-v\d+(?:-[a-z0-9-]+)?\.ts$/i.test(name))
    .map((name) => ({ name, version: Number(name.match(/^call-session-v(\d+)/i)[1]) }))
    .filter(({ version }) => version >= 2 && version <= 54)
    .map(({ name }) => ({ name, source: readFileSync(new URL(name, sourceDirectory), "utf8") }));
}

test("active CallSession layers contain no unowned async invocation", () => {
  const violations = [];
  for (const { name, source } of activeCallSessionSources()) {
    source.split(/\r?\n/).forEach((line, index) => {
      if (/\bvoid\s+(?:this|\()/.test(line)) violations.push(`${name}:${index + 1}:${line.trim()}`);
    });
  }
  assert.deepEqual(violations, [], `unowned active-session work is forbidden:\n${violations.join("\n")}`);
});

test("sideband ingress and stateful watchdogs use the session task owner", () => {
  const v2 = readFileSync(new URL("./call-session-v2.ts", import.meta.url), "utf8");
  assert.match(v2, /socket\.addEventListener\("message"[\s\S]*?sessionTasks\.enqueue\("realtime_sideband_message"/);
  assert.match(v2, /waitUntil:\s*\(promise\)\s*=>\s*this\.ctx\.waitUntil\(promise\)/);

  for (const name of [
    "call-session-v3.ts",
    "call-session-v18.ts",
    "call-session-v35.ts",
    "call-session-v35-runtime.ts",
    "call-session-v37.ts",
    "call-session-v38.ts",
    "turn-concurrency-coordinator.ts",
    "hangup-controller.ts",
  ]) {
    const source = readFileSync(new URL(name, sourceDirectory), "utf8");
    assert.match(source, /sessionTaskRuntimeFor\([^)]+\)\.enqueue\(/, `${name} must serialize timer completion`);
  }
});

test("session task owner contains failures and keeps the serial tail live", () => {
  const runtime = readFileSync(new URL("./session-task-runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /private tail: Promise<void> = Promise\.resolve\(\)/);
  assert.match(runtime, /execution\.catch\(\(error\) => this\.report\(label, error\)\)/);
  assert.match(runtime, /this\.waitUntil\?\.\(promise\)/);
});
