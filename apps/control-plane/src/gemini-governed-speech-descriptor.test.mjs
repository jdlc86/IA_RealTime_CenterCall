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

test("governed speech descriptor preserves product-owned presence, terminal and handoff kinds", () => {
  assert.equal(geminiGovernedSpeechDescriptor({
    instructions: "Pregunta si sigue ahí.",
    exactText: "¿Sigues ahí?",
    purpose: "presence_recovery_v18",
  }).kind, "PRESENCE");
  assert.equal(geminiGovernedSpeechDescriptor({
    instructions: "Despídete.",
    exactText: "Hasta pronto.",
    purpose: "terminal_farewell",
  }).kind, "TERMINAL");
  assert.equal(geminiGovernedSpeechDescriptor({
    instructions: "Anuncia la transferencia.",
    exactText: "Te transfiero ahora.",
    metadata: { human_handoff_v37: "ANNOUNCEMENT" },
  }).kind, "HANDOFF");
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
  assert.throws(
    () => geminiGovernedSpeechDescriptor({
      instructions: "Pronuncia exactamente el texto.",
      exactText: "Hola.",
      metadata: { human_handoff_v37: "UNKNOWN" },
    }),
    /handoff kind is unsupported/,
  );
});
