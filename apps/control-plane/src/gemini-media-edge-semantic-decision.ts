import type { SemanticDecisionPort } from "./semantic-decision-port.js";
import type { RealtimeTextDecisionRequest } from "./realtime-provider-command-port.js";
import { deliverRealtimeProviderEvents } from "./realtime-provider-event-ingress-runtime.js";

export type GeminiMediaEdgeSemanticDecisionInput = Readonly<{
  edgeUrl: string;
  tenantId: string;
  callControlId: string;
  controlPlaneToken: string;
  capabilityHost: object;
}>;

export type GeminiMediaEdgeSemanticDecisionCapability = Readonly<{
  port: SemanticDecisionPort;
  close(): void;
}>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function endpoint(edgeUrl: string): string {
  let edge: URL;
  try { edge = new URL(required(edgeUrl, "Gemini media edge URL")); }
  catch { throw new Error("Gemini media edge URL is invalid"); }
  if (edge.protocol !== "wss:") throw new Error("Gemini media edge URL must use wss://");
  if (edge.username || edge.password) throw new Error("Gemini media edge URL must not contain credentials");
  edge.protocol = "https:";
  edge.pathname = "/internal/semantic-decision";
  edge.search = "";
  edge.hash = "";
  return edge.toString();
}

function sourceItemId(request: RealtimeTextDecisionRequest): string | undefined {
  const value = request.metadata?.source_item_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedDecisionText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Gemini isolated decision text is required");
  return value.trim().slice(0, 4096);
}

/**
 * Session-scoped isolated text-decision adapter for Gemini calls.
 *
 * The auxiliary classifier is reached through the authenticated media-edge
 * control plane, never through the Live conversation. Results are reintroduced
 * only as provider-neutral events. Runtime classifier failures resolve
 * conservatively to INTERRUPT so a usable caller turn is never destroyed merely
 * because auxiliary classification became unavailable.
 */
export function createGeminiMediaEdgeSemanticDecisionCapability(
  input: GeminiMediaEdgeSemanticDecisionInput,
  fetcher: typeof fetch = fetch,
): GeminiMediaEdgeSemanticDecisionCapability {
  const url = endpoint(input.edgeUrl);
  const tenantId = required(input.tenantId, "Gemini media edge tenant_id");
  const callControlId = required(input.callControlId, "Gemini media edge call_control_id");
  const token = required(input.controlPlaneToken, "Gemini media edge control-plane token");
  if (!input.capabilityHost || typeof input.capabilityHost !== "object") throw new Error("Gemini semantic decision capability host is required");
  if (typeof fetcher !== "function") throw new Error("Gemini semantic decision fetcher is required");

  let active = true;

  async function execute(request: RealtimeTextDecisionRequest): Promise<void> {
    const responseId = `gemini_isolated_decision_${crypto.randomUUID()}`;
    const purpose = typeof request.purpose === "string" && request.purpose.trim() ? request.purpose.trim() : undefined;
    const itemId = sourceItemId(request);

    await deliverRealtimeProviderEvents(input.capabilityHost, [{
      type: "ASSISTANT_RESPONSE_STARTED",
      kind: "NORMAL",
      responseId,
      ...(purpose ? { purpose } : {}),
      ...(itemId ? { sourceItemId: itemId } : {}),
    }]);
    if (!active) return;

    let text = "INTERRUPT";
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
        },
        body: JSON.stringify({
          tenantId,
          callControlId,
          instructions: required(request.instructions, "Gemini semantic decision instructions"),
          inputText: required(request.inputText, "Gemini semantic decision input"),
          ...(request.maxOutputTokens == null ? {} : { maxOutputTokens: request.maxOutputTokens }),
        }),
      });
      if (!response.ok) throw new Error(`Gemini isolated decision endpoint failed with HTTP ${response.status}`);
      const payload = await response.json() as { ok?: unknown; text?: unknown };
      if (payload.ok !== true) throw new Error("Gemini isolated decision endpoint rejected request");
      text = boundedDecisionText(payload.text);
    } catch {
      text = "INTERRUPT";
    }

    if (!active) return;
    await deliverRealtimeProviderEvents(input.capabilityHost, [{
      type: "TEXT_DECISION_COMPLETED",
      responseId,
      text,
    }]);
  }

  const port: SemanticDecisionPort = Object.freeze({
    request(request: RealtimeTextDecisionRequest): void {
      if (!active) throw new Error("Gemini semantic decision capability is closed");
      void execute(request).catch(() => {});
    },
  });

  return Object.freeze({
    port,
    close() { active = false; },
  });
}
