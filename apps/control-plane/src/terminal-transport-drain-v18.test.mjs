import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFile(join(here, name), "utf8");

test("terminal hangup drains transport after OpenAI output buffer stop without affecting normal turns", async () => {
  const v18 = await source("call-session-v18.ts");

  assert.match(v18, /const TERMINAL_TRANSPORT_DRAIN_MS = 750;/);
  assert.match(v18, /LIFECYCLE_TERMINAL_DRAIN_ARMED_V18/);
  assert.match(v18, /source_guarantee: "openai_server_buffer_drained"/);
  assert.match(v18, /normal_response_latency_affected: false/);
  assert.match(v18, /setTimeout\(\(\) => \{[\s\S]*?LIFECYCLE_TERMINAL_DRAIN_COMPLETED_V18[\s\S]*?performHangup\?\.\("lifecycle_terminal_transport_drained"\)[\s\S]*?\}, TERMINAL_TRANSPORT_DRAIN_MS\)/);
  assert.doesNotMatch(v18, /performHangup\?\.\("lifecycle_terminal_audio_stopped"\)/);
});
