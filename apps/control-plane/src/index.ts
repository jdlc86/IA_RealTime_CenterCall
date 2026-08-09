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

type RealtimeSidebandEvent = {
  type?: string;
  event_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  transcript?: string;
  response?: { id?: string; status?: string };
  error?: { type?: string; code?: string; message?: string };
};

type ClosingState = "active" | "confirming" | "closing";

const activeSidebands = new Map<string, WebSocket>();
const IDLE_TIMEOUT_MS = 10_000;
const CONFIRMATION_TTL_MS = 30_000;
const USER_END_SIGNAL_TTL_MS = 30_000;
const FAREWELL_FALLBACK_MS = 7_000;

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

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
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
    /\bpuedes colgar\b/, /\bpuede colgar\b/, /\bcuelga(?: la llamada)?\b/, /\bcuelgue(?: la llamada)?\b/,
    /\bfinaliza la llamada\b/, /\bfinalice la llamada\b/, /\btermina la llamada\b/, /\btermine la llamada\b/,
  ].some((pattern) => pattern.test(text));
}

function isUserEndSignal(raw: string): boolean {
  const text = normalizeText(raw);
  if (!text || hasContextualFarewellMention(text)) return false;
  return [
    /\badios\b/, /\bhasta luego\b/, /\bhasta pronto\b/, /\bnos vemos\b/, /\bchao\b/, /\bciao\b/,
    /\beso es todo\b/, /\beso seria todo\b/, /\bseria todo\b/, /\bnada mas\b/, /\ben nada mas\b/,
    /\bno necesito(?: ya)? nada\b/, /\bno necesito nada mas\b/, /\bno quiero nada mas\b/,
    /\bno necesito mas ayuda\b/, /\bno quiero seguir\b/, /\bno quiero hablar mas\b/, /\bya no quiero hablar\b/,
    /\bya no necesito nada\b/, /\bya no tengo mas preguntas\b/, /\bno tengo mas preguntas\b/,
    /\bno tengo nada mas que consultar\b/, /\bya termine\b/, /\bya he terminado\b/, /\bhe terminado\b/,
    /\btermine la consulta\b/, /\bya termine la consulta\b/, /\bya he terminado la consulta\b/,
    /\bconsulta terminada\b/, /\bhemos terminado\b/, /\bya hemos terminado\b/, /\bme despido\b/,
    /\blo dejamos aqui\b/, /\bdejamos esto aqui\b/, /\bme tengo que ir\b/, /\bcon eso es suficiente\b/,
    /\bcon esto termino\b/, /\bpor mi parte nada mas\b/, /\bde momento nada mas\b/, /\bcreo que ya esta\b/,
    /\bcreo que es todo\b/,
  ].some((pattern) => pattern.test(text));
}

function classifyConfirmationReply(raw: string): "close" | "continue" | "unknown" {
  const text = normalizeText(raw);
  if (!text) return "unknown";
  if ([/^no$/, /^no no$/, /^nada$/, /^nada mas$/, /^en nada$/, /^en nada mas$/, /^ya esta$/, /^ya termine$/, /^ya he terminado$/, /^termine$/, /^adios$/, /^hasta luego$/, /^hasta pronto$/].some((p) => p.test(text))) return "close";
  if (/\bno\b/.test(text) && (/\bnada\b/.test(text) || /\bmas\b/.test(text) || /\bseguir\b/.test(text) || /\bayuda\b/.test(text) || /\bconsulta\b/.test(text))) return "close";
  if (isUserEndSignal(text) || /\bya termine(?: la consulta)?\b/.test(text) || /\bno quiero seguir\b/.test(text)) return "close";
  if ([/^si$/, /^si gracias$/, /^si necesito\b/, /^espera\b/, /^un momento\b/, /^tengo otra pregunta\b/, /^otra cosa\b/, /^ademas\b/, /^quiero continuar\b/, /^no he terminado\b/, /^aun no\b/, /^todavia no\b/].some((p) => p.test(text))) return "continue";
  return "unknown";
}

