import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HangupController } from "../.test-dist/hangup-controller.js";

function makeHost({ sourceCallControlId = null, terminateCall }) {
  let connected = true;
  const checkpoints = [];
  const failures = [];
  const host = {
    getCallId: () => "rt-1",
    getSocketConnected: () => connected,
    getSourceCallControlId: () => sourceCallControlId,
    terminateCall: async (request) => terminateCall(request, () => { connected = false; }),
    clearFinalFarewellWatchdog() {},
    resetExternalFlow() {},
    diagnostics: {
      checkpoint(event, details) { checkpoints.push({ event, details }); },
      fail(event, code, details) { failures.push({ event, code, details }); },
    },
  };
  return { host, checkpoints, failures };
}

test("source-leg hangup retries stay SOURCE_ONLY and never authorize realtime fallback", async () => {
  const requests = [];
  const { host, failures } = makeHost({
    sourceCallControlId: "source-1",
    terminateCall: async (request) => {
      requests.push(request);
      return {
        terminated: false,
        attempts: [{ transport: "TELNYX_SOURCE_LEG", ok: false, error: "source failed" }],
      };
    },
  });
  const controller = new HangupController(host, {
    confirmationTimeoutMs: 1,
    retryDelayMs: 0,
    maxImmediateAttempts: 2,
    backgroundRetryMs: 60_000,
  });

  await controller.perform("test_source_retry");
  controller.dispose();

  assert.equal(requests.length, 2);
  assert.equal(requests.every((request) => request.fallbackMode === "SOURCE_ONLY"), true);
  assert.equal(requests.every((request) => request.sourceCallControlId === "source-1"), true);
  assert.equal(requests.every((request) => request.realtimeCallId === "rt-1"), true);
  assert.equal(failures.some((failure) => failure.event === "HANGUP_UNCONFIRMED"), true);
});

test("direct realtime hangup uses neutral termination port and waits for sideband close", async () => {
  const requests = [];
  const { host, checkpoints } = makeHost({
    terminateCall: async (request, disconnect) => {
      requests.push(request);
      disconnect();
      return {
        terminated: true,
        attempts: [{ transport: "OPENAI_REALTIME_FALLBACK", ok: true, httpStatus: 204 }],
      };
    },
  });
  const controller = new HangupController(host, {
    confirmationTimeoutMs: 10,
    retryDelayMs: 0,
    maxImmediateAttempts: 1,
    backgroundRetryMs: 60_000,
  });

  await controller.perform("test_realtime");
  controller.dispose();

  assert.deepEqual(requests, [{ realtimeCallId: "rt-1", fallbackMode: "REALTIME_FALLBACK" }]);
  assert.equal(checkpoints.some((entry) => entry.event === "HANGUP_REQUEST_ACCEPTED"), true);
  assert.equal(checkpoints.some((entry) => entry.event === "HANGUP_COMPLETED"), true);
});

test("provider terminal evidence completes immediately without a sideband timeout", async () => {
  const { host, checkpoints, failures } = makeHost({
    sourceCallControlId: "source-already-ended",
    terminateCall: async () => ({
      terminated: true,
      terminationConfirmed: true,
      attempts: [{
        transport: "TELNYX_SOURCE_LEG",
        ok: true,
        httpStatus: 422,
        terminalEvidence: "ALREADY_TERMINATED",
      }],
    }),
  });
  const controller = new HangupController(host, {
    confirmationTimeoutMs: 100,
    retryDelayMs: 0,
    maxImmediateAttempts: 1,
    backgroundRetryMs: 60_000,
  });

  await controller.perform("test_provider_terminal_evidence");
  controller.dispose();

  assert.equal(failures.length, 0);
  assert.equal(checkpoints.some((entry) => entry.event === "HANGUP_COMPLETED"
    && entry.details.confirmation === "provider_terminal_state"), true);
});

test("delayed sideband confirmation is informational when a retry proves the call already terminal", async () => {
  let attempts = 0;
  const { host, checkpoints, failures } = makeHost({
    sourceCallControlId: "source-delayed-sideband",
    terminateCall: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          terminated: true,
          attempts: [{ transport: "TELNYX_SOURCE_LEG", ok: true, httpStatus: 200 }],
        };
      }
      return {
        terminated: true,
        terminationConfirmed: true,
        attempts: [{
          transport: "TELNYX_SOURCE_LEG",
          ok: true,
          httpStatus: 422,
          terminalEvidence: "ALREADY_TERMINATED",
        }],
      };
    },
  });
  const controller = new HangupController(host, {
    confirmationTimeoutMs: 1,
    retryDelayMs: 0,
    maxImmediateAttempts: 2,
    backgroundRetryMs: 60_000,
  });

  await controller.perform("test_delayed_sideband");
  controller.dispose();

  assert.equal(attempts, 2);
  assert.equal(failures.length, 0);
  assert.equal(checkpoints.some((entry) => entry.event === "HANGUP_CONFIRMATION_TIMEOUT"
    && entry.details.terminal_failure === false), true);
  assert.equal(checkpoints.some((entry) => entry.event === "HANGUP_COMPLETED"
    && entry.details.confirmation === "provider_terminal_state"), true);
});

test("default sideband confirmation window covers ordinary provider close latency", () => {
  const source = readFileSync(new URL("./hangup-controller.ts", import.meta.url), "utf8");
  assert.match(source, /DEFAULT_CONFIRMATION_TIMEOUT_MS = 8_000/);
});

test("hangup controller owns the in-flight lock and rejects overlapping termination attempts", async () => {
  const requests = [];
  let resolveTermination;
  const { host } = makeHost({
    terminateCall: (request, disconnect) => new Promise((resolve) => {
      requests.push(request);
      resolveTermination = () => {
        disconnect();
        resolve({
          terminated: true,
          attempts: [{ transport: "OPENAI_REALTIME_FALLBACK", ok: true, httpStatus: 204 }],
        });
      };
    }),
  });
  const controller = new HangupController(host, {
    confirmationTimeoutMs: 10,
    retryDelayMs: 0,
    maxImmediateAttempts: 1,
    backgroundRetryMs: 60_000,
  });

  const first = controller.perform("first");
  const overlapping = controller.perform("overlapping");
  await overlapping;
  assert.equal(requests.length, 1);

  assert.equal(typeof resolveTermination, "function");
  resolveTermination();
  await first;
  controller.dispose();
});

test("hangup controller owns orchestration but contains no provider endpoint or inherited state authority", () => {
  const source = readFileSync(new URL("./hangup-controller.ts", import.meta.url), "utf8");
  const v22 = readFileSync(new URL("./call-session-v22.ts", import.meta.url), "utf8");

  assert.match(source, /private hangupStarted = false/);
  assert.match(source, /terminateCall\(request\)/);
  assert.match(source, /fallbackMode: "SOURCE_ONLY"/);
  assert.doesNotMatch(source, /api\.telnyx\.com|api\.openai\.com/);
  assert.doesNotMatch(source, /TELNYX_API_KEY|OPENAI_API_KEY/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /isHangupStarted|setHangupStarted/);

  assert.match(v22, /callTerminationPortFor/);
  assert.match(v22, /terminateCall: \(request\) => terminationPort\.terminate\(request\)/);
  assert.doesNotMatch(v22, /getApiKey|getTelnyxApiKey/);
  assert.doesNotMatch(v22, /\bhangupStarted\b/);
});
