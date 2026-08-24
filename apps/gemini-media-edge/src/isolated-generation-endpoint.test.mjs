import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");

test("isolated generation endpoint stays authenticated and session-scoped", () => {
  assert.match(source, /request\.url === "\/internal\/isolated-generation" && request\.method === "POST"/);
  assert.match(source, /controlAuthorization\(request, controlPlaneToken\)/);
  assert.match(source, /generateForActiveGeminiControlSession\(controlRegistry, isolatedGeneration/);
  assert.match(source, /readJsonBody\(request, 64 \* 1024\)/);
  assert.match(source, /"cache-control": "no-store"/);
});

test("isolated generation endpoint redacts provider failures", () => {
  assert.match(source, /"inactive_session"/);
  assert.match(source, /"invalid_request"/);
  assert.match(source, /"isolated_generation_failed"/);
  assert.doesNotMatch(source, /response\.end\(JSON\.stringify\(\{ ok: false, error: message \}\)\)/);
});