function isAssistantFarewell(raw: string): boolean {
  const text = normalizeText(raw);
  return [/\badios\b/, /\bhasta luego\b/, /\bhasta pronto\b/, /\bnos vemos\b/, /\bque tengas un buen dia\b/, /\bque tenga un buen dia\b/, /\bha sido un placer\b/, /\bgracias por llamar\b/].some((p) => p.test(text));
}

function isAssistantCloseAcknowledgement(raw: string): boolean {
  const text = normalizeText(raw);
  return [/\bentiendo que (?:ya )?has terminado\b/, /\bentiendo que (?:ya )?ha terminado\b/, /\bentiendo que (?:ya )?terminaste\b/, /\bveo que (?:ya )?has terminado\b/, /\bparece que (?:ya )?has terminado\b/, /\bsi no necesitas nada mas\b/, /\bsi no necesita nada mas\b/, /\bcomo no necesitas nada mas\b/, /\bcomo no necesita nada mas\b/].some((p) => p.test(text));
}

function isAssistantHangupCommitment(raw: string): boolean {
  const text = normalizeText(raw);
  return [/\bvoy a colgar(?: la llamada)?(?: ahora)?\b/, /\bvoy a finalizar(?: la llamada)?(?: ahora)?\b/, /\bvoy a terminar(?: la llamada)?(?: ahora)?\b/, /\bprocedo a colgar(?: la llamada)?\b/, /\bprocedo a finalizar(?: la llamada)?\b/, /\bterminare la llamada(?: ahora)?\b/, /\bfinalizare la llamada(?: ahora)?\b/, /\bcolgare(?: la llamada)?(?: ahora)?\b/].some((p) => p.test(text));
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
    "Si percibes que el usuario quiere terminar la consulta o ya no desea continuar, invoca end_call en vez de repetir preguntas de cortesía.",
    "Después de una señal de cierre no repitas varias veces que entiendes que ha terminado.",
    "No uses end_call por silencio aislado ni por una mención contextual de una despedida.",
    "Nunca anuncies que vas a colgar sin invocar end_call. El Core controla la confirmación, despedida y hangup.",
  ].join("\n");
  return {
    type: "realtime", model: env.REALTIME_MODEL, instructions, output_modalities: ["audio"],
    audio: {
      input: { format: { type: "audio/pcmu" }, transcription: { model: "gpt-4o-mini-transcribe", language: "es" }, turn_detection: { type: "server_vad", create_response: true, interrupt_response: true, threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, idle_timeout_ms: IDLE_TIMEOUT_MS } },
      output: { format: { type: "audio/pcmu" }, voice: env.REALTIME_VOICE },
    },
    tools: [{ type: "function", name: "end_call", description: "Indica que el usuario parece haber terminado la consulta o desea finalizar la llamada. El Core confirmará la intención y realizará el cierre técnico.", parameters: { type: "object", properties: { reason: { type: "string", description: "Motivo breve que indica intención de terminar." } }, required: ["reason"], additionalProperties: false } }],
    tool_choice: "auto",
  };
}

function buildOpenAISipUri(env: Env): string { return `sip:${env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls`; }

