import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FAST_DIAGNOSTIC_SINK_URL,
  resolveFastDiagnosticSinkUrl,
} from "./server-fast.mjs";

test("fast diagnostics use the Gemini Worker sink by default", () => {
  assert.equal(
    resolveFastDiagnosticSinkUrl({}),
    DEFAULT_FAST_DIAGNOSTIC_SINK_URL,
  );
  assert.equal(
    DEFAULT_FAST_DIAGNOSTIC_SINK_URL,
    "https://ia-realtime-centercall-gemini-fast.julopezcardona.workers.dev/internal/diagnostics-ingest",
  );
});

test("fast diagnostics preserve an explicit sink override", () => {
  assert.equal(
    resolveFastDiagnosticSinkUrl({ FAST_DIAGNOSTIC_SINK_URL: "  https://example.invalid/diagnostics  " }),
    "https://example.invalid/diagnostics",
  );
});
