import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CallTerminationRuntime } from "../.test-dist/call-termination-port.js";

function host(env = {}) {
  return { env };
}

function response(status, body = "") {
  return new Response(status === 204 ? null : body, { status });
}

test("call termination uses Telnyx source leg first", async () => {
  const calls = [];
  const runtime = new CallTerminationRuntime(
    host({ TELNYX_API_KEY: "tel-key", OPENAI_API_KEY: "open-key" }),
    async (url, init) => {
      calls.push({ url: String(url), init });
      return response(200);
    },
  );

  const result = await runtime.terminate({
    sourceCallControlId: "source-1",
    realtimeCallId: "rt-1",
    commandId: "cmd-1",
  });

  assert.equal(result.terminated, true);
  assert.deepEqual(result.attempts, [{ transport: "TELNYX_SOURCE_LEG", ok: true, httpStatus: 200 }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.telnyx\.com/);
  assert.equal(JSON.parse(calls[0].init.body).command_id, "cmd-1");
});

test("failed Telnyx termination falls back to realtime transport by default", async () => {
  const urls = [];
  const runtime = new CallTerminationRuntime(
    host({ TELNYX_API_KEY: "tel-key", OPENAI_API_KEY: "open-key" }),
    async (url) => {
      const text = String(url);
      urls.push(text);
      return text.includes("telnyx.com") ? response(500, "telnyx failed") : response(200);
    },
  );

  const result = await runtime.terminate({ sourceCallControlId: "source-2", realtimeCallId: "rt-2" });
  assert.equal(result.terminated, true);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].transport, "TELNYX_SOURCE_LEG");
  assert.equal(result.attempts[0].ok, false);
  assert.match(result.attempts[0].error, /Telnyx hangup HTTP 500/);
  assert.deepEqual(result.attempts[1], {
    transport: "OPENAI_REALTIME_FALLBACK",
    ok: true,
    httpStatus: 200,
  });
  assert.match(urls[1], /api\.openai\.com/);
});

test("source-only termination never changes transport after a Telnyx failure", async () => {
  const urls = [];
  const runtime = new CallTerminationRuntime(
    host({ TELNYX_API_KEY: "tel-key", OPENAI_API_KEY: "open-key" }),
    async (url) => {
      urls.push(String(url));
      return response(500, "source failed");
    },
  );

  const result = await runtime.terminate({
    sourceCallControlId: "source-only-1",
    realtimeCallId: "rt-unused",
    fallbackMode: "SOURCE_ONLY",
  });

  assert.equal(result.terminated, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].transport, "TELNYX_SOURCE_LEG");
  assert.equal(result.attempts[0].ok, false);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /api\.telnyx\.com/);
  assert.doesNotMatch(urls[0], /api\.openai\.com/);
});

test("direct realtime session terminates without a Telnyx attempt", async () => {
  const urls = [];
  const runtime = new CallTerminationRuntime(
    host({ OPENAI_API_KEY: "open-key" }),
    async (url) => {
      urls.push(String(url));
      return response(204);
    },
  );

  const result = await runtime.terminate({ realtimeCallId: "rt-direct" });
  assert.equal(result.terminated, true);
  assert.deepEqual(result.attempts, [{
    transport: "OPENAI_REALTIME_FALLBACK",
    ok: true,
    httpStatus: 204,
  }]);
  assert.equal(urls.length, 1);
});

test("termination reports failure without claiming lifecycle completion", async () => {
  const runtime = new CallTerminationRuntime(
    host({ TELNYX_API_KEY: "tel-key", OPENAI_API_KEY: "open-key" }),
    async () => response(500, "failed"),
  );
  const result = await runtime.terminate({ sourceCallControlId: "source-3", realtimeCallId: "rt-3" });
  assert.equal(result.terminated, false);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts.every((attempt) => attempt.ok === false), true);
});

test("V37 delegates physical hangup and source-leg transfer through neutral ports", () => {
  const v37 = readFileSync(new URL("./call-session-v37.ts", import.meta.url), "utf8");
  assert.match(v37, /callTerminationPortFor/);
  assert.match(v37, /\.terminate\(\{/);
  assert.match(v37, /humanHandoffTransportPortFor\(this as any\)\.startTransfer\(/);
  assert.doesNotMatch(v37, /api\.(?:openai|telnyx)\.com/);
  assert.doesNotMatch(v37, /\b(?:OPENAI_API_KEY|TELNYX_API_KEY)\b/);
});