async function transferTelnyxCallToOpenAI(callControlId: string, eventId: string, env: Env): Promise<void> {
  const startedAt = Date.now();
  log("info", "telnyx_transfer_start", { call_control_id: callControlId, command_id: eventId, target_host: "sip.api.openai.com" });
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`, { method: "POST", headers: { Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ to: buildOpenAISipUri(env), sip_transport_protocol: "TLS", timeout_secs: 30, command_id: eventId }) });
  const body = await response.text();
  log(response.ok ? "info" : "error", "telnyx_transfer_response", { call_control_id: callControlId, status: response.status, elapsed_ms: Date.now() - startedAt, response: body.slice(0, 2000) });
  if (!response.ok) throw new Error(`Telnyx transfer failed with HTTP ${response.status}`);
}

async function verifyAndParseTelnyxWebhook(rawBody: string, request: Request, env: Env): Promise<TelnyxVoiceEvent> {
  const signature = request.headers.get("telnyx-signature-ed25519"); const timestamp = request.headers.get("telnyx-timestamp");
  if (!signature || !timestamp) throw new Error("Missing Telnyx signature headers");
  const ts = Number(timestamp); if (!Number.isFinite(ts)) throw new Error("Invalid Telnyx timestamp");
  if (Math.abs(Math.floor(Date.now()/1000)-ts)>300) throw new Error("Telnyx webhook timestamp outside 5 minute tolerance");
  const valid = await verifyTelnyxSignature(rawBody, signature, timestamp, requireEnvString(env.TELNYX_PUBLIC_KEY, "TELNYX_PUBLIC_KEY"));
  if (!valid) throw new Error("Telnyx Ed25519 signature verification failed");
  return JSON.parse(rawBody) as TelnyxVoiceEvent;
}

async function handleTelnyxWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await request.text(); let event: TelnyxVoiceEvent;
  try { event = await verifyAndParseTelnyxWebhook(rawBody, request, env); } catch (error) { log("error", "invalid_telnyx_webhook", { error: error instanceof Error ? error.message : String(error) }); return json({ ok:false,error:"invalid_webhook_signature"},403); }
  const eventType=event.data?.event_type??"unknown"; const eventId=event.data?.id??crypto.randomUUID(); const payload=event.data?.payload;
  log("info","telnyx_event",{event_type:eventType,event_id:eventId,attempt:event.meta?.attempt,call_control_id:payload?.call_control_id,call_leg_id:payload?.call_leg_id,call_session_id:payload?.call_session_id,connection_id:payload?.connection_id,direction:payload?.direction,state:payload?.state,from:payload?.from,to:payload?.to,hangup_cause:payload?.hangup_cause,hangup_source:payload?.hangup_source});
  if(eventType==="call.initiated"&&payload?.direction==="incoming"){
    const callControlId=payload.call_control_id; if(!callControlId)return json({ok:false,error:"missing_call_control_id"},400);
    log("info","call_orchestrator_route_selected",{call_control_id:callControlId,tenant_id:env.DEFAULT_TENANT_ID,route:"openai_realtime_sip"});
    ctx.waitUntil(transferTelnyxCallToOpenAI(callControlId,eventId,env).catch((error)=>log("error","call_orchestrator_failed",{call_control_id:callControlId,error:error instanceof Error?error.message:String(error)})));
    return json({ok:true,accepted:true,action:"transfer_to_realtime",tenant_id:env.DEFAULT_TENANT_ID});
  }
  return json({ok:true,ignored:true,event_type:eventType});
}

async function acceptRealtimeCall(callId:string,configuration:RealtimeSessionConfiguration,env:Env):Promise<Response>{
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);const startedAt=Date.now();
  log("info","openai_accept_start",{call_id:callId,model:configuration.model,voice:configuration.audio.output.voice,tools:configuration.tools.map(t=>t.name),input_transcription:configuration.audio.input.transcription.model});
  try{const response=await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,{method:"POST",headers:{Authorization:`Bearer ${requireEnvString(env.OPENAI_API_KEY,"OPENAI_API_KEY")}`,"Content-Type":"application/json","X-Client-Request-Id":crypto.randomUUID()},body:JSON.stringify(configuration),signal:controller.signal});log(response.ok?"info":"error","openai_accept_http",{call_id:callId,status:response.status,elapsed_ms:Date.now()-startedAt});return response;}finally{clearTimeout(timeout);}
}

async function hangupOpenAICall(callId:string,reason:string,env:Env):Promise<void>{
  const startedAt=Date.now();log("info","end_call_hangup_start",{call_id:callId,reason});
  const response=await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,{method:"POST",headers:{Authorization:`Bearer ${requireEnvString(env.OPENAI_API_KEY,"OPENAI_API_KEY")}`}});
  const body=await response.text();log(response.ok?"info":"error","end_call_hangup_result",{call_id:callId,status:response.status,elapsed_ms:Date.now()-startedAt,body:body.slice(0,1000)});if(!response.ok)throw new Error(`OpenAI hangup failed with HTTP ${response.status}`);
}

function readWebSocketText(data:unknown):string|null{if(typeof data==="string")return data;if(data instanceof ArrayBuffer)return new TextDecoder().decode(data);if(ArrayBuffer.isView(data))return new TextDecoder().decode(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));return null;}

async function attachRealtimeSideband(callId:string,env:Env):Promise<void>{
  if(activeSidebands.has(callId)){log("info","realtime_sideband_duplicate_skipped",{call_id:callId});return;}
  const startedAt=Date.now();log("info","realtime_sideband_connect_start",{call_id:callId});
  const response=await fetch(`https://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,{method:"GET",headers:{Authorization:`Bearer ${requireEnvString(env.OPENAI_API_KEY,"OPENAI_API_KEY")}`,"Sec-WebSocket-Protocol":"realtime",Connection:"Upgrade",Upgrade:"websocket"}});
  const socket=(response as Response&{webSocket?:WebSocket}).webSocket;if(!socket){const body=await response.text().catch(()=>"");throw new Error(`Realtime sideband upgrade failed: HTTP ${response.status} ${body.slice(0,500)}`);}socket.accept();activeSidebands.set(callId,socket);log("info","realtime_sideband_connected",{call_id:callId,elapsed_ms:Date.now()-startedAt});
  let state:ClosingState="active";let confirmationPendingAt=0;let lastUserEndSignalAt=0;let closingReason="user_requested_end";let hangupStarted=false;let closingResponseId:string|null=null;let fallbackTimer:ReturnType<typeof setTimeout>|null=null;
  const send=(event:unknown)=>socket.send(JSON.stringify(event));
  const clearFallback=()=>{if(fallbackTimer!==null){clearTimeout(fallbackTimer);fallbackTimer=null;}};
  const userEndSignalRecent=()=>lastUserEndSignalAt>0&&Date.now()-lastUserEndSignalAt<=USER_END_SIGNAL_TTL_MS;
  const confirmationIsPending=()=>state==="confirming"&&confirmationPendingAt>0&&Date.now()-confirmationPendingAt<=CONFIRMATION_TTL_MS;
  const performHangup=async(trigger:string)=>{if(hangupStarted)return;hangupStarted=true;clearFallback();log("info","end_call_hangup_triggered",{call_id:callId,trigger,state,closing_response_id:closingResponseId});try{await hangupOpenAICall(callId,closingReason,env);}catch(error){hangupStarted=false;log("error","end_call_hangup_failed",{call_id:callId,trigger,error:error instanceof Error?error.message:String(error)});}};
  const armHangupAfterCurrentAudio=(reason:string,source:string)=>{if(state==="closing"||hangupStarted)return;state="closing";closingReason=reason;confirmationPendingAt=0;log("info","end_call_closing_armed_current_audio",{call_id:callId,source,reason});fallbackTimer=setTimeout(()=>void performHangup("current_audio_fallback"),FAREWELL_FALLBACK_MS);};
  const beginClosing=(reason:string,source:string)=>{if(state==="closing"||hangupStarted)return;state="closing";closingReason=reason;confirmationPendingAt=0;closingResponseId=null;log("info","end_call_closing_started",{call_id:callId,source,reason});send({type:"response.cancel"});send({type:"response.create",response:{instructions:"Despídete ahora con una sola frase muy breve y natural en español. No preguntes nada más, no repitas que la consulta ha terminado y no ofrezcas ayuda adicional."}});log("info","end_call_final_farewell_requested",{call_id:callId,source});fallbackTimer=setTimeout(()=>void performHangup("final_farewell_fallback"),FAREWELL_FALLBACK_MS);};
  const requestConfirmation=(reason:string,source:string)=>{if(state==="closing"||hangupStarted)return;if(confirmationIsPending()){log("info","end_call_confirmation_duplicate_suppressed",{call_id:callId,source});return;}state="confirming";confirmationPendingAt=Date.now();closingReason=reason;log("info","end_call_confirmation_started",{call_id:callId,source,reason,idle_timeout_ms:IDLE_TIMEOUT_MS});send({type:"response.cancel"});send({type:"response.create",response:{instructions:"Confirma una sola vez y de forma breve que has entendido que el usuario quiere terminar. Pregunta: ¿Quieres que cierre la llamada? Después espera su respuesta y no repitas la pregunta."}});};
  socket.addEventListener("message",(message)=>{const text=readWebSocketText(message.data);if(!text)return;let event:RealtimeSidebandEvent;try{event=JSON.parse(text) as RealtimeSidebandEvent;}catch{log("error","realtime_sideband_invalid_json",{call_id:callId});return;}
    if(event.type==="error"){log("error","realtime_sideband_error_event",{call_id:callId,state,error_type:event.error?.type,error_code:event.error?.code,error_message:event.error?.message});return;}
    if(event.type==="response.function_call_arguments.done"&&event.name==="end_call"){let reason="model_detected_end_intent";if(event.arguments){try{const parsed=JSON.parse(event.arguments) as {reason?:unknown};if(typeof parsed.reason==="string"&&parsed.reason.trim())reason=parsed.reason.trim().slice(0,300);}catch{}}if(event.call_id)send({type:"conversation.item.create",item:{type:"function_call_output",call_id:event.call_id,output:JSON.stringify({ok:true,action:"confirmation_managed_by_core"})}});lastUserEndSignalAt=Date.now();requestConfirmation(reason,"model_tool");return;}
    if(event.type==="conversation.item.input_audio_transcription.completed"&&event.transcript){if(state==="closing"||hangupStarted)return;if(state==="confirming"){const answer=classifyConfirmationReply(event.transcript);log("info","end_call_confirmation_reply",{call_id:callId,result:answer,transcript_chars:event.transcript.length});if(answer==="close"){beginClosing("user_confirmed_end","confirmation_reply");return;}if(answer==="continue"){state="active";confirmationPendingAt=0;lastUserEndSignalAt=0;log("info","end_call_confirmation_cancelled",{call_id:callId,reason:"user_wants_to_continue"});return;}log("info","end_call_confirmation_reply_unknown",{call_id:callId});return;}if(isDirectHangupRequest(event.transcript)){lastUserEndSignalAt=Date.now();beginClosing("explicit_hangup_request","transcript_detector");return;}if(isUserEndSignal(event.transcript)){lastUserEndSignalAt=Date.now();log("info","end_call_user_signal_detected",{call_id:callId,transcript_chars:event.transcript.length});requestConfirmation("user_end_intent","transcript_detector");}return;}
    if(event.type==="input_audio_buffer.timeout_triggered"){if(state==="confirming"){log("info","end_call_confirmation_silence_timeout",{call_id:callId,pending_ms:Date.now()-confirmationPendingAt});beginClosing("confirmation_silence_timeout","idle_timeout");}return;}
    if(event.type==="response.output_audio_transcript.done"&&event.transcript){if(state==="closing")return;if(isAssistantHangupCommitment(event.transcript)){log("error","end_call_assistant_commitment_without_core_close",{call_id:callId,state,transcript_chars:event.transcript.length});armHangupAfterCurrentAudio("assistant_announced_hangup","assistant_commitment_guard");return;}const farewell=isAssistantFarewell(event.transcript);const acknowledgement=isAssistantCloseAcknowledgement(event.transcript);if(state==="confirming"){if(farewell)armHangupAfterCurrentAudio("assistant_farewell_during_confirmation","assistant_output_guard");return;}if(state==="active"&&userEndSignalRecent()){if(farewell){armHangupAfterCurrentAudio("assistant_farewell_after_user_end_signal","assistant_output_guard");return;}if(acknowledgement){state="confirming";confirmationPendingAt=Date.now();log("info","end_call_confirmation_inferred_from_assistant",{call_id:callId,transcript_chars:event.transcript.length});return;}}return;}
    if(state==="closing"&&event.type==="response.created"&&!closingResponseId){closingResponseId=event.response_id??event.response?.id??null;if(closingResponseId)log("info","end_call_final_response_created",{call_id:callId,response_id:closingResponseId});return;}
    if(state==="closing"&&event.type==="output_audio_buffer.stopped"){void performHangup("output_audio_buffer_stopped");return;}
  });
  socket.addEventListener("close",()=>{clearFallback();activeSidebands.delete(callId);log("info","realtime_sideband_closed",{call_id:callId,state,hangup_started:hangupStarted});});
  socket.addEventListener("error",()=>log("error","realtime_sideband_socket_error",{call_id:callId,state}));
}

