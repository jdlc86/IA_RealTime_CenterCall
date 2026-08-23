import { directAgentRealtimeBootstrapPolicy, type DirectAgentRealtimeBootstrapContext } from "./direct-agent-realtime-bootstrap.js";
import type { GeminiMediaEdgeSessionBinding } from "./gemini-media-edge-session-contract.js";

export type GeminiMediaEdgeBootstrapRegistrationInput = Readonly<{
  credentialId: string;
  binding: GeminiMediaEdgeSessionBinding;
  context: DirectAgentRealtimeBootstrapContext;
  controlPlaneToken: string;
}>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function registrationEndpoint(edgeUrl: string): string {
  let edge: URL;
  try { edge = new URL(required(edgeUrl, "Gemini media edge URL")); }
  catch { throw new Error("Gemini media edge URL is invalid"); }
  if (edge.protocol !== "wss:") throw new Error("Gemini media edge URL must use wss://");
  edge.protocol = "https:";
  edge.pathname = "/internal/bootstrap";
  edge.search = "";
  edge.hash = "";
  return edge.toString();
}

/**
 * Registers the canonical immutable agent bootstrap with an already-admitted media
 * edge session. The policy is produced only by directAgentRealtimeBootstrapPolicy;
 * this adapter never owns or duplicates instruction/tool content.
 *
 * Caller audio is deferred until authoritative STT and semantic ownership decide
 * whether the completed candidate is NORMAL, INTERRUPT or IGNORE. Therefore the
 * immutable Gemini setup must use manual activity detection with the only handling
 * mode that lets an explicitly authorized activityStart interrupt active generation.
 */
export async function registerGeminiMediaEdgeBootstrapForAdmittedSession(
  input: GeminiMediaEdgeBootstrapRegistrationInput,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (input.binding.provider !== "GEMINI") throw new Error("Gemini media edge bootstrap requires GEMINI affinity");
  const credentialId = required(input.credentialId, "Gemini media edge credential id");
  const controlPlaneToken = required(input.controlPlaneToken, "Gemini media edge control-plane token");
  const policy = directAgentRealtimeBootstrapPolicy(input.context);
  const body = {
    credentialId,
    tenantId: required(input.binding.tenantId, "Gemini media edge tenant_id"),
    callControlId: required(input.binding.callControlId, "Gemini media edge call_control_id"),
    notAfterEpochMs: input.binding.notAfterEpochMs,
    instructions: policy.instructions,
    tools: policy.tools,
    manualActivityDetection: true,
    manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  };

  let response: Response;
  try {
    response = await fetcher(registrationEndpoint(input.binding.edgeUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${controlPlaneToken}`,
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Gemini media edge bootstrap registration failed");
  }
  if (!response.ok) throw new Error(`Gemini media edge bootstrap registration failed with HTTP ${response.status}`);
}
