# Gemini independiente — progreso vivo Fase 3

> Estado: ACTIVO  
> Rama: `rebuild/v39-stable-baseline`  
> PR: `#85` (debe permanecer OPEN/DRAFT)  
> Arquitectura autoridad: `ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`

Este documento es el checkpoint operativo de Fase 3. Debe actualizarse conforme se validen slices. El código híbrido existente no es la especificación del runtime nuevo.

## 3A — GeminiCallSession / control contract

- [x] `apps/gemini-control-plane` existe como aplicación separada.
- [x] `GeminiCallSession` Durable Object independiente de OpenAI.
- [x] lifecycle pequeño propio, sin herencia `CallSession V2→V54`.
- [x] direcciones `EDGE_TO_WORKER` / `WORKER_TO_EDGE` explícitas.
- [x] eventos inválidos por estado reciben NACK y no consumen inbound sequence.
- [x] lifecycle + message id + inbound sequence se persisten atómicamente en SQLite.
- [x] outbound sequence persiste tras reconnect.
- [x] duplicate / gap / reconnect probados en Cloudflare test runtime.
- [x] admission previa obligatoria antes de WSS.
- [x] WSS público ya no confía en `call_session_id`, `edge_session_id` ni `credential_id` en query string.
- [x] capability HMAC `gemini-control-capability.v1` requerida como `Authorization: Bearer`.
- [x] Worker verifica capability y deriva los bindings; el DO compara tenant/call/session/edge/credential/expiry con admission persistida.
- [ ] `SYNC`/replay completo de mensajes worker→edge aún no implementado.
- [ ] comandos worker→edge con effect idempotency aún no conectados al runtime real.

Evidencia validada: SHA `9044f8df141b5e1363bd13677472cac82361cea8` — Gemini Control Plane CI, Gemini Media Edge CI, Benchmark CI y Control Plane CI SUCCESS.

## 3B — Admission Telnyx Gemini

- [x] verificación Ed25519 sobre `timestamp|raw_body` antes de parsear JSON.
- [x] PEM/SPKI y raw base64 soportados; ventana temporal bounded configurable.
- [x] identidad Telnyx retry-stable basada en `data.id` + `occurred_at` firmados.
- [x] tenant route provider-neutral reutiliza el contrato KV de número llamado.
- [x] IDs `callSessionId`, `edgeSessionId`, `credentialId` derivados por HMAC domain-separated y estables en retry.
- [x] admission persistida por RPC interno en `GeminiCallSession`.
- [x] retry idéntico = idempotente; rebinding de identidad = rechazado.
- [x] admission emite capability de control con exactamente los mismos bindings/expiry.
- [ ] caller-security pre-call compartida todavía no conectada al nuevo Worker.
- [ ] webhook HTTP Gemini todavía no expuesto.
- [ ] Telnyx `answer` todavía no conectado.
- [ ] Telnyx `streaming_start` todavía no conectado.

## 3C — Edge ↔ DO no productivo

- [ ] definir bootstrap de control Edge↔Worker separado del bootstrap Gemini Live antiguo.
- [ ] Media Edge usa capability Bearer y no identidad sensible en URL.
- [ ] conectar WSS no productivo.
- [ ] medir RTT p50/p95/p99.
- [ ] medir reconnect/SYNC/replay.
- [ ] medir quarantine high-water.

## 3D — Tools / negocio

- [ ] Gemini tool call → DO → ToolGateway → dominio/Supabase.
- [ ] FunctionResponse mismo tool_call_id en la misma sesión Live.
- [ ] reserva progresiva / outside-hours / BOOKED.
- [ ] cero efecto antes de autorización.

## 3E — Trust/audio

- [ ] conectar `TurnAuthorizationQuarantine` al runtime nuevo.
- [ ] Google STT authority en paralelo.
- [ ] clean restart para contexto rechazado.
- [ ] control turns single-voice Gemini Live.

## 3F — E2E / canary antes de tráfico

Pendiente completo. No habilitar número productivo hasta cerrar los gates E2E/canary.

## Siguiente acción exacta

Definir y probar un bootstrap `edge-control` efímero que transporte únicamente:

- identidad inmutable de admission;
- endpoint WSS del Gemini Worker;
- capability Bearer opaca;
- expiry.

No debe incluir audio, transcript, PII, secretos de firma, Gemini API key, tools ni instrucciones del modelo. Después el Media Edge podrá abrir un WSS no productivo contra el nuevo Worker y medir el contrato real.
