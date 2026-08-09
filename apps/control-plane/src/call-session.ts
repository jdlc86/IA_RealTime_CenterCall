import { DurableObject } from "cloudflare:workers";

type CallSessionEnv = {
  OPENAI_API_KEY: string;
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

type ClosingState = "active" | "confirming" | "closing";

const IDLE_TIMEOUT_MS = 10_000;
const CONFIRMATION_TTL_MS = 30_000;
const USER_END_SIGNAL_TTL_MS = 30_000;
const FINAL_FAREWELL_WATCHDOG_MS = 7_000;
const HANGUP_RETRY_DELAY_MS = 300;
const HANGUP_MAX_ATTEMPTS = 2;

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ level, event, component: "CallSession", ...details });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

function requireEnvString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
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

function hasContextualFarewellMention(text: string): boolean {
  return [
    /\b(me|nos|le|les) dijo (adios|hasta luego)\b/,
    /\b(dijo|dijeron) (adios|hasta luego)\b/,
    /\b(decir|diga|dice|dices|dijo) adios\b/,
    /\b(palabra|expresion) adios\b/,
    /\b(significa|significado de) adios\b/,
    /\bcomo se dice adios\b/,
    /\bcuando alguien dice (adios|hasta luego)\b/,
  ].some((pattern) => pattern.test(text));
}

function isDirectHangupRequest(raw: string): boolean {
  const text = normalizeText(raw);
  return [
    /\bpuedes colgar\b/,
    /\bpuede colgar\b/,
    /\bcuelga(?: la llamada)?\b/,
    /\bcuelgue(?: la llamada)?\b/,
    /\bfinaliza la llamada\b/,
    /\bfinalice la llamada\b/,
    /\btermina la llamada\b/,
    /\btermine la llamada\b/,
  ].some((pattern) => pattern.test(text));
}

function isUserEndSignal(raw: string): boolean {
  const text = normalizeText(raw);
  if (!text || hasContextualFarewellMention(text)) return false;
  return [
    /\badios\b/,
    /\bhasta luego\b/,
    /\bhasta pronto\b/,
    /\bnos vemos\b/,
    /\bchao\b/,
    /\bciao\b/,
    /\beso es todo\b/,
    /\beso seria todo\b/,
    /\bseria todo\b/,
    /\bnada mas\b/,
    /\ben nada mas\b/,
    /\bno necesito(?: ya)? nada\b/,
    /\bno necesito nada mas\b/,
    /\bno quiero nada mas\b/,
    /\bno necesito mas ayuda\b/,
    /\bno quiero seguir\b/,
    /\bno quiero hablar mas\b/,
    /\bya no quiero hablar\b/,
    /\bya no necesito nada\b/,
    /\bya no tengo mas preguntas\b/,
    /\bno tengo mas preguntas\b/,
    /\bno tengo nada mas que consultar\b/,
    /\bya termine\b/,
    /\bya he terminado\b/,
    /\bhe terminado\b/,
    /\btermine la consulta\b/,
    /\bya termine la consulta\b/,
    /\bya he terminado la consulta\b/,
    /\bconsulta terminada\b/,
    /\bhemos terminado\b/,
    /\bya hemos terminado\b/,
    /\bme despido\b/,
    /\blo dejamos aqui\b/,
    /\bdejamos esto aqui\b/,
    /\bme tengo que ir\b/,
    /\bcon eso es suficiente\b/,
    /\bcon esto termino\b/,
    /\bpor mi parte nada mas\b/,
    /\bde momento nada mas\b/,
    /\bcreo que ya esta\b/,
    /\bcreo que es todo\b/,
  ].some((pattern) => pattern.test(text));
}

function classifyConfirmationReply(raw: string): "close" | "continue" | "unknown" {
  const text = normalizeText(raw);
  if (!text) return "unknown";

  if (
    [
      /^no$/,
      /^no no$/,
      /^nada$/,
      /^nada mas$/,
      /^en nada$/,
      /^en nada mas$/,
      /^ya esta$/,
      /^ya termine$/,
      /^ya he terminado$/,
      /^termine$/,
      /^adios$/,
      /^hasta luego$/,
      /^hasta pronto$/,
    ].some((pattern) => pattern.test(text))
  ) {
    return "close";
  }

  if (
    /\bno\b/.test(text) &&
    (/\bnada\b/.test(text) || /\bmas\b/.test(text) || /\bseguir\b/.test(text) || /\bayuda\b/.test(text) || /\bconsulta\b/.test(text))
  ) {
    return "close";
  }

  if (isUserEndSignal(text)) return "close";

  if (
    [
      /^si$/,
      /^si gracias$/,
      /^si necesito\b/,
      /^espera\b/,
      /^un momento\b/,
      /^tengo otra pregunta\b/,
      /^otra cosa\b/,
      /^ademas\b/,
      /^quiero continuar\b/,
      /^no he terminado\b/,
      /^aun no\b/,
      /^todavia no\b/,
    ].some((pattern) => pattern.test(text))
  ) {
    return "continue";
  }

  return "unknown";
}

