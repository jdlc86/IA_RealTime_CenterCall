import { CallSession as CallSessionV4 } from "./call-session-v4";
import {
  availabilityKey,
  completeReservationFingerprint,
  mergeReservationDraft,
  missingReservationAvailability,
  missingReservationContact,
  nearbyStartTimes,
  parseReservationTurn,
  type ReservationDraft,
} from "./reservation-orchestrator";
import { parseSemanticDecision } from "./semantic-router";
import { SupabaseAdapter, type RestaurantAvailability } from "./supabase-adapter";
import { ToolGateway, requireObject, type ToolDefinition, type ToolRequest, type ToolResult } from "./tool-gateway";
import { claimClassifierBootstrap, ownsClassifierBootstrap } from "./classifier-bootstrap-authority.js";
import {
  executeLegacyIntent,
  LEGACY_INTENT_EXECUTOR,
  type LegacyIntentSelection,
} from "./legacy-intent-execution.js";

const CONVERSATION_INTENT = "conversation_intent";
const CHECK_RESERVATION_AVAILABILITY = "check_reservation_availability";
const MANAGE_RESERVATION = "manage_reservation";
const MANAGE_MARKETING_CONSENT = "manage_marketing_consent";

const BaseConstructor = CallSessionV4 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV4.prototype as any;

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

type AvailabilityArgs = {
  partySize: number;
  startsAt: string;
  durationMinutes: number;
};

type AvailabilityOption = {
  starts_at: string;
  table_code: string;
  table_name: string;
  max_capacity: number;
};

