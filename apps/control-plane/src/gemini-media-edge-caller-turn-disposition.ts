import {
  requireCallerTurnDispositionRequest,
  type CallerTurnDispositionPort,
  type CallerTurnDispositionRequest,
} from "./caller-turn-disposition-port.js";
import { GeminiMediaEdgeSidebandRuntime } from "./gemini-media-edge-sideband-runtime.js";

/** Provider-edge adapter; semantic classification remains in the control plane. */
export function createGeminiMediaEdgeCallerTurnDispositionPort(
  sideband: GeminiMediaEdgeSidebandRuntime,
): CallerTurnDispositionPort {
  if (!sideband || typeof sideband.resolveCallerTurn !== "function") {
    throw new Error("Gemini media edge sideband runtime is required");
  }
  return Object.freeze({
    resolve(value: CallerTurnDispositionRequest) {
      const request = requireCallerTurnDispositionRequest(value);
      sideband.resolveCallerTurn(request.itemId, request.disposition);
    },
  });
}
