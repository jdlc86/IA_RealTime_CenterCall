import OpenAI from "openai";
import { StaticTenantResolver, parseTenantRoutesJson, type TenantResolution } from "./tenant-resolver";
import { getTenantConfiguration, type TenantConfiguration } from "./tenant-configuration";
export { CallSession } from "./call-session";

type WorkerEnv = {
  ENVIRONMENT: string;
  DEFAULT_TENANT_ID?: string;
  TENANT_ROUTES_JSON: string;
  REALTIME_MODEL: string;
  REALTIME_VOICE: string;
  OPENAI_PROJECT_ID: string;
  OPENAI_API_KEY: string;
  OPENAI_WEBHOOK_SECRET: string;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  CALL_SESSIONS: DurableObjectNamespace;
};

type RealtimeIncomingCallEvent = {
  id: string;
  type: "realtime.call.incoming";
  created_at: number;
  data: {
    call_id: string;
    sip_headers?: Array<{ name: string; value: string }>;
  };
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
    output: {
      format: { type: "audio/pcmu" };
      voice: string;
    };
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

function getTenantResolver(env: WorkerEnv): StaticTenantResolver {
  return new StaticTenantResolver(parseTenantRoutesJson(requireEnvString(env.TENANT_ROUTES_JSON, "TENANT_ROUTES_JSON")));
}

function getSipHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  const normalized = name.toLowerCase();
  const header = headers?.find((item) => item.name.toLowerCase() === normalized);
  return header?.value?.trim() || null;
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
    const base64 = trimmed
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "");
    return { format: "spki", bytes: decodeBase64(base64) };
  }
  const bytes = decodeBase64(trimmed);
  return bytes.byteLength === 32 ? { format: "raw", bytes } : { format: "spki", bytes };
}

async function verifyTelnyxSignature(
  rawBody: string,
  signatureBase64: string,
  timestamp: string,
  publicKeyValue: string,
): Promise<boolean> {
  const decoded = decodeTelnyxPublicKey(publicKeyValue);
  const key = await crypto.subtle.importKey(decoded.format, decoded.bytes, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify(
    "Ed25519",
    key,
    decodeBase64(signatureBase64),
    new TextEncoder().encode(`${timestamp}|${rawBody}`),
  );
}

async function verifyAndParseTelnyxWebhook(
  rawBody: string,
  request: Request,
  env: WorkerEnv,
): Promise<TelnyxVoiceEvent> {
  const signature = request.headers.get("telnyx-signature-ed25519");
  const timestamp = request.headers.get("telnyx-timestamp");
  if (!signature || !timestamp) throw new Error("Missing Telnyx signature headers");

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) throw new Error("Invalid Telnyx timestamp");
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300) {
    throw new Error("Telnyx webhook timestamp outside 5 minute tolerance");
  }

  const valid = await verifyTelnyxSignature(
    rawBody,
    signature,
    timestamp,
    requireEnvString(env.TELNYX_PUBLIC_KEY, "TELNYX_PUBLIC_KEY"),
  );
  if (!valid) throw new Error("Telnyx Ed25519 signature verification failed");
  return JSON.parse(rawBody) as TelnyxVoiceEvent;
}

function buildOpenAISipUri(env: WorkerEnv): string {
  return `sip:${requireEnvString(env.OPENAI_PROJECT_ID, "OPENAI_PROJECT_ID")}@sip.api.openai.com;transport=tls`;
}

async function transferTelnyxCallToOpenAI(
  callControlId: string,
  eventId: string,
  resolution: TenantResolution,
  env: WorkerEnv,
): Promise<void> {
  const startedAt = Date.now();
  log("info", "telnyx_transfer_start", {
    call_control_id: callControlId,
    command_id: eventId,
    tenant_id: resolution.tenantId,
    called_number: resolution.calledNumber,
    routing_source: resolution.source,
    target_host: "sip.api.openai.com",
  });

  const response = await fetch(
    `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`,
        "Content-Type": "application/json",
      },
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
    },
  );

  const body = await response.text();
  log(response.ok ? "info" : "error", "telnyx_transfer_response", {
    call_control_id: callControlId,
    tenant_id: resolution.tenantId,
    status: response.status,
    elapsed_ms: Date.now() - startedAt,
    response: body.slice(0, 2000),
  });

  if (!response.ok) throw new Error(`Telnyx transfer failed with HTTP ${response.status}`);
}

