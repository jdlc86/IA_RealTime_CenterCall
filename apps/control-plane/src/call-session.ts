import { DurableObject } from "cloudflare:workers";
import { SupabaseAdapter } from "./supabase-adapter";
import { ToolGateway, requireObject, type ToolDefinition, type ToolResult } from "./tool-gateway";

type CallSessionEnv = {
  OPENAI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
};

type SemanticIntent = "CONTINUE" | "END_AMBIGUOUS" | "END_CLEAR";
type DataRequirement = "NONE" | "BUSINESS_INFO" | "SERVICES" | "PROFESSIONALS" | "HOURS";
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
const HANGUP_RETRY_DELAY_MS = 300;
const HANGUP_MAX_ATTEMPTS = 2;

const GET_BUSINESS_INFORMATION = "get_business_information";
const GET_SERVICES = "get_services";
const GET_PROFESSIONALS = "get_professionals";
const GET_BUSINESS_HOURS = "get_business_hours";

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

const TOOL_BY_REQUIREMENT: Partial<Record<DataRequirement, RealtimeFunctionTool>> = {
  BUSINESS_INFO: BUSINESS_INFORMATION_REALTIME_TOOL,
  SERVICES: SERVICES_REALTIME_TOOL,
  PROFESSIONALS: PROFESSIONALS_REALTIME_TOOL,
  HOURS: BUSINESS_HOURS_REALTIME_TOOL,
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

function parseSemanticIntent(argumentsJson: string | undefined): {
  intent: SemanticIntent;
  dataRequirement: DataRequirement;
  reason: string;
} | null {
  if (!argumentsJson) return null;
  try {
    const parsed = JSON.parse(argumentsJson) as { intent?: unknown; data_requirement?: unknown; reason?: unknown };
    if (parsed.intent !== "CONTINUE" && parsed.intent !== "END_AMBIGUOUS" && parsed.intent !== "END_CLEAR") return null;
    const validRequirements: DataRequirement[] = ["NONE", "BUSINESS_INFO", "SERVICES", "PROFESSIONALS", "HOURS"];
    const dataRequirement = validRequirements.includes(parsed.data_requirement as DataRequirement)
      ? (parsed.data_requirement as DataRequirement)
      : parsed.intent === "CONTINUE"
        ? "BUSINESS_INFO"
        : "NONE";
    const reason = typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 300)
      : "semantic_intent_classifier";
    return { intent: parsed.intent, dataRequirement, reason };
  } catch {
    return null;
  }
}