function isAssistantFarewell(raw: string): boolean {
  const text = normalizeText(raw);
  return [
    /\badios\b/,
    /\bhasta luego\b/,
    /\bhasta pronto\b/,
    /\bnos vemos\b/,
    /\bque tengas un buen dia\b/,
    /\bque tenga un buen dia\b/,
    /\bha sido un placer\b/,
    /\bgracias por llamar\b/,
  ].some((pattern) => pattern.test(text));
}

function isAssistantCloseAcknowledgement(raw: string): boolean {
  const text = normalizeText(raw);
  return [
    /\bentiendo que (?:ya )?has terminado\b/,
    /\bentiendo que (?:ya )?ha terminado\b/,
    /\bentiendo que (?:ya )?terminaste\b/,
    /\bveo que (?:ya )?has terminado\b/,
    /\bparece que (?:ya )?has terminado\b/,
    /\bsi no necesitas nada mas\b/,
    /\bsi no necesita nada mas\b/,
  ].some((pattern) => pattern.test(text));
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

export class CallSession extends DurableObject<CallSessionEnv> {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private callId: string | null = null;
  private state: ClosingState = "active";
  private confirmationPendingAt = 0;
  private lastUserEndSignalAt = 0;
  private closingReason = "user_requested_end";
  private hangupStarted = false;
  private closingResponseId: string | null = null;
  private finalFarewellWatchdog: ReturnType<typeof setTimeout> | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      const body = (await request.json()) as { call_id?: unknown };
      if (typeof body.call_id !== "string" || !body.call_id.trim()) {
        return Response.json({ ok: false, error: "missing_call_id" }, { status: 400 });
      }

      const callId = body.call_id.trim();
      if (this.callId && this.callId !== callId) {
        return Response.json({ ok: false, error: "call_session_id_mismatch" }, { status: 409 });
      }

      this.callId = callId;
      if (!this.socket) {
        this.connectPromise ??= this.connectSideband(callId).finally(() => {
          this.connectPromise = null;
        });
        await this.connectPromise;
      }

      return Response.json({ ok: true, call_id: callId, state: this.state, sideband: "durable_object" });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json({
        ok: true,
        call_id: this.callId,
        state: this.state,
        websocket_connected: this.socket !== null,
        hangup_started: this.hangupStarted,
      });
    }

    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  private async connectSideband(callId: string): Promise<void> {
    const startedAt = Date.now();
    log("info", "realtime_sideband_connect_start", { call_id: callId });

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
      elapsed_ms: Date.now() - startedAt,
      lifecycle: "durable_object_outbound_websocket",
    });

    socket.addEventListener("message", (event) => {
      void this.handleRealtimeMessage(event.data);
    });

    socket.addEventListener("close", () => {
      this.clearFinalFarewellWatchdog();
      this.socket = null;
      log("info", "realtime_sideband_closed", {
        call_id: this.callId,
        state: this.state,
        hangup_started: this.hangupStarted,
      });
    });

    socket.addEventListener("error", () => {
      log("error", "realtime_sideband_socket_error", { call_id: this.callId, state: this.state });
    });
  }

  private send(event: unknown): void {
    if (!this.socket) throw new Error("Realtime sideband socket is not connected");
    this.socket.send(JSON.stringify(event));
  }

  private sendBestEffortCancel(): void {
    if (!this.socket) return;
    this.send({ type: "response.cancel" });
  }

  private confirmationIsPending(): boolean {
    return (
      this.state === "confirming" &&
      this.confirmationPendingAt > 0 &&
      Date.now() - this.confirmationPendingAt <= CONFIRMATION_TTL_MS
    );
  }

  private userEndSignalRecent(): boolean {
    return this.lastUserEndSignalAt > 0 && Date.now() - this.lastUserEndSignalAt <= USER_END_SIGNAL_TTL_MS;
  }

  private clearFinalFarewellWatchdog(): void {
    if (this.finalFarewellWatchdog !== null) {
      clearTimeout(this.finalFarewellWatchdog);
      this.finalFarewellWatchdog = null;
    }
  }

  private requestConfirmation(reason: string, source: string): void {
    if (this.state === "closing" || this.hangupStarted) return;
    if (this.confirmationIsPending()) {
      log("info", "end_call_confirmation_duplicate_suppressed", { call_id: this.callId, source });
      return;
    }

    this.state = "confirming";
    this.confirmationPendingAt = Date.now();
    this.closingReason = reason;
    log("info", "end_call_confirmation_started", {
      call_id: this.callId,
      source,
      reason,
      idle_timeout_ms: IDLE_TIMEOUT_MS,
    });

    this.sendBestEffortCancel();
    this.send({
      type: "response.create",
      response: {
        instructions:
          "Confirma una sola vez y de forma breve que has entendido que el usuario quiere terminar. Pregunta exactamente: ¿Quieres que cierre la llamada? Después espera su respuesta y no repitas la pregunta.",
      },
    });
  }

  private beginClosing(reason: string, source: string): void {
    if (this.state === "closing" || this.hangupStarted) return;

    this.state = "closing";
    this.closingReason = reason;
    this.confirmationPendingAt = 0;
    this.closingResponseId = null;
    log("info", "end_call_closing_started", { call_id: this.callId, source, reason });

    this.sendBestEffortCancel();
    this.send({
      type: "response.create",
      response: {
        instructions:
          "Despídete ahora con una sola frase muy breve, natural y amable en español. No preguntes nada más, no repitas que la consulta ha terminado y no ofrezcas ayuda adicional.",
      },
    });
    log("info", "end_call_final_farewell_requested", { call_id: this.callId, source });

    this.clearFinalFarewellWatchdog();
    this.finalFarewellWatchdog = setTimeout(() => {
      void this.performHangup("final_farewell_watchdog");
    }, FINAL_FAREWELL_WATCHDOG_MS);
  }

  private armHangupAfterCurrentAudio(reason: string, source: string): void {
    if (this.state === "closing" || this.hangupStarted) return;
    this.state = "closing";
    this.closingReason = reason;
    this.confirmationPendingAt = 0;
    this.closingResponseId = null;
    log("info", "end_call_closing_armed_current_audio", { call_id: this.callId, source, reason });

    this.clearFinalFarewellWatchdog();
    this.finalFarewellWatchdog = setTimeout(() => {
      void this.performHangup("current_audio_watchdog");
    }, FINAL_FAREWELL_WATCHDOG_MS);
  }

  private async performHangup(trigger: string): Promise<void> {
    if (this.hangupStarted || !this.callId) return;
    this.hangupStarted = true;
    this.clearFinalFarewellWatchdog();

    log("info", "end_call_hangup_triggered", {
      call_id: this.callId,
      trigger,
      state: this.state,
      closing_response_id: this.closingResponseId,
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= HANGUP_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.hangupOpenAICall(this.callId, this.closingReason, attempt);
        return;
      } catch (error) {
        lastError = error;
        log("error", "end_call_hangup_attempt_failed", {
          call_id: this.callId,
          trigger,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < HANGUP_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, HANGUP_RETRY_DELAY_MS));
        }
      }
    }

    this.hangupStarted = false;
    this.state = "active";
    this.confirmationPendingAt = 0;
    this.lastUserEndSignalAt = 0;
    log("error", "end_call_hangup_abandoned_session_reactivated", {
      call_id: this.callId,
      trigger,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });

    if (this.socket) {
      this.send({
        type: "response.create",
        response: {
          instructions:
            "No se pudo cerrar automáticamente la llamada. Indica brevemente al usuario que la llamada sigue activa y que puede continuar hablando o colgar manualmente.",
        },
      });
    }
  }

  private async hangupOpenAICall(callId: string, reason: string, attempt: number): Promise<void> {
    const startedAt = Date.now();
    log("info", "end_call_hangup_start", { call_id: callId, reason, attempt });

    const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnvString(this.env.OPENAI_API_KEY, "OPENAI_API_KEY")}`,
      },
    });

    const body = await response.text();
    log(response.ok ? "info" : "error", "end_call_hangup_result", {
      call_id: callId,
      status: response.status,
      elapsed_ms: Date.now() - startedAt,
      attempt,
      body: body.slice(0, 1000),
    });

    if (!response.ok) throw new Error(`OpenAI hangup failed with HTTP ${response.status}`);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readWebSocketText(data);
    if (!text) return;

    let event: RealtimeSidebandEvent;
    try {
      event = JSON.parse(text) as RealtimeSidebandEvent;
    } catch {
      log("error", "realtime_sideband_invalid_json", { call_id: this.callId });
      return;
    }

    if (event.type === "error") {
      if (event.error?.code === "response_cancel_not_active") {
        log("info", "realtime_sideband_cancel_noop", { call_id: this.callId, state: this.state });
        return;
      }

      log("error", "realtime_sideband_error_event", {
        call_id: this.callId,
        state: this.state,
        error_type: event.error?.type,
        error_code: event.error?.code,
        error_message: event.error?.message,
      });
      return;
    }

    if (event.type === "response.function_call_arguments.done" && event.name === "end_call") {
      let reason = "model_detected_end_intent";
      if (event.arguments) {
        try {
          const parsed = JSON.parse(event.arguments) as { reason?: unknown };
          if (typeof parsed.reason === "string" && parsed.reason.trim()) reason = parsed.reason.trim().slice(0, 300);
        } catch {
          // Keep safe default.
        }
      }

      if (event.call_id) {
        this.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: event.call_id,
            output: JSON.stringify({ ok: true, action: "confirmation_managed_by_core" }),
          },
        });
      }

      this.lastUserEndSignalAt = Date.now();
      this.requestConfirmation(reason, "model_tool");
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      if (this.hangupStarted) return;

      if (this.state === "closing") {
        log("info", "end_call_user_audio_during_closing", {
          call_id: this.callId,
          transcript_chars: event.transcript.length,
        });
        return;
      }

      if (this.state === "confirming") {
        const answer = classifyConfirmationReply(event.transcript);
        log("info", "end_call_confirmation_reply", {
          call_id: this.callId,
          result: answer,
          transcript_chars: event.transcript.length,
        });

        if (answer === "close") {
          this.beginClosing("user_confirmed_end", "confirmation_reply");
          return;
        }

        if (answer === "continue") {
          this.state = "active";
          this.confirmationPendingAt = 0;
          this.lastUserEndSignalAt = 0;
          log("info", "end_call_confirmation_cancelled", {
            call_id: this.callId,
            reason: "user_wants_to_continue",
          });
          return;
        }

        return;
      }

      if (isDirectHangupRequest(event.transcript)) {
        this.lastUserEndSignalAt = Date.now();
        this.beginClosing("explicit_hangup_request", "transcript_detector");
        return;
      }

      if (isUserEndSignal(event.transcript)) {
        this.lastUserEndSignalAt = Date.now();
        log("info", "end_call_user_signal_detected", {
          call_id: this.callId,
          transcript_chars: event.transcript.length,
        });
        this.requestConfirmation("user_end_intent", "transcript_detector");
      }
      return;
    }

    if (event.type === "input_audio_buffer.timeout_triggered") {
      if (this.state === "confirming") {
        log("info", "end_call_confirmation_silence_timeout", {
          call_id: this.callId,
          pending_ms: Date.now() - this.confirmationPendingAt,
        });
        this.beginClosing("confirmation_silence_timeout", "idle_timeout");
      }
      return;
    }

    if (event.type === "response.output_audio_transcript.done" && event.transcript) {
      if (this.state === "closing") return;

      if (isAssistantHangupCommitment(event.transcript)) {
        log("error", "end_call_assistant_commitment_without_core_close", {
          call_id: this.callId,
          state: this.state,
          transcript_chars: event.transcript.length,
        });
        this.armHangupAfterCurrentAudio("assistant_announced_hangup", "assistant_commitment_guard");
        return;
      }

      const farewell = isAssistantFarewell(event.transcript);
      const acknowledgement = isAssistantCloseAcknowledgement(event.transcript);

      if (this.state === "confirming") {
        if (farewell) {
          this.armHangupAfterCurrentAudio("assistant_farewell_during_confirmation", "assistant_output_guard");
        }
        return;
      }

      if (this.state === "active" && this.userEndSignalRecent()) {
        if (farewell) {
          this.armHangupAfterCurrentAudio("assistant_farewell_after_user_end_signal", "assistant_output_guard");
          return;
        }
        if (acknowledgement) {
          this.state = "confirming";
          this.confirmationPendingAt = Date.now();
          log("info", "end_call_confirmation_inferred_from_assistant", {
            call_id: this.callId,
            transcript_chars: event.transcript.length,
          });
        }
      }
      return;
    }

    if (this.state === "closing" && event.type === "response.created" && !this.closingResponseId) {
      this.closingResponseId = event.response_id ?? event.response?.id ?? null;
      if (this.closingResponseId) {
        log("info", "end_call_final_response_created", {
          call_id: this.callId,
          response_id: this.closingResponseId,
        });
      }
      return;
    }

    if (this.state === "closing" && event.type === "output_audio_buffer.stopped") {
      if (!this.closingResponseId || event.response_id === this.closingResponseId) {
        await this.performHangup("output_audio_buffer_stopped");
      } else {
        log("info", "end_call_nonfinal_audio_stopped_ignored", {
          call_id: this.callId,
          response_id: event.response_id,
          closing_response_id: this.closingResponseId,
        });
      }
    }
  }
}
