import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authoritativeMadridNowContext,
  authoritativeTemporalPromptContext,
  groundMadridDateTime,
  withAuthoritativeTemporalGrounding,
} from "../.test-dist/temporal-grounding.js";

const now = new Date("2026-08-13T07:13:00.000Z"); // 09:13 Europe/Madrid

test("13 August is HOY when Madrid date is 13 August", () => {
  const grounded = groundMadridDateTime("2026-08-13T19:00:00.000Z", now);
  assert.equal(grounded.relative_day, "HOY");
  assert.match(grounded.spoken_date, /^hoy, 13 de agosto de 2026$/);
});

test("14 August is MANANA when Madrid date is 13 August", () => {
  const grounded = groundMadridDateTime("2026-08-14T19:00:00.000Z", now);
  assert.equal(grounded.relative_day, "MANANA");
  assert.match(grounded.spoken_date, /^mañana, 14 de agosto de 2026$/);
});

test("spoken boundary adds authoritative mapping for backend ISO timestamps", () => {
  const instruction = "Informa de la reserva con starts_at 2026-08-13T19:00:00.000Z.";
  const grounded = withAuthoritativeTemporalGrounding(instruction, now);
  assert.match(grounded, /TEMPORAL AUTORITATIVA/);
  assert.match(grounded, /\"relative_day\":\"HOY\"/);
  assert.match(grounded, /si relative_day=HOY, nunca digas mañana/i);
});

test("instructions without backend timestamps are left unchanged", () => {
  const instruction = "Pregunta cuántas personas son.";
  assert.equal(withAuthoritativeTemporalGrounding(instruction, now), instruction);
});

test("authoritative now context exposes Madrid date clock weekday and offset ISO", () => {
  const context = authoritativeMadridNowContext(now);
  assert.equal(context.timezone, "Europe/Madrid");
  assert.equal(context.now_iso, "2026-08-13T09:13:00+02:00");
  assert.equal(context.calendar_date, "13 de agosto de 2026");
  assert.equal(context.clock_time, "09:13");
  assert.equal(context.weekday.toLowerCase(), "jueves");
});

test("prompt context explicitly forbids inventing current year or date", () => {
  const prompt = authoritativeTemporalPromptContext(now);
  assert.match(prompt, /CONTEXTO TEMPORAL AUTORITATIVO DEL BACKEND/);
  assert.match(prompt, /2026-08-13T09:13:00\+02:00/);
  assert.match(prompt, /Nunca inventes el año ni la fecha actual/i);
  assert.match(prompt, /autoridad final/i);
});
