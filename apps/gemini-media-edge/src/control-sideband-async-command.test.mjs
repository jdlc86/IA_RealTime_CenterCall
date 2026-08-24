import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryControlSidebandRegistry } from "./control-sideband.mjs";

const claims = { tenantId: "tenant-async", callControlId: "call-async" };

test("control registry propagates async command sink completion", async () => {
  const registry = new InMemoryControlSidebandRegistry();
  const expected = Promise.resolve("done");
  const attachment = registry.bindCommandSink(claims, () => expected);

  const actual = registry.command(claims, {
    type: "PLAYBACK_DRAIN",
    responseId: "response-1",
  });

  assert.equal(actual, expected);
  assert.equal(await actual, "done");
  attachment.detach();
});

test("control registry propagates async command sink rejection", async () => {
  const registry = new InMemoryControlSidebandRegistry();
  const attachment = registry.bindCommandSink(claims, async () => {
    throw new Error("async command failed");
  });

  await assert.rejects(
    registry.command(claims, { type: "PLAYBACK_DRAIN", responseId: "response-2" }),
    /async command failed/,
  );
  attachment.detach();
});