type AvailabilityResult = {
  requested_available: boolean;
  requested_starts_at: string;
  party_size: number;
  duration_minutes: number;
  requested_candidates: AvailabilityOption[];
  alternatives: AvailabilityOption[];
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function requireRuntimeString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function validateAvailabilityArgs(value: unknown): AvailabilityArgs {
  const record = requireObject(value);
  const allowed = new Set(["party_size", "starts_at", "duration_minutes"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Unexpected availability field: ${key}`);
  if (!Number.isInteger(record.party_size) || (record.party_size as number) < 1 || (record.party_size as number) > 100) throw new Error("Invalid party_size");
  if (typeof record.starts_at !== "string" || !record.starts_at.trim()) throw new Error("Invalid starts_at");
  const parsed = Date.parse(record.starts_at);
  if (!Number.isFinite(parsed) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(record.starts_at)) throw new Error("Invalid starts_at");
  const duration = record.duration_minutes === undefined ? 90 : record.duration_minutes;
  if (!Number.isInteger(duration) || (duration as number) < 15 || (duration as number) > 480) throw new Error("Invalid duration_minutes");
  return { partySize: record.party_size as number, startsAt: new Date(parsed).toISOString(), durationMinutes: duration as number };
}

function toOption(row: RestaurantAvailability): AvailabilityOption {
  return {
    starts_at: row.starts_at,
    table_code: row.table_code,
    table_name: row.table_name,
    max_capacity: row.max_capacity,
  };
}

function currentMadridReference(): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date());
}

function reservationAwareIntentTool(): Record<string, unknown> {
  return {
    type: "function",
    name: CONVERSATION_INTENT,
    description: `Clasifica cada turno. Para RESERVATION incluye además el objeto reservation con TODOS los datos de reserva que ya sean inequívocamente conocidos en la conversación. Referencia temporal actual en Madrid: ${currentMadridReference()}. Resuelve expresiones como hoy/mañana usando esa referencia. Nunca inventes fecha, hora, personas, nombre ni teléfono. confirm=true solo si el usuario acaba de confirmar explícitamente un resumen de reserva presentado por el asistente en un turno anterior. use_caller_phone=true solo si el usuario acepta explícitamente usar el mismo número desde el que llama.`,
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["CONTINUE", "END_AMBIGUOUS", "END_CLEAR"] },
        data_requirement: { type: "string", enum: ["NONE", "BUSINESS_INFO", "SERVICES", "MENU", "RESERVATION", "MARKETING_CONSENT", "PROFESSIONALS", "HOURS"] },
        reason: { type: "string" },
        reservation: {
          type: "object",
          description: "Solo para RESERVATION. Incluye los datos ya conocidos de toda la conversación; omite los desconocidos.",
          properties: {
            party_size: { type: "integer", minimum: 1, maximum: 100 },
            starts_at: { type: "string", description: "ISO 8601 con zona horaria. Omite si fecha u hora siguen siendo ambiguas." },
            customer_name: { type: "string" },
            customer_phone: { type: "string", description: "E.164 solo si el usuario proporciona explícitamente un número." },
            use_caller_phone: { type: "boolean" },
            duration_minutes: { type: "integer", minimum: 15, maximum: 480 },
            notes: { type: "string" },
            confirm: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["intent", "data_requirement", "reason"],
      additionalProperties: false,
    },
  };
}

export class CallSession extends BaseConstructor {
  private reservationSessionUpdateSent = false;
  private reservationDraft: ReservationDraft = {};
  private reservationAvailabilityKey: string | null = null;
  private reservationAvailabilityPromise: Promise<ToolResult<AvailabilityResult>> | null = null;
  private reservationConfirmationFingerprint: string | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isStart = request.method === "POST" && url.pathname === "/start";
    if (isStart) claimClassifierBootstrap(this, "RESERVATION_V5");
    const response = await super.fetch(request);
    if (isStart && response.ok && ownsClassifierBootstrap(this, "RESERVATION_V5") && !this.reservationSessionUpdateSent) {
      this.reservationSessionUpdateSent = true;
      try {
        (this as any).send({
          type: "session.update",
          session: {
            tools: [reservationAwareIntentTool()],
            tool_choice: "required",
          },
        });
        (this as any).diagnostics?.checkpoint?.("RESERVATION_CLASSIFIER_SCHEMA_UPDATED", { strategy: "backend_orchestrator_v1" });
      } catch (error) {
        (this as any).diagnostics?.fail?.("RESERVATION_CLASSIFIER_SCHEMA_UPDATE_FAILED", "SESSION_UPDATE_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return response;
  }

  private getSupabaseAdapterV5(): SupabaseAdapter {
    return new SupabaseAdapter({
      SUPABASE_URL: requireRuntimeString((this as any).env?.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireRuntimeString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
  }

  private async executeAvailability(args: AvailabilityArgs, tenantId: string): Promise<AvailabilityResult> {
    const adapter = this.getSupabaseAdapterV5();
    const exact = await adapter.checkRestaurantAvailability(tenantId, args.startsAt, args.partySize, args.durationMinutes);
    if (exact.length > 0) {
      return {
        requested_available: true,
        requested_starts_at: args.startsAt,
        party_size: args.partySize,
        duration_minutes: args.durationMinutes,
        requested_candidates: exact.slice(0, 3).map(toOption),
        alternatives: [],
      };
    }

    const nearby = nearbyStartTimes(args.startsAt);
    const checked = await Promise.all(nearby.map(async (startsAt) => ({
      startsAt,
      rows: await adapter.checkRestaurantAvailability(tenantId, startsAt, args.partySize, args.durationMinutes),
    })));
    const alternatives: AvailabilityOption[] = [];
    for (const candidate of checked) {
      if (candidate.rows[0]) alternatives.push({ ...toOption(candidate.rows[0]), starts_at: candidate.startsAt });
      if (alternatives.length >= 3) break;
    }
    return {
      requested_available: false,
      requested_starts_at: args.startsAt,
      party_size: args.partySize,
      duration_minutes: args.durationMinutes,
      requested_candidates: [],
      alternatives,
    };
  }

  private createToolGateway(): ToolGateway {
    const baseGateway = BasePrototype.createToolGateway.call(this) as ToolGateway;
    const tenantId = requireRuntimeString((this as any).tenantId, "tenant_id");
    const allowedTools = Array.isArray((this as any).allowedTools) ? (this as any).allowedTools as string[] : [];
    const availabilityDefinition: ToolDefinition<AvailabilityArgs, AvailabilityResult> = {
      name: CHECK_RESERVATION_AVAILABILITY,
      access: "READ",
      description: "Consulta disponibilidad real del restaurante y, si no existe en la hora solicitada, devuelve alternativas cercanas verificadas.",
      validate: validateAvailabilityArgs,
      execute: async (args, context) => this.executeAvailability(args, context.tenantId),
    };
    const availabilityGateway = new ToolGateway([availabilityDefinition as ToolDefinition<unknown, unknown>], [{ tenantId, allowedTools }]);
    return {
      execute: async (request: ToolRequest): Promise<ToolResult> => request.name === CHECK_RESERVATION_AVAILABILITY
        ? availabilityGateway.execute(request)
        : baseGateway.execute(request),
    } as ToolGateway;
  }

  private sendClassifierOutput(callId: string | undefined): void {
    if (!callId) return;
    (this as any).send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ ok: true, action: "continue", data_requirement: "RESERVATION", reservation_orchestrator: "backend_v1" }),
      },
    });
  }

  private startAvailabilityIfPossible(): Promise<ToolResult<AvailabilityResult>> | null {
    const key = availabilityKey(this.reservationDraft);
    if (!key) return null;
    if (key === this.reservationAvailabilityKey && this.reservationAvailabilityPromise) return this.reservationAvailabilityPromise;

    this.reservationAvailabilityKey = key;
    this.reservationConfirmationFingerprint = null;
    const tenantId = requireRuntimeString((this as any).tenantId, "tenant_id");
    const callId = requireRuntimeString((this as any).callId, "call_id");
    const args = {
      party_size: this.reservationDraft.partySize,
      starts_at: this.reservationDraft.startsAt,
      duration_minutes: this.reservationDraft.durationMinutes ?? 90,
    };
    const startedAt = Date.now();
    (this as any).diagnostics?.checkpoint?.("RESERVATION_AVAILABILITY_STARTED", { execution: "parallel_with_contact_collection", tool: CHECK_RESERVATION_AVAILABILITY });
    this.reservationAvailabilityPromise = this.createToolGateway().execute({
      name: CHECK_RESERVATION_AVAILABILITY,
      arguments: args,
      context: { tenantId, callId },
    }) as Promise<ToolResult<AvailabilityResult>>;
    void this.reservationAvailabilityPromise.then((result) => {
      if (this.reservationAvailabilityKey !== key) return;
      if (result.ok) {
        (this as any).diagnostics?.checkpoint?.("RESERVATION_AVAILABILITY_COMPLETED", {
          tool: CHECK_RESERVATION_AVAILABILITY,
          elapsed_ms: Date.now() - startedAt,
          requested_available: (result.result as AvailabilityResult).requested_available,
        });
      } else {
        (this as any).diagnostics?.fail?.("RESERVATION_AVAILABILITY_FAILED", "TOOL_GATEWAY_RETURNED_ERROR", {
          tool: CHECK_RESERVATION_AVAILABILITY,
          error: result.error,
          elapsed_ms: Date.now() - startedAt,
        });
      }
    });
    return this.reservationAvailabilityPromise;
  }

  private speakCollectMissing(availabilityMissing: string[], contactMissing: string[]): void {
    if (availabilityMissing.length) {
      const needPeople = availabilityMissing.includes("party_size");
      const needDate = availabilityMissing.includes("starts_at");
      const instruction = needPeople && needDate
        ? "Pregunta de forma amable para cuántas personas es la reserva y qué día y hora desean. No pidas todavía otros datos."
        : needPeople
          ? "Pregunta de forma amable para cuántas personas es la reserva."
          : "Pregunta de forma amable qué día y a qué hora desean reservar. Si la fecha u hora es ambigua, aclárala.";
      (this as any).createSpokenResponse(instruction);
      return;
    }

    const callerPhone = (this as any).callerPhone as string | null | undefined;
    const needName = contactMissing.includes("customer_name");
    const needPhone = contactMissing.includes("customer_phone");
    let instruction: string;
    if (needName && needPhone && callerPhone) {
      instruction = "Mientras compruebas la disponibilidad en paralelo, pregunta de forma natural a nombre de quién será la reserva y ofrece usar como contacto el mismo número desde el que está llamando. No leas el número en voz alta.";
    } else if (needName && needPhone) {
      instruction = "Mientras compruebas la disponibilidad en paralelo, pregunta de forma natural el nombre para la reserva y el teléfono de contacto.";
    } else if (needName) {
      instruction = "Mientras compruebas la disponibilidad en paralelo, pregunta únicamente a nombre de quién será la reserva.";
    } else if (needPhone && callerPhone) {
      instruction = "Mientras compruebas la disponibilidad en paralelo, pregunta si quiere usar como contacto el mismo número desde el que está llamando. No leas el número en voz alta.";
    } else {
      instruction = "Mientras compruebas la disponibilidad en paralelo, solicita únicamente un teléfono de contacto con prefijo internacional.";
    }
    (this as any).createSpokenResponse(instruction);
  }

  private async executeManagedReservation(confirm: boolean): Promise<ToolResult> {
    const tenantId = requireRuntimeString((this as any).tenantId, "tenant_id");
    const callId = requireRuntimeString((this as any).callId, "call_id");
    return this.createToolGateway().execute({
      name: MANAGE_RESERVATION,
      arguments: {
        party_size: this.reservationDraft.partySize,
        starts_at: this.reservationDraft.startsAt,
        customer_name: this.reservationDraft.customerName,
        customer_phone: this.reservationDraft.customerPhone,
        duration_minutes: this.reservationDraft.durationMinutes ?? 90,
        notes: this.reservationDraft.notes,
        confirm,
      },
      context: { tenantId, callId },
    });
  }

  private async handleReservationTurn(argumentsJson: string | undefined, callId: string | undefined): Promise<void> {
    this.sendClassifierOutput(callId);
    (this as any).state = "active";
    (this as any).ambiguousCount = 0;

    let turn;
    try {
      turn = parseReservationTurn(argumentsJson);
    } catch (error) {
      (this as any).diagnostics?.fail?.("RESERVATION_TURN_INVALID", "RESERVATION_CLASSIFIER_PAYLOAD_INVALID", {
        error: error instanceof Error ? error.message : String(error),
      });
      (this as any).createSpokenResponse("No he entendido con suficiente precisión los datos de la reserva. Pide al usuario que repita de forma breve el número de personas y la fecha y hora deseadas.");
      return;
    }

    const previousFingerprint = completeReservationFingerprint(this.reservationDraft);
    this.reservationDraft = mergeReservationDraft(this.reservationDraft, turn.patch, (this as any).callerPhone as string | null | undefined);
    const nextFingerprint = completeReservationFingerprint(this.reservationDraft);
    if (previousFingerprint && nextFingerprint !== previousFingerprint) this.reservationConfirmationFingerprint = null;

    const availabilityMissing = missingReservationAvailability(this.reservationDraft);
    if (availabilityMissing.length) {
      this.speakCollectMissing(availabilityMissing, []);
      return;
    }

    const availabilityPromise = this.startAvailabilityIfPossible();
    const contactMissing = missingReservationContact(this.reservationDraft);
    if (contactMissing.length) {
      this.speakCollectMissing([], contactMissing);
      return;
    }

    if (!availabilityPromise) {
      (this as any).createSpokenResponse("Indica brevemente que todavía faltan datos para poder comprobar la disponibilidad y pide que repita fecha, hora y número de personas.");
      return;
    }

    const availability = await availabilityPromise;
    if (!availability.ok) {
      (this as any).createSpokenResponse("Indica de forma amable que ahora mismo no puedes comprobar la disponibilidad y que no se ha creado ninguna reserva.");
      return;
    }
    const availabilityResult = availability.result as AvailabilityResult;
    if (!availabilityResult.requested_available) {
      this.reservationConfirmationFingerprint = null;
      const alternatives = JSON.stringify(availabilityResult.alternatives);
      (this as any).createSpokenResponse(
        availabilityResult.alternatives.length
          ? `No hay disponibilidad para la hora solicitada. Ofrece de forma natural únicamente estas alternativas verificadas: ${alternatives}. Pide al usuario que elija una. No inventes otras horas y no confirmes ninguna reserva.`
          : "No hay disponibilidad para la hora solicitada ni alternativas cercanas verificadas en el margen consultado. Indícalo de forma amable y pregunta si quiere probar otra hora o fecha. No confirmes ninguna reserva.",
      );
      return;
    }

    const fingerprint = completeReservationFingerprint(this.reservationDraft);
    if (!fingerprint) {
      this.speakCollectMissing([], missingReservationContact(this.reservationDraft));
      return;
    }

    if (turn.confirm === true && this.reservationConfirmationFingerprint === fingerprint) {
      (this as any).diagnostics?.checkpoint?.("RESERVATION_FINAL_RECHECK_STARTED", { tool: MANAGE_RESERVATION });
      const booked = await this.executeManagedReservation(true);
      if (!booked.ok) {
        (this as any).diagnostics?.fail?.("RESERVATION_CREATE_FAILED", "TOOL_GATEWAY_RETURNED_ERROR", { tool: MANAGE_RESERVATION, error: booked.error });
        (this as any).createSpokenResponse("Indica claramente que la reserva no ha podido confirmarse y que no se ha creado. Ofrece intentarlo de nuevo sin afirmar disponibilidad.");
        return;
      }
      const result = booked.result as Record<string, unknown>;
      if (result.stage !== "BOOKED") {
        this.reservationConfirmationFingerprint = null;
        (this as any).diagnostics?.fail?.("RESERVATION_CREATE_NOT_BOOKED", "BOOKED_EVIDENCE_MISSING", { tool: MANAGE_RESERVATION, stage: result.stage ?? null });
        (this as any).createSpokenResponse("Indica que la reserva todavía no está confirmada y sigue exactamente las instrucciones del backend para completar los datos o volver a confirmar. No digas que está hecha.");
        return;
      }
      (this as any).reservationBookedThisCall = true;
      this.reservationConfirmationFingerprint = null;
      (this as any).diagnostics?.checkpoint?.("RESERVATION_BACKEND_BOOKED", { tool: MANAGE_RESERVATION });
      const marketingEnabled = Array.isArray((this as any).allowedTools) && ((this as any).allowedTools as string[]).includes(MANAGE_MARKETING_CONSENT);
      (this as any).createSpokenResponse(
        marketingEnabled
          ? `La reserva está confirmada por el backend. Comunícalo de forma breve usando únicamente este resultado autorizado: ${JSON.stringify(result)}. Después pregunta, de forma separada y opcional, si desea recibir ofertas y promociones en este mismo número.`
          : `La reserva está confirmada por el backend. Comunícalo de forma breve usando únicamente este resultado autorizado: ${JSON.stringify(result)}. No preguntes todavía por promociones porque esa gestión no está habilitada.`,
      );
      return;
    }

    const armed = await this.executeManagedReservation(false);
    if (!armed.ok) {
      (this as any).createSpokenResponse("Indica de forma amable que no puedes preparar la confirmación de la reserva en este momento y que no se ha creado ninguna reserva.");
      return;
    }
    const result = armed.result as Record<string, unknown>;
    if (result.stage !== "CONFIRM_RESERVATION") {
      this.reservationConfirmationFingerprint = null;
      (this as any).createSpokenResponse(`Sigue únicamente este resultado autorizado del backend: ${JSON.stringify(result)}. No afirmes que existe una reserva salvo que stage sea BOOKED.`);
      return;
    }

    this.reservationConfirmationFingerprint = fingerprint;
    (this as any).diagnostics?.checkpoint?.("RESERVATION_CONFIRMATION_ARMED_BACKEND", { tool: MANAGE_RESERVATION });
    (this as any).createSpokenResponse(`Resume de forma natural y breve estos datos autorizados: ${JSON.stringify(result)}. Después pregunta de forma inequívoca si confirma la reserva. No digas que está reservada todavía.`);
  }

  async [LEGACY_INTENT_EXECUTOR](selection: LegacyIntentSelection): Promise<void> {
    const classification = parseSemanticDecision(selection.argumentsJson);
    if (classification.intent === "CONTINUE" && classification.dataRequirement === "RESERVATION") {
      (this as any).diagnostics?.checkpoint?.("INTENT_CLASSIFIED", { intent: classification.intent, data_requirement: "RESERVATION", orchestrator: "backend_v1" });
      await this.handleReservationTurn(selection.argumentsJson, selection.callId);
      return;
    }

    await executeLegacyIntent(BasePrototype, this, selection);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) {
      await this[LEGACY_INTENT_EXECUTOR]({ argumentsJson: event.arguments, callId: event.call_id });
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
