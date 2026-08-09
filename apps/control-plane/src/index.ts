import OpenAI from "openai";
export { CallSession } from "./call-session";

type WorkerEnv = {
  ENVIRONMENT: string;
  DEFAULT_TENANT_ID: string;
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
  tool_choice: "auto";
};

const IDLE_TIMEOUT_MS = 10_000;

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
  env: WorkerEnv,
): Promise<void> {
  const startedAt = Date.now();
  log("info", "telnyx_transfer_start", {
    call_control_id: callControlId,
    command_id: eventId,
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
      }),
    },
  );

  const body = await response.text();
  log(response.ok ? "info" : "error", "telnyx_transfer_response", {
    call_control_id: callControlId,
    status: response.status,
    elapsed_ms: Date.now() - startedAt,
    response: body.slice(0, 2000),
  });

  if (!response.ok) throw new Error(`Telnyx transfer failed with HTTP ${response.status}`);
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
    if (!callControlId) return json({ ok: false, error: "missing_call_control_id" }, 400);

    log("info", "call_orchestrator_route_selected", {
      call_control_id: callControlId,
      tenant_id: env.DEFAULT_TENANT_ID,
      route: "openai_realtime_sip",
    });

    ctx.waitUntil(
      transferTelnyxCallToOpenAI(callControlId, eventId, env).catch((error) => {
        log("error", "call_orchestrator_failed", {
          call_control_id: callControlId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );

    return json({
      ok: true,
      accepted: true,
      action: "transfer_to_realtime",
      tenant_id: env.DEFAULT_TENANT_ID,
    });
  }

  return json({ ok: true, ignored: true, event_type: eventType });
}

function buildRealtimeSessionConfiguration(env: WorkerEnv): RealtimeSessionConfiguration {
  const instructions = [
    "Eres el asistente telefónico de pruebas de IA_RealTime_CenterCall.",
    "Habla siempre en español, de forma amable, natural, breve y profesional.",
    "Esta es únicamente una prueba técnica del canal de voz de FASE 0.",
    "No gestiones citas, reservas, pedidos ni acciones externas.",
    "No solicites datos médicos ni información personal innecesaria.",
    "No inventes información sobre ningún negocio.",
    "Si el usuario te interrumpe, deja de hablar y escúchalo.",
    "Si no entiendes algo, pide que lo repita.",
    "Si percibes que el usuario quiere terminar la consulta o ya no desea continuar, invoca end_call en vez de repetir preguntas de cortesía.",
    "Después de una señal de cierre no repitas varias veces que entiendes que ha terminado.",
    "No uses end_call por silencio aislado ni por una mención contextual de una despedida.",
    "Nunca anuncies que vas a colgar sin invocar end_call. CallSession controla la confirmación, despedida y hangup.",
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
        name: "end_call",
        description:
          "Indica que el usuario parece haber terminado la consulta o desea finalizar la llamada. CallSession confirmará la intención y realizará el cierre técnico.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Motivo breve que indica intención de terminar.",
            },
          },
          required: ["reason"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: "auto",
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

async function startCallSession(callId: string, env: WorkerEnv): Promise<void> {
  const id = env.CALL_SESSIONS.idFromName(callId);
  const stub = env.CALL_SESSIONS.get(id);
  const startedAt = Date.now();

  log("info", "call_session_start_requested", {
    call_id: callId,
    persistence: "durable_object",
  });

  const response = await stub.fetch("https://call-session.internal/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call_id: callId }),
  });

  const body = await response.text();
  log(response.ok ? "info" : "error", "call_session_start_result", {
    call_id: callId,
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

  const configuration = buildRealtimeSessionConfiguration(env);
  log("info", "realtime_call_incoming", {
    call_id: callId,
    tenant_id: env.DEFAULT_TENANT_ID,
    sip_header_names: incoming.data.sip_headers?.map((header) => header.name) ?? [],
  });

  let openAIResponse: Response;
  try {
    openAIResponse = await acceptRealtimeCall(callId, configuration, env);
  } catch (error) {
    log("error", "realtime_accept_exception", {
      call_id: callId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ ok: false, error: "accept_exception" }, 502);
  }

  const responseBody = await openAIResponse.text();
  log(openAIResponse.ok ? "info" : "error", "realtime_accept_result", {
    call_id: callId,
    status: openAIResponse.status,
    body: responseBody.slice(0, 2000),
  });

  if (!openAIResponse.ok) {
    return json({ ok: false, error: "openai_accept_failed", status: openAIResponse.status }, 502);
  }

  let callSessionStarted = false;
  try {
    await startCallSession(callId, env);
    callSessionStarted = true;
  } catch (error) {
    log("error", "call_session_start_failed", {
      call_id: callId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return json({
    ok: true,
    call_id: callId,
    tenant_id: env.DEFAULT_TENANT_ID,
    intent_hangup: true,
    intent_hangup_mode: "durable_object_state_machine_v8",
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
        phase: "F0",
        environment: env.ENVIRONMENT,
        tenant_id: env.DEFAULT_TENANT_ID,
        telephony_provider: "telnyx",
        call_orchestrator: true,
        telnyx_webhook_verification: "webcrypto-ed25519",
        tracing: "f0-e2e-v8",
        realtime_sideband_lifecycle: "durable_object",
        call_session_class: "CallSession",
        intent_hangup: true,
        intent_hangup_mode: "durable_object_state_machine_v8",
        confirmation_silence_auto_hangup: true,
        confirmation_idle_timeout_ms: IDLE_TIMEOUT_MS,
        hangup_retry: true,
        input_transcription: "gpt-4o-mini-transcribe",
        runtime_config: {
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
