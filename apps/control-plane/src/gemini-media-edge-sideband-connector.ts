import {
  GeminiMediaEdgeSidebandRuntime,
  type GeminiMediaEdgeSidebandOutbound,
} from "./gemini-media-edge-sideband-runtime.js";
import type { GeminiLiveSessionRuntimeObservation } from "./gemini-live-session-runtime.js";
import { createGeminiMediaEdgeCallerTurnDispositionPort } from "./gemini-media-edge-caller-turn-disposition.js";
import {
  installCallerTurnDispositionPort,
  removeCallerTurnDispositionPort,
} from "./caller-turn-disposition-runtime.js";

export type GeminiMediaEdgeSidebandConnectionInput = Readonly<{
  edgeUrl: string;
  tenantId: string;
  callControlId: string;
  controlPlaneToken: string;
  capabilityHost?: object;
}>;

export type GeminiMediaEdgeSidebandConnection = Readonly<{
  socket: WebSocket;
  runtime: GeminiMediaEdgeSidebandRuntime;
  close(): void;
}>;

export type GeminiMediaEdgeSidebandObservation = (
  observation: GeminiLiveSessionRuntimeObservation,
) => void | Promise<void>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
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

/**
 * Opens the control-only WebSocket from a Cloudflare Worker/DO to the media edge.
 * Authentication remains in the Authorization header; no token is placed in the
 * URL. Provider audio never traverses this connection.
 *
 * When capabilityHost is supplied, this connector also owns the session-scoped
 * neutral caller-turn disposition capability for exactly this sideband lifetime.
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
  if (input.capabilityHost && dispositionPort) installCallerTurnDispositionPort(input.capabilityHost, dispositionPort);

  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    if (input.capabilityHost && dispositionPort) removeCallerTurnDispositionPort(input.capabilityHost, dispositionPort);
    runtime.close();
  };

  socket.accept();
  socket.addEventListener("message", (event: MessageEvent) => {
    try {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) throw new Error("Gemini media edge sideband requires text frames");
      const observation = runtime.observe(JSON.parse(text));
      void observe(observation);
    } catch {
      try { socket.close(1008, "invalid sideband event"); } catch {}
    }
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
