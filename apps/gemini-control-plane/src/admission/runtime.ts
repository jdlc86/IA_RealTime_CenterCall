import { parseGeminiAdmissionV1, type GeminiAdmissionV1 } from "./v1";
import type { GeminiAdmissionRegistrationResult, GeminiControlPlaneEnv } from "../gemini-call-session";

export type RegisterGeminiAdmissionResult = Readonly<{
  admission: GeminiAdmissionV1;
  registration: GeminiAdmissionRegistrationResult;
}>;

/**
 * Worker-side composition boundary for a verified/admissible Gemini call.
 * The Telnyx webhook handler will call this only after signature, tenant and
 * pre-call policy checks. This function deliberately has no public HTTP route.
 */
export async function registerGeminiAdmission(
  env: GeminiControlPlaneEnv,
  value: unknown,
  options: Readonly<{ nowEpochMs: number; maxTtlMs: number }>,
): Promise<RegisterGeminiAdmissionResult> {
  const admission = parseGeminiAdmissionV1(value, options);
  const stub = env.GEMINI_CALL_SESSIONS.getByName(admission.callSessionId);
  const registration = await stub.registerAdmission(admission);
  return Object.freeze({ admission, registration });
}
