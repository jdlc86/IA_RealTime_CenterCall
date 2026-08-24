import assert from "node:assert/strict";
import test from "node:test";
import { geminiGovernedSpeechDescriptor } from "../.test-dist/gemini-governed-speech-descriptor.js";

test("governed speech descriptor preserves exact protected identity without heuristics", () => {
  const descriptor = geminiGovernedSpeechDescriptor({
    requestId: "greeting-1",
    instructions: "Pronuncia exactamente el saludo.",
    exactText: "Hola.",
    purpose: "initial_greeting",
    metadata: { protected_speech_v35: "GREETING" },
  });
  assert.deepEqual(descriptor, {
    responseId: "greeting-1",
    text: "Hola.",
    kind: "GREETING",
    purpose: "initial_greeting",
  });
});

test("governed speech descriptor defaults ordinary governed speech to NORMAL and mints identity", () => {
  const descriptor = geminiGovernedSpeechDescriptor({
    instructions: "Pronuncia exactamente el texto.",
    exactText: "De acuerdo.",
  }, () => "fixed-id");
  assert.deepEqual(descriptor, {
    responseId: "gemini_governed_speech_fixed-id",
    text: "De acuerdo.",
    kind: "NORMAL",
  });
});

test("governed speech descriptor fails closed on missing exact text or unsupported protected metadata", () => {
  assert.throws(
    () => geminiGovernedSpeechDescriptor({ instructions: "Genera algo" }),
    /exact text is required/,
  );
  assert.throws(
    () => geminiGovernedSpeechDescriptor({
      instructions: "Pronuncia exactamente el texto.",
      exactText: "Hola.",
      metadata: { protected_speech_v35: "TERMINAL" },
    }),
    /protected kind is unsupported/,
  );
});
