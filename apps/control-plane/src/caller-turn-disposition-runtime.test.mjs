import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiMediaEdgeCallerTurnDispositionPort } from "../.test-dist/gemini-media-edge-caller-turn-disposition.js";
import {
  callerTurnDispositionPortFor,
  installCallerTurnDispositionPort,
  removeCallerTurnDispositionPort,
} from "../.test-dist/caller-turn-disposition-runtime.js";


test("caller disposition capability is session scoped and single-owner", () => {
  const host = {};
  const calls = [];
  const port = { resolve: (request) => calls.push(request) };
  installCallerTurnDispositionPort(host, port);
  assert.equal(callerTurnDispositionPortFor(host), port);
  assert.throws(() => installCallerTurnDispositionPort(host, { resolve() {} }), /already installed/);
  callerTurnDispositionPortFor(host).resolve({ itemId: "item-1", disposition: "IGNORE" });
  assert.deepEqual(calls, [{ itemId: "item-1", disposition: "IGNORE" }]);
  removeCallerTurnDispositionPort(host, port);
  assert.equal(callerTurnDispositionPortFor(host), null);
});

test("Gemini adapter sends only an already-authorized neutral disposition", () => {
  const calls = [];
  const sideband = { resolveCallerTurn: (itemId, disposition) => calls.push({ itemId, disposition }) };
  const port = createGeminiMediaEdgeCallerTurnDispositionPort(sideband);
  port.resolve({ itemId: "gemini-candidate-7", disposition: "INTERRUPT" });
  assert.deepEqual(calls, [{ itemId: "gemini-candidate-7", disposition: "INTERRUPT" }]);
  assert.throws(() => port.resolve({ itemId: "", disposition: "NORMAL" }), /requires itemId/);
});
