import {
  connectGeminiMediaEdgeSidebandToProviderHost,
  type GeminiMediaEdgeSidebandConnection,
} from "./gemini-media-edge-sideband-connector.js";
import {
  bindAdmittedRealtimeProvider,
  bindRealtimeProvider,
  realtimeProviderFor,
  type RealtimeProviderHost,
} from "./realtime-provider-runtime.js";
import type { RealtimeProviderSelection } from "./realtime-provider-selector.js";
import { authorizeRealtimeProviderTraffic } from "./realtime-provider-traffic-admission.js";

type ProviderDiagnostics = Readonly<{
  checkpoint?: (stage: string, details?: Record<string, unknown>) => void;
  fail?: (stage: string, errorCode: string, details?: Record<string, unknown>) => void;
}>;

type ProviderCallSessionHost = RealtimeProviderHost & {
  env?: Record<string, unknown>;
  socket?: WebSocket | null;
  diagnostics?: ProviderDiagnostics;
};

type SidebandState = Readonly<{
  identity: string;
  connection: GeminiMediaEdgeSidebandConnection;
}>;

const SIDEBAND_BY_HOST = new WeakMap<object, SidebandState>();

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

export function classifyGeminiSidebandClose(codeValue: unknown, reasonValue: unknown): string {
  const code = Number(codeValue);
  const reason = typeof reasonValue === "string" ? reasonValue : "";
  if (code === 1000) return "NORMAL_CONTROL_CLOSE";
  if (code === 1008) {
    if (reason === "invalid sideband event") return "INVALID_SIDEBAND_EVENT";
    if (reason === "invalid control command") return "MEDIA_EDGE_CONTROL_COMMAND_REJECTED";
    if (reason === "control session already attached") return "DUPLICATE_CONTROL_SESSION";
    return "POLICY_VIOLATION";
  }
  if (code === 1011) return "SIDEBAND_INTERNAL_ERROR";
  return "UNCLASSIFIED_CLOSE";
}

async function prepareGemini(
  host: ProviderCallSessionHost,
  selection: RealtimeProviderSelection & Readonly<{ provider: "GEMINI" }>,
  callControlId: string,
): Promise<void> {
  const tenantId = required(selection.tenantId, "Gemini CallSession tenant affinity");
  const boundCallControlId = required(callControlId, "Gemini CallSession call affinity");
  const identity = `${tenantId}\u0000${boundCallControlId}`;
  const existing = SIDEBAND_BY_HOST.get(host);
  if (existing) {
    if (existing.identity !== identity) throw new Error("Gemini media edge sideband identity mismatch");
    return;
  }

  const env = host.env ?? {};
  const admission = authorizeRealtimeProviderTraffic(selection, {
    environment: env.ENVIRONMENT,
    geminiEnabled: env.GEMINI_REALTIME_ENABLED,
    geminiCanaryTenantId: env.GEMINI_CANARY_TENANT_ID,
  });
  bindAdmittedRealtimeProvider(host, selection, admission);

  const connection = await connectGeminiMediaEdgeSidebandToProviderHost({
    edgeUrl: required(env.GEMINI_MEDIA_EDGE_URL, "GEMINI_MEDIA_EDGE_URL"),
    tenantId,
    callControlId: boundCallControlId,
    controlPlaneToken: required(env.MEDIA_EDGE_CONTROL_PLANE_TOKEN, "MEDIA_EDGE_CONTROL_PLANE_TOKEN"),
    capabilityHost: host,
    observeDiagnostic: (diagnostic) => {
      host.diagnostics?.fail?.(
        diagnostic.stage,
        diagnostic.failureCategory,
        {
          provider: "GEMINI",
          sideband_frame_type: diagnostic.frameType,
          failure_category: diagnostic.failureCategory,
        },
      );
    },
  });
  const state = Object.freeze({ identity, connection });
  SIDEBAND_BY_HOST.set(host, state);
  host.socket = connection.socket;
  connection.socket.addEventListener("close", (event: CloseEvent) => {
    host.diagnostics?.checkpoint?.("GEMINI_SIDEBAND_CLOSED", {
      provider: "GEMINI",
      close_code: Number(event.code),
      close_reason_category: classifyGeminiSidebandClose(event.code, event.reason),
      was_clean: Boolean(event.wasClean),
    });
    if (SIDEBAND_BY_HOST.get(host) !== state) return;
    SIDEBAND_BY_HOST.delete(host);
    if (host.socket === connection.socket) host.socket = null;
  });
}

/**
 * Provider-specific connection composition kept outside active CallSession layers.
 * The CallSession consumes only an immutable selection and a neutral capability host.
 */
export async function prepareRealtimeProviderCallSession(
  host: ProviderCallSessionHost,
  selection: RealtimeProviderSelection,
  callControlId: string,
): Promise<void> {
  switch (selection.provider) {
    case "OPENAI":
      bindRealtimeProvider(host, selection.provider);
      return;
    case "GEMINI":
      await prepareGemini(host, { ...selection, provider: "GEMINI" }, callControlId);
      return;
  }
}

export function realtimeProviderCallSessionStatus(host: ProviderCallSessionHost): Readonly<{
  provider: RealtimeProviderSelection["provider"];
  sidebandReady: boolean;
}> {
  const provider = realtimeProviderFor(host);
  const sideband = SIDEBAND_BY_HOST.get(host);
  return Object.freeze({
    provider,
    sidebandReady: sideband
      ? sideband.connection.socket.readyState === 1
      : Boolean(host.socket),
  });
}

export function closeRealtimeProviderCallSessionOnFailedStart(host: ProviderCallSessionHost): void {
  const sideband = SIDEBAND_BY_HOST.get(host);
  if (!sideband) return;
  SIDEBAND_BY_HOST.delete(host);
  sideband.connection.close();
  if (host.socket === sideband.connection.socket) host.socket = null;
}