async function handleOpenAIWebhook(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const rawBody=await request.text();let rawEventType="unknown";try{rawEventType=(JSON.parse(rawBody) as {type?:string}).type??"unknown";}catch{rawEventType="invalid_json";}
  log("info","openai_webhook_received",{webhook_id:request.headers.get("webhook-id"),body_bytes:rawBody.length,raw_event_type:rawEventType});
  const client=new OpenAI({apiKey:requireEnvString(env.OPENAI_API_KEY,"OPENAI_API_KEY"),webhookSecret:requireEnvString(env.OPENAI_WEBHOOK_SECRET,"OPENAI_WEBHOOK_SECRET")});let event:unknown;
  try{event=await client.webhooks.unwrap(rawBody,request.headers);}catch(error){log("error","invalid_openai_webhook",{error:error instanceof Error?error.message:String(error)});return json({ok:false,error:"invalid_webhook_signature"},400);}
  const typedEvent=event as {type?:string};log("info","openai_event",{type:typedEvent.type??"unknown",raw_event_type:rawEventType});if(typedEvent.type!=="realtime.call.incoming")return json({ok:true,ignored:true,event_type:typedEvent.type??"unknown"});
  const incoming=event as RealtimeIncomingCallEvent;const callId=incoming.data?.call_id;if(!callId)return json({ok:false,error:"missing_call_id"},400);const configuration=buildRealtimeSessionConfiguration(env);log("info","realtime_call_incoming",{call_id:callId,tenant_id:env.DEFAULT_TENANT_ID,sip_header_names:incoming.data.sip_headers?.map(h=>h.name)??[]});let openAIResponse:Response;
  try{openAIResponse=await acceptRealtimeCall(callId,configuration,env);}catch(error){log("error","realtime_accept_exception",{call_id:callId,error:error instanceof Error?error.message:String(error)});return json({ok:false,error:"accept_exception"},502);}
  const responseBody=await openAIResponse.text();log(openAIResponse.ok?"info":"error","realtime_accept_result",{call_id:callId,status:openAIResponse.status,body:responseBody.slice(0,2000)});if(!openAIResponse.ok)return json({ok:false,error:"openai_accept_failed",status:openAIResponse.status},502);
  ctx.waitUntil(attachRealtimeSideband(callId,env).catch((error)=>log("error","realtime_sideband_connect_failed",{call_id:callId,error:error instanceof Error?error.message:String(error)})));
  return json({ok:true,call_id:callId,tenant_id:env.DEFAULT_TENANT_ID,intent_hangup:true,intent_hangup_mode:"state_machine_v7"});
}

