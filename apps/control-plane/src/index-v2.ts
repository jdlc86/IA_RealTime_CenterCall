import OpenAI from "openai";
import {
  KvTenantRepository,
  type TenantConfigurationV1,
  type TenantKvNamespace,
  type TenantResolutionV1,
} from "./tenant-kv";
export { CallSession } from "./call-session";

type WorkerEnv = {
  ENVIRONMENT: string;
  TENANT_CONFIG: TenantKvNamespace;
  REALTIME_MODEL: string;
  REALTIME_VOICE: string;
  OPENAI_PROJECT_ID: string;
  OPENAI_API_KEY: string;
  OPENAI_WEBHOOK_SECRET: string;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  CALL_SESSIONS: DurableObjectNamespace;
};

type RealtimeIncomingCallEvent = {
  id: string;
  type: "realtime.call.incoming";
  created_at: number;
  data: { call_id: string; sip_headers?: Array<{ name: string; value: string }> };
};

type TelnyxVoiceEvent = {
  data?: {
    id?: string;
    event_type?: string;
    payload?: {
      call_control_id?: string;
      call_leg_id?: string;
      call_session_id?: string;
      connection_id?: string;
      direction?: string;
      state?: string;
      from?: string;
      to?: string;
      hangup_cause?: string;
      hangup_source?: string;
    };
  };
  meta?: { attempt?: number };
};

type RealtimeFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type RealtimeSessionConfiguration = {
  type: "realtime";
  model: string;
  instructions: string;
  output_modalities: ["audio"];
  audio: {
    input: {
      format: { type: "audio/pcmu" };
      transcription: { model: "gpt-4o-mini-transcribe"; language: "es" };
      turn_detection: {
        type: "server_vad";
        create_response: true;
        interrupt_response: true;
        threshold: number;
        prefix_padding_ms: number;
        silence_duration_ms: number;
        idle_timeout_ms: number;
      };
    };
    output: { format: { type: "audio/pcmu" }; voice: string };
  };
  tools: RealtimeFunctionTool[];
  tool_choice: "required";
};

const IDLE_TIMEOUT_MS = 10_000;
const AMBIGUOUS_LIMIT = 3;
const TENANT_HEADER = "x-ia-tenant-id";
const CALLED_NUMBER_HEADER = "x-ia-called-number";
const ROUTING_SOURCE_HEADER = "x-ia-routing-source";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ level, event, ...details });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

function requireEnvString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function getTenantRepository(env: WorkerEnv): KvTenantRepository {
  if (!env.TENANT_CONFIG || typeof env.TENANT_CONFIG.get !== "function") throw new Error("Missing runtime configuration: TENANT_CONFIG");
  return new KvTenantRepository(env.TENANT_CONFIG);
}

function getSipHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  const normalized = name.toLowerCase();
  return headers?.find((item) => item.name.toLowerCase() === normalized)?.value?.trim() || null;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeTelnyxPublicKey(value: string): { format: "raw" | "spki"; bytes: Uint8Array } {
  const trimmed = requireEnvString(value, "TELNYX_PUBLIC_KEY");
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    const base64 = trimmed.replace(/-----BEGIN PUBLIC KEY-----/g, "").replace(/-----END PUBLIC KEY-----/g, "").replace(/\s+/g, "");
    return { format: "spki", bytes: decodeBase64(base64) };
  }
  const bytes = decodeBase64(trimmed);
  return bytes.byteLength === 32 ? { format: "raw", bytes } : { format: "spki", bytes };
}

async function verifyTelnyxSignature(rawBody: string, signatureBase64: string, timestamp: string, publicKeyValue: string): Promise<boolean> {
  const decoded = decodeTelnyxPublicKey(publicKeyValue);
  const key = await crypto.subtle.importKey(decoded.format, decoded.bytes, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, decodeBase64(signatureBase64), new TextEncoder().encode(`${timestamp}|${rawBody}`));
}

