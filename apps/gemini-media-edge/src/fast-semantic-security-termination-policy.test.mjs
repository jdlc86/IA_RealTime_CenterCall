import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { FastSemanticSecurityTerminationPolicy } from "./fast-semantic-security-termination-policy.mjs";

test("semantic security termination requires three distinct authorized observations", () => {
  const policy = new FastSemanticSecurityTerminationPolicy();
  assert.equal(policy.observe({ toolCallId: "signal-1", category: "PROMPT_INJECTION" }).terminate, false);
  assert.equal(policy.observe({ toolCallId: "signal-2", category: "ROLE_ESCALATION" }).terminate, false);
  const terminal = policy.observe({ toolCallId: "signal-3", category: "TOOL_MANIPULATION" });
  assert.equal(terminal.highConfidence, true);
  assert.equal(terminal.terminate, true);
  assert.equal(terminal.observationCount, 3);
  assert.equal(policy.observe({ toolCallId: "signal-4", category: "PROMPT_EXFILTRATION" }).terminate, false);
});

test("semantic security replay cannot advance or repeat termination", () => {
  const policy = new FastSemanticSecurityTerminationPolicy();
  policy.observe({ toolCallId: "signal-1", category: "PROMPT_INJECTION" });
  const replay = policy.observe({ toolCallId: "signal-1", category: "PROMPT_INJECTION" });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.observationCount, 1);
  assert.equal(replay.terminate, false);
});

test("semantic security can retry on a later distinct observation after terminal control failure", () => {
  const policy = new FastSemanticSecurityTerminationPolicy({ threshold: 2 });
  policy.observe({ toolCallId: "call-1", category: "PROMPT_INJECTION" });
  assert.equal(policy.observe({ toolCallId: "call-2", category: "PROMPT_INJECTION" }).terminate, true);
  policy.releaseTerminationAttempt();
  assert.equal(policy.observe({ toolCallId: "call-3", category: "PROMPT_INJECTION" }).terminate, true);
});

test("semantic security policy is bounded and rejects invalid configuration", () => {
  assert.throws(() => new FastSemanticSecurityTerminationPolicy({ threshold: 1 }), /threshold is invalid/);
  const policy = new FastSemanticSecurityTerminationPolicy({ threshold: 2, maxObservations: 2 });
  policy.observe({ toolCallId: "signal-1", category: "PROMPT_INJECTION" });
  policy.observe({ toolCallId: "signal-2", category: "PROMPT_INJECTION" });
  assert.throws(() => policy.observe({ toolCallId: "signal-3", category: "PROMPT_INJECTION" }), /budget exceeded/);
});

test("semantic security local decision adds no asynchronous or network gate", () => {
  const samples = [];
  for (let index = 0; index < 10_000; index += 1) {
    const policy = new FastSemanticSecurityTerminationPolicy({ maxObservations: 128 });
    const started = performance.now();
    policy.observe({ toolCallId: `signal-${index}`, category: "PROMPT_INJECTION" });
    samples.push((performance.now() - started) * 1_000);
  }
  samples.sort((left, right) => left - right);
  const percentile = (value) => samples[Math.min(samples.length - 1, Math.floor(samples.length * value))];
  const result = { p50Micros: percentile(0.50), p95Micros: percentile(0.95), p99Micros: percentile(0.99) };
  assert.equal(result.p99Micros < 250, true, JSON.stringify(result));
});
