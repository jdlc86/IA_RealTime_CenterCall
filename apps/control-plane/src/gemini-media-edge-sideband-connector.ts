import {
  GeminiMediaEdgeSidebandRuntime,
  type GeminiMediaEdgeSidebandOutbound,
} from "./gemini-media-edge-sideband-runtime.js";
import type { GeminiLiveSessionRuntimeObservation } from "./gemini-live-session-runtime.js";
import { createGeminiMediaEdgeCallerTurnDispositionPort } from "./gemini-media-edge-caller-turn-disposition.js";
import { createGeminiMediaEdgeSemanticDecisionCapability } from "./gemini-media-edge-semantic-decision.js";
import { createGeminiMediaEdgeIsolatedGenerationCapability } from "./gemini-media-edge-isolated-generation.js";
import {
  installCallerTurnDispositionPort,
  removeCallerTurnDispositionPort,
} from "./caller-turn-disposition-runtime.js";
import {
  installExternalRealtimeProviderCommandPort,
  removeExternalRealtimeProviderCommandPort,
} from "./realtime-provider-external-command-runtime.js";
import {
  installSemanticDecisionPort,
  removeSemanticDecisionPort,
} from "./semantic-decision-runtime.js";
import {
  installSemanticToolGatePort,
  removeSemanticToolGatePort,
} from "./semantic-tool-gate-runtime.js";
import {
  installGovernedSpeechPort,
  removeGovernedSpeechPort,
} from "./governed-speech-runtime.js";
import {
  installIsolatedTextGenerationPort,
  removeIsolatedTextGenerationPort,
} from "./isolated-text-generation-runtime.js";
import { createProductOwnedAuthoritativeTemporalContextCapability } from "./authoritative-temporal-context-port.js";
import {
  installAuthoritativeTemporalContextPort,
  removeAuthoritativeTemporalContextPort,
} from "./authoritative-temporal-context-runtime.js";
import {
  deliverRealtimeProviderEvents,
  requireRealtimeProviderEventIngress,
} from "./realtime-provider-event-ingress-runtime.js";

export type GeminiMediaEdgeSidebandObservationFailureCategory =
  | "FRAME_NOT_TEXT"
  | "FRAME_JSON_INVALID"
  | "FRAME_TYPE_UNSUPPORTED"
  | "PROVIDER_RESET_IDENTITY_MISMATCH"
  | "PLAYBACK_IDENTITY_MISMATCH"
  | "PLAYBACK_KIND_MISMATCH"
  | "CALLER_CONTEXT_INVALID"
  | "INGRESS_REJECTED"
  | "OBSERVATION_INVALID";

export type GeminiMediaEdgeSidebandDiagnostic = Readonly<{
  stage: "GEMINI_SIDEBAND_OBSERVATION_FAILED";
  frameType: string;
  failureCategory: GeminiMediaEdgeSidebandObservationFailureCategory;
}>;

export type GeminiMediaEdgeSidebandConnectionInput = Readonly<{
  edgeUrl: string;
  tenantId: string;
  callControlId: string;
  controlPlaneToken: string;
  capabilityHost?: object;
  observeDiagnostic?: (diagnostic: GeminiMediaEdgeSidebandDiagnostic) => void;
}>;

export type GeminiMediaEdgeSidebandConnection = Readonly<{
  socket: WebSocket;
  runtime: GeminiMediaEdgeSidebandRuntime;
  close(): void;
}>;

export type GeminiMediaEdgeSidebandObservation = (
  observation: GeminiLiveSessionRuntimeObservation,
) => void | Promise<void>;

const SAFE_FRAME_TYPES = new Set([
  "GEMINI_EVENT",
  "CALLER_EVENT",
  "PLAYBACK_EVENT",
  "GOVERNED_EVENT",
  "INPUT_DETECTION_EVENT",
  "PROVIDER_SESSION_RESET",
]);

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function safeFrameType(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "UNKNOWN";
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" && SAFE_FRAME_TYPES.has(type) ? type : "UNKNOWN";
}

