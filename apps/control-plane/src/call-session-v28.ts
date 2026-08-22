import { CallSession as CallSessionV27 } from "./call-session-v27";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";

const BaseConstructor = CallSessionV27 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV27.prototype as any;
const HUMAN_ASSISTANCE = "restaurant_human_assistance";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}

function finalInstructions(session: any): string {
  const assistantName = typeof session.assistantName === "string" && session.assistantName.trim() ? session.assistantName.trim() : "Lucía";
  const businessName = typeof session.businessName === "string" && session.businessName.trim() ? session.businessName.trim() : "el restaurante";
  return `Eres ${assistantName}, agente telefónica de ${businessName}. Cada turno del usuario debe quedar representado por una tool pública antes de responder libremente. Tú interpretas el lenguaje natural; las tools controlan datos, acciones y límites.

ÁMBITO ABSOLUTO: atiende únicamente asuntos relacionados con ${businessName}. Si la petición no tiene relación con el restaurante usa restaurant_out_of_scope y no contestes el contenido general. Si sí pertenece al restaurante pero necesita intervención de una persona, una garantía que el sistema no puede dar, o el usuario pide explícitamente hablar con alguien, usa restaurant_human_assistance. Nunca uses out_of_scope para una petición legítima del restaurante.

AUTORIDAD: disponibilidad, reservas, cancelaciones, modificaciones, marketing, identidad y cualquier dato operativo solo pueden afirmarse después de la tool correspondiente. No inventes datos ni prometas acciones futuras que una tool no haya confirmado.

ASISTENCIA HUMANA: restaurant_human_assistance no significa automáticamente que exista transferencia. Lee su resultado. Si transfer_available=false, no digas que vas a transferir, que alguien llamará después ni que has avisado a una persona. Explica brevemente que esa gestión requiere atención humana y limita tu afirmación a la alternativa que la tool autorice.

RESPUESTAS: después de una tool comunica el resultado de forma breve y natural, normalmente una o dos frases. No menciones JSON, nombres internos de tools ni procesos técnicos. Conserva el contexto y pregunta solo lo necesario para avanzar.

CIERRE: ante una despedida inequívoca usa restaurant_end_call con confirmed=true. Usa confirmed=false solo si el cierre es ambiguo. El silencio lo gestiona el watchdog.`;
}

/**
 * v28 closes the remaining intent-coverage gap: restaurant matters that require
 * human intervention now have an explicit public tool instead of being forced
 * into out_of_scope or freeform speech. There is deliberately no fake transfer:
 * until a real transfer transport is configured the tool reports that limitation
 * authoritatively.
 */
export class CallSession extends BaseConstructor {
  private v28InstructionsInstalled = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok && !this.v28InstructionsInstalled) {
      this.v28InstructionsInstalled = true;
      (this as any).send?.({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: finalInstructions(this as any),
        },
      });
      (this as any).diagnostics?.checkpoint?.("RESTAURANT_INTENT_COVERAGE_V28_ENABLED", {
        public_tool_count: 9,
        human_assistance_tool: true,
        fake_transfer_forbidden: true,
        restaurant_only: true,
      });
    }
    return response;
  }

  private sendOutputV28(callId: string | undefined, output: Record<string, unknown>): void {
    (this as any).send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });
    (this as any).send?.({ type: "response.create" });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === HUMAN_ASSISTANCE) {
      let args: Record<string, unknown>;
      try {
        args = parseArgs(event.arguments);
      } catch (error) {
        this.sendOutputV28(event.call_id, {
          ok: false,
          status: "ERROR",
          error: "INVALID_ARGUMENTS",
          retryable: false,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const reason = typeof args.reason === "string" ? args.reason : "OTHER_RESTAURANT_MATTER";
      const contextSummary = typeof args.context_summary === "string" && args.context_summary.trim()
        ? args.context_summary.trim().slice(0, 500)
        : undefined;

      const lifecycle = conversationLifecyclePortFor(this);
      lifecycle.validateUserTurn("agent_tool");
      lifecycle.suspendForTool(HUMAN_ASSISTANCE);
      (this as any).diagnostics?.checkpoint?.("DIRECT_HUMAN_ASSISTANCE_REQUESTED_V28", {
        reason,
        has_context_summary: Boolean(contextSummary),
        transfer_available: false,
      });

      this.sendOutputV28(event.call_id, {
        ok: true,
        status: "HUMAN_ASSISTANCE_REQUIRED",
        reason,
        transfer_available: false,
        callback_created: false,
        human_notified: false,
        instruction: "Esta gestión necesita atención de una persona del restaurante, pero no hay una transferencia telefónica ni callback automático configurados. No prometas transferencia, callback ni que alguien haya sido avisado. Explica esta limitación brevemente y ofrece continuar con cualquier gestión que sí puedas resolver con tus herramientas.",
      });
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