async function verifyAndParseTelnyxWebhook(rawBody: string, request: Request, env: WorkerEnv): Promise<TelnyxVoiceEvent> {
  const signature = request.headers.get("telnyx-signature-ed25519");
  const timestamp = request.headers.get("telnyx-timestamp");
  if (!signature || !timestamp) throw new Error("Missing Telnyx signature headers");
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) throw new Error("Invalid Telnyx timestamp");
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300) throw new Error("Telnyx webhook timestamp outside 5 minute tolerance");
  const valid = await verifyTelnyxSignature(rawBody, signature, timestamp, requireEnvString(env.TELNYX_PUBLIC_KEY, "TELNYX_PUBLIC_KEY"));
  if (!valid) throw new Error("Telnyx Ed25519 signature verification failed");
  return JSON.parse(rawBody) as TelnyxVoiceEvent;
}

function buildOpenAISipUri(env: WorkerEnv): string {
  return `sip:${requireEnvString(env.OPENAI_PROJECT_ID, "OPENAI_PROJECT_ID")}@sip.api.openai.com;transport=tls`;
}

async function transferTelnyxCallToOpenAI(callControlId: string, eventId: string, resolution: TenantResolutionV1, env: WorkerEnv): Promise<void> {
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: buildOpenAISipUri(env),
      sip_transport_protocol: "TLS",
      timeout_secs: 30,
      command_id: eventId,
      custom_headers: [
        { name: "X-IA-Tenant-ID", value: resolution.tenantId },
        { name: "X-IA-Called-Number", value: resolution.calledNumber },
        { name: "X-IA-Routing-Source", value: resolution.source },
      ],
    }),
  });
  const body = await response.text();
  log(response.ok ? "info" : "error", "telnyx_transfer_response", { call_control_id: callControlId, tenant_id: resolution.tenantId, status: response.status, response: body.slice(0, 1000) });
  if (!response.ok) throw new Error(`Telnyx transfer failed with HTTP ${response.status}`);
}

