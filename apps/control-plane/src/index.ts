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

function buildRealtimeSessionConfiguration(env: Env): RealtimeSessionConfiguration {
  // FASE 0 still performs tenant binding. The tenant is fixed for development,
  // but its effective Realtime configuration is built here rather than being
  // hard-coded inside the OpenAI HTTP adapter.
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
    console.error(
      JSON.stringify({
        level: "error",
        event: "invalid_openai_webhook",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return json({ ok: false, error: "invalid_webhook_signature" }, 400);
  }

  const typedEvent = event as { type?: string };
  if (typedEvent.type !== "realtime.call.incoming") {
    console.log(
      JSON.stringify({
        level: "info",
        event: "ignored_openai_webhook",
        type: typedEvent.type ?? "unknown",
      }),
    );
    return json({ ok: true, ignored: true });
  }

  const incoming = event as RealtimeIncomingCallEvent;
  const callId = incoming.data?.call_id;

  if (!callId) {
    return json({ ok: false, error: "missing_call_id" }, 400);
  }

  const startedAt = Date.now();
  const configuration = buildRealtimeSessionConfiguration(env);

  console.log(
    JSON.stringify({
      level: "info",
      event: "realtime_call_incoming",
      call_id: callId,
      tenant_id: env.DEFAULT_TENANT_ID,
      sip_header_names: incoming.data.sip_headers?.map((header) => header.name) ?? [],
    }),
  );

  let openAIResponse: Response;

  try {
    openAIResponse = await acceptRealtimeCall(callId, configuration, env);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "realtime_accept_exception",
        call_id: callId,
        tenant_id: env.DEFAULT_TENANT_ID,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return json({ ok: false, error: "accept_exception" }, 502);
  }

  const responseBody = await openAIResponse.text();
  const setupMs = Date.now() - startedAt;

  if (!openAIResponse.ok) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "realtime_accept_failed",
        call_id: callId,
        tenant_id: env.DEFAULT_TENANT_ID,
        status: openAIResponse.status,
        setup_ms: setupMs,
        openai_response: responseBody.slice(0, 2_000),
      }),
    );
    return json(
      {
        ok: false,
        error: "openai_accept_failed",
        status: openAIResponse.status,
      },
      502,
    );
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "realtime_call_accepted",
      call_id: callId,
      tenant_id: env.DEFAULT_TENANT_ID,
      setup_ms: setupMs,
    }),
  );

  return json({
    ok: true,
    call_id: callId,
    tenant_id: env.DEFAULT_TENANT_ID,
    setup_ms: setupMs,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "IA_RealTime_CenterCall",
        phase: "F0",
        environment: env.ENVIRONMENT,
        tenant_id: env.DEFAULT_TENANT_ID,
      });
    }

    if (request.method === "POST" && url.pathname === "/webhooks/openai") {
      return handleOpenAIWebhook(request, env);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
