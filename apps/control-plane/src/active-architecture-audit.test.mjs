import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function activeCallSessionFiles() {
  return readdirSync(here)
    .filter((name) => /^call-session-v(?:3[1-9]|4\d|5[0-4])(?:-|\.)/.test(name) && name.endsWith(".ts"))
    .sort();
}

const forbiddenBoundaries = [
  ["raw OpenAI event adapter", /openai-realtime-event-adapter/],
  ["raw OpenAI command adapter", /openai-realtime-command-adapter/],
  ["direct Gemini provider branch", /\bGEMINI\b/],
  ["raw realtime text parser", /\b(?:readRealtimeText|parseEvent|TextDecoder)\b/],
  ["raw OpenAI transcription wire event", /conversation\.item\.input_audio_transcription\.completed/],
  ["raw OpenAI tool-selection wire event", /response\.function_call_arguments\.done/],
  ["direct session send/update", /(?:\bsession|\bself|\bthis|\(this as any\))\??\.(?:send|update)\s*\(/],
  ["direct semantic authority", /\bauthorizePublicRestaurantTool\s*\(/],
  ["legacy hangupStarted state", /\bhangupStarted\b/],
  ["direct provider credential access", /\b(?:OPENAI_API_KEY|TELNYX_API_KEY|getTelnyxApiKey|getOpenAiApiKey|getOpenAIApiKey)\b/],
  ["direct provider HTTP endpoint", /api\.(?:openai|telnyx)\.com/],
];

test("active V31-V54 consolidation has no provider-wire or authority bypasses", () => {
  const violations = [];
  for (const file of activeCallSessionFiles()) {
    const source = readFileSync(join(here, file), "utf8");
    for (const [label, pattern] of forbiddenBoundaries) {
      if (pattern.test(source)) violations.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(violations, [], `active architecture boundary violations:\n${violations.join("\n")}`);
});

test("audit guard itself covers the known regression classes", () => {
  const samples = [
    ["openai-realtime-event-adapter", "raw OpenAI event adapter"],
    ["if (provider === 'GEMINI')", "direct Gemini provider branch"],
    ["const event = parseEvent(data)", "raw realtime text parser"],
    ["response.function_call_arguments.done", "raw OpenAI tool-selection wire event"],
    ["session.send({ type: 'response.create' })", "direct session send/update"],
    ["authorizePublicRestaurantTool(this, request)", "direct semantic authority"],
    ["session.hangupStarted", "legacy hangupStarted state"],
    ["const key = env.TELNYX_API_KEY", "direct provider credential access"],
    ["getOpenAIApiKey()", "direct provider credential access"],
    ["https://api.openai.com/v1/realtime/calls/x/hangup", "direct provider HTTP endpoint"],
    ["https://api.telnyx.com/v2/calls/x/actions/hangup", "direct provider HTTP endpoint"],
  ];
  for (const [source, expectedLabel] of samples) {
    assert.equal(
      forbiddenBoundaries.some(([label, pattern]) => label === expectedLabel && pattern.test(source)),
      true,
      `audit guard must catch ${expectedLabel}`,
    );
  }
});
