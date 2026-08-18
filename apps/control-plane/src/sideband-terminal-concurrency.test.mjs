import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFile(join(here, name), "utf8");

test("sideband terminal boundary detaches v36 turn concurrency without adding timers", async () => {
  const v46 = await source("call-session-v46-sideband-lifecycle.ts");
  const v36 = await source("call-session-v36.ts");

  assert.match(v46, /observeRealtimeTransportClosedV18\?\.\(lifecycleEvent\.reason\)/);
  assert.match(v46, /detachTurnConcurrencyForTerminalV36\?\.\(`transport_closed:\$\{lifecycleEvent\.reason\}`\)/);
  assert.match(v46, /turn_concurrency_detached: true/);
  assert.doesNotMatch(v46, /setTimeout\s*\(/);

  const detachBody = v36.match(/protected detachTurnConcurrencyForTerminalV36\(reason: string\): void \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.match(detachBody, /turnConcurrencyV36\.release\(\)/);
  assert.match(detachBody, /clearTurnConcurrencyWatchdogV36\(\)/);
  assert.doesNotMatch(detachBody, /restoreInputDetection/);
});
