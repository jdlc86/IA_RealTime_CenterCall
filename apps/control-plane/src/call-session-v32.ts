import { CallSession as CallSessionV31 } from "./call-session-v31";

const BaseConstructor = CallSessionV31 as unknown as new (...args: any[]) => any;

function madridLocal(iso: string): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`;
}

/**
 * v32 removes UTC ambiguity from reservation suggestions.
 *
 * Supabase is authoritative for business-hours filtering. This layer only
 * enriches search results with an explicit Europe/Madrid local representation
 * so Lucia never has to infer or mentally convert UTC when speaking or choosing
 * a suggested slot.
 */
export class CallSession extends BaseConstructor {
  private outputLocalizerInstalledV32 = false;

  async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    if (isStart && response.ok) this.installOutputLocalizerV32();
    return response;
  }

  private installOutputLocalizerV32(): void {
    if (this.outputLocalizerInstalledV32) return;
    const session = this as any;
    const currentSend = session.send;
    if (typeof currentSend !== "function") return;
    this.outputLocalizerInstalledV32 = true;
    const original = currentSend.bind(this);

    session.send = (message: any) => {
      if (message?.type === "conversation.item.create" && message?.item?.type === "function_call_output" && typeof message.item.output === "string") {
        try {
          const payload = JSON.parse(message.item.output) as Record<string, any>;
          if (payload.status === "SUGGESTIONS_AVAILABLE" && Array.isArray(payload.options)) {
            payload.timezone = "Europe/Madrid";
            payload.options = payload.options.map((option: Record<string, any>) => ({
              ...option,
              starts_at_utc: option.starts_at,
              starts_at_local: typeof option.starts_at === "string" ? madridLocal(option.starts_at) : null,
              timezone: "Europe/Madrid",
            }));
            payload.instruction = "Presenta como máximo tres opciones usando starts_at_local (hora de Madrid). Nunca verbalices ni reutilices starts_at_utc como si fuese hora local. Estas opciones ya están filtradas por horario comercial; no reserves hasta que el cliente elija una y pase por restaurant_reservation_create.";
            message = { ...message, item: { ...message.item, output: JSON.stringify(payload) } };
            session.diagnostics?.checkpoint?.("RESERVATION_SEARCH_LOCAL_TIME_ENRICHED_V32", {
              option_count: payload.options.length,
              timezone: "Europe/Madrid",
              business_hours_authoritative: true,
            });
          }
        } catch {
          // Preserve the original output if it is not JSON.
        }
      }
      original(message);
    };
  }
}
