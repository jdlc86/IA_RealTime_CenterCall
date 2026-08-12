import { DurableObject } from "cloudflare:workers";
import { CallDiagnostics, isDebugEnabled } from "./call-diagnostics";
import { SupabaseAdapter } from "./supabase-adapter";
import { KvTenantRepository, type TenantKvNamespace } from "./tenant-kv";
import { parseSemanticDecision, type DataRequirement } from "./semantic-router";
import {
  missingAvailabilityFields,
  missingContactFields,
  reservationFingerprint,
  validateReservationFlowArgs,
  type ReservationFlowArgs,
} from "./reservation-flow";
import { ToolGateway, requireObject, type ToolDefinition, type ToolResult } from "./tool-gateway";

type CallSessionEnv = {
  OPENAI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  DEBUG_KEY?: string;
  TENANT_CONFIG: TenantKvNamespace;
};

type ClosingState = "active" | "ambiguous" | "closing";
type BusinessFacts = Record<string, string | number | boolean>;

type RealtimeFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type RealtimeSidebandEvent = {
  type?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  transcript?: string;
  response?: { id?: string; status?: string };
  error?: { type?: string; code?: string; message?: string };
};

type CallSessionStartBody = {
  call_id?: unknown;
  tenant_id?: unknown;
  business_name?: unknown;
  assistant_name?: unknown;
  initial_greeting?: unknown;
  allowed_tools?: unknown;
  business_facts?: unknown;
};

const IDLE_TIMEOUT_MS = 10_000;
const AMBIGUOUS_LIMIT = 3;
const FINAL_FAREWELL_WATCHDOG_MS = 7_000;
const WAITING_PLAYBACK_WATCHDOG_MS = 5_000;
const HANGUP_RETRY_DELAY_MS = 300;
const HANGUP_MAX_ATTEMPTS = 2;

const GET_BUSINESS_INFORMATION = "get_business_information";
const GET_SERVICES = "get_services";
const GET_MENU = "get_menu";
const GET_PROFESSIONALS = "get_professionals";
const GET_BUSINESS_HOURS = "get_business_hours";
const MANAGE_RESERVATION = "manage_reservation";

const BUSINESS_INFORMATION_REALTIME_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: GET_BUSINESS_INFORMATION,
  description: "Obtiene hechos generales oficiales del negocio desde la configuración autorizada del tenant.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const SERVICES_REALTIME_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: GET_SERVICES,
  description: "Obtiene el catálogo activo de servicios o tratamientos, incluidos precio y duración cuando estén registrados.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const MENU_REALTIME_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: GET_MENU,
  description: "Obtiene la carta activa del restaurante, incluidos categoría, descripción, precio y alérgenos cuando estén registrados.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const PROFESSIONALS_REALTIME_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: GET_PROFESSIONALS,
  description: "Obtiene la lista activa de profesionales del negocio y sus cargos cuando estén registrados.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const BUSINESS_HOURS_REALTIME_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: GET_BUSINESS_HOURS,
  description: "Obtiene el horario comercial oficial registrado para el negocio.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const RESERVATION_REALTIME_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: MANAGE_RESERVATION,
  description: "Gestiona de forma progresiva una reserva de restaurante. Recoge fecha/hora, número de personas, nombre y teléfono; consulta disponibilidad; exige confirmación explícita antes de escribir la reserva. Nunca inventes datos que falten.",
  parameters: {
    type: "object",
    properties: {
      party_size: { type: "integer", minimum: 1, maximum: 100, description: "Número de comensales si el usuario lo ha indicado." },
      starts_at: { type: "string", description: "Fecha y hora solicitada en ISO 8601 con zona horaria. Si falta la zona horaria o la fecha/hora no es inequívoca, no inventes: omite el campo y pregunta." },
      customer_name: { type: "string", description: "Nombre para la reserva, solo si el usuario lo ha proporcionado." },
      customer_phone: { type: "string", description: "Teléfono de contacto en E.164, solo si está explícitamente disponible. Si falta prefijo internacional, pregunta antes de inferirlo." },
      duration_minutes: { type: "integer", minimum: 15, maximum: 480, description: "Duración prevista; omitir para usar el valor backend por defecto de 90 minutos." },
      notes: { type: "string", description: "Observación operacional de la reserva si el usuario la solicita." },
      confirm: { type: "boolean", description: "true únicamente cuando el usuario acaba de confirmar explícitamente los mismos detalles presentados previamente para confirmación." },
    },
    additionalProperties: false,
  },
};

const TOOL_BY_REQUIREMENT: Partial<Record<DataRequirement, RealtimeFunctionTool>> = {
  BUSINESS_INFO: BUSINESS_INFORMATION_REALTIME_TOOL,
  SERVICES: SERVICES_REALTIME_TOOL,
  MENU: MENU_REALTIME_TOOL,
  PROFESSIONALS: PROFESSIONALS_REALTIME_TOOL,
  HOURS: BUSINESS_HOURS_REALTIME_TOOL,
  RESERVATION: RESERVATION_REALTIME_TOOL,
};

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ level, event, component: "CallSession", ...details });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

