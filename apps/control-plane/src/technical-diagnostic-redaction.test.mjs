import test from "node:test";
import assert from "node:assert/strict";
import {
  redactTechnicalText,
  sanitizeDiagnosticDetails,
} from "../.test-dist/technical-diagnostic-redaction.js";
import { CallDiagnostics } from "../.test-dist/call-diagnostics.js";

test("technical transcript keeps intent while redacting direct identifiers", () => {
  const redacted = redactTechnicalText(
    "Me llamo Ana López, mi teléfono es +34 612 345 678 y abandono la reserva. Escríbeme a ana@example.com",
  );
  assert.match(redacted, /abandono la reserva/i);
  assert.match(redacted, /\[NOMBRE_REDACTADO\]/);
  assert.match(redacted, /\[TELEFONO_REDACTADO\]/);
  assert.match(redacted, /\[EMAIL_REDACTADO\]/);
  assert.doesNotMatch(redacted, /Ana López|612 345 678|ana@example\.com/i);
});

test("tool arguments and outputs become bounded structured redacted evidence", () => {
  const details = sanitizeDiagnosticDetails({
    tool: "restaurant_reservation_create",
    arguments: JSON.stringify({
      customer_name: "Ana López",
      customer_phone: "+34612345678",
      party_size: 2,
      starts_at: "2026-08-27T21:00:00+02:00",
      notes: "Tiene una alergia grave",
    }),
    output: JSON.stringify({
      ok: true,
      status: "AVAILABLE_NEEDS_CONTACT",
      missing: ["customer_name"],
      instruction: "internal model instruction",
      draft: { customer_phone: "+34612345678", party_size: 2 },
    }),
  });

  assert.deepEqual(details?.arguments, {
    customer_name: "[NOMBRE_REDACTADO]",
    customer_phone: "[TELEFONO_REDACTADO]",
    party_size: 2,
    starts_at: "2026-08-27T21:00:00+02:00",
    notes: "[DATO_REDACTADO]",
  });
  assert.deepEqual(details?.output, {
    ok: true,
    status: "AVAILABLE_NEEDS_CONTACT",
    missing: ["customer_name"],
    draft: { customer_phone: "[TELEFONO_REDACTADO]", party_size: 2 },
  });
});

test("camelCase identifiers and spoken credentials are redacted too", () => {
  const details = sanitizeDiagnosticDetails({
    output: {
      customerName: "Lucía Ramos",
      callerPhone: "+34611222333",
      contactName: "Luis Pérez",
      dateOfBirth: "1990-01-01",
    },
    transcript: "Mi contraseña es espada azul. Quiero cancelar la reserva",
  });

  assert.deepEqual(details?.output, {
    customerName: "[NOMBRE_REDACTADO]",
    callerPhone: "[TELEFONO_REDACTADO]",
    contactName: "[NOMBRE_REDACTADO]",
    dateOfBirth: "[DATO_REDACTADO]",
  });
  assert.equal(details?.redacted_text, "[CREDENCIAL_REDACTADA]. Quiero cancelar la reserva");
});

test("diagnostic sanitizer exposes only redacted transcript text", () => {
  const details = sanitizeDiagnosticDetails({
    transcript: "Mi nombre es Carlos Ruiz y no quiero continuar",
    usable: true,
    system_prompt: "never persist this",
    audio_payload: "never persist this either",
  });
  assert.deepEqual(details, {
    redacted_text: "Mi nombre es [NOMBRE_REDACTADO] y no quiero continuar",
    redaction_version: 2,
    usable: true,
  });
  assert.equal(JSON.stringify(details).includes("Carlos"), false);
  assert.equal(JSON.stringify(details).includes("never persist"), false);
});

test("reservation names and codes are removed from caller and assistant transcripts", () => {
  const caller = redactTechnicalText("A nombre de Marta Soler.");
  const assistant = redactTechnicalText(
    "La reserva para 15 personas a nombre de Marta Soler ha quedado confirmada. Tu código de reserva es R-123456.",
  );

  assert.equal(caller, "A nombre de [NOMBRE_REDACTADO].");
  assert.match(assistant, /a nombre de \[NOMBRE_REDACTADO\]/i);
  assert.match(assistant, /c[oó]digo de reserva es \[CODIGO_REDACTADO\]/i);
  assert.doesNotMatch(assistant, /Marta|Soler|R-123456/i);
});

test("a request for the reservation holder remains diagnostically meaningful", () => {
  assert.equal(redactTechnicalText("¿A nombre de quién?"), "¿A nombre de quién?");
});

test("unstructured tool payload is never persisted verbatim", () => {
  const output = "customer Ana +34612345678 malformed";
  const details = sanitizeDiagnosticDetails({ output });
  assert.deepEqual(details, { output: { unstructured_redacted: true, char_count: output.length } });
});

test("CallDiagnostics stores only the sanitized evidence in its timeline and sink", async () => {
  const persisted = [];
  const diagnostics = new CallDiagnostics(true);
  diagnostics.configure(true, "call-1", "restaurante-centro", async (entry) => {
    persisted.push(entry);
  });
  diagnostics.checkpoint("TECHNICAL_CALLER_TEXT_REDACTED", {
    transcript: "Me llamo Elena Martín y mi teléfono es +34 611 222 333",
    speaker: "caller",
  });

  const entry = diagnostics.snapshot().timeline.at(-1);
  assert.deepEqual(entry?.details, {
    redacted_text: "Me llamo [NOMBRE_REDACTADO] y mi teléfono es [TELEFONO_REDACTADO]",
    redaction_version: 2,
    speaker: "caller",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted.at(-1)?.details, entry?.details);
  assert.equal(JSON.stringify(persisted).includes("Elena"), false);
  assert.equal(JSON.stringify(persisted).includes("611 222 333"), false);
});