async function rejectTelnyxCall(callControlId: string, eventId: string, env: WorkerEnv): Promise<void> {
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/reject`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cause: "CALL_REJECTED", command_id: eventId }),
  });
  if (!response.ok) throw new Error(`Telnyx reject failed with HTTP ${response.status}`);
}

async function handleTelnyxWebhook(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await request.text();
  let event: TelnyxVoiceEvent;
  try {
    event = await verifyAndParseTelnyxWebhook(rawBody, request, env);
  } catch (error) {
    log("error", "invalid_telnyx_webhook", { error: error instanceof Error ? error.message : String(error) });
    return json({ ok: false, error: "invalid_webhook_signature" }, 403);
  }
  const eventType = event.data?.event_type ?? "unknown";
  const eventId = event.data?.id ?? crypto.randomUUID();
  const payload = event.data?.payload;
  if (eventType === "call.initiated" && payload?.direction === "incoming") {
    const callControlId = payload.call_control_id;
    const calledNumber = payload.to?.trim();
    if (!callControlId) return json({ ok: false, error: "missing_call_control_id" }, 400);
    if (!calledNumber) return json({ ok: false, error: "missing_called_number" }, 400);

    let resolution: TenantResolutionV1 | null = null;
    let tenantConfig: TenantConfigurationV1 | null = null;
    try {
      const repository = getTenantRepository(env);
      resolution = await repository.resolveByCalledNumber(calledNumber);
      if (resolution) tenantConfig = await repository.getTenantConfiguration(resolution.tenantId);
    } catch (error) {
      log("error", "tenant_resolution_failed", { called_number: calledNumber, error: error instanceof Error ? error.message : String(error) });
      return json({ ok: false, error: "tenant_kv_configuration_invalid" }, 500);
    }

    if (!resolution || !tenantConfig) {
      ctx.waitUntil(rejectTelnyxCall(callControlId, eventId, env).catch((error) => log("error", "call_orchestrator_reject_failed", { error: error instanceof Error ? error.message : String(error) })));
      return json({ ok: true, accepted: false, action: "reject_unroutable", called_number: calledNumber });
    }

    ctx.waitUntil(transferTelnyxCallToOpenAI(callControlId, eventId, resolution, env).catch((error) => log("error", "call_orchestrator_failed", { tenant_id: resolution!.tenantId, error: error instanceof Error ? error.message : String(error) })));
    return json({ ok: true, accepted: true, action: "transfer_to_realtime", tenant_id: resolution.tenantId, called_number: resolution.calledNumber, business_name: tenantConfig.business.displayName, allowed_tools: tenantConfig.tools.allowed, tenant_config_source: "kv" });
  }
  return json({ ok: true, ignored: true, event_type: eventType });
}

function buildRealtimeSessionConfiguration(env: WorkerEnv, tenantConfig: TenantConfigurationV1): RealtimeSessionConfiguration {
  const vad = tenantConfig.realtime.vad ?? {};
  const instructions = [
    `Atiendes llamadas para ${tenantConfig.business.displayName}.`,
    `Tu nombre de asistente es ${tenantConfig.assistant.name}.`,
    "Habla en español de forma amable, natural, breve y profesional.",
    "Antes de responder a CADA turno real del usuario invoca exactamente una vez conversation_intent.",
    "conversation_intent debe clasificar tanto la intención de cierre como si la respuesta necesita datos empresariales verificables.",
    "data_requirement=NONE cuando el turno puede responderse sin consultar hechos específicos del negocio.",
    "data_requirement=BUSINESS_INFO para identidad, antigüedad u otros hechos generales del negocio almacenados en su configuración. También úsalo temporalmente para disponibilidad u otros datos empresariales aún sin una tool especializada, de modo que el sistema responda de forma fail-closed si no están disponibles.",
    "data_requirement=SERVICES para cualquier consulta sobre tratamientos, servicios, procedimientos, terapias, catálogo, qué ofrece el negocio, disponibilidad de un tratamiento concreto, precios, costes o duración.",
    "REGLA OBLIGATORIA: si el usuario pregunta qué tratamientos/servicios/procedimientos/terapias se ofrecen, aunque no mencione precio ni un tratamiento concreto, usa siempre data_requirement=SERVICES. Nunca clasifiques esas preguntas como NONE ni BUSINESS_INFO.",
    "Ejemplos obligatorios de SERVICES: '¿Qué tratamientos tenéis?', '¿Qué servicios ofrecéis?', '¿Qué me puedo hacer allí?', '¿Tenéis botox?', '¿Cuánto cuesta el botox?', '¿Cuánto dura ese tratamiento?'.",
    "data_requirement=PROFESSIONALS para profesionales, especialistas, médicos o personal que presta servicios.",
    "data_requirement=HOURS para horarios de apertura o cierre.",
    "No inventes información empresarial. CallSession decidirá si debe consultar una fuente autorizada y qué herramienta exacta utilizar.",
    "Usa CONTINUE cuando el usuario quiere seguir conversando o formula una consulta.",
    "Usa END_CLEAR cuando la intención de finalizar la llamada es clara.",
    "Usa END_AMBIGUOUS cuando parece estar terminando pero el contexto no permite afirmarlo con suficiente seguridad.",
    "No anuncies por tu cuenta que vas a colgar; CallSession controla el cierre y hangup.",
    "Después de conversation_intent espera el resultado de la herramienta.",
    ...(tenantConfig.assistant.systemPrompt ? [tenantConfig.assistant.systemPrompt] : tenantConfig.assistant.instructions ? [tenantConfig.assistant.instructions] : []),
  ].join("\n");

  return {
    type: "realtime",
    model: requireEnvString(env.REALTIME_MODEL, "REALTIME_MODEL"),
    instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        transcription: { model: "gpt-4o-mini-transcribe", language: "es" },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          threshold: vad.threshold ?? 0.5,
          prefix_padding_ms: vad.prefixPaddingMs ?? 300,
          silence_duration_ms: vad.silenceDurationMs ?? 500,
          idle_timeout_ms: vad.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
        },
      },
      output: { format: { type: "audio/pcmu" }, voice: tenantConfig.realtime.voice ?? requireEnvString(env.REALTIME_VOICE, "REALTIME_VOICE") },
    },
    tools: [{
      type: "function",
      name: "conversation_intent",
      description: "Clasifica semánticamente la intención de conversación y el dominio de datos empresariales requerido usando el contexto completo. Toda consulta sobre tratamientos, servicios, procedimientos, terapias, catálogo, oferta, disponibilidad de tratamientos, precios o duración debe clasificarse como SERVICES.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["CONTINUE", "END_AMBIGUOUS", "END_CLEAR"] },
          data_requirement: { type: "string", enum: ["NONE", "BUSINESS_INFO", "SERVICES", "PROFESSIONALS", "HOURS"], description: "Dominio de datos verificables requerido. Usa SERVICES obligatoriamente para tratamientos, servicios, procedimientos, terapias, catálogo/oferta, disponibilidad de tratamientos, precios, costes o duración. Para END_CLEAR/END_AMBIGUOUS usa NONE." },
          reason: { type: "string", description: "Explicación breve basada en el contexto conversacional. Si eliges SERVICES, menciona brevemente el concepto detectado (tratamiento, servicio, catálogo, precio, duración, etc.) para permitir validación fail-safe." },
        },
        required: ["intent", "data_requirement", "reason"],
        additionalProperties: false,
      },
    }],
    tool_choice: "required",
  };
}

async function acceptRealtimeCall(callId: string, configuration: RealtimeSessionConfiguration, env: WorkerEnv): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireEnvString(env.OPENAI_API_KEY, "OPENAI_API_KEY")}`, "Content-Type": "application/json", "X-Client-Request-Id": crypto.randomUUID() },
      body: JSON.stringify(configuration),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function startCallSession(callId: string, tenantConfig: TenantConfigurationV1, env: WorkerEnv): Promise<void> {
  const id = env.CALL_SESSIONS.idFromName(callId);
  const stub = env.CALL_SESSIONS.get(id);
  const response = await stub.fetch("https://call-session.internal/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call_id: callId,
      tenant_id: tenantConfig.tenantId,
      business_name: tenantConfig.business.displayName,
      assistant_name: tenantConfig.assistant.name,
      initial_greeting: tenantConfig.assistant.greeting,
      allowed_tools: tenantConfig.tools.allowed,
      business_facts: tenantConfig.business.facts,
    }),
  });
  if (!response.ok) throw new Error(`CallSession start failed with HTTP ${response.status}`);
}

