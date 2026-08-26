import { parseGeminiAdmissionV1, type GeminiAdmissionV1 } from "./v1";
import type { GeminiAdmissionRegistrationResult, GeminiControlPlaneEnv } from "../gemini-call-session";

export type RegisterGeminiAdmissionResult = Readonly<{
  admission: GeminiAdmissionV1;
  registration: Extract<GeminiAdmissionRegistrationResult, "CREATED" | "IDEMPOTENT">;
}>;

/**
 * Worker-side composition boundary for a verified/admissible Gemini call.
 * The Telnyx webhook handler will call this only after signature, tenant and
 * pre-call policy checks. Expected DO rejections are translated locally rather
 * than thrown across Durable Object RPC.
 */
export async function registerGeminiAdmission(
  env: GeminiControlPlaneEnv,
  value: unknown,
  options: Readonly<{ nowEpochMs: number; maxTtlMs: number }>,
): Promise<RegisterGeminiAdmissionResult> {
  const admission = parseGeminiAdmissionV1(value, options);
  const stub = env.GEMINI_CALL_SESSIONS.getByName(admission.callSessionId);
  const registration = await stub.registerAdmission(admission);
  if (registration === "REJECTED_EXPIRED") throw new Error("Gemini admission rejected as expired by call session");
  if (registration === "REJECTED_IMMUTABLE") throw new Error("Gemini admission rejected because call identity is immutable");
  return Object.freeze({ admission, registration });
}
