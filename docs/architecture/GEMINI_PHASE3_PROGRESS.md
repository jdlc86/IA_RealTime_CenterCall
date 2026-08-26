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

Evidencia validada:

- SHA `9044f8df141b5e1363bd13677472cac82361cea8`: cuatro pipelines SUCCESS tras capability + admission.
- SHA `5275949c7571e1f91d4627cf0b5aea26dd9fb5a7`: handshake integrado admission → capability → router Worker → DO → `EDGE_READY` → `ACK APPLIED`; cuatro pipelines SUCCESS.

## 3B — Admission Telnyx Gemini

- [x] verificación Ed25519 sobre `timestamp|raw_body` antes de parsear JSON.
- [x] PEM/SPKI y raw base64 soportados; ventana temporal bounded configurable.
- [x] identidad Telnyx retry-stable basada en `data.id` + `occurred_at` firmados.
- [x] tenant route provider-neutral reutiliza el contrato KV de número llamado.
- [x] IDs `callSessionId`, `edgeSessionId`, `credentialId` derivados por HMAC domain-separated y estables en retry.
- [x] admission persistida por RPC interno en `GeminiCallSession`.
- [x] retry idéntico = idempotente; rebinding de identidad = rechazado.
- [x] admission emite capability de control con exactamente los mismos bindings/expiry.
- [x] admission construye bootstrap `gemini-edge-control-bootstrap.v1` efímero con WSS + Bearer capability.
- [ ] caller-security pre-call compartida todavía no conectada al nuevo Worker.
- [ ] webhook HTTP Gemini todavía no expuesto.
- [ ] Telnyx `answer` todavía no conectado.
- [ ] Telnyx `streaming_start` todavía no conectado.

## 3C — Edge ↔ DO no productivo

- [x] bootstrap de control Edge↔Worker separado del bootstrap Gemini Live antiguo.
- [x] bootstrap prohíbe identidad sensible en query y exige `wss://.../internal/control`.
- [x] Media Edge canoniza el bootstrap y coloca capability sólo en `Authorization: Bearer`.
- [x] vistas de auditoría no contienen material de capability.
- [x] handshake autenticado demostrado en Cloudflare test runtime hasta `EDGE_READY → ACK APPLIED`.
- [ ] cliente WSS Media Edge mínimo todavía no conectado al runtime real.
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

Implementar un cliente WSS mínimo y provider-specific en Media Edge para `gemini-control.v1` usando el bootstrap autenticado ya validado. Inicialmente sólo debe:

1. abrir WSS con Bearer capability;
2. emitir `EDGE_READY` con sequence/message id propios;
3. correlacionar `ACK/NACK`;
4. mantener estado bounded necesario para reconnect;
5. ser probado con transporte WebSocket inyectado antes de conectar Cloud Run al Worker nuevo.

No debe ejecutar tools, liberar audio ni tocar Telnyx productivo todavía.