export default { async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const url=new URL(request.url);
  if(request.method==="GET"&&url.pathname==="/health")return json({ok:true,service:"IA_RealTime_CenterCall",phase:"F0",environment:env.ENVIRONMENT,tenant_id:env.DEFAULT_TENANT_ID,telephony_provider:"telnyx",call_orchestrator:true,telnyx_webhook_verification:"webcrypto-ed25519",tracing:"f0-e2e-v7",intent_hangup:true,intent_hangup_mode:"state_machine_v7",confirmation_silence_auto_hangup:true,confirmation_idle_timeout_ms:IDLE_TIMEOUT_MS,assistant_output_close_guard:true,input_transcription:"gpt-4o-mini-transcribe",runtime_config:{openai_api_key:typeof env.OPENAI_API_KEY==="string"&&env.OPENAI_API_KEY.length>0,openai_webhook_secret:typeof env.OPENAI_WEBHOOK_SECRET==="string"&&env.OPENAI_WEBHOOK_SECRET.length>0,openai_project_id:typeof env.OPENAI_PROJECT_ID==="string"&&env.OPENAI_PROJECT_ID.length>0,telnyx_api_key:typeof env.TELNYX_API_KEY==="string"&&env.TELNYX_API_KEY.length>0,telnyx_public_key:typeof env.TELNYX_PUBLIC_KEY==="string"&&env.TELNYX_PUBLIC_KEY.length>0}});
  if(request.method==="POST"&&url.pathname==="/webhooks/telnyx")return handleTelnyxWebhook(request,env,ctx);
  if(request.method==="POST"&&url.pathname==="/webhooks/openai")return handleOpenAIWebhook(request,env,ctx);
  return json({ok:false,error:"not_found"},404);
}} satisfies ExportedHandler<Env>;
