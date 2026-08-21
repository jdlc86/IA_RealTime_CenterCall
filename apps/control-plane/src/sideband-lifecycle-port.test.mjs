import assert from "node:assert/strict";
import test from "node:test";
import { SidebandLifecyclePort } from "../.test-dist/sideband-lifecycle-port.js";

test("sideband lifecycle port delegates close observation to one composed owner", async () => {
  const observations = [];
  const port = new SidebandLifecyclePort();
  const observer = async (observation) => { observations.push(observation); };
  port.installCloseObserver(observer);
  port.installCloseObserver(observer);

  await port.transportClosed({
    reason: "sideband_closed",
    closeCode: 1000,
    providerReason: "normal",
    wasClean: true,
  });

  assert.deepEqual(observations, [{
    reason: "sideband_closed",
    closeCode: 1000,
    providerReason: "normal",
    wasClean: true,
  }]);
});

test("sideband lifecycle port rejects competing close owners", () => {
  const port = new SidebandLifecyclePort();
  port.installCloseObserver(() => {});
  assert.throws(() => port.installCloseObserver(() => {}), /already installed/);
});
