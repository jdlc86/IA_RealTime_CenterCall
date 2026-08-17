import { CallSession as CallSessionV46 } from "./call-session-v46-sideband-lifecycle";
import { realtimeCommandPortFor } from "./openai-realtime-command-adapter";
import {
  decideReservationSearch,
  initialReservationSearchAuthorityState,
  noteReservationSearchCallerTurn,
  type ReservationSearchAuthorityState,
} from "./reservation-search-turn-authority";

const BaseConstructor = CallSessionV46 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV46.prototype as any;
const SEARCH_RESERVATION = "restaurant_reservation_search";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  item_id?: string;
  transcript?: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function parseEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

function hasUsableTranscript(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\s+/g, " ").trim().length > 0;
}

/**
 * v47 closes the reservation-search authority hole left by v31.
 *
 * v29 already guarantees one public semantic tool decision per caller turn, but
 * v31 intercepts restaurant_reservation_search before the event reaches v29.
 * That allowed one model response to execute the search repeatedly (14 times in
 * the production incident) without any new caller input.
 *
 * This layer sits above the whole current chain and gives reservation search a
 * deterministic caller-turn boundary: one completed caller transcript item can
 * authorize at most one search. Changed arguments do not create authority; only
 * a new completed caller transcript item does.
 *
 * The first duplicate receives one corrective function output and one response
 * opportunity so Lucia can present the already-known result or ask for a new
 * criterion. Further duplicates in the same turn receive the function output
 * only: no response.create is emitted, so recovery cannot feed another loop.
 */
export class CallSession extends BaseConstructor {
  private reservationSearchAuthorityV47: ReservationSearchAuthorityState = initialReservationSearchAuthorityState();

  private noteCallerTurnV47(event: RealtimeEvent): void {
    if (!hasUsableTranscript(event.transcript) || typeof event.item_id !== "string" || !event.item_id.trim()) return;
    const previousTurnId = this.reservationSearchAuthorityV47.currentTurnId;
    this.reservationSearchAuthorityV47 = noteReservationSearchCallerTurn(this.reservationSearchAuthorityV47, event.item_id);
    if (this.reservationSearchAuthorityV47.currentTurnId !== previousTurnId) {
      (this as any).diagnostics?.checkpoint?.("RESERVATION_SEARCH_CALLER_TURN_OPENED_V47", {
        item_id: this.reservationSearchAuthorityV47.currentTurnId,
        search_authority_available: true,
        authority_source: "completed_caller_transcription",
      });
    }
  }

  private sendBlockedSearchOutputV47(event: RealtimeEvent, reason: string, recoveryResponse: boolean): void {
    (this as any).send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({
          ok: false,
          status: "SEARCH_REQUIRES_NEW_CALLER_TURN",
          reason,
          search_executed: false,
          instruction: "No vuelvas a ejecutar restaurant_reservation_search en este turno. Usa únicamente el resultado de búsqueda ya obtenido. Si necesitas cambiar fecha, hora, número de personas u otro criterio, pregunta al cliente y espera una nueva respuesta antes de volver a buscar.",
        }),
      },
    });

    if (recoveryResponse) realtimeCommandPortFor(this as any).createDefaultResponse();
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      this.noteCallerTurnV47(event);
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === SEARCH_RESERVATION) {
      const decision = decideReservationSearch(this.reservationSearchAuthorityV47);
      this.reservationSearchAuthorityV47 = decision.state;

      if (decision.kind === "ALLOW") {
        (this as any).diagnostics?.checkpoint?.("RESERVATION_SEARCH_AUTHORIZED_V47", {
          item_id: this.reservationSearchAuthorityV47.currentTurnId,
          one_search_per_caller_turn: true,
        });
        await BasePrototype.handleRealtimeMessage.call(this, data);
        return;
      }

      const recoveryResponse = decision.kind === "BLOCK_AND_RECOVER";
      (this as any).diagnostics?.checkpoint?.(
        recoveryResponse ? "RESERVATION_SEARCH_REPEAT_BLOCKED_V47" : "RESERVATION_SEARCH_LOOP_CIRCUIT_OPEN_V47",
        {
          item_id: this.reservationSearchAuthorityV47.currentTurnId,
          reason: decision.reason,
          search_executed: false,
          recovery_response_created: recoveryResponse,
          requires_new_caller_turn: true,
        },
      );
      this.sendBlockedSearchOutputV47(event, decision.reason, recoveryResponse);
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
