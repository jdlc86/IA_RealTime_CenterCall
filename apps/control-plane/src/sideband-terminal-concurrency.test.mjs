import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFile(join(here, name), "utf8");

test("sideband terminal boundary detaches turn concurrency through neutral ports without adding timers", async () => {
  const v46 = await source("call-session-v46-sideband-lifecycle.ts");
  const coordinator = await source("turn-concurrency-coordinator.ts");

  assert.match(v46, /conversationLifecyclePortFor\(this\)\.transportClosed\(lifecycleEvent\.reason\)/);
  assert.match(v46, /sidebandLifecyclePortFor\(this\)\.installCloseObserver/);
  assert.match(v46, /turnConcurrencyCoordinatorFor\(this\)\.detachForTerminal\(session, `transport_closed:\$\{lifecycleEvent\.reason\}`\)/);
  assert.match(v46, /lifecycle_authority: "conversation_lifecycle_port"/);
  assert.match(v46, /turn_concurrency_detached: true/);
  assert.match(v46, /direct_version_state_mutation: false/);
  assert.doesNotMatch(v46, /observeRealtimeTransportClosedV18/);
  assert.doesNotMatch(v46, /detachTurnConcurrencyForTerminalV36/);
  assert.doesNotMatch(v46, /setTimeout\s*\(/);
  assert.doesNotMatch(v46, /addEventListener\s*\(/);

  const detachBody = coordinator.match(/detachForTerminal\(session: any, reason: string\): void \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.match(detachBody, /this\.lifecycle\.release\(\)/);
  assert.match(detachBody, /this\.clearWatchdog\(\)/);
  assert.match(detachBody, /this\.normalPlaybackActive = false/);
  assert.match(detachBody, /owner: "turn_concurrency_coordinator"/);
  assert.doesNotMatch(detachBody, /restoreInputDetection/);
});

test("V46 diagnostics read terminal state only through ConversationLifecyclePort", async () => {
  const v46 = await source("call-session-v46-sideband-lifecycle.ts");
  assert.match(v46, /const lifecycle = conversationLifecyclePortFor\(this\)/);
  assert.match(v46, /lifecycle_terminal_before_transport_notification: lifecycle\.isTerminal\(\)/);
  assert.doesNotMatch(v46, /session\.state/);
  assert.doesNotMatch(v46, /session\.hangupStarted/);
  assert.doesNotMatch(v46, /hangup_started/);
});