export function classifyGeminiMediaEdgeObservationFailure(
  error: unknown,
): GeminiMediaEdgeSidebandObservationFailureCategory {
  const message = error instanceof Error ? error.message : "";
  if (/frame type is unsupported/i.test(message)) return "FRAME_TYPE_UNSUPPORTED";
  if (/provider session reset identity mismatch/i.test(message)) return "PROVIDER_RESET_IDENTITY_MISMATCH";
  if (/playback .*identity mismatch|playback already owned|caller playback identity mismatch/i.test(message)) return "PLAYBACK_IDENTITY_MISMATCH";
  if (/playback .*kind mismatch/i.test(message)) return "PLAYBACK_KIND_MISMATCH";
  if (/caller context|caller item|caller speech stop|caller transcript|caller playback/i.test(message)) return "CALLER_CONTEXT_INVALID";
  return "OBSERVATION_INVALID";
}

export function geminiMediaEdgeControlUrl(input: Pick<GeminiMediaEdgeSidebandConnectionInput, "edgeUrl" | "tenantId" | "callControlId">): string {
  let edge: URL;
  try { edge = new URL(required(input.edgeUrl, "Gemini media edge URL")); }
  catch { throw new Error("Gemini media edge URL is invalid"); }
  if (edge.protocol !== "wss:") throw new Error("Gemini media edge URL must use wss://");
  if (edge.username || edge.password) throw new Error("Gemini media edge URL must not contain credentials");
  edge.protocol = "https:";
  edge.pathname = "/internal/control";
  edge.search = "";
  edge.searchParams.set("tenant_id", required(input.tenantId, "Gemini media edge tenant_id"));
  edge.searchParams.set("call_control_id", required(input.callControlId, "Gemini media edge call_control_id"));
  edge.hash = "";
  return edge.toString();
}

function closeForObservationFailure(socket: WebSocket): void {
  try { socket.close(1008, "invalid sideband event"); } catch {}
}

/**
 * Opens the control-only WebSocket from a Cloudflare Worker/DO to the media edge.
 * Authentication remains in the Authorization header; no token is placed in the
 * URL. Provider audio never traverses this connection.
 *
 * When capabilityHost is supplied, this connector owns the session-scoped Gemini
 * command port, caller disposition effect boundary, isolated semantic-decision,
 * isolated text-generation, governed speech capability and product-owned semantic
 * tool gate plus authoritative caller-turn clock for exactly this sideband lifetime.
 */
