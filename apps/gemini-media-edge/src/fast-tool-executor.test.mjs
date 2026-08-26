import assert from "node:assert/strict";
import test from "node:test";
import { FastGeminiToolExecutor } from "./fast-tool-executor.mjs";

test("fast tool executor executes an allowed tool exactly once and caches exact retry", async () => {
  let calls = 0;
  const executor = new FastGeminiToolExecutor({
    handlers: {
      restaurant_reservation_create: async (call, context) => {
        calls += 1;
        assert.equal(context.tenantId, "tenant-1");
        return { status: "NEEDS_TIME", party_size: call.args.party_size };
      },
    },
  });
  const toolCall = {
    id: "gemini-tool-1",
    name: "restaurant_reservation_create",
    args: { party_size: 2 },
  };
  const first = await executor.execute(toolCall, { tenantId: "tenant-1" });
  const retry = await executor.execute(toolCall, { tenantId: "tenant-1" });
  assert.deepEqual(first, { status: "NEEDS_TIME", party_size: 2 });
  assert.deepEqual(retry, first);
  assert.equal(calls, 1);
  assert.equal(executor.snapshot().completedCalls, 1);
});

test("fast tool executor rejects tool identity rebinding", async () => {
  const executor = new FastGeminiToolExecutor({
    handlers: { restaurant_reservation_create: async () => ({ ok: true }) },
  });
  await executor.execute({ id: "same-id", name: "restaurant_reservation_create", args: { party_size: 2 } });
  await assert.rejects(
    executor.execute({ id: "same-id", name: "restaurant_reservation_create", args: { party_size: 3 } }),
    /reused with different content/,
  );
});

test("fast tool executor rejects undeclared tools before any side effect", async () => {
  let called = false;
  const executor = new FastGeminiToolExecutor({
    handlers: { allowed_tool: async () => { called = true; return { ok: true }; } },
  });
  await assert.rejects(
    executor.execute({ id: "bad-1", name: "not_allowed", args: {} }),
    /not allowed/,
  );
  assert.equal(called, false);
});

test("fast tool executor coalesces an identical concurrent Gemini retry", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executor = new FastGeminiToolExecutor({
    handlers: {
      slow_tool: async () => {
        calls += 1;
        await gate;
        return { ok: true };
      },
    },
  });
  const call = { id: "inflight-1", name: "slow_tool", args: { a: 1 } };
  const first = executor.execute(call);
  const second = executor.execute(call);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.equal(calls, 1);
});
