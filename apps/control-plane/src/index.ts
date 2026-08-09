import OpenAI from "openai";

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
    occurred_at?: string;
    payload?: {
      call_control_id?: string;
      call_leg_id?: string;
      call_session_id?: string;
      connection_id?: string;
      direction?: string;
      state?: string;
      from?: string;
      to?: string;
    };
  };
  meta?: {
    attempt?: number;
  };
};

type RealtimeSessionConfiguration = {
  type: "realtime";
  model: string;
  instructions: string;
  output_modalities: ["audio"];
  audio: {
    input: {
      format: { type: "audio/pcmu" };
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
  tools: [];
  tool_choice: "none";
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ level, event, ...details });
  if (level === "error") {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeTelnyxPublicKey(value: string): { format: "raw" | "spki"; bytes: Uint8Array } {
  const trimmed = value.trim();

  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    const base64 = trimmed
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "");
    return { format: "spki", bytes: decodeBase64(base64) };
  }

  const bytes = decodeBase64(trimmed);

  // Telnyx commonly exposes the Ed25519 public key as the raw 32-byte key.
  // Accept SPKI as well so the Worker remains robust if the portal representation changes.
  if (bytes.byteLength === 32) {
    return { format: "raw", bytes };
  }

  return { format: "spki", bytes };
}

async function verifyTelnyxSignature(
  rawBody: string,
  signatureBase64: string,
  timestamp: string,
  publicKeyValue: string,
): Promise<boolean> {
  const decodedKey = decodeTelnyxPublicKey(publicKeyValue);
  const key = await crypto.subtle.importKey(
    decodedKey.format,
    decodedKey.bytes,
    { name: "Ed25519" },
    false,
    ["verify"],
  );

  const signedPayload = new TextEncoder().encode(`${timestamp}|${rawBody}`);
  const signature = decodeBase64(signatureBase64);

  return crypto.subtle.verify("Ed25519", key, signature, signedPayload);
}

function buildRealtimeSessionConfiguration(env: Env): RealtimeSessionConfiguration {
  const instructions = [
    "Eres el asistente telefónico de pruebas de IA_RealTime_CenterCall.",
    "Habla siempre en español, de forma amable, natural, breve y profesional.",
    "Esta es únicamente una prueba técnica del canal de voz de FASE 0.",
    "No gestiones citas, reservas, pedidos ni acciones externas.",
    "No solicites datos médicos ni información personal innecesaria.",
    "No inventes información sobre ningún negocio.",
    "Si el usuario te interrumpe, deja de hablar y escúchalo.",
    "Si no entiendes algo, pide que lo repita.",
  ].join("\n");

  return {
    type: "realtime",
    model: env.REALTIME_MODEL,
    instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          idle_timeout_ms: 10_000,
        },
      },
      output: {
        format: { type: "audio/pcmu" },
        voice: env.REALTIME_VOICE,
      },
    },
    tools: [],
    tool_choice: "none",
  };
}

function buildOpenAISipUri(env: Env): string {
  return `sip:${env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls`;
}

async function transferTelnyxCallToOpenAI(
  callControlId: string,
  eventId: string,
  env: Env,
): Promise<void> {
  const target = buildOpenAISipUri(env);
  const startedAt = Date.now();

  const response = await fetch(
    `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: target,
        sip_transport_protocol: "TLS",
        timeout_secs: 30,
        command_id: eventId,
      }),
    },
  );

  const body = await response.text();
  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    log("error", "telnyx_transfer_failed", {
      call_control_id: callControlId,
      status: response.status,
      elapsed_ms: elapsedMs,
      response: body.slice(0, 2_000),
    });
    throw new Error(`Telnyx transfer failed with HTTP ${response.status}`);
  }

  log("info", "telnyx_transfer_requested", {
    call_control_id: callControlId,
    tenant_id: env.DEFAULT_TENANT_ID,
    target_host: "sip.api.openai.com",
    elapsed_ms: elapsedMs,
  });
}

async function verifyAndParseTelnyxWebhook(
  rawBody: string,
  request: Request,
  env: Env,
): Promise<TelnyxVoiceEvent> {
  const signature = request.headers.get("telnyx-signature-ed25519");
  const timestamp = request.headers.get("telnyx-timestamp");

  if (!signature || !timestamp) {
    throw new Error("Missing Telnyx signature headers");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error("Invalid Telnyx timestamp");
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > 300) {
    throw new Error("Telnyx webhook timestamp outside 5 minute tolerance");
  }

  const valid = await verifyTelnyxSignature(
    rawBody,
    signature,
    timestamp,
    env.TELNYX_PUBLIC_KEY,
  );

  if (!valid) {
    throw new Error("Telnyx Ed25519 signature verification failed");
  }

  return JSON.parse(rawBody) as TelnyxVoiceEvent;
}

async function handleTelnyxWebhook(
  request: Request,
  env: Env,
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

  log("info", "telnyx_webhook_received", {
    event_type: eventType,
    event_id: eventId,
    attempt: event.meta?.attempt,
    call_control_id: payload?.call_control_id,
    call_session_id: payload?.call_session_id,
    direction: payload?.direction,
    state: payload?.state,
  });

  // Only the initial inbound parked leg is routed by F0 CallOrchestrator.
  // Webhooks for the transferred/outbound leg are acknowledged but ignored.
  if (eventType === "call.initiated" && payload?.direction === "incoming") {
    const callControlId = payload.call_control_id;
    if (!callControlId) {
      return json({ ok: false, error: "missing_call_control_id" }, 400);
    }

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

async function acceptRealtimeCall(
  callId: string,
  configuration: RealtimeSessionConfiguration,
  env: Env,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    return await fetch(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "X-Client-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify(configuration),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function handleOpenAIWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    webhookSecret: env.OPENAI_WEBHOOK_SECRET,
  });

  let event: unknown;

  try {
    event = client.webhooks.unwrap(rawBody, request.headers);
  } catch (error) {
    log("error", "invalid_openai_webhook", {
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ ok: false, error: "invalid_webhook_signature" }, 400);
  }

  const typedEvent = event as { type?: string };
  if (typedEvent.type !== "realtime.call.incoming") {
    log("info", "ignored_openai_webhook", { type: typedEvent.type ?? "unknown" });
    return json({ ok: true, ignored: true });
  }

  const incoming = event as RealtimeIncomingCallEvent;
  const callId = incoming.data?.call_id;

  if (!callId) {
    return json({ ok: false, error: "missing_call_id" }, 400);
  }

  const startedAt = Date.now();
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
      tenant_id: env.DEFAULT_TENANT_ID,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ ok: false, error: "accept_exception" }, 502);
  }

  const responseBody = await openAIResponse.text();
  const setupMs = Date.now() - startedAt;

  if (!openAIResponse.ok) {
    log("error", "realtime_accept_failed", {
      call_id: callId,
      tenant_id: env.DEFAULT_TENANT_ID,
      status: openAIResponse.status,
      setup_ms: setupMs,
      openai_response: responseBody.slice(0, 2_000),
    });
    return json(
      {
        ok: false,
        error: "openai_accept_failed",
        status: openAIResponse.status,
      },
      502,
    );
  }

  log("info", "realtime_call_accepted", {
    call_id: callId,
    tenant_id: env.DEFAULT_TENANT_ID,
    setup_ms: setupMs,
  });

  return json({
    ok: true,
    call_id: callId,
    tenant_id: env.DEFAULT_TENANT_ID,
    setup_ms: setupMs,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
} satisfies ExportedHandler<Env>;