export async function connectGeminiMediaEdgeSideband(
  input: GeminiMediaEdgeSidebandConnectionInput,
  observe: GeminiMediaEdgeSidebandObservation,
  fetcher: typeof fetch = fetch,
): Promise<GeminiMediaEdgeSidebandConnection> {
  if (typeof observe !== "function") throw new Error("Gemini media edge sideband observer is required");
  const token = required(input.controlPlaneToken, "Gemini media edge control-plane token");
  const url = geminiMediaEdgeControlUrl(input);
  let response: Response & { webSocket?: WebSocket | null };
  try {
    response = await fetcher(url, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } }) as Response & { webSocket?: WebSocket | null };
  } catch {
    throw new Error("Gemini media edge sideband connection failed");
  }
  const socket = response.webSocket;
  if (!socket) throw new Error(`Gemini media edge sideband upgrade failed with HTTP ${response.status}`);

  const runtime = new GeminiMediaEdgeSidebandRuntime((message: GeminiMediaEdgeSidebandOutbound) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Gemini media edge sideband is not open");
    socket.send(JSON.stringify(message));
  });
  const dispositionPort = input.capabilityHost
    ? createGeminiMediaEdgeCallerTurnDispositionPort(runtime)
    : null;
  const semanticDecisionCapability = input.capabilityHost
    ? createGeminiMediaEdgeSemanticDecisionCapability({
        edgeUrl: input.edgeUrl,
        tenantId: input.tenantId,
        callControlId: input.callControlId,
        controlPlaneToken: token,
        capabilityHost: input.capabilityHost,
      }, fetcher)
    : null;
  const isolatedGenerationCapability = input.capabilityHost
    ? createGeminiMediaEdgeIsolatedGenerationCapability({
        edgeUrl: input.edgeUrl,
        tenantId: input.tenantId,
        callControlId: input.callControlId,
        controlPlaneToken: token,
      }, fetcher)
    : null;
  const temporalContextCapability = input.capabilityHost
    ? createProductOwnedAuthoritativeTemporalContextCapability()
    : null;

  let commandCapabilityInstalled = false;
  let temporalContextCapabilityInstalled = false;
  let dispositionCapabilityInstalled = false;
  let semanticDecisionCapabilityInstalled = false;
  let semanticToolGateCapabilityInstalled = false;
  let governedSpeechCapabilityInstalled = false;
  let isolatedGenerationCapabilityInstalled = false;
  if (input.capabilityHost) {
    try {
      installExternalRealtimeProviderCommandPort(input.capabilityHost, "GEMINI", runtime.commandPort);
      commandCapabilityInstalled = true;
      if (temporalContextCapability) {
        installAuthoritativeTemporalContextPort(input.capabilityHost, temporalContextCapability.port);
        temporalContextCapabilityInstalled = true;
      }
      if (dispositionPort) {
        installCallerTurnDispositionPort(input.capabilityHost, dispositionPort);
        dispositionCapabilityInstalled = true;
      }
      if (semanticDecisionCapability) {
        installSemanticDecisionPort(input.capabilityHost, semanticDecisionCapability.port);
        semanticDecisionCapabilityInstalled = true;
      }
      installSemanticToolGatePort(input.capabilityHost, runtime.semanticToolGatePort);
      semanticToolGateCapabilityInstalled = true;
      installGovernedSpeechPort(input.capabilityHost, "GEMINI", runtime.governedSpeechPort);
      governedSpeechCapabilityInstalled = true;
      if (isolatedGenerationCapability) {
        installIsolatedTextGenerationPort(input.capabilityHost, isolatedGenerationCapability);
        isolatedGenerationCapabilityInstalled = true;
      }
    } catch (error) {
      if (isolatedGenerationCapabilityInstalled && isolatedGenerationCapability) {
        removeIsolatedTextGenerationPort(input.capabilityHost, isolatedGenerationCapability);
      }
      isolatedGenerationCapability?.close();
      if (governedSpeechCapabilityInstalled) {
        removeGovernedSpeechPort(input.capabilityHost, "GEMINI", runtime.governedSpeechPort);
      }
      semanticDecisionCapability?.close();
      if (semanticToolGateCapabilityInstalled) {
        removeSemanticToolGatePort(input.capabilityHost, runtime.semanticToolGatePort);
      }
      if (semanticDecisionCapabilityInstalled && semanticDecisionCapability) {
        removeSemanticDecisionPort(input.capabilityHost, semanticDecisionCapability.port);
      }
      if (dispositionCapabilityInstalled && dispositionPort) {
        removeCallerTurnDispositionPort(input.capabilityHost, dispositionPort);
      }
      if (commandCapabilityInstalled) {
        removeExternalRealtimeProviderCommandPort(input.capabilityHost, "GEMINI", runtime.commandPort);
      }
      if (temporalContextCapabilityInstalled && temporalContextCapability) {
        removeAuthoritativeTemporalContextPort(input.capabilityHost, temporalContextCapability.port);
      }
      temporalContextCapability?.close();
      runtime.close();
      try { socket.close(1011, "capability installation failed"); } catch {}
      throw error;
    }
  }

  let closed = false;
  let observationTail: Promise<void> = Promise.resolve();
  const release = () => {
    if (closed) return;
    closed = true;
    if (input.capabilityHost && isolatedGenerationCapabilityInstalled && isolatedGenerationCapability) {
      removeIsolatedTextGenerationPort(input.capabilityHost, isolatedGenerationCapability);
      isolatedGenerationCapabilityInstalled = false;
    }
    isolatedGenerationCapability?.close();
    if (input.capabilityHost && governedSpeechCapabilityInstalled) {
      removeGovernedSpeechPort(input.capabilityHost, "GEMINI", runtime.governedSpeechPort);
      governedSpeechCapabilityInstalled = false;
    }
    semanticDecisionCapability?.close();
    if (input.capabilityHost && semanticToolGateCapabilityInstalled) {
      removeSemanticToolGatePort(input.capabilityHost, runtime.semanticToolGatePort);
      semanticToolGateCapabilityInstalled = false;
    }
    if (input.capabilityHost && semanticDecisionCapabilityInstalled && semanticDecisionCapability) {
      removeSemanticDecisionPort(input.capabilityHost, semanticDecisionCapability.port);
      semanticDecisionCapabilityInstalled = false;
    }
    if (input.capabilityHost && dispositionCapabilityInstalled && dispositionPort) {
      removeCallerTurnDispositionPort(input.capabilityHost, dispositionPort);
      dispositionCapabilityInstalled = false;
    }
    if (input.capabilityHost && commandCapabilityInstalled) {
      removeExternalRealtimeProviderCommandPort(input.capabilityHost, "GEMINI", runtime.commandPort);
      commandCapabilityInstalled = false;
    }
    if (input.capabilityHost && temporalContextCapabilityInstalled && temporalContextCapability) {
      removeAuthoritativeTemporalContextPort(input.capabilityHost, temporalContextCapability.port);
      temporalContextCapabilityInstalled = false;
    }
    temporalContextCapability?.close();
    runtime.close();
  };

  const reportObservationFailure = (
    frameType: string,
    failureCategory: GeminiMediaEdgeSidebandObservationFailureCategory,
  ) => {
    try {
      input.observeDiagnostic?.(Object.freeze({
        stage: "GEMINI_SIDEBAND_OBSERVATION_FAILED",
        frameType,
        failureCategory,
      }));
    } catch {}
  };

  const failObservation = (
    frameType: string,
    failureCategory: GeminiMediaEdgeSidebandObservationFailureCategory,
  ) => {
    reportObservationFailure(frameType, failureCategory);
    closeForObservationFailure(socket);
    release();
  };

  socket.accept();
  socket.addEventListener("message", (event: MessageEvent) => {
    const text = typeof event.data === "string" ? event.data : "";
    if (!text) {
      failObservation("UNKNOWN", "FRAME_NOT_TEXT");
      return;
    }

    let frameValue: unknown;
    try {
      frameValue = JSON.parse(text);
    } catch {
      failObservation("UNKNOWN", "FRAME_JSON_INVALID");
      return;
    }
    const frameType = safeFrameType(frameValue);

    let observation: GeminiLiveSessionRuntimeObservation;
    try {
      observation = runtime.observe(frameValue);
    } catch (error) {
      failObservation(frameType, classifyGeminiMediaEdgeObservationFailure(error));
      return;
    }

    observationTail = observationTail
      .then(async () => {
        if (closed) return;
        await observe(observation);
      })
      .catch(() => failObservation(frameType, "INGRESS_REJECTED"));
  });
  socket.addEventListener("close", release);
  socket.addEventListener("error", () => { try { socket.close(1011, "sideband error"); } catch {} release(); });

  return Object.freeze({
    socket,
    runtime,
    close() {
      release();
      try { socket.close(1000, "control session closed"); } catch {}
    },
  });
}

/**
 * Production composition boundary for a Gemini CallSession host. The normalized
 * event ingress must already be installed before any network or provider effect.
 */
export async function connectGeminiMediaEdgeSidebandToProviderHost(
  input: GeminiMediaEdgeSidebandConnectionInput & Readonly<{ capabilityHost: object }>,
  fetcher: typeof fetch = fetch,
): Promise<GeminiMediaEdgeSidebandConnection> {
  requireRealtimeProviderEventIngress(input.capabilityHost);
  return connectGeminiMediaEdgeSideband(
    input,
    async (observation) => {
      if (observation.events.length) {
        await deliverRealtimeProviderEvents(input.capabilityHost, observation.events);
      }
    },
    fetcher,
  );
}