function requireEnvString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function requireBodyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing call session field: ${name}`);
  return value.trim();
}

function parseAllowedTools(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid call session field: allowed_tools");
  const tools = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error("Invalid call session field: allowed_tools");
    return item.trim();
  });
  if (new Set(tools).size !== tools.length) throw new Error("Invalid call session field: duplicate allowed_tools");
  return tools;
}

function parseBusinessFacts(value: unknown): BusinessFacts {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid call session field: business_facts");
  const facts: BusinessFacts = {};
  for (const [key, fact] of Object.entries(value as Record<string, unknown>)) {
    if (typeof fact !== "string" && typeof fact !== "number" && typeof fact !== "boolean") {
      throw new Error(`Invalid call session field: business_facts.${key}`);
    }
    facts[key] = fact;
  }
  return facts;
}

function parseJsonArguments(argumentsJson: string | undefined): unknown {
  if (!argumentsJson?.trim()) return {};
  return JSON.parse(argumentsJson);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAssistantHangupCommitment(raw: string): boolean {
  const text = normalizeText(raw);
  return [
    /\bvoy a colgar(?: la llamada)?(?: ahora)?\b/,
    /\bvoy a finalizar(?: la llamada)?(?: ahora)?\b/,
    /\bvoy a terminar(?: la llamada)?(?: ahora)?\b/,
    /\bprocedo a colgar(?: la llamada)?\b/,
    /\bprocedo a finalizar(?: la llamada)?\b/,
    /\bterminare la llamada(?: ahora)?\b/,
    /\bfinalizare la llamada(?: ahora)?\b/,
    /\bcolgare(?: la llamada)?(?: ahora)?\b/,
  ].some((pattern) => pattern.test(text));
}

function readWebSocketText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function emptyObjectValidator(value: unknown): Record<string, never> {
  const object = requireObject(value);
  if (Object.keys(object).length > 0) throw new Error("This tool does not accept arguments");
  return {};
}

function isExternalRequirement(requirement: DataRequirement): boolean {
  return requirement === "SERVICES" || requirement === "MENU" || requirement === "PROFESSIONALS" || requirement === "HOURS";
}

export class CallSession extends DurableObject<CallSessionEnv> {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private callId: string | null = null;
  private tenantId: string | null = null;
  private businessName: string | null = null;
  private assistantName: string | null = null;
  private initialGreeting: string | null = null;
  private allowedTools: string[] = [];
  private businessFacts: BusinessFacts = {};
  private waitingPhrases: string[] = [];
  private waitingPhraseIndex = 0;
  private pendingExternalRequirement: DataRequirement | null = null;
  private pendingExternalResult: ToolResult | null = null;
  private externalResponseGateOpen = false;
  private waitingResponseId: string | null = null;
  private waitingPhraseStarted = false;
  private waitingPhrasePlaybackComplete = false;
  private waitingPlaybackWatchdog: ReturnType<typeof setTimeout> | null = null;
  private reservationConfirmationArmed = false;
  private reservationConfirmationFingerprint: string | null = null;
  private greetingSent = false;
  private state: ClosingState = "active";
  private ambiguousCount = 0;
  private closingReason = "user_requested_end";
  private hangupStarted = false;
  private closingResponseId: string | null = null;
  private finalFarewellWatchdog: ReturnType<typeof setTimeout> | null = null;
  private diagnostics = new CallDiagnostics(false);

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") {
      let body: CallSessionStartBody;
      try {
        body = (await request.json()) as CallSessionStartBody;
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }

      let callId: string;
      let tenantId: string;
      let businessName: string;
      let assistantName: string;
      let initialGreeting: string;
      let allowedTools: string[];
      let businessFacts: BusinessFacts;
      try {
        callId = requireBodyString(body.call_id, "call_id");
        tenantId = requireBodyString(body.tenant_id, "tenant_id");
        businessName = requireBodyString(body.business_name, "business_name");
        assistantName = requireBodyString(body.assistant_name, "assistant_name");
        initialGreeting = requireBodyString(body.initial_greeting, "initial_greeting");
        allowedTools = parseAllowedTools(body.allowed_tools);
        businessFacts = parseBusinessFacts(body.business_facts);
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "invalid_call_session_start" }, { status: 400 });
      }

      if (this.callId && this.callId !== callId) return Response.json({ ok: false, error: "call_session_id_mismatch" }, { status: 409 });
      if (this.tenantId && this.tenantId !== tenantId) return Response.json({ ok: false, error: "call_session_tenant_mismatch" }, { status: 409 });

      this.callId = callId;
      this.tenantId = tenantId;
      this.businessName = businessName;
      this.assistantName = assistantName;
      this.initialGreeting = initialGreeting;
      this.allowedTools = allowedTools;
      this.businessFacts = businessFacts;
      const debugEnabled = isDebugEnabled(this.env.DEBUG_KEY);
      this.diagnostics.configure(debugEnabled, callId, tenantId, debugEnabled ? async (entry, snapshot) => {
        const details = entry.details ?? {};
        const dataRequirement = typeof details.data_requirement === "string" ? details.data_requirement : null;
        const toolName = typeof details.tool === "string"
          ? details.tool
          : typeof details.required_tool === "string"
            ? details.required_tool
            : null;
        await this.getSupabaseAdapter().writeDiagnosticEvent({
          call_id: snapshot.call_id ?? callId,
          tenant_id: snapshot.tenant_id,
          component: "CallSession",
          stage: entry.stage,
          event: "call_diagnostic",
          severity: entry.level,
          data_requirement: dataRequirement,
          tool_name: toolName,
          elapsed_ms: entry.elapsed_ms,
          recovery: snapshot.recovery,
          diagnosis: snapshot.diagnosis,
          details,
        });
      } : null);
      this.diagnostics.checkpoint("CALL_SESSION_STARTED", { allowed_tools_count: allowedTools.length });

      try {
        if (this.env.TENANT_CONFIG && typeof this.env.TENANT_CONFIG.get === "function") {
          const config = await new KvTenantRepository(this.env.TENANT_CONFIG).getTenantConfiguration(tenantId);
          this.waitingPhrases = config?.assistant.waitingPhrases ?? [];
          this.diagnostics.checkpoint("TENANT_CONFIG_LOADED", { waiting_phrases_count: this.waitingPhrases.length });
        }
      } catch (error) {
        this.waitingPhrases = [];
        this.diagnostics.fail("TENANT_CONFIG_FAILED", "TENANT_CONFIGURATION_READ_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
        log("error", "tenant_waiting_phrases_load_failed", {
          call_id: callId,
          tenant_id: tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (!this.socket) {
        this.connectPromise ??= this.connectSideband(callId).finally(() => { this.connectPromise = null; });
        await this.connectPromise;
      }
      this.sendInitialGreetingIfNeeded();

      return Response.json({
        ok: true,
        call_id: callId,
        tenant_id: tenantId,
        business_name: businessName,
        assistant_name: assistantName,
        allowed_tools: this.allowedTools,
        waiting_phrases: this.waitingPhrases.length,
        greeting_sent: this.greetingSent,
        state: this.state,
        ambiguous_count: this.ambiguousCount,
        sideband: "durable_object",
        intent_policy: "semantic_v15_restaurant_reservation_guarded",
        tool_gateway: "tenant_allowlist_v2",
        business_data_provider: "supabase",
        tenant_config_source: "bootstrap+kv_waiting_phrases",
        debug_enabled: this.diagnostics.snapshot().enabled,
      });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json({
        ok: true,
        call_id: this.callId,
        tenant_id: this.tenantId,
        business_name: this.businessName,
        assistant_name: this.assistantName,
        allowed_tools: this.allowedTools,
        waiting_phrases: this.waitingPhrases.length,
        greeting_sent: this.greetingSent,
        state: this.state,
        ambiguous_count: this.ambiguousCount,
        ambiguous_limit: AMBIGUOUS_LIMIT,
        websocket_connected: this.socket !== null,
        hangup_started: this.hangupStarted,
        pending_external_requirement: this.pendingExternalRequirement,
        external_result_ready: this.pendingExternalResult !== null,
        waiting_phrase_started: this.waitingPhraseStarted,
        waiting_phrase_playback_complete: this.waitingPhrasePlaybackComplete,
        reservation_confirmation_armed: this.reservationConfirmationArmed,
        tool_gateway: "tenant_allowlist_v2",
        business_data_provider: "supabase",
        diagnostics: this.diagnostics.snapshot(),
      });
    }

    if (request.method === "GET" && url.pathname === "/diagnostics") {
      const snapshot = this.diagnostics.snapshot();
      return Response.json(snapshot.enabled ? { ok: true, diagnostics: snapshot } : { ok: false, error: "debug_disabled" }, { status: snapshot.enabled ? 200 : 404 });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  private async connectSideband(callId: string): Promise<void> {
    const startedAt = Date.now();
    const response = await fetch(`https://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${requireEnvString(this.env.OPENAI_API_KEY, "OPENAI_API_KEY")}`,
        "Sec-WebSocket-Protocol": "realtime",
        Connection: "Upgrade",
        Upgrade: "websocket",
      },
    });
    const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
    if (!socket) {
      const body = await response.text().catch(() => "");
      this.diagnostics.fail("SIDEBAND_CONNECT_FAILED", "OPENAI_SIDEBAND_UPGRADE_FAILED", { status: response.status });
      throw new Error(`Realtime sideband upgrade failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    }
    socket.accept();
    this.socket = socket;
    this.diagnostics.checkpoint("SIDEBAND_CONNECTED", { elapsed_ms: Date.now() - startedAt });
    log("info", "realtime_sideband_connected", {
      call_id: callId,
      tenant_id: this.tenantId,
      elapsed_ms: Date.now() - startedAt,
      lifecycle: "durable_object_outbound_websocket",
      intent_policy: "semantic_v15_restaurant_reservation_guarded",
      allowed_tools: this.allowedTools,
      waiting_phrases: this.waitingPhrases.length,
    });
    socket.addEventListener("message", (event) => { void this.handleRealtimeMessage(event.data); });
    socket.addEventListener("close", () => {
      this.clearFinalFarewellWatchdog();
      this.clearWaitingPlaybackWatchdog();
      this.socket = null;
      this.diagnostics.checkpoint("SIDEBAND_CLOSED", { state: this.state, hangup_started: this.hangupStarted });
      log("info", "realtime_sideband_closed", { call_id: this.callId, tenant_id: this.tenantId, state: this.state, ambiguous_count: this.ambiguousCount, hangup_started: this.hangupStarted });
    });
    socket.addEventListener("error", () => {
      this.diagnostics.fail("SIDEBAND_SOCKET_ERROR", "OPENAI_SIDEBAND_SOCKET_ERROR", { state: this.state });
      log("error", "realtime_sideband_socket_error", { call_id: this.callId, tenant_id: this.tenantId, state: this.state, ambiguous_count: this.ambiguousCount });
    });
  }

  private send(event: unknown): void {
    if (!this.socket) throw new Error("Realtime sideband socket is not connected");
    this.socket.send(JSON.stringify(event));
  }

  private sendInitialGreetingIfNeeded(): void {
    if (this.greetingSent || !this.socket || !this.initialGreeting || !this.callId) return;
    this.greetingSent = true;
    this.createSpokenResponse(`Pronuncia exactamente este saludo inicial y nada más: ${JSON.stringify(this.initialGreeting)}`);
    this.diagnostics.checkpoint("GREETING_SENT");
    log("info", "tenant_initial_greeting_requested", { call_id: this.callId, tenant_id: this.tenantId, business_name: this.businessName, assistant_name: this.assistantName });
  }

  private sendBestEffortCancel(): void {
    if (this.socket) this.send({ type: "response.cancel" });
  }

  private clearFinalFarewellWatchdog(): void {
    if (this.finalFarewellWatchdog !== null) {
      clearTimeout(this.finalFarewellWatchdog);
      this.finalFarewellWatchdog = null;
    }
  }

  private clearWaitingPlaybackWatchdog(): void {
    if (this.waitingPlaybackWatchdog !== null) {
      clearTimeout(this.waitingPlaybackWatchdog);
      this.waitingPlaybackWatchdog = null;
    }
  }

  private resetExternalFlow(): void {
    this.clearWaitingPlaybackWatchdog();
    this.pendingExternalRequirement = null;
    this.pendingExternalResult = null;
    this.externalResponseGateOpen = false;
    this.waitingResponseId = null;
    this.waitingPhraseStarted = false;
    this.waitingPhrasePlaybackComplete = false;
  }

  private resetReservationConfirmation(): void {
    this.reservationConfirmationArmed = false;
    this.reservationConfirmationFingerprint = null;
  }

  private sendToolResult(callId: string | undefined, payload: Record<string, unknown> | ToolResult): void {
    if (!callId) return;
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(payload) } });
  }

  private createSpokenResponse(instructions: string): void {
    this.send({ type: "response.create", response: { tool_choice: "none", instructions } });
  }

  private nextWaitingPhrase(): string | null {
    if (this.waitingPhrases.length === 0) return null;
    const phrase = this.waitingPhrases[this.waitingPhraseIndex % this.waitingPhrases.length];
    this.waitingPhraseIndex = (this.waitingPhraseIndex + 1) % this.waitingPhrases.length;
    return phrase;
  }

  private forceToolForRequirement(requirement: DataRequirement): void {
    const tool = TOOL_BY_REQUIREMENT[requirement];
    if (!tool || !this.allowedTools.includes(tool.name)) {
      this.diagnostics.fail("TOOL_NOT_AVAILABLE", "REQUIRED_TOOL_NOT_ALLOWED", { data_requirement: requirement, required_tool: tool?.name ?? null });
      log("error", "business_data_requirement_not_available", {
        call_id: this.callId,
        tenant_id: this.tenantId,
        data_requirement: requirement,
        required_tool: tool?.name ?? null,
        allowed_tools: this.allowedTools,
      });
      this.createSpokenResponse(
        "El usuario solicita un dato empresarial que no tiene una fuente autorizada disponible para este tenant. Indica brevemente que no dispones de ese dato verificado en este momento. No lo estimes, deduzcas ni inventes.",
      );
      return;
    }

    this.send({
      type: "response.create",
      response: {
        tool_choice: { type: "function", name: tool.name },
        tools: [tool],
        instructions: requirement === "RESERVATION"
          ? "Gestiona el proceso de reserva exclusivamente mediante manage_reservation. Pasa solo datos que el usuario haya proporcionado o confirmado. Si faltan campos, omítelos; la herramienta indicará qué preguntar. No marques confirm=true salvo que el usuario haya confirmado explícitamente los mismos detalles después de que el sistema los presentara para confirmación."
          : `Consulta obligatoriamente ${tool.name} antes de responder. No generes una respuesta textual hasta recibir el resultado de la herramienta.`,
      },
    });
    this.diagnostics.checkpoint("TOOL_FORCED", { data_requirement: requirement, tool: tool.name });
    log("info", "business_data_tool_forced", {
      call_id: this.callId,
      tenant_id: this.tenantId,
      data_requirement: requirement,
      tool: tool.name,
      grounding_policy: requirement === "RESERVATION" ? "guarded_write_v1" : "domain_forced_v2",
    });
  }

  private getSupabaseAdapter(): SupabaseAdapter {
    return new SupabaseAdapter({
      SUPABASE_URL: requireEnvString(this.env.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireEnvString(this.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
  }

  private async executeReservationFlow(args: ReservationFlowArgs, tenantId: string): Promise<Record<string, unknown>> {
    const availabilityMissing = missingAvailabilityFields(args);
    if (availabilityMissing.length) {
      this.resetReservationConfirmation();
      return {
        stage: "COLLECT_AVAILABILITY_DETAILS",
        missing_fields: availabilityMissing,
        instruction: "Pregunta únicamente por los datos que faltan para consultar disponibilidad. No inventes fecha, hora ni número de personas.",
      };
    }

    const availability = await this.getSupabaseAdapter().checkRestaurantAvailability(
      tenantId,
      args.startsAt!,
      args.partySize!,
      args.durationMinutes ?? 90,
    );

    if (availability.length === 0) {
      this.resetReservationConfirmation();
      return {
        stage: "NO_AVAILABILITY",
        requested: { starts_at: args.startsAt, party_size: args.partySize, duration_minutes: args.durationMinutes ?? 90 },
        instruction: "No confirmes ninguna reserva. Informa de que no hay mesa disponible para esos datos y pide otra hora o fecha.",
      };
    }

    const contactMissing = missingContactFields(args);
    if (contactMissing.length) {
      this.resetReservationConfirmation();
      return {
        stage: "COLLECT_CONTACT_DETAILS",
        available: true,
        missing_fields: contactMissing,
        requested: { starts_at: args.startsAt, party_size: args.partySize, duration_minutes: args.durationMinutes ?? 90 },
        table_candidate: {
          code: availability[0]?.table_code,
          name: availability[0]?.table_name,
          max_capacity: availability[0]?.max_capacity,
        },
        instruction: "Hay disponibilidad. Solicita únicamente los datos de contacto que faltan. No confirmes todavía la reserva.",
      };
    }

    const fingerprint = reservationFingerprint(args);
    if (args.confirm !== true || !this.reservationConfirmationArmed || this.reservationConfirmationFingerprint !== fingerprint) {
      this.reservationConfirmationArmed = true;
      this.reservationConfirmationFingerprint = fingerprint;
      return {
        stage: "CONFIRM_RESERVATION",
        explicit_confirmation_required: true,
        reservation: {
          customer_name: args.customerName,
          customer_phone: args.customerPhone,
          party_size: args.partySize,
          starts_at: args.startsAt,
          duration_minutes: args.durationMinutes ?? 90,
          notes: args.notes ?? null,
        },
        instruction: "Resume los datos de la reserva y pregunta de forma inequívoca si el usuario confirma. No marques confirm=true hasta recibir esa confirmación en un turno posterior.",
      };
    }

    const reservation = await this.getSupabaseAdapter().createRestaurantReservation(tenantId, {
      customerName: args.customerName!,
      customerPhone: args.customerPhone!,
      partySize: args.partySize!,
      startsAt: args.startsAt!,
      durationMinutes: args.durationMinutes ?? 90,
      notes: args.notes ?? null,
      source: "voice",
    });
    this.resetReservationConfirmation();
    return {
      stage: "BOOKED",
      reservation,
      ask_marketing_consent: true,
      marketing_instruction: "La reserva ya está confirmada. Después de comunicarlo, pregunta de forma separada y opcional si desea recibir ofertas/promociones. Rechazar marketing nunca afecta a la reserva.",
    };
  }

  private createToolGateway(): ToolGateway {
    if (!this.tenantId) throw new Error("ToolGateway requires tenant_id");
    const definitions: ToolDefinition<unknown, unknown>[] = [
      {
        name: GET_BUSINESS_INFORMATION,
        access: "READ",
        description: BUSINESS_INFORMATION_REALTIME_TOOL.description,
        validate: emptyObjectValidator,
        execute: async () => ({ business_name: this.businessName ?? "", assistant_name: this.assistantName ?? "", ...this.businessFacts, source: "tenant_configuration" }),
      },
      {
        name: GET_SERVICES,
        access: "READ",
        description: SERVICES_REALTIME_TOOL.description,
        validate: emptyObjectValidator,
        execute: async (_args, context) => ({ services: await this.getSupabaseAdapter().listServices(context.tenantId), source: "supabase" }),
      },
      {
        name: GET_MENU,
        access: "READ",
        description: MENU_REALTIME_TOOL.description,
        validate: emptyObjectValidator,
        execute: async (_args, context) => ({ menu_items: await this.getSupabaseAdapter().listMenuItems(context.tenantId), source: "supabase" }),
      },
      {
        name: GET_PROFESSIONALS,
        access: "READ",
        description: PROFESSIONALS_REALTIME_TOOL.description,
        validate: emptyObjectValidator,
        execute: async (_args, context) => ({ professionals: await this.getSupabaseAdapter().listProfessionals(context.tenantId), source: "supabase" }),
      },
      {
        name: GET_BUSINESS_HOURS,
        access: "READ",
        description: BUSINESS_HOURS_REALTIME_TOOL.description,
        validate: emptyObjectValidator,
        execute: async (_args, context) => ({ business_hours: await this.getSupabaseAdapter().listBusinessHours(context.tenantId), source: "supabase" }),
      },
      {
        name: MANAGE_RESERVATION,
        access: "WRITE",
        description: RESERVATION_REALTIME_TOOL.description,
        validate: validateReservationFlowArgs,
        execute: async (args, context) => this.executeReservationFlow(args as ReservationFlowArgs, context.tenantId),
      },
    ];
    return new ToolGateway(definitions, [{ tenantId: this.tenantId, allowedTools: this.allowedTools }]);
  }

  private async executeExternalRequirement(requirement: DataRequirement): Promise<void> {
    if (!this.tenantId || !this.callId || this.pendingExternalRequirement !== requirement) return;
    const tool = TOOL_BY_REQUIREMENT[requirement];
    if (!tool || !isExternalRequirement(requirement) || !this.allowedTools.includes(tool.name)) {
      this.pendingExternalResult = {
        ok: false,
        tool: tool?.name ?? "unknown",
        tenantId: this.tenantId,
        error: "TOOL_NOT_ALLOWED",
        message: "Required external tool is not available for this tenant",
      } as ToolResult;
      this.diagnostics.fail("BACKEND_QUERY_BLOCKED", "REQUIRED_EXTERNAL_TOOL_NOT_AVAILABLE", { data_requirement: requirement, tool: tool?.name ?? null });
      this.maybeDeliverExternalResult("tool_not_available");
      return;
    }

    const startedAt = Date.now();
    this.diagnostics.checkpoint("BACKEND_QUERY_STARTED", { data_requirement: requirement, tool: tool.name });
    log("info", "business_data_backend_query_started", {
      call_id: this.callId,
      tenant_id: this.tenantId,
      data_requirement: requirement,
      tool: tool.name,
      execution: "direct_tool_gateway_parallel",
    });

    try {
      const result = await this.createToolGateway().execute({
        name: tool.name,
        arguments: {},
        context: { tenantId: this.tenantId, callId: this.callId },
      });
      if (this.pendingExternalRequirement !== requirement) return;
      this.pendingExternalResult = result;
      if (result.ok) this.diagnostics.checkpoint("BACKEND_QUERY_COMPLETED", { data_requirement: requirement, tool: tool.name, elapsed_ms: Date.now() - startedAt });
      else this.diagnostics.fail("BACKEND_QUERY_FAILED", "TOOL_GATEWAY_RETURNED_ERROR", { data_requirement: requirement, tool: tool.name, elapsed_ms: Date.now() - startedAt, error: result.error });
      log(result.ok ? "info" : "error", "business_data_backend_query_completed", {
        call_id: this.callId,
        tenant_id: this.tenantId,
        data_requirement: requirement,
        tool: tool.name,
        ok: result.ok,
        elapsed_ms: Date.now() - startedAt,
        error: result.ok ? undefined : result.error,
      });
    } catch (error) {
      if (this.pendingExternalRequirement !== requirement) return;
      this.pendingExternalResult = {
        ok: false,
        tool: tool.name,
        tenantId: this.tenantId,
        error: "EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
      this.diagnostics.fail("BACKEND_QUERY_EXCEPTION", "EXTERNAL_DATA_QUERY_EXCEPTION", {
        data_requirement: requirement,
        tool: tool.name,
        elapsed_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      log("error", "business_data_backend_query_failed", {
        call_id: this.callId,
        tenant_id: this.tenantId,
        data_requirement: requirement,
        tool: tool.name,
        elapsed_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.maybeDeliverExternalResult("backend_completed");
  }

  private startWaitingPhrase(requirement: DataRequirement): void {
    const waitingPhrase = this.nextWaitingPhrase();
    this.externalResponseGateOpen = true;

    if (!waitingPhrase) {
      this.waitingPhraseStarted = false;
      this.waitingPhrasePlaybackComplete = true;
      this.diagnostics.checkpoint("WAITING_PHRASE_SKIPPED", { data_requirement: requirement, reason: "not_configured" });
      log("info", "business_data_waiting_phrase_skipped", {
        call_id: this.callId,
        tenant_id: this.tenantId,
        data_requirement: requirement,
        reason: "no_waiting_phrase_configured",
      });
      this.maybeDeliverExternalResult("no_waiting_phrase");
      return;
    }

    this.waitingPhraseStarted = true;
    this.waitingPhrasePlaybackComplete = false;
    this.waitingResponseId = null;
    this.createSpokenResponse(`Pronuncia exactamente esta frase de espera y nada más: ${JSON.stringify(waitingPhrase)}`);
    this.diagnostics.checkpoint("WAITING_PHRASE_REQUESTED", { data_requirement: requirement, phrase_chars: waitingPhrase.length });
    this.clearWaitingPlaybackWatchdog();
    this.waitingPlaybackWatchdog = setTimeout(() => {
      this.markWaitingPhrasePlaybackComplete("playback_watchdog");
    }, WAITING_PLAYBACK_WATCHDOG_MS);
    log("info", "business_data_waiting_phrase_requested", {
      call_id: this.callId,
      tenant_id: this.tenantId,
      data_requirement: requirement,
      phrase_chars: waitingPhrase.length,
      backend_query: "already_running_in_parallel",
      watchdog_ms: WAITING_PLAYBACK_WATCHDOG_MS,
    });
  }

  private markWaitingPhrasePlaybackComplete(trigger: "output_audio_buffer.stopped" | "playback_watchdog"): void {
    if (!this.pendingExternalRequirement || !this.waitingPhraseStarted || this.waitingPhrasePlaybackComplete) return;
    this.clearWaitingPlaybackWatchdog();
    this.waitingPhrasePlaybackComplete = true;
    if (trigger === "playback_watchdog") {
      this.diagnostics.fail("WAITING_PHRASE_PLAYBACK_STALLED", "WAITING_PHRASE_PLAYBACK_EVENT_MISSING", {
        data_requirement: this.pendingExternalRequirement,
        watchdog_ms: WAITING_PLAYBACK_WATCHDOG_MS,
      });
      this.diagnostics.recovered("WAITING_PHRASE_FALLBACK_CONTINUE", "continue_with_already_started_backend_query", { data_requirement: this.pendingExternalRequirement });
    } else {
      this.diagnostics.checkpoint("WAITING_PHRASE_PLAYBACK_COMPLETED", { data_requirement: this.pendingExternalRequirement });
    }
    log(trigger === "playback_watchdog" ? "error" : "info", "business_data_waiting_phrase_completed", {
      call_id: this.callId,
      tenant_id: this.tenantId,
      data_requirement: this.pendingExternalRequirement,
      trigger,
      diagnosis: trigger === "playback_watchdog" ? "WAITING_PHRASE_PLAYBACK_EVENT_MISSING" : undefined,
      recovery: trigger === "playback_watchdog" ? "continue_with_already_started_backend_query" : undefined,
    });
    this.maybeDeliverExternalResult(trigger);
  }

  private maybeDeliverExternalResult(trigger: string): void {
    const requirement = this.pendingExternalRequirement;
    const result = this.pendingExternalResult;
    if (!requirement || !result || !this.externalResponseGateOpen || !this.waitingPhrasePlaybackComplete) return;

    this.diagnostics.checkpoint("EXTERNAL_RESULT_READY_FOR_SPEECH", { data_requirement: requirement, trigger, ok: result.ok });
    log(result.ok ? "info" : "error", "business_data_external_result_ready_for_speech", {
      call_id: this.callId,
      tenant_id: this.tenantId,
      data_requirement: requirement,
      trigger,
      ok: result.ok,
      waiting_phrase_used: this.waitingPhraseStarted,
    });

    const serialized = JSON.stringify(result);
    this.resetExternalFlow();
    if (result.ok) {
      this.createSpokenResponse(
        `Responde ahora usando exclusivamente los hechos que aparezcan explícitamente en este resultado autorizado: ${serialized}. Si el dato pedido no figura o una lista está vacía, indica que no dispones de ese dato verificado. No estimes, deduzcas, completes ni inventes. No menciones Supabase, ToolGateway, JSON ni procesos internos.`,
      );
      this.diagnostics.checkpoint("FINAL_RESPONSE_REQUESTED", { source: "authorized_external_result" });
    } else {
      this.createSpokenResponse(
        "La fuente autorizada no pudo proporcionar el dato. Informa brevemente de que no puedes verificarlo ahora mismo; no inventes información ni menciones procesos internos.",
      );
      this.diagnostics.checkpoint("FINAL_RESPONSE_REQUESTED", { source: "external_error_fallback" });
    }
  }

  private createResponseForRequirement(requirement: DataRequirement): void {
    if (requirement === "NONE") {
      this.diagnostics.checkpoint("GENERAL_CONVERSATION_RESPONSE", { data_requirement: requirement });
      this.createSpokenResponse(
        "Continúa la conversación de forma breve, natural y útil. No introduzcas datos concretos del negocio que no estén ya verificados en la conversación.",
      );
      return;
    }

    if (!isExternalRequirement(requirement)) {
      this.forceToolForRequirement(requirement);
      return;
    }

    this.resetExternalFlow();
    this.pendingExternalRequirement = requirement;
    this.pendingExternalResult = null;
    this.externalResponseGateOpen = false;
    this.waitingPhraseStarted = false;
    this.waitingPhrasePlaybackComplete = this.waitingPhrases.length === 0;
    this.diagnostics.checkpoint("EXTERNAL_FLOW_STARTED", { data_requirement: requirement });
    log("info", "business_data_external_flow_started", {
      call_id: this.callId,
      tenant_id: this.tenantId,
      data_requirement: requirement,
      sequencing: "backend_parallel_then_waiting_phrase_after_classifier_done",
    });
    void this.executeExternalRequirement(requirement);
  }

  private async handleBusinessToolCall(event: RealtimeSidebandEvent): Promise<void> {
    if (!this.tenantId || !this.callId || !event.name) return;
    let args: unknown;
    try {
      args = parseJsonArguments(event.arguments);
    } catch {
      this.diagnostics.fail("TOOL_ARGUMENTS_INVALID", "TOOL_ARGUMENTS_NOT_VALID_JSON", { tool: event.name });
      this.sendToolResult(event.call_id, { ok: false, tool: event.name, tenantId: this.tenantId, error: "INVALID_ARGUMENTS", message: "Tool arguments must be valid JSON" });
      this.createSpokenResponse("No pude consultar una fuente autorizada. Indica que no dispones del dato verificado; no inventes información.");
      return;
    }

    const result = await this.createToolGateway().execute({ name: event.name, arguments: args, context: { tenantId: this.tenantId, callId: this.callId } });
    this.sendToolResult(event.call_id, result);
    if (result.ok) this.diagnostics.checkpoint("TOOL_GATEWAY_COMPLETED", { tool: event.name });
    else this.diagnostics.fail("TOOL_GATEWAY_FAILED", "TOOL_GATEWAY_RETURNED_ERROR", { tool: event.name, error: result.error });
    log(result.ok ? "info" : "error", "tool_gateway_result", {
      call_id: this.callId,
      tenant_id: this.tenantId,
      tool: event.name,
      ok: result.ok,
      access: result.ok ? result.access : undefined,
      error: result.ok ? undefined : result.error,
    });

    if (result.ok) {
      this.createSpokenResponse(
        event.name === MANAGE_RESERVATION
          ? "Continúa el flujo usando exclusivamente el resultado autorizado de manage_reservation. Sigue exactamente el campo instruction/marketing_instruction cuando exista. Si stage=CONFIRM_RESERVATION, resume los datos y pide confirmación explícita. Si stage=BOOKED, confirma que la reserva está hecha y pregunta por marketing de forma separada y opcional. Nunca afirmes que una reserva está hecha salvo stage=BOOKED."
          : "Responde usando exclusivamente los hechos que aparezcan explícitamente en el resultado autorizado de la herramienta. Si el dato pedido no figura o la lista está vacía, indica que no dispones de ese dato verificado. No estimes, deduzcas, completes ni inventes. No menciones Supabase, ToolGateway, JSON ni procesos internos.",
      );
    } else {
      this.createSpokenResponse("La fuente autorizada no pudo proporcionar el dato. Informa brevemente de que no puedes verificarlo ahora mismo; no inventes información.");
    }
  }

  private continueConversation(reason: string, dataRequirement: DataRequirement, toolCallId?: string): void {
    const previousAmbiguousCount = this.ambiguousCount;
    this.state = "active";
    this.ambiguousCount = 0;
    this.sendToolResult(toolCallId, { ok: true, action: "continue", data_requirement: dataRequirement, ambiguous_count: 0 });
    this.diagnostics.checkpoint("CONVERSATION_CONTINUE", { data_requirement: dataRequirement });
    log("info", "call_intent_continue", {
      call_id: this.callId,
      tenant_id: this.tenantId,
      reason,
      data_requirement: dataRequirement,
      ambiguous_count_before_reset: previousAmbiguousCount,
      ambiguous_count: 0,
    });
    if (previousAmbiguousCount > 0) {
      log("info", "call_intent_ambiguity_reset", { call_id: this.callId, tenant_id: this.tenantId, reason: "user_returned_to_normal_conversation", previous_ambiguous_count: previousAmbiguousCount });
    }
    this.createResponseForRequirement(dataRequirement);
  }

  private handleAmbiguousIntent(reason: string, toolCallId?: string): void {
    if (this.state === "closing" || this.hangupStarted) return;
    this.ambiguousCount += 1;
    this.state = "ambiguous";
    this.sendToolResult(toolCallId, { ok: true, action: this.ambiguousCount >= AMBIGUOUS_LIMIT ? "close" : "ask_if_more_help", ambiguous_count: this.ambiguousCount, ambiguous_limit: AMBIGUOUS_LIMIT });
    this.diagnostics.checkpoint("INTENT_AMBIGUOUS", { ambiguous_count: this.ambiguousCount });
    log("info", "call_intent_ambiguous", { call_id: this.callId, tenant_id: this.tenantId, reason, ambiguous_count: this.ambiguousCount, ambiguous_limit: AMBIGUOUS_LIMIT });
    if (this.ambiguousCount >= AMBIGUOUS_LIMIT) {
      this.beginClosing("ambiguous_limit_reached", "semantic_intent");
      return;
    }
    this.createSpokenResponse("La intención de terminar es ambigua. Pregunta una sola vez y de forma natural si puedes ayudar en algo más. Después espera. No te despidas todavía.");
  }

  private handleClearEndIntent(reason: string, toolCallId?: string): void {
    this.sendToolResult(toolCallId, { ok: true, action: "close", ambiguous_count: this.ambiguousCount });
    this.diagnostics.checkpoint("END_INTENT_CLEAR");
    log("info", "call_intent_end_clear", { call_id: this.callId, tenant_id: this.tenantId, reason, ambiguous_count: this.ambiguousCount });
    this.beginClosing("semantic_end_clear", "semantic_intent");
  }

  private beginClosing(reason: string, source: string): void {
    if (this.state === "closing" || this.hangupStarted) return;
    this.resetExternalFlow();
    this.resetReservationConfirmation();
    this.state = "closing";
    this.closingReason = reason;
    this.closingResponseId = null;
    this.diagnostics.checkpoint("CLOSING_STARTED", { source, reason });
    log("info", "end_call_closing_started", { call_id: this.callId, tenant_id: this.tenantId, source, reason, ambiguous_count: this.ambiguousCount });
    this.sendBestEffortCancel();
    this.createSpokenResponse("Despídete ahora con una sola frase muy breve, natural y amable en español. No preguntes nada más ni ofrezcas más ayuda. Esta es la despedida final.");
    this.clearFinalFarewellWatchdog();
    this.finalFarewellWatchdog = setTimeout(() => { void this.performHangup("final_farewell_watchdog"); }, FINAL_FAREWELL_WATCHDOG_MS);
  }

  private armHangupAfterCurrentAudio(reason: string, source: string): void {
    if (this.state === "closing" || this.hangupStarted) return;
    this.resetExternalFlow();
    this.resetReservationConfirmation();
    this.state = "closing";
    this.closingReason = reason;
    this.closingResponseId = null;
    this.diagnostics.fail("HANGUP_COMMITMENT_GUARD", "ASSISTANT_ANNOUNCED_HANGUP_OUTSIDE_CORE_CLOSE", { source, reason });
    log("info", "end_call_closing_armed_current_audio", { call_id: this.callId, tenant_id: this.tenantId, source, reason, ambiguous_count: this.ambiguousCount });
    this.clearFinalFarewellWatchdog();
    this.finalFarewellWatchdog = setTimeout(() => { void this.performHangup("assistant_commitment_watchdog"); }, FINAL_FAREWELL_WATCHDOG_MS);
  }

  private async performHangup(trigger: string): Promise<void> {
    if (this.hangupStarted || !this.callId) return;
    this.hangupStarted = true;
    this.clearFinalFarewellWatchdog();
    this.resetExternalFlow();
    this.resetReservationConfirmation();
    this.diagnostics.checkpoint("HANGUP_STARTED", { trigger });
    log("info", "end_call_hangup_triggered", { call_id: this.callId, tenant_id: this.tenantId, trigger, state: this.state, ambiguous_count: this.ambiguousCount, closing_response_id: this.closingResponseId });
    let lastError: unknown;
    for (let attempt = 1; attempt <= HANGUP_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.hangupOpenAICall(this.callId, this.closingReason, attempt);
        this.diagnostics.checkpoint("HANGUP_COMPLETED", { attempt });
        return;
      } catch (error) {
        lastError = error;
        this.diagnostics.fail("HANGUP_ATTEMPT_FAILED", "OPENAI_HANGUP_REQUEST_FAILED", { attempt, error: error instanceof Error ? error.message : String(error) });
        log("error", "end_call_hangup_attempt_failed", { call_id: this.callId, tenant_id: this.tenantId, trigger, attempt, error: error instanceof Error ? error.message : String(error) });
        if (attempt < HANGUP_MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, HANGUP_RETRY_DELAY_MS));
      }
    }
    this.hangupStarted = false;
    this.state = "active";
    this.ambiguousCount = 0;
    this.diagnostics.recovered("CALL_REACTIVATED", "hangup_abandoned_after_retries", { error: lastError instanceof Error ? lastError.message : String(lastError) });
    log("error", "end_call_hangup_abandoned_session_reactivated", { call_id: this.callId, tenant_id: this.tenantId, trigger, error: lastError instanceof Error ? lastError.message : String(lastError) });
    if (this.socket) this.createSpokenResponse("No se pudo cerrar automáticamente la llamada. Indica brevemente que la llamada sigue activa y continúa atendiendo.");
  }

  private async hangupOpenAICall(callId: string, reason: string, attempt: number): Promise<void> {
    const startedAt = Date.now();
    const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireEnvString(this.env.OPENAI_API_KEY, "OPENAI_API_KEY")}` },
    });
    const body = await response.text();
    log(response.ok ? "info" : "error", "end_call_hangup_result", { call_id: callId, tenant_id: this.tenantId, status: response.status, elapsed_ms: Date.now() - startedAt, attempt, body: body.slice(0, 1000), reason });
    if (!response.ok) throw new Error(`OpenAI hangup failed with HTTP ${response.status}`);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readWebSocketText(data);
    if (!text) return;
    let event: RealtimeSidebandEvent;
    try {
      event = JSON.parse(text) as RealtimeSidebandEvent;
    } catch {
      this.diagnostics.fail("REALTIME_INVALID_JSON", "OPENAI_REALTIME_EVENT_INVALID_JSON");
      log("error", "realtime_sideband_invalid_json", { call_id: this.callId, tenant_id: this.tenantId });
      return;
    }

    if (event.type === "error") {
      if (event.error?.code === "response_cancel_not_active") {
        log("info", "realtime_sideband_cancel_noop", { call_id: this.callId, tenant_id: this.tenantId, state: this.state });
        return;
      }
      this.diagnostics.fail("REALTIME_ERROR_EVENT", event.error?.code ?? "OPENAI_REALTIME_ERROR", { error_type: event.error?.type, error_code: event.error?.code, error_message: event.error?.message });
      log("error", "realtime_sideband_error_event", { call_id: this.callId, tenant_id: this.tenantId, state: this.state, error_type: event.error?.type, error_code: event.error?.code, error_message: event.error?.message });
      return;
    }

    if (event.type === "response.function_call_arguments.done" && event.name === "conversation_intent") {
      if (this.state === "closing" || this.hangupStarted) {
        this.sendToolResult(event.call_id, { ok: true, action: "closing_already_in_progress" });
        return;
      }

      const classification = parseSemanticDecision(event.arguments);
      if (classification.degraded) {
        this.diagnostics.fail("INTENT_CLASSIFIER_DEGRADED", "SEMANTIC_CLASSIFIER_FALLBACK_USED", { fallback_intent: classification.intent, fallback_data_requirement: classification.dataRequirement });
        log("error", "call_intent_degraded_fallback", {
          call_id: this.callId,
          tenant_id: this.tenantId,
          arguments_chars: event.arguments?.length ?? 0,
          fallback_intent: classification.intent,
          fallback_data_requirement: classification.dataRequirement,
          reason: classification.reason,
        });
      } else {
        this.diagnostics.checkpoint("INTENT_CLASSIFIED", { intent: classification.intent, data_requirement: classification.dataRequirement });
      }

      log("info", "call_intent_classified", {
        call_id: this.callId,
        tenant_id: this.tenantId,
        intent: classification.intent,
        data_requirement: classification.dataRequirement,
        reason: classification.reason,
        degraded: classification.degraded,
        state_before: this.state,
        ambiguous_count_before: this.ambiguousCount,
      });
      if (classification.intent === "CONTINUE") {
        this.continueConversation(classification.reason, classification.dataRequirement, event.call_id);
        return;
      }
      if (classification.intent === "END_CLEAR") {
        this.handleClearEndIntent(classification.reason, event.call_id);
        return;
      }
      this.handleAmbiguousIntent(classification.reason, event.call_id);
      return;
    }

    if (event.type === "response.function_call_arguments.done" && event.name && event.name !== "conversation_intent") {
      if (this.state === "closing" || this.hangupStarted) {
        this.sendToolResult(event.call_id, { ok: false, error: "CALL_CLOSING" });
        return;
      }
      await this.handleBusinessToolCall(event);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      this.diagnostics.checkpoint("USER_TURN_RECEIVED", { transcript_chars: event.transcript.length });
      log("info", "call_user_transcription_observed", { call_id: this.callId, tenant_id: this.tenantId, state: this.state, ambiguous_count: this.ambiguousCount, transcript_chars: event.transcript.length });
      return;
    }

    if (event.type === "input_audio_buffer.timeout_triggered") {
      if (this.state === "ambiguous") this.beginClosing("ambiguous_silence_timeout", "idle_timeout");
      return;
    }

    if (event.type === "response.output_audio_transcript.done" && event.transcript) {
      if (this.state !== "closing" && isAssistantHangupCommitment(event.transcript)) {
        this.diagnostics.fail("ASSISTANT_HANGUP_COMMITMENT", "ASSISTANT_HANGUP_COMMITMENT_OUTSIDE_CLOSE", { transcript_chars: event.transcript.length });
        log("error", "end_call_assistant_commitment_without_core_close", { call_id: this.callId, tenant_id: this.tenantId, state: this.state, transcript_chars: event.transcript.length });
        this.armHangupAfterCurrentAudio("assistant_announced_hangup", "assistant_commitment_guard");
      }
      return;
    }

    if (event.type === "response.created") {
      const responseId = event.response_id ?? event.response?.id ?? null;
      if (this.pendingExternalRequirement && this.waitingPhraseStarted && !this.waitingResponseId && responseId) {
        this.waitingResponseId = responseId;
        this.diagnostics.checkpoint("WAITING_PHRASE_RESPONSE_CREATED", { data_requirement: this.pendingExternalRequirement });
        log("info", "business_data_waiting_response_created", {
          call_id: this.callId,
          tenant_id: this.tenantId,
          response_id: responseId,
          data_requirement: this.pendingExternalRequirement,
        });
        return;
      }
      if (this.state === "closing" && !this.closingResponseId) {
        this.closingResponseId = responseId;
        return;
      }
    }

    if (event.type === "response.done" && this.pendingExternalRequirement) {
      const requirement = this.pendingExternalRequirement;
      const responseId = event.response_id ?? event.response?.id ?? null;

      if (!this.externalResponseGateOpen) {
        this.diagnostics.checkpoint("CLASSIFIER_RESPONSE_COMPLETED", { data_requirement: requirement, backend_result_ready: this.pendingExternalResult !== null });
        log("info", "business_data_classifier_response_completed", {
          call_id: this.callId,
          tenant_id: this.tenantId,
          data_requirement: requirement,
          response_id: responseId,
          backend_result_ready: this.pendingExternalResult !== null,
        });
        this.startWaitingPhrase(requirement);
        return;
      }

      if (this.waitingPhraseStarted && (!this.waitingResponseId || !responseId || responseId === this.waitingResponseId)) {
        this.diagnostics.checkpoint("WAITING_PHRASE_GENERATED", { data_requirement: requirement, backend_result_ready: this.pendingExternalResult !== null });
        log("info", "business_data_waiting_phrase_generated", {
          call_id: this.callId,
          tenant_id: this.tenantId,
          data_requirement: requirement,
          response_id: responseId,
          backend_result_ready: this.pendingExternalResult !== null,
          expected_next: "output_audio_buffer.stopped_or_watchdog",
        });
        return;
      }
    }

    if (event.type === "output_audio_buffer.stopped" && this.pendingExternalRequirement && this.waitingPhraseStarted) {
      if (!this.waitingResponseId || !event.response_id || event.response_id === this.waitingResponseId) {
        this.markWaitingPhrasePlaybackComplete("output_audio_buffer.stopped");
        return;
      }
    }

    if (this.state === "closing" && event.type === "output_audio_buffer.stopped") {
      if (!this.closingResponseId || event.response_id === this.closingResponseId) await this.performHangup("output_audio_buffer_stopped");
    }
  }
}
