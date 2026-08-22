import assert from "node:assert/strict";
import test from "node:test";
import { SessionTaskRuntime } from "../.test-dist/session-task-runtime.js";

test("session tasks execute serially in enqueue order", async () => {
  const runtime = new SessionTaskRuntime();
  const observed = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  runtime.enqueue("first", async () => {
    observed.push("first:start");
    await firstGate;
    observed.push("first:end");
  });
  runtime.enqueue("second", () => { observed.push("second"); });

  await Promise.resolve();
  assert.deepEqual(observed, ["first:start"]);
  releaseFirst();
  await runtime.whenIdle();
  assert.deepEqual(observed, ["first:start", "first:end", "second"]);
});

test("a failed task is reported without poisoning the queue", async () => {
  const failures = [];
  const runtime = new SessionTaskRuntime().configure({
    onError: (label, error) => failures.push([label, error.message]),
  });
  let completed = false;

  runtime.enqueue("broken", () => { throw new Error("boom"); });
  runtime.enqueue("healthy", () => { completed = true; });

  await runtime.whenIdle();
  assert.equal(completed, true);
  assert.deepEqual(failures, [["broken", "boom"]]);
});

test("serialized and background work is attached to the session lifetime", async () => {
  const owned = [];
  const runtime = new SessionTaskRuntime().configure({ waitUntil: (promise) => owned.push(promise) });

  runtime.enqueue("event", () => {});
  runtime.runInBackground("io", async () => {});

  assert.equal(owned.length, 2);
  await Promise.all(owned);
});
