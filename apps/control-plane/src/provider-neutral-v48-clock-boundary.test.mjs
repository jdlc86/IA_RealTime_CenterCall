import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v48-authoritative-clock.ts", import.meta.url), "utf8");

test("v48 consumes caller transcripts through the provider-neutral event boundary", () => {
  assert.match(source, /adaptRealtimeProviderEvents/);
  assert.match(source, /CALLER_TRANSCRIPT_COMPLETED/);
  assert.match(source, /event\.itemId/);
  assert.doesNotMatch(source, /conversation\.item\.input_audio_transcription\.completed/);
  assert.doesNotMatch(source, /event\.item_id/);
});

test("v48 publishes clock refresh through neutral session policy while retaining raw fallback", () => {
  assert.match(source, /installRealtimeSessionPolicyTransform/);
  assert.match(source, /updateSessionPolicy/);
  assert.match(source, /AUTHORITATIVE_CLOCK_INJECTED_V48/);
  assert.match(source, /AUTHORITATIVE_CLOCK_REFRESHED_FOR_CALLER_TURN_V48/);
  assert.match(source, /Compatibility fallback for historical layers/);
  assert.match(source, /message\?\.type === "session\.update"/);
});

test("v48 adds no timer or sleep during provider-neutral refactor", () => {
  assert.doesNotMatch(source, /setTimeout\s*\(/);
  assert.doesNotMatch(source, /sleep\s*\(/);
});