function emptyObjectValidator(value: unknown): Record<string, never> {
  const object = requireObject(value);
  if (Object.keys(object).length > 0) throw new Error("This tool does not accept arguments");
  return {};
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
  private greetingSent = false;
  private state: ClosingState = "active";
  private ambiguousCount = 0;
  private closingReason = "user_requested_end";
  private hangupStarted = false;
  private closingResponseId: string | null = null;
  private finalFarewellWatchdog: ReturnType<typeof setTimeout> | null = null;

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
        greeting_sent: this.greetingSent,
        state: this.state,
        ambiguous_count: this.ambiguousCount,
        sideband: "durable_object",
        intent_policy: "semantic_v10_data_router",
        tool_gateway: "tenant_allowlist_v2",
        business_data_provider: "supabase",
        tenant_config_source: "bootstrap",
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
        greeting_sent: this.greetingSent,
        state: this.state,
        ambiguous_count: this.ambiguousCount,
        ambiguous_limit: AMBIGUOUS_LIMIT,
        websocket_connected: this.socket !== null,
        hangup_started: this.hangupStarted,
        tool_gateway: "tenant_allowlist_v2",
        business_data_provider: "supabase",
      });
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
      throw new Error(`Realtime sideband upgrade failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    }
    socket.accept();
    this.socket = socket;
    log("info", "realtime_sideband_connected", {
      call_id: callId,
      tenant_id: this.tenantId,
      elapsed_ms: Date.now() - startedAt,
      lifecycle: "durable_object_outbound_websocket",
      intent_policy: "semantic_v10_data_router",
      allowed_tools: this.allowedTools,
    });
    socket.addEventListener("message", (event) => { void this.handleRealtimeMessage(event.data); });
    socket.addEventListener("close", () => {
      this.clearFinalFarewellWatchdog();
      this.socket = null;
      log("info", "realtime_sideband_closed", { call_id: this.callId, tenant_id: this.tenantId, state: this.state, ambiguous_count: this.ambiguousCount, hangup_started: this.hangupStarted });
    });
    socket.addEventListener("error", () => {
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

  private sendToolResult(callId: string | undefined, payload: Record<string, unknown> | ToolResult): void {
    if (!callId) return;
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(payload) } });
  }

  private createSpokenResponse(instructions: string): void {
    this.send({ type: "response.create", response: { tool_choice: "none", instructions } });
  }

  private createResponseForRequirement(requirement: DataRequirement): void {
    if (requirement === "NONE") {
      this.createSpokenResponse(
        "Continúa la conversación de forma breve, natural y útil. No introduzcas datos concretos del negocio que no estén ya verificados en la conversación.",
      );
      return;
    }

    const tool = TOOL_BY_REQUIREMENT[requirement];
    if (!tool || !this.allowedTools.includes(tool.name)) {
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
        instructions: `Consulta obligatoriamente ${tool.name} antes de responder. No generes una respuesta textual hasta recibir el resultado de la herramienta.`,
      },
    });
    log("info", "business_data_tool_forced", {
      call_id: this.callId,
      tenant_id: this.tenantId,
      data_requirement: requirement,
      tool: tool.name,
      grounding_policy: "domain_forced_v2",
    });
  }

  private getSupabaseAdapter(): SupabaseAdapter {
    return new SupabaseAdapter({
      SUPABASE_URL: requireEnvString(this.env.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireEnvString(this.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
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
    ];
    return new ToolGateway(definitions, [{ tenantId: this.tenantId, allowedTools: this.allowedTools }]);
  }

  private async handleBusinessToolCall(event: RealtimeSidebandEvent): Promise<void> {
    if (!this.tenantId || !this.callId || !event.name) return;
    let args: unknown;
    try {
      args = parseJsonArguments(event.arguments);
    } catch {
      this.sendToolResult(event.call_id, { ok: false, tool: event.name, tenantId: this.tenantId, error: "INVALID_ARGUMENTS", message: "Tool arguments must be valid JSON" });
      this.createSpokenResponse("No pude consultar una fuente autorizada. Indica que no dispones del dato verificado; no inventes información.");
      return;
    }

    const result = await this.createToolGateway().execute({ name: event.name, arguments: args, context: { tenantId: this.tenantId, callId: this.callId } });
    this.sendToolResult(event.call_id, result);
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
        "Responde usando exclusivamente los hechos que aparezcan explícitamente en el resultado autorizado de la herramienta. Si el dato pedido no figura o la lista está vacía, indica que no dispones de ese dato verificado. No estimes, deduzcas, completes ni inventes. No menciones Supabase, ToolGateway, JSON ni procesos internos.",
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
    log("info", "call_intent_ambiguous", { call_id: this.callId, tenant_id: this.tenantId, reason, ambiguous_count: this.ambiguousCount, ambiguous_limit: AMBIGUOUS_LIMIT });
    if (this.ambiguousCount >= AMBIGUOUS_LIMIT) {
      this.beginClosing("ambiguous_limit_reached", "semantic_intent");
      return;
    }
    this.createSpokenResponse("La intención de terminar es ambigua. Pregunta una sola vez y de forma natural si puedes ayudar en algo más. Después espera. No te despidas todavía.");
  }

  private handleClearEndIntent(reason: string, toolCallId?: string): void {
    this.sendToolResult(toolCallId, { ok: true, action: "close", ambiguous_count: this.ambiguousCount });
    log("info", "call_intent_end_clear", { call_id: this.callId, tenant_id: this.tenantId, reason, ambiguous_count: this.ambiguousCount });
    this.beginClosing("semantic_end_clear", "semantic_intent");
  }

  private beginClosing(reason: string, source: string): void {
    if (this.state === "closing" || this.hangupStarted) return;
    this.state = "closing";
    this.closingReason = reason;
    this.closingResponseId = null;
    log("info", "end_call_closing_started", { call_id: this.callId, tenant_id: this.tenantId, source, reason, ambiguous_count: this.ambiguousCount });
    this.sendBestEffortCancel();
    this.createSpokenResponse("Despídete ahora con una sola frase muy breve, natural y amable en español. No preguntes nada más ni ofrezcas más ayuda. Esta es la despedida final.");
    this.clearFinalFarewellWatchdog();
    this.finalFarewellWatchdog = setTimeout(() => { void this.performHangup("final_farewell_watchdog"); }, FINAL_FAREWELL_WATCHDOG_MS);
  }

  private armHangupAfterCurrentAudio(reason: string, source: string): void {
    if (this.state === "closing" || this.hangupStarted) return;
    this.state = "closing";
    this.closingReason = reason;
    this.closingResponseId = null;
    log("info", "end_call_closing_armed_current_audio", { call_id: this.callId, tenant_id: this.tenantId, source, reason, ambiguous_count: this.ambiguousCount });
    this.clearFinalFarewellWatchdog();
    this.finalFarewellWatchdog = setTimeout(() => { void this.performHangup("assistant_commitment_watchdog"); }, FINAL_FAREWELL_WATCHDOG_MS);
  }

  private async performHangup(trigger: string): Promise<void> {
    if (this.hangupStarted || !this.callId) return;
    this.hangupStarted = true;
    this.clearFinalFarewellWatchdog();
    log("info", "end_call_hangup_triggered", { call_id: this.callId, tenant_id: this.tenantId, trigger, state: this.state, ambiguous_count: this.ambiguousCount, closing_response_id: this.closingResponseId });
    let lastError: unknown;
    for (let attempt = 1; attempt <= HANGUP_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.hangupOpenAICall(this.callId, this.closingReason, attempt);
        return;
      } catch (error) {
        lastError = error;
        log("error", "end_call_hangup_attempt_failed", { call_id: this.callId, tenant_id: this.tenantId, trigger, attempt, error: error instanceof Error ? error.message : String(error) });
        if (attempt < HANGUP_MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, HANGUP_RETRY_DELAY_MS));
      }
    }
    this.hangupStarted = false;
    this.state = "active";
    this.ambiguousCount = 0;
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
      log("error", "realtime_sideband_invalid_json", { call_id: this.callId, tenant_id: this.tenantId });
      return;
    }

    if (event.type === "error") {
      if (event.error?.code === "response_cancel_not_active") {
        log("info", "realtime_sideband_cancel_noop", { call_id: this.callId, tenant_id: this.tenantId, state: this.state });
        return;
      }
      log("error", "realtime_sideband_error_event", { call_id: this.callId, tenant_id: this.tenantId, state: this.state, error_type: event.error?.type, error_code: event.error?.code, error_message: event.error?.message });
      return;
    }

    if (event.type === "response.function_call_arguments.done" && event.name === "conversation_intent") {
      if (this.state === "closing" || this.hangupStarted) {
        this.sendToolResult(event.call_id, { ok: true, action: "closing_already_in_progress" });
        return;
      }
      const classification = parseSemanticIntent(event.arguments);
      if (!classification) {
        log("error", "call_intent_invalid_arguments", { call_id: this.callId, tenant_id: this.tenantId, arguments_chars: event.arguments?.length ?? 0 });
        this.sendToolResult(event.call_id, { ok: false, error: "invalid_intent_arguments" });
        this.continueConversation("invalid_classifier_output", "BUSINESS_INFO");
        return;
      }
      log("info", "call_intent_classified", {
        call_id: this.callId,
        tenant_id: this.tenantId,
        intent: classification.intent,
        data_requirement: classification.dataRequirement,
        reason: classification.reason,
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
      log("info", "call_user_transcription_observed", { call_id: this.callId, tenant_id: this.tenantId, state: this.state, ambiguous_count: this.ambiguousCount, transcript_chars: event.transcript.length });
      return;
    }

    if (event.type === "input_audio_buffer.timeout_triggered") {
      if (this.state === "ambiguous") this.beginClosing("ambiguous_silence_timeout", "idle_timeout");
      return;
    }

    if (event.type === "response.output_audio_transcript.done" && event.transcript) {
      if (this.state !== "closing" && isAssistantHangupCommitment(event.transcript)) {
        log("error", "end_call_assistant_commitment_without_core_close", { call_id: this.callId, tenant_id: this.tenantId, state: this.state, transcript_chars: event.transcript.length });
        this.armHangupAfterCurrentAudio("assistant_announced_hangup", "assistant_commitment_guard");
      }
      return;
    }

    if (this.state === "closing" && event.type === "response.created" && !this.closingResponseId) {
      this.closingResponseId = event.response_id ?? event.response?.id ?? null;
      return;
    }

    if (this.state === "closing" && event.type === "output_audio_buffer.stopped") {
      if (!this.closingResponseId || event.response_id === this.closingResponseId) await this.performHangup("output_audio_buffer_stopped");
    }
  }
}
