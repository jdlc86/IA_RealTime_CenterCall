import assert from "node:assert/strict";
import test from "node:test";
import { FastToolAuthorizationKernel, defineFastToolPolicy } from "./fast-tool-authorization-kernel.mjs";
import { FastGeminiToolExecutor } from "./fast-tool-executor.mjs";

const executionContext = Object.freeze({ tenantId: "tenant-1", callControlId: "v3:call-1" });

function authorizationFor(call, context = executionContext) {
  const kernel = new FastToolAuthorizationKernel({
    policies: {
      [call.name]: defineFastToolPolicy({
        authority: "SEMANTIC_NECESSITY",
        effect: "READ_CONTEXT",
        capability: `test.${call.name}`,
      }),
    },
    declaredTools: [{ name: call.name, capability: `test.${call.name}` }],
  });
  return kernel.authorize(call, context);
}

function authorizedCall(id, name, args = {}) {
  return { id, name, args: { ...args, authorization: "SEMANTIC_NECESSITY" } };
}

test("fast tool executor executes an authorized tool exactly once and caches exact retry", async () => {
  let calls = 0;
  const executor = new FastGeminiToolExecutor({ handlers: {
    restaurant_reservation_create: async (call, context) => {
      calls += 1;
      assert.equal(context.tenantId, "tenant-1");
      return { status: "NEEDS_TIME", party_size: call.args.party_size };
    },
  } });
  const toolCall = authorizedCall("gemini-tool-1", "restaurant_reservation_create", { party_size: 2 });
  const authorization = authorizationFor(toolCall);
  const first = await executor.execute(toolCall, authorization, executionContext);
  const retry = await executor.execute(toolCall, authorization, executionContext);
  assert.deepEqual(first, { status: "NEEDS_TIME", party_size: 2 });
  assert.deepEqual(retry, first);
  assert.equal(calls, 1);
  assert.equal(executor.snapshot().completedCalls, 1);
});

test("fast tool executor rejects a missing or fabricated authorization receipt before side effects", async () => {
  let calls = 0;
  const executor = new FastGeminiToolExecutor({ handlers: { effect_tool: async () => { calls += 1; return { ok: true }; } } });
  const call = authorizedCall("bypass-1", "effect_tool");
  await assert.rejects(executor.execute(call, null, executionContext), /authorization receipt is required/);
  await assert.rejects(
    executor.execute(call, Object.freeze({ allowed: true, status: "TOOL_AUTHORIZED" }), executionContext),
    /authorization receipt is required/,
  );
  assert.equal(calls, 0);
});

test("fast tool executor rejects receipt rebinding to another call or context", async () => {
  let calls = 0;
  const executor = new FastGeminiToolExecutor({ handlers: { effect_tool: async () => { calls += 1; return { ok: true }; } } });
  const original = authorizedCall("bound-1", "effect_tool", { value: 1 });
  const authorization = authorizationFor(original);
  await assert.rejects(executor.execute(structuredClone(original), authorization, executionContext), /does not match the function call/);
  await assert.rejects(
    executor.execute(original, authorization, { tenantId: "tenant-2", callControlId: "v3:call-1" }),
    /does not match the call context/,
  );
  assert.equal(calls, 0);
});

test("fast tool executor executes the authorized argument snapshot if raw arguments mutate", async () => {
  let observed;
  const executor = new FastGeminiToolExecutor({ handlers: { effect_tool: async (call) => { observed = call.args.value; return { ok: true }; } } });
  const call = authorizedCall("snapshot-1", "effect_tool", { value: "authorized" });
  const authorization = authorizationFor(call);
  call.args.value = "mutated-after-authorization";
  await executor.execute(call, authorization, executionContext);
  assert.equal(observed, "authorized");
});

test("fast tool executor rejects tool identity rebinding", async () => {
  const executor = new FastGeminiToolExecutor({ handlers: { restaurant_reservation_create: async () => ({ ok: true }) } });
  const firstCall = authorizedCall("same-id", "restaurant_reservation_create", { party_size: 2 });
  await executor.execute(firstCall, authorizationFor(firstCall), executionContext);
  const reboundCall = authorizedCall("same-id", "restaurant_reservation_create", { party_size: 3 });
  await assert.rejects(
    executor.execute(reboundCall, authorizationFor(reboundCall), executionContext),
    /reused with different content/,
  );
});

test("fast tool executor rejects undeclared tools before any side effect", async () => {
  let called = false;
  const executor = new FastGeminiToolExecutor({ handlers: { allowed_tool: async () => { called = true; return { ok: true }; } } });
  const allowed = authorizedCall("allowed-1", "allowed_tool");
  const authorization = authorizationFor(allowed);
  await assert.rejects(
    executor.execute(authorizedCall("bad-1", "not_allowed"), authorization, executionContext),
    /does not match the function call/,
  );
  assert.equal(called, false);
});

test("fast tool executor coalesces an identical concurrent Gemini retry", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executor = new FastGeminiToolExecutor({ handlers: { slow_tool: async () => { calls += 1; await gate; return { ok: true }; } } });
  const call = authorizedCall("inflight-1", "slow_tool", { a: 1 });
  const authorization = authorizationFor(call);
  const first = executor.execute(call, authorization, executionContext);
  const second = executor.execute(call, authorization, executionContext);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.equal(calls, 1);
});