async function rejectTelnyxCall(callControlId: string, eventId: string, env: WorkerEnv): Promise<void> {
  const startedAt = Date.now();
  const response = await fetch(
    `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/reject`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cause: "CALL_REJECTED", command_id: eventId }),
    },
  );
  const body = await response.text();
  log(response.ok ? "info" : "error", "telnyx_reject_response", {
    call_control_id: callControlId,
    status: response.status,
    elapsed_ms: Date.now() - startedAt,
    response: body.slice(0, 1000),
  });
  if (!response.ok) throw new Error(`Telnyx reject failed with HTTP ${response.status}`);
}

async function handleTelnyxWebhook(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  let event: TelnyxVoiceEvent;
  try {
    event = await verifyAndParseTelnyxWebhook(rawBody, request, env);
  } catch (error) {
    log("error", "invalid_telnyx_webhook", {
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ ok: false, error: "invalid_webhook_signature" }, 403);
  }

  const eventType = event.data?.event_type ?? "unknown";
  const eventId = event.data?.id ?? crypto.randomUUID();
  const payload = event.data?.payload;
  log("info", "telnyx_event", {
    event_type: eventType,
    event_id: eventId,
    attempt: event.meta?.attempt,
    call_control_id: payload?.call_control_id,
    call_leg_id: payload?.call_leg_id,
    call_session_id: payload?.call_session_id,
    connection_id: payload?.connection_id,
    direction: payload?.direction,
    state: payload?.state,
    from: payload?.from,
    to: payload?.to,
    hangup_cause: payload?.hangup_cause,
    hangup_source: payload?.hangup_source,
  });

  if (eventType === "call.initiated" && payload?.direction === "incoming") {
    const callControlId = payload.call_control_id;
    const calledNumber = payload.to?.trim();
    if (!callControlId) return json({ ok: false, error: "missing_call_control_id" }, 400);
    if (!calledNumber) return json({ ok: false, error: "missing_called_number" }, 400);

    log("info", "tenant_resolution_started", {
      call_control_id: callControlId,
      called_number: calledNumber,
      routing_source: "called_number",
    });

    let resolution: TenantResolution | null = null;
    try {
      resolution = getTenantResolver(env).resolve({ calledNumber });
    } catch (error) {
      log("error", "tenant_resolution_failed", {
        call_control_id: callControlId,
        called_number: calledNumber,
        reason: "invalid_tenant_routes_configuration",
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ ok: false, error: "tenant_routes_configuration_invalid" }, 500);
    }

    if (!resolution) {
      log("error", "tenant_resolution_failed", {
        call_control_id: callControlId,
        called_number: calledNumber,
        reason: "route_not_found",
      });
      ctx.waitUntil(
        rejectTelnyxCall(callControlId, eventId, env).catch((error) => {
          log("error", "call_orchestrator_reject_failed", {
            call_control_id: callControlId,
            called_number: calledNumber,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
      return json({ ok: true, accepted: false, action: "reject_unroutable", called_number: calledNumber });
    }

    const tenantConfig = getTenantConfiguration(resolution.tenantId);
    if (!tenantConfig) {
      log("error", "tenant_resolution_failed", {
        call_control_id: callControlId,
        tenant_id: resolution.tenantId,
        called_number: resolution.calledNumber,
        reason: "tenant_configuration_not_found",
      });
      ctx.waitUntil(rejectTelnyxCall(callControlId, eventId, env).catch(() => undefined));
      return json({ ok: true, accepted: false, action: "reject_tenant_config_missing" });
    }

    log("info", "tenant_resolution_succeeded", {
      call_control_id: callControlId,
      tenant_id: resolution.tenantId,
      called_number: resolution.calledNumber,
      routing_source: resolution.source,
      business_name: tenantConfig.business.displayName,
    });

    log("info", "call_orchestrator_route_selected", {
      call_control_id: callControlId,
      tenant_id: resolution.tenantId,
      called_number: resolution.calledNumber,
      routing_source: resolution.source,
      route: "openai_realtime_sip",
    });

    ctx.waitUntil(
      transferTelnyxCallToOpenAI(callControlId, eventId, resolution, env).catch((error) => {
        log("error", "call_orchestrator_failed", {
          call_control_id: callControlId,
          tenant_id: resolution.tenantId,
          called_number: resolution.calledNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );

    return json({
      ok: true,
      accepted: true,
      action: "transfer_to_realtime",
      tenant_id: resolution.tenantId,
      called_number: resolution.calledNumber,
      routing_source: resolution.source,
      business_name: tenantConfig.business.displayName,
    });
  }

  return json({ ok: true, ignored: true, event_type: eventType });
}

function buildRealtimeSessionConfiguration(
  env: WorkerEnv,
  tenantConfig: TenantConfiguration,
): RealtimeSessionConfiguration {
  const instructions = [
    `Atiendes llamadas para ${tenantConfig.business.displayName}.`,
    `Tu nombre de asistente es ${tenantConfig.assistant.name}.`,
    "Habla siempre en español, de forma amable, natural, breve y profesional.",
    "La identidad del negocio y del asistente procede de TenantConfiguration y no debe sustituirse por otro negocio.",
    "No gestiones todavía citas, reservas, pedidos ni acciones externas durante FASE 1.",
    "No solicites datos médicos ni información personal innecesaria.",
    "No inventes información del negocio que no esté presente en la configuración o en una fuente autorizada.",
    "Si el usuario te interrumpe, deja de hablar y escúchalo.",
    "Si no entiendes algo, pide que lo repita.",
    "Antes de responder a CADA turno real del usuario debes invocar exactamente una vez la herramienta conversation_intent.",
    "Clasifica semánticamente la intención usando el significado de la intervención actual y todo el contexto conversacional; no hagas coincidencia de palabras aisladas.",
    "Usa CONTINUE cuando el usuario quiere seguir conversando, formula una nueva consulta, pide más ayuda o no existe señal razonable de cierre.",
    "Usa END_CLEAR cuando el contexto hace clara la intención de finalizar la conversación o la llamada. Una intención clara no necesita una pregunta de confirmación adicional.",
    "Usa END_AMBIGUOUS cuando parece que el usuario podría estar terminando pero el contexto no permite afirmarlo con suficiente seguridad.",
    "Una mención narrativa o contextual de una despedida no implica END_CLEAR si el usuario no pretende terminar la conversación actual.",
    "No anuncies que vas a colgar por tu cuenta. CallSession decide la política, genera la despedida final y ejecuta el hangup.",
    "Después de invocar conversation_intent espera el resultado de la herramienta; CallSession generará la respuesta hablada apropiada.",
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
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          idle_timeout_ms: IDLE_TIMEOUT_MS,
        },
      },
      output: {
        format: { type: "audio/pcmu" },
        voice: requireEnvString(env.REALTIME_VOICE, "REALTIME_VOICE"),
      },
    },
    tools: [
      {
        type: "function",
        name: "conversation_intent",
        description:
          "Clasifica semánticamente la intención conversacional del usuario en CONTINUE, END_AMBIGUOUS o END_CLEAR usando el contexto completo de la conversación. Debe invocarse una vez antes de responder a cada turno real del usuario.",
        parameters: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              enum: ["CONTINUE", "END_AMBIGUOUS", "END_CLEAR"],
              description:
                "CONTINUE: desea seguir o hace una consulta. END_AMBIGUOUS: podría estar terminando pero no es seguro. END_CLEAR: intención clara de terminar.",
            },
            reason: {
              type: "string",
              description: "Explicación breve basada en el contexto conversacional, sin datos sensibles innecesarios.",
            },
          },
          required: ["intent", "reason"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: "required",
  };
}

async function acceptRealtimeCall(
  callId: string,
  configuration: RealtimeSessionConfiguration,
  env: WorkerEnv,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const startedAt = Date.now();
  log("info", "openai_accept_start", {
    call_id: callId,
    model: configuration.model,
    voice: configuration.audio.output.voice,
    tools: configuration.tools.map((tool) => tool.name),
    tool_choice: configuration.tool_choice,
    input_transcription: configuration.audio.input.transcription.model,
  });

  try {
    const response = await fetch(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${requireEnvString(env.OPENAI_API_KEY, "OPENAI_API_KEY")}`,
          "Content-Type": "application/json",
          "X-Client-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify(configuration),
        signal: controller.signal,
      },
    );

    log(response.ok ? "info" : "error", "openai_accept_http", {
      call_id: callId,
      status: response.status,
      elapsed_ms: Date.now() - startedAt,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function startCallSession(
  callId: string,
  tenantConfig: TenantConfiguration,
  env: WorkerEnv,
): Promise<void> {
  const id = env.CALL_SESSIONS.idFromName(callId);
  const stub = env.CALL_SESSIONS.get(id);
  const startedAt = Date.now();

  log("info", "call_session_start_requested", {
    call_id: callId,
    tenant_id: tenantConfig.tenantId,
    business_name: tenantConfig.business.displayName,
    assistant_name: tenantConfig.assistant.name,
    persistence: "durable_object",
    intent_policy: "semantic_v9",
  });

  const response = await stub.fetch("https://call-session.internal/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call_id: callId,
      tenant_id: tenantConfig.tenantId,
      business_name: tenantConfig.business.displayName,
      assistant_name: tenantConfig.assistant.name,
      initial_greeting: tenantConfig.assistant.greeting,
    }),
  });

  const body = await response.text();
  log(response.ok ? "info" : "error", "call_session_start_result", {
    call_id: callId,
    tenant_id: tenantConfig.tenantId,
    status: response.status,
    elapsed_ms: Date.now() - startedAt,
    body: body.slice(0, 1000),
  });

  if (!response.ok) throw new Error(`CallSession start failed with HTTP ${response.status}`);
}

async function handleOpenAIWebhook(request: Request, env: WorkerEnv): Promise<Response> {
  const rawBody = await request.text();
  let rawEventType = "unknown";
  try {
    rawEventType = (JSON.parse(rawBody) as { type?: string }).type ?? "unknown";
  } catch {
    rawEventType = "invalid_json";
  }

  log("info", "openai_webhook_received", {
    webhook_id: request.headers.get("webhook-id"),
    body_bytes: rawBody.length,
    raw_event_type: rawEventType,
  });

  const client = new OpenAI({
    apiKey: requireEnvString(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
    webhookSecret: requireEnvString(env.OPENAI_WEBHOOK_SECRET, "OPENAI_WEBHOOK_SECRET"),
  });

  let event: unknown;
  try {
    event = await client.webhooks.unwrap(rawBody, request.headers);
  } catch (error) {
    log("error", "invalid_openai_webhook", {
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ ok: false, error: "invalid_webhook_signature" }, 400);
  }

  const typedEvent = event as { type?: string };
  log("info", "openai_event", {
    type: typedEvent.type ?? "unknown",
    raw_event_type: rawEventType,
  });

  if (typedEvent.type !== "realtime.call.incoming") {
    return json({ ok: true, ignored: true, event_type: typedEvent.type ?? "unknown" });
  }

  const incoming = event as RealtimeIncomingCallEvent;
  const callId = incoming.data?.call_id;
  if (!callId) return json({ ok: false, error: "missing_call_id" }, 400);

  const tenantId = getSipHeader(incoming.data.sip_headers, TENANT_HEADER);
  const calledNumber = getSipHeader(incoming.data.sip_headers, CALLED_NUMBER_HEADER);
  const routingSource = getSipHeader(incoming.data.sip_headers, ROUTING_SOURCE_HEADER);

  if (!tenantId || !calledNumber || routingSource !== "called_number") {
    log("error", "call_bootstrap_tenant_binding_missing", {
      call_id: callId,
      tenant_header_present: Boolean(tenantId),
      called_number_header_present: Boolean(calledNumber),
      routing_source: routingSource,
      sip_header_names: incoming.data.sip_headers?.map((header) => header.name) ?? [],
    });
    return json({ ok: false, error: "tenant_binding_missing" }, 409);
  }

  const tenantConfig = getTenantConfiguration(tenantId);
  if (!tenantConfig) {
    log("error", "call_bootstrap_tenant_configuration_missing", {
      call_id: callId,
      tenant_id: tenantId,
      called_number: calledNumber,
    });
    return json({ ok: false, error: "tenant_configuration_missing" }, 409);
  }

  log("info", "call_bootstrap_started", {
    call_id: callId,
    tenant_id: tenantId,
    called_number: calledNumber,
    routing_source: routingSource,
    business_name: tenantConfig.business.displayName,
    assistant_name: tenantConfig.assistant.name,
  });

  const configuration = buildRealtimeSessionConfiguration(env, tenantConfig);
  log("info", "realtime_call_incoming", {
    call_id: callId,
    tenant_id: tenantId,
    called_number: calledNumber,
    routing_source: routingSource,
    business_name: tenantConfig.business.displayName,
    assistant_name: tenantConfig.assistant.name,
    sip_header_names: incoming.data.sip_headers?.map((header) => header.name) ?? [],
  });

  let openAIResponse: Response;
  try {
    openAIResponse = await acceptRealtimeCall(callId, configuration, env);
  } catch (error) {
    log("error", "realtime_accept_exception", {
      call_id: callId,
      tenant_id: tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ ok: false, error: "accept_exception" }, 502);
  }

  const responseBody = await openAIResponse.text();
  log(openAIResponse.ok ? "info" : "error", "realtime_accept_result", {
    call_id: callId,
    tenant_id: tenantId,
    status: openAIResponse.status,
    body: responseBody.slice(0, 2000),
  });

  if (!openAIResponse.ok) {
    return json({ ok: false, error: "openai_accept_failed", status: openAIResponse.status }, 502);
  }

  let callSessionStarted = false;
  try {
    await startCallSession(callId, tenantConfig, env);
    callSessionStarted = true;
  } catch (error) {
    log("error", "call_session_start_failed", {
      call_id: callId,
      tenant_id: tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  log("info", "call_bootstrap_ready", {
    call_id: callId,
    tenant_id: tenantId,
    called_number: calledNumber,
    routing_source: routingSource,
    business_name: tenantConfig.business.displayName,
    assistant_name: tenantConfig.assistant.name,
    call_session_started: callSessionStarted,
  });

  return json({
    ok: true,
    call_id: callId,
    tenant_id: tenantId,
    called_number: calledNumber,
    routing_source: routingSource,
    business_name: tenantConfig.business.displayName,
    assistant_name: tenantConfig.assistant.name,
    intent_hangup: true,
    intent_hangup_mode: "semantic_intent_v9",
    call_session_started: callSessionStarted,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      let tenantRoutesValid = false;
      let tenantRoutesCount = 0;
      let configuredTenantId: string | null = null;
      let configuredBusinessName: string | null = null;
      let configuredAssistantName: string | null = null;
      try {
        const routes = parseTenantRoutesJson(requireEnvString(env.TENANT_ROUTES_JSON, "TENANT_ROUTES_JSON"));
        new StaticTenantResolver(routes);
        tenantRoutesValid = true;
        tenantRoutesCount = routes.length;
        if (routes.length === 1) {
          configuredTenantId = routes[0].tenantId;
          const tenantConfig = getTenantConfiguration(configuredTenantId);
          configuredBusinessName = tenantConfig?.business.displayName ?? null;
          configuredAssistantName = tenantConfig?.assistant.name ?? null;
        }
      } catch {
        tenantRoutesValid = false;
      }

      return json({
        ok: true,
        service: "IA_RealTime_CenterCall",
        phase: "F1",
        environment: env.ENVIRONMENT,
        telephony_provider: "telnyx",
        call_orchestrator: true,
        tenant_resolver: "StaticTenantResolver",
        tenant_routing_source: "called_number",
        tenant_routes_valid: tenantRoutesValid,
        tenant_routes_count: tenantRoutesCount,
        configured_tenant_id: configuredTenantId,
        configured_business_name: configuredBusinessName,
        configured_assistant_name: configuredAssistantName,
        initial_tenant_greeting: true,
        default_tenant_used_for_routing: false,
        tenant_binding_transport: "sip_custom_headers",
        telnyx_webhook_verification: "webcrypto-ed25519",
        tracing: "f1-tenant-greeting-v2",
        realtime_sideband_lifecycle: "durable_object",
        call_session_class: "CallSession",
        intent_hangup: true,
        intent_hangup_mode: "semantic_intent_v9",
        intent_classifier: "realtime_model_required_tool",
        intent_values: ["CONTINUE", "END_AMBIGUOUS", "END_CLEAR"],
        ambiguous_limit: AMBIGUOUS_LIMIT,
        ambiguity_reset_on_continue: true,
        ambiguous_silence_auto_hangup: true,
        ambiguous_idle_timeout_ms: IDLE_TIMEOUT_MS,
        hangup_retry: true,
        input_transcription: "gpt-4o-mini-transcribe_observability_only",
        runtime_config: {
          tenant_routes_json: typeof env.TENANT_ROUTES_JSON === "string" && env.TENANT_ROUTES_JSON.length > 0,
          openai_api_key: typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0,
          openai_webhook_secret:
            typeof env.OPENAI_WEBHOOK_SECRET === "string" && env.OPENAI_WEBHOOK_SECRET.length > 0,
          openai_project_id:
            typeof env.OPENAI_PROJECT_ID === "string" && env.OPENAI_PROJECT_ID.length > 0,
          telnyx_api_key: typeof env.TELNYX_API_KEY === "string" && env.TELNYX_API_KEY.length > 0,
          telnyx_public_key:
            typeof env.TELNYX_PUBLIC_KEY === "string" && env.TELNYX_PUBLIC_KEY.length > 0,
          call_sessions_binding: typeof env.CALL_SESSIONS === "object" && env.CALL_SESSIONS !== null,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/webhooks/telnyx") {
      return handleTelnyxWebhook(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/webhooks/openai") {
      return handleOpenAIWebhook(request, env);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
} satisfies ExportedHandler<WorkerEnv>;
