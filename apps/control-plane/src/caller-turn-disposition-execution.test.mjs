import assert from "node:assert/strict";
import test from "node:test";
import { executeCallerTurnDisposition } from "../.test-dist/caller-turn-disposition-execution.js";
import {
  installCallerTurnDispositionPort,
  removeCallerTurnDispositionPort,
} from "../.test-dist/caller-turn-disposition-runtime.js";

test("installed caller disposition capability suppresses the legacy effect", () => {
  const host = {};
  const resolved = [];
  const port = { resolve(request) { resolved.push(request); } };
  installCallerTurnDispositionPort(host, port);
  let legacyCalls = 0;
  const executor = executeCallerTurnDisposition(
    host,
    { itemId: "candidate-1", disposition: "INTERRUPT" },
    () => { legacyCalls += 1; },
  );
  assert.equal(executor, "CAPABILITY");
  assert.equal(legacyCalls, 0);
  assert.deepEqual(resolved, [{ itemId: "candidate-1", disposition: "INTERRUPT" }]);
  removeCallerTurnDispositionPort(host, port);
});

test("absence of caller disposition capability preserves the legacy effect exactly once", () => {
  const host = {};
  let legacyCalls = 0;
  const executor = executeCallerTurnDisposition(
    host,
    { itemId: "candidate-2", disposition: "IGNORE" },
    () => { legacyCalls += 1; },
  );
  assert.equal(executor, "LEGACY");
  assert.equal(legacyCalls, 1);
});