async function handleOpenAIWebhook(request: Request, env: WorkerEnv): Promise<Response> {
  const rawBody = await request.text();
  const client = new OpenAI({ apiKey: requireEnvString(env.OPENAI_API_KEY, "OPENAI_API_KEY"), webhookSecret: requireEnvString(env.OPENAI_WEBHOOK_SECRET, "OPENAI_WEBHOOK_SECRET") });
  let event: unknown;
  try {
    event = await client.webhooks.unwrap(rawBody, request.headers);
  } catch (error) {
    log("error", "invalid_openai_webhook", { error: error instanceof Error ? error.message : String(error) });
    return json({ ok: false, error: "invalid_webhook_signature" }, 400);
  }

  const typedEvent = event as { type?: string };
  if (typedEvent.type !== "realtime.call.incoming") return json({ ok: true, ignored: true, event_type: typedEvent.type ?? "unknown" });
  const incoming = event as RealtimeIncomingCallEvent;
  const callId = incoming.data?.call_id;
  if (!callId) return json({ ok: false, error: "missing_call_id" }, 400);

  const tenantId = getSipHeader(incoming.data.sip_headers, TENANT_HEADER);
  const calledNumber = getSipHeader(incoming.data.sip_headers, CALLED_NUMBER_HEADER);
  const routingSource = getSipHeader(incoming.data.sip_headers, ROUTING_SOURCE_HEADER);
  if (!tenantId || !calledNumber || routingSource !== "called_number") return json({ ok: false, error: "tenant_binding_missing" }, 409);

  let tenantConfig: TenantConfigurationV1 | null = null;
  try {
    const repository = getTenantRepository(env);
    const resolution = await repository.resolveByCalledNumber(calledNumber);
    if (!resolution || resolution.tenantId !== tenantId) return json({ ok: false, error: "tenant_binding_mismatch" }, 409);
    tenantConfig = await repository.getTenantConfiguration(tenantId);
  } catch (error) {
    log("error", "call_bootstrap_tenant_configuration_invalid", { call_id: callId, tenant_id: tenantId, error: error instanceof Error ? error.message : String(error) });
    return json({ ok: false, error: "tenant_kv_configuration_invalid" }, 500);
  }
  if (!tenantConfig) return json({ ok: false, error: "tenant_configuration_missing" }, 409);

  const configuration = buildRealtimeSessionConfiguration(env, tenantConfig);
  let openAIResponse: Response;
  try {
    openAIResponse = await acceptRealtimeCall(callId, configuration, env);
  } catch (error) {
    log("error", "realtime_accept_exception", { call_id: callId, tenant_id: tenantId, error: error instanceof Error ? error.message : String(error) });
    return json({ ok: false, error: "accept_exception" }, 502);
  }
  const responseBody = await openAIResponse.text();
  if (!openAIResponse.ok) {
    log("error", "realtime_accept_result", { call_id: callId, tenant_id: tenantId, status: openAIResponse.status, body: responseBody.slice(0, 1000) });
    return json({ ok: false, error: "openai_accept_failed", status: openAIResponse.status }, 502);
  }

  let callSessionStarted = false;
  try {
    await startCallSession(callId, tenantConfig, env);
    callSessionStarted = true;
  } catch (error) {
    log("error", "call_session_start_failed", { call_id: callId, tenant_id: tenantId, error: error instanceof Error ? error.message : String(error) });
  }

  return json({
    ok: true,
    call_id: callId,
    tenant_id: tenantId,
    called_number: calledNumber,
    business_name: tenantConfig.business.displayName,
    assistant_name: tenantConfig.assistant.name,
    allowed_tools: tenantConfig.tools.allowed,
    tenant_config_source: "kv",
    business_data_provider: "supabase",
    semantic_data_router: true,
    call_session_started: callSessionStarted,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "IA_RealTime_CenterCall",
        phase: "F5",
        environment: env.ENVIRONMENT,
        tenant_resolver: "KvTenantRepository",
        tenant_config_source: "kv",
        tenant_fail_closed: true,
        tool_gateway: true,
        tool_gateway_policy: "tenant_allowlist_fail_closed",
        business_data_provider: "supabase",
        semantic_data_router: "conversation_intent_v11_services_strict",
        data_requirements: ["NONE", "BUSINESS_INFO", "SERVICES", "PROFESSIONALS", "HOURS"],
        supabase_tenant_scope: "server_imposed",
        intent_values: ["CONTINUE", "END_AMBIGUOUS", "END_CLEAR"],
        ambiguous_limit: AMBIGUOUS_LIMIT,
        runtime_config: {
          tenant_config_binding: Boolean(env.TENANT_CONFIG && typeof env.TENANT_CONFIG.get === "function"),
          supabase_url: typeof env.SUPABASE_URL === "string" && env.SUPABASE_URL.length > 0,
          supabase_secret_key: typeof env.SUPABASE_SECRET_KEY === "string" && env.SUPABASE_SECRET_KEY.length > 0,
          openai_api_key: typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0,
          openai_webhook_secret: typeof env.OPENAI_WEBHOOK_SECRET === "string" && env.OPENAI_WEBHOOK_SECRET.length > 0,
          telnyx_api_key: typeof env.TELNYX_API_KEY === "string" && env.TELNYX_API_KEY.length > 0,
          telnyx_public_key: typeof env.TELNYX_PUBLIC_KEY === "string" && env.TELNYX_PUBLIC_KEY.length > 0,
          call_sessions_binding: typeof env.CALL_SESSIONS === "object" && env.CALL_SESSIONS !== null,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/webhooks/telnyx") return handleTelnyxWebhook(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/webhooks/openai") return handleOpenAIWebhook(request, env);
    return json({ ok: false, error: "not_found" }, 404);
  },
} satisfies ExportedHandler<WorkerEnv>;
