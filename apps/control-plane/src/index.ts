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
      transcription: {
        model: "gpt-4o-mini-transcribe";
        language: "es";
      };
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

type RealtimeSidebandEvent = {
  type?: string;
  event_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  transcript?: string;
  response?: { id?: string };
  error?: {
    type?: string;
    code?: string;
    message?: string;
  };
};

type EndCallIntentLevel = "clear" | "probable" | "none";
type EndCallIntent = { level: EndCallIntentLevel; rule: string };

const activeSidebands = new Map<string, WebSocket>();
const END_CONFIRMATION_TTL_MS = 30_000;
const ASSISTANT_FAREWELL_TTL_MS = 30_000;
const FAREWELL_FALLBACK_MS = 8_000;
const ASSISTANT_COMMITMENT_GRACE_MS = 1_200;
const CONFIRMATION_IDLE_TIMEOUT_MS = 10_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ level, event, ...details });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

function requireEnvString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing runtime configuration: ${name}`);
  }
  return value.trim();
}

function normalizeIntentText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyEndCallIntent(rawTranscript: string, assistantFarewellRecent: boolean): EndCallIntent {
  const text = normalizeIntentText(rawTranscript);
  if (!text) return { level: "none", rule: "empty" };
  const words = text.split(" ").filter(Boolean);

  const contextualMention = [
    /\b(me|nos|le|les) dijo (adios|hasta luego)\b/,
    /\b(dijo|dijeron) (adios|hasta luego)\b/,
    /\b(decir|diga|dice|dices|dijo) adios\b/,
    /\b(palabra|expresion) adios\b/,
    /\b(significa|significado de) adios\b/,
    /\bcomo se dice adios\b/,
    /\bcuando alguien dice (adios|hasta luego)\b/,
  ].some((pattern) => pattern.test(text));
  if (contextualMention) return { level: "none", rule: "contextual_farewell_mention" };

  const explicitTermination = [
    /\beso es todo\b/,
    /\bno necesito nada mas\b/,
    /\bno quiero nada mas\b/,
    /\bno necesito mas ayuda\b/,
    /\bnada mas gracias\b/,
    /\bno no (?:en )?nada mas\b/,
    /\bno (?:en )?nada mas\b/,
    /\ben nada mas\b/,
    /\bno tengo nada mas\b/,
    /\bya no tengo nada mas\b/,
    /\bya no necesito nada\b/,
    /\bya termine(?: la consulta)?\b/,
    /\bya he terminado(?: la consulta)?\b/,
    /\bhe terminado(?: la consulta)?\b/,
    /\btermine(?: la consulta)?\b/,
    /\bya acabe(?: la consulta)?\b/,
    /\bhe acabado(?: la consulta)?\b/,
    /\bya no tengo mas preguntas\b/,
    /\bno quiero seguir hablando\b/,
    /\bno necesito seguir hablando\b/,
    /\bpodemos dejarlo aqui\b/,
    /\blo dejamos aqui\b/,
    /\bdejamos esto aqui\b/,
    /\bme tengo que ir\b/,
    /\bhemos terminado\b/,
    /\bya hemos terminado\b/,
    /\bme despido\b/,
    /\bya esta gracias\b/,
    /\bcon eso es suficiente\b/,
  ].some((pattern) => pattern.test(text));
  if (explicitTermination) return { level: "clear", rule: "explicit_termination" };

  const explicitHangupCommand = [
    /\bpuedes colgar\b/,
    /\bpuede colgar\b/,
    /\bcuelga(?: ya| ahora)?\b/,
    /\bpuedes finalizar la llamada\b/,
    /\bpuede finalizar la llamada\b/,
    /\btermina la llamada\b/,
    /\btermine la llamada\b/,
    /\bfinaliza la llamada\b/,
    /\bfinalice la llamada\b/,
  ].some((pattern) => pattern.test(text));
  if (explicitHangupCommand) return { level: "clear", rule: "explicit_hangup_command" };

  const shortFarewell = /^(?:(?:vale|bueno|ok|okay|perfecto|muy bien|gracias|muchas gracias) )*(?:adios|hasta luego|hasta pronto|nos vemos|chao|ciao)(?: gracias| muchas gracias)?$/;
  if (words.length <= 10 && shortFarewell.test(text)) {
    return { level: "clear", rule: "short_farewell" };
  }

  const shortThanks = /^(?:vale |bueno |ok |okay |perfecto |muy bien )?(?:gracias|muchas gracias|mil gracias)$/;
  if (words.length <= 6 && shortThanks.test(text)) {
    return assistantFarewellRecent
      ? { level: "clear", rule: "thanks_after_assistant_farewell" }
      : { level: "probable", rule: "thanks_only" };
  }

  const softClosing = [
    /\bcreo que ya esta\b/,
    /\bpor mi parte nada mas\b/,
    /\bde momento nada mas\b/,
    /\bcreo que es todo\b/,
    /\bcreo que ya termine\b/,
    /\bparece que ya esta todo\b/,
  ].some((pattern) => pattern.test(text));
  if (softClosing) {
    return {
      level: assistantFarewellRecent ? "clear" : "probable",
      rule: "soft_closing",
    };
  }

  return { level: "none", rule: "no_closing_signal" };
}

function classifyConfirmationReply(rawTranscript: string): "close" | "continue" | "unknown" {
  const text = normalizeIntentText(rawTranscript);
  if (!text) return "unknown";

  const closePatterns = [
    /^no$/,
    /^no no$/,
    /^no gracias$/,
    /^no muchas gracias$/,
    /^no nada mas$/,
    /^no no nada mas$/,
    /^no en nada mas$/,
    /^no no en nada mas$/,
    /^en nada mas$/,
    /^nada mas$/,
    /^nada mas gracias$/,
    /^eso es todo$/,
    /^correcto nada mas$/,
    /^no necesito nada mas$/,
    /^no necesito mas ayuda$/,
    /^no tengo nada mas$/,
    /^ya no tengo nada mas$/,
    /^ya esta$/,
    /^ya esta gracias$/,
    /^ya termine$/,
    /^ya he terminado$/,
    /^he terminado$/,
    /^termine la consulta$/,
    /^ya termine la consulta$/,
  ];
  if (closePatterns.some((pattern) => pattern.test(text))) return "close";

  const continuePatterns = [
    /^si$/,
    /^si gracias$/,
    /^si necesito\b/,
    /^si tengo\b/,
    /^no espera\b/,
    /^espera\b/,
    /^un momento\b/,
    /^tengo otra pregunta\b/,
    /^otra cosa\b/,
    /^ademas\b/,
    /^quiero preguntar\b/,
    /^necesito otra cosa\b/,
  ];
  if (continuePatterns.some((pattern) => pattern.test(text))) return "continue";

  return "unknown";
}

function isAssistantFarewell(rawTranscript: string): boolean {
  const text = normalizeIntentText(rawTranscript);
  return [
    /\badios\b/,
    /\bhasta luego\b/,
    /\bhasta pronto\b/,
    /\bque tengas un buen dia\b/,
    /\bque tenga un buen dia\b/,
    /\bha sido un placer\b/,
  ].some((pattern) => pattern.test(text));
}

function isAssistantHangupCommitment(rawTranscript: string): boolean {
  const text = normalizeIntentText(rawTranscript);
  if (!text) return false;
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

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  const binary = atob(normalized);
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
  const decodedKey = decodeTelnyxPublicKey(publicKeyValue);
  const key = await crypto.subtle.importKey(
    decodedKey.format,
    decodedKey.bytes,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const signedPayload = new TextEncoder().encode(`${timestamp}|${rawBody}`);
  return crypto.subtle.verify(
    "Ed25519",
    key,
    decodeBase64(signatureBase64),
    signedPayload,
  );
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
    "Dispones de la herramienta end_call para solicitar el cierre de la llamada actual.",
    "Cuando percibas que el usuario probablemente ha terminado su consulta o ya no desea continuar hablando, no asumas ni permanezcas en silencio: confirma brevemente su intención de terminar.",
    "Una confirmación natural puede ser: Entiendo que ya has terminado. ¿Necesitas algo más antes de que cierre la llamada?",
    "Si el usuario confirma que no necesita nada más, usa end_call.",
    "Si el usuario expresa una orden directa de colgar o finalizar la llamada, usa end_call.",
    "Si el usuario quiere continuar, continúa con normalidad.",
    "Si el usuario no responde a una confirmación de cierre, el sistema gestionará automáticamente la despedida y el cierre; no generes respuestas repetitivas.",
    "No uses end_call por silencio ordinario, pausas o falta de audio si no existe previamente una señal de intención de terminar.",
    "No uses end_call si adiós, hasta luego u otra despedida aparece citada dentro de una historia, una pregunta o un contexto que no implique terminar esta llamada.",
    "REGLA CRÍTICA: nunca digas que vas a colgar, finalizar o terminar la llamada si no has invocado end_call. Si decides que corresponde terminar, invoca end_call en lugar de limitarte a anunciarlo verbalmente.",
  ].join("\n");

  return {
    type: "realtime",
    model: env.REALTIME_MODEL,
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
          idle_timeout_ms: CONFIRMATION_IDLE_TIMEOUT_MS,
        },
      },
      output: { format: { type: "audio/pcmu" }, voice: env.REALTIME_VOICE },
    },
    tools: [
      {
        type: "function",
        name: "end_call",
        description:
          "Solicita finalizar la llamada actual. Úsala después de que el usuario confirme que ha terminado/no necesita nada más, o ante una orden directa de colgar. No usar por silencio ordinario ni por menciones contextuales.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Motivo breve por el que el usuario desea terminar la llamada.",
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

function buildOpenAISipUri(env: Env): string {
  return `sip:${env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls`;
}

async function transferTelnyxCallToOpenAI(
  callControlId: string,
  eventId: string,
  env: Env,
): Promise<void> {
  const apiKey = requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY");
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
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
    response: body.slice(0, 2_000),
  });
  if (!response.ok) throw new Error(`Telnyx transfer failed with HTTP ${response.status}`);
}

async function verifyAndParseTelnyxWebhook(
  rawBody: string,
  request: Request,
  env: Env,
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

async function acceptRealtimeCall(
  callId: string,
  configuration: RealtimeSessionConfiguration,
  env: Env,
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

async function hangupOpenAICall(callId: string, reason: string, env: Env): Promise<void> {
  const startedAt = Date.now();
  log("info", "end_call_hangup_start", { call_id: callId, reason });
  const response = await fetch(
    `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnvString(env.OPENAI_API_KEY, "OPENAI_API_KEY")}`,
      },
    },
  );
  const body = await response.text();
  log(response.ok ? "info" : "error", "end_call_hangup_result", {
    call_id: callId,
    status: response.status,
    elapsed_ms: Date.now() - startedAt,
    body: body.slice(0, 1_000),
  });
  if (!response.ok) throw new Error(`OpenAI hangup failed with HTTP ${response.status}`);
}

function readWebSocketText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

async function attachRealtimeSideband(callId: string, env: Env): Promise<void> {
  if (activeSidebands.has(callId)) {
    log("info", "realtime_sideband_duplicate_skipped", { call_id: callId });
    return;
  }

  const startedAt = Date.now();
  log("info", "realtime_sideband_connect_start", { call_id: callId });
  const response = await fetch(
    `https://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${requireEnvString(env.OPENAI_API_KEY, "OPENAI_API_KEY")}`,
        "Sec-WebSocket-Protocol": "realtime",
        Connection: "Upgrade",
        Upgrade: "websocket",
      },
    },
  );

  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  if (!socket) {
    const body = await response.text().catch(() => "");
    throw new Error(`Realtime sideband upgrade failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }

  socket.accept();
  activeSidebands.set(callId, socket);
  log("info", "realtime_sideband_connected", {
    call_id: callId,
    elapsed_ms: Date.now() - startedAt,
  });

  let endCallPending = false;
  let hangupStarted = false;
  let closingResponseId: string | null = null;
  let endCallReason = "user_requested_end";
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let confirmationPendingAt = 0;
  let confirmationRule = "";
  let assistantFarewellAt = 0;

  const clearFallback = () => {
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };
  const confirmationIsPending = () =>
    confirmationPendingAt > 0 && Date.now() - confirmationPendingAt <= END_CONFIRMATION_TTL_MS;
  const assistantFarewellIsRecent = () =>
    assistantFarewellAt > 0 && Date.now() - assistantFarewellAt <= ASSISTANT_FAREWELL_TTL_MS;

  const clearConfirmation = (reason: string) => {
    if (!confirmationIsPending()) return;
    confirmationPendingAt = 0;
    confirmationRule = "";
    log("info", "end_call_confirmation_cleared", { call_id: callId, reason });
  };

  const performHangup = async (trigger: string) => {
    if (hangupStarted) return;
    hangupStarted = true;
    clearFallback();
    log("info", "end_call_hangup_triggered", {
      call_id: callId,
      trigger,
      closing_response_id: closingResponseId,
    });
    try {
      await hangupOpenAICall(callId, endCallReason, env);
    } catch (error) {
      hangupStarted = false;
      log("error", "end_call_hangup_failed", {
        call_id: callId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const startClosingFlow = (reason: string, source: string, toolCallId?: string) => {
    if (endCallPending || hangupStarted) {
      log("info", "end_call_duplicate_ignored", {
        call_id: callId,
        source,
        tool_call_id: toolCallId,
      });
      return;
    }

    endCallPending = true;
    endCallReason = reason.slice(0, 300);
    confirmationPendingAt = 0;
    confirmationRule = "";
    log("info", "end_call_intent_detected", {
      call_id: callId,
      source,
      tool_call_id: toolCallId,
      reason: endCallReason,
    });

    if (toolCallId) {
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: toolCallId,
            output: JSON.stringify({ ok: true, action: "prepare_final_farewell" }),
          },
        }),
      );
    } else {
      socket.send(JSON.stringify({ type: "response.cancel" }));
    }

    socket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Despídete ahora en español con una sola frase breve, natural y amable. No hagas preguntas ni ofrezcas más ayuda. Esta es la despedida final antes de terminar la llamada.",
        },
      }),
    );
    log("info", "end_call_farewell_requested", {
      call_id: callId,
      source,
      tool_call_id: toolCallId,
    });
    fallbackTimer = setTimeout(() => {
      void performHangup("farewell_timeout");
    }, FAREWELL_FALLBACK_MS);
  };

  const requestEndConfirmation = (rule: string, toolCallId?: string) => {
    if (endCallPending || hangupStarted || confirmationIsPending()) return;
    confirmationPendingAt = Date.now();
    confirmationRule = rule;

    if (toolCallId) {
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: toolCallId,
            output: JSON.stringify({ ok: true, action: "confirmation_required" }),
          },
        }),
      );
    } else {
      socket.send(JSON.stringify({ type: "response.cancel" }));
    }

    log("info", "end_call_confirmation_requested", {
      call_id: callId,
      rule,
      tool_call_id: toolCallId,
      no_response_timeout_ms: CONFIRMATION_IDLE_TIMEOUT_MS,
    });

    socket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Confirma brevemente la intención de terminar diciendo de forma natural: Entiendo que ya has terminado. ¿Necesitas algo más antes de que cierre la llamada? No te despidas todavía. No ofrezcas información adicional y no llames a herramientas en esta respuesta.",
        },
      }),
    );
  };

  const commitAssistantAnnouncedHangup = (transcript: string) => {
    if (endCallPending || hangupStarted) return;
    endCallPending = true;
    endCallReason = "assistant_announced_hangup_without_tool";
    confirmationPendingAt = 0;
    confirmationRule = "";
    log("error", "end_call_assistant_commitment_without_tool", {
      call_id: callId,
      transcript_chars: transcript.length,
    });
    log("info", "end_call_hangup_guard_armed", {
      call_id: callId,
      grace_ms: ASSISTANT_COMMITMENT_GRACE_MS,
    });
    fallbackTimer = setTimeout(() => {
      void performHangup("assistant_hangup_commitment_guard");
    }, ASSISTANT_COMMITMENT_GRACE_MS);
  };

  socket.addEventListener("message", (message) => {
    const text = readWebSocketText(message.data);
    if (!text) return;

    let event: RealtimeSidebandEvent;
    try {
      event = JSON.parse(text) as RealtimeSidebandEvent;
    } catch {
      log("error", "realtime_sideband_invalid_json", { call_id: callId });
      return;
    }

    if (event.type === "error") {
      log("error", "realtime_sideband_error_event", {
        call_id: callId,
        error_type: event.error?.type,
        error_code: event.error?.code,
        error_message: event.error?.message,
      });
      return;
    }

    if (event.type === "response.function_call_arguments.done" && event.name === "end_call") {
      let reason = "model_end_call";
      if (event.arguments) {
        try {
          const parsed = JSON.parse(event.arguments) as { reason?: unknown };
          if (typeof parsed.reason === "string" && parsed.reason.trim()) {
            reason = parsed.reason.trim();
          }
        } catch {
          // Safe default remains.
        }
      }
      requestEndConfirmation(`model_tool:${reason}`, event.call_id);
      return;
    }

    if (event.type === "input_audio_buffer.timeout_triggered" && confirmationIsPending()) {
      log("info", "end_call_confirmation_timeout", {
        call_id: callId,
        rule: confirmationRule,
        timeout_ms: CONFIRMATION_IDLE_TIMEOUT_MS,
      });
      startClosingFlow("confirmation_timeout_no_response", "confirmation_timeout");
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      if (endCallPending || hangupStarted) return;

      if (confirmationIsPending()) {
        const confirmation = classifyConfirmationReply(event.transcript);
        log("info", "end_call_confirmation_classified", {
          call_id: callId,
          result: confirmation,
          rule: confirmationRule,
          transcript_chars: event.transcript.length,
        });
        if (confirmation === "close") {
          startClosingFlow("confirmed_no_more_help", "confirmation_reply");
          return;
        }
        if (confirmation === "continue") {
          clearConfirmation("user_wants_to_continue");
          return;
        }

        const repeatedIntent = classifyEndCallIntent(event.transcript, assistantFarewellIsRecent());
        if (repeatedIntent.level !== "none") {
          log("info", "end_call_confirmation_inferred_close", {
            call_id: callId,
            level: repeatedIntent.level,
            rule: repeatedIntent.rule,
          });
          startClosingFlow(`confirmation_intent:${repeatedIntent.rule}`, "confirmation_reply_intent");
          return;
        }
      }

      const intent = classifyEndCallIntent(event.transcript, assistantFarewellIsRecent());
      log("info", "end_call_intent_classified", {
        call_id: callId,
        level: intent.level,
        rule: intent.rule,
        transcript_chars: event.transcript.length,
        assistant_farewell_recent: assistantFarewellIsRecent(),
        confirmation_pending: confirmationIsPending(),
      });

      if (intent.rule === "explicit_hangup_command") {
        startClosingFlow("explicit_hangup_command", "transcript_detector");
      } else if (intent.level === "clear" || intent.level === "probable") {
        requestEndConfirmation(intent.rule);
      }
      return;
    }

    if (event.type === "response.output_audio_transcript.done" && event.transcript) {
      if (isAssistantHangupCommitment(event.transcript)) {
        commitAssistantAnnouncedHangup(event.transcript);
        return;
      }
      if (isAssistantFarewell(event.transcript)) {
        assistantFarewellAt = Date.now();
        log("info", "end_call_assistant_farewell_observed", {
          call_id: callId,
          transcript_chars: event.transcript.length,
        });
      }
      return;
    }

    if (endCallPending && event.type === "response.created" && !closingResponseId) {
      const responseId = event.response_id ?? event.response?.id;
      if (responseId) {
        closingResponseId = responseId;
        log("info", "end_call_farewell_response_created", {
          call_id: callId,
          response_id: closingResponseId,
        });
      }
      return;
    }

    if (endCallPending && event.type === "output_audio_buffer.stopped") {
      void performHangup("farewell_audio_stopped");
    }
  });

  socket.addEventListener("close", () => {
    clearFallback();
    activeSidebands.delete(callId);
    log("info", "realtime_sideband_closed", {
      call_id: callId,
      end_call_pending: endCallPending,
      hangup_started: hangupStarted,
      confirmation_pending: confirmationIsPending(),
    });
  });

  socket.addEventListener("error", () => {
    log("error", "realtime_sideband_socket_error", { call_id: callId });
  });
}

async function handleOpenAIWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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
    body: responseBody.slice(0, 2_000),
  });
  if (!openAIResponse.ok) {
    return json({ ok: false, error: "openai_accept_failed", status: openAIResponse.status }, 502);
  }

  ctx.waitUntil(
    attachRealtimeSideband(callId, env).catch((error) => {
      log("error", "realtime_sideband_connect_failed", {
        call_id: callId,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );

  return json({
    ok: true,
    call_id: callId,
    tenant_id: env.DEFAULT_TENANT_ID,
    intent_hangup: true,
    intent_hangup_mode: "hybrid_confirm_timeout_v6",
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
        tracing: "f0-e2e-v6",
        intent_hangup: true,
        intent_hangup_mode: "hybrid_confirm_timeout_v6",
        assistant_hangup_commitment_guard: true,
        confirmation_silence_auto_hangup: true,
        confirmation_idle_timeout_ms: CONFIRMATION_IDLE_TIMEOUT_MS,
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
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/webhooks/telnyx") {
      return handleTelnyxWebhook(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/webhooks/openai") {
      return handleOpenAIWebhook(request, env, ctx);
    }
    return json({ ok: false, error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
