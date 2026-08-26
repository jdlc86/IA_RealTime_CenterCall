# Gemini Worker ↔ Media Edge Control Contract v1

> **Estado:** NORMATIVO / FASE 2  
> **Fecha:** 2026-08-26  
> **Protocolo:** `gemini-control.v1`  
> **Autoridad arquitectónica:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Diseño:** [`GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`](./GEMINI_INDEPENDENT_RUNTIME_DESIGN.md)  
> **Revisión:** [`GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md`](./GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md)

## 1. Objetivo

Definir una frontera pequeña, explícita y provider-specific entre:

- `GeminiCallSession` Durable Object, autoridad de control/negocio;
- `Gemini Media Edge`, autoridad de media/wire Gemini Live.

Este contrato sustituirá progresivamente el sideband híbrido actual. No intenta ser compatible con OpenAI ni servir como abstracción universal.

Principios:

1. no transportar audio;
2. identidad de llamada explícita en cada mensaje;
3. orden por secuencia, no por timing heurístico;
4. efectos idempotentes;
5. ACK/NACK explícito para mensajes que cambian estado o producen efectos;
6. una falla no envenena automáticamente comandos posteriores;
7. datos sensibles pueden cruzar efímeramente cuando son necesarios para seguridad/ToolGateway, pero no se persisten/loguean en bruto;
8. reconnect debe reconciliar estado sin reejecutar tools ni duplicar playback;
9. ningún concepto `response.create`, `response.cancel` o provider selector pertenece a este contrato.

---

# 2. Transporte y binding

Transporte objetivo:

```text
Gemini Media Edge  ── WSS client ──► Gemini Control Plane Worker
                                      └─ route/bind
                                         └─ GeminiCallSession DO
                                            WebSocket Hibernation server
```

El WSS se autentica antes de aceptar mensajes de aplicación mediante credencial efímera ligada a:

```text
tenant_id
call_control_id
call_session_id
edge_session_id
contract_version
credential_id
not_after
```

La credencial no aparece en envelopes ni diagnósticos.

El DO debe persistir las fronteras mínimas de control necesarias para sobrevivir hibernación/reconstrucción.

---

# 3. Envelope canónico

Todo mensaje de aplicación usa:

```json
{
  "protocol": "gemini-control.v1",
  "call_session_id": "cs_...",
  "message_id": "msg_...",
  "sequence": 1,
  "type": "EDGE_READY",
  "ack_required": true,
  "payload": {}
}
```

## 3.1 Reglas

### `protocol`

Valor exacto:

```text
gemini-control.v1
```

Cualquier otro valor falla cerrado como `UNSUPPORTED_CONTRACT_VERSION`.

### `call_session_id`

- string no vacío;
- máximo 160 caracteres;
- debe coincidir con el binding autenticado del WSS;
- nunca se cambia durante la conexión.

### `message_id`

- identidad única por mensaje lógico;
- máximo 160 caracteres;
- una retransmisión conserva el mismo `message_id`.

### `sequence`

- entero seguro positivo;
- monotónico por **sender + call_session_id**;
- empieza en 1 para una nueva sesión lógica;
- no se reinicia por reconnect del control WSS;
- se persiste el último sequence aplicado en el DO.

### `type`

Uno de los tipos enumerados en este contrato.

### `ack_required`

- `true` para todo mensaje que cambie ownership/estado o pueda causar un efecto;
- `false` únicamente para mensajes explícitamente declarados best-effort/telemetry;
- `ACK` y `NACK` nunca requieren ACK.

### `payload`

Objeto JSON bounded específico del tipo.

## 3.2 Límites iniciales v1

Hasta benchmark D4:

```text
max envelope UTF-8        64 KiB
max string general        4 KiB
max transcript            3,000 chars
max tool arguments JSON   32 KiB
max tool result JSON      32 KiB
max unacked messages      32 por dirección
max replay window         32 mensajes por dirección
```

Estos límites son de seguridad/boundedness iniciales, no tuning final de rendimiento.

---

# 4. ACK / NACK

## 4.1 ACK

```json
{
  "protocol": "gemini-control.v1",
  "call_session_id": "cs_...",
  "message_id": "msg_ack_...",
  "sequence": 20,
  "type": "ACK",
  "ack_required": false,
  "payload": {
    "acked_message_id": "msg_...",
    "acked_sequence": 12,
    "result": "APPLIED"
  }
}
```

`result`:

```text
APPLIED
DUPLICATE_ALREADY_APPLIED
ACCEPTED_NO_EFFECT
```

## 4.2 NACK

```json
{
  "protocol": "gemini-control.v1",
  "call_session_id": "cs_...",
  "message_id": "msg_nack_...",
  "sequence": 21,
  "type": "NACK",
  "ack_required": false,
  "payload": {
    "rejected_message_id": "msg_...",
    "rejected_sequence": 13,
    "code": "INVALID_STATE",
    "retryable": false,
    "terminal": false
  }
}
```

Códigos base:

```text
INVALID_ENVELOPE
UNSUPPORTED_CONTRACT_VERSION
SESSION_BINDING_MISMATCH
OUT_OF_ORDER_SEQUENCE
REPLAY_WINDOW_EXCEEDED
INVALID_STATE
IDENTITY_MISMATCH
INVALID_PAYLOAD
COMMAND_REJECTED
PROTOCOL_VIOLATION
SESSION_TERMINAL
```

Un NACK no crea un `commandFailure` sticky global. Cada fallo se resuelve por su identidad y política.

---

# 5. Edge → Worker / DO

Todos los eventos siguientes son control-plane events, no telemetría bruta.

## `EDGE_READY`

```json
{
  "edge_session_id": "edge_...",
  "provider_connection_epoch": 1
}
```

Confirma que el Edge ha validado su estado local y puede aceptar comandos.

## `MEDIA_STARTED`

```json
{
  "stream_id": "stream_..."
}
```

No incluye token ni URL.

## `CALLER_ACTIVITY_STARTED`

```json
{
  "turn_id": "turn_...",
  "generation_id_at_start": "gen_... | null"
}
```

`generation_id_at_start` permite correlacionar barge-in.

## `CALLER_ACTIVITY_ENDED`

```json
{
  "turn_id": "turn_..."
}
```

## `CALLER_TRANSCRIPT_READY`

```json
{
  "turn_id": "turn_...",
  "transcript": "texto efímero bounded",
  "authority": "GOOGLE_STT_V2",
  "is_final": true
}
```

Reglas:

- `transcript` puede contener PII; existe para seguridad/semántica empresarial;
- nunca se escribe raw en logs/diagnóstico;
- cualquier persistencia pasa por redacción/política vigente;
- v1 exige `is_final=true` para esta autoridad;
- otras authorities se incorporan sólo tras D1.

## `GEMINI_TOOL_CALL`

```json
{
  "turn_id": "turn_...",
  "tool_call_id": "toolcall_...",
  "tool_name": "restaurant_reservation_create",
  "arguments": {}
}
```

Reglas:

- arguments son efímeros y potencialmente sensibles;
- no se ejecuta ninguna tool en el Edge;
- no se inventan IDs;
- `tool_call_id` debe ser el ID real del proveedor.

## `GEMINI_GENERATION_STARTED`

```json
{
  "turn_id": "turn_... | null",
  "generation_id": "gen_...",
  "origin": "CALLER_TURN | TOOL_CONTINUATION | CONTROL_TURN"
}
```

## `GEMINI_INTERRUPTED`

```json
{
  "generation_id": "gen_..."
}
```

## `GEMINI_GENERATION_COMPLETE`

```json
{
  "generation_id": "gen_..."
}
```

Representa fin de generación del proveedor, no necesariamente fin de playback Telnyx.

## `GEMINI_TURN_COMPLETE`

```json
{
  "generation_id": "gen_..."
}
```

## `PLAYBACK_STARTED`

```json
{
  "generation_id": "gen_...",
  "playback_id": "pb_..."
}
```

## `PLAYBACK_COMPLETED`

```json
{
  "generation_id": "gen_...",
  "playback_id": "pb_..."
}
```

Sólo este evento confirma que el audio correlacionado drenó por la frontera Telnyx definida.

## `SESSION_RESUMPTION_UPDATE`

```json
{
  "provider_connection_epoch": 1,
  "handle_ref": "opaque-local-reference"
}
```

El handle real no cruza ni se persiste en Supabase. `handle_ref` referencia estado seguro local del Edge si se necesita correlación diagnóstica.

## `PROVIDER_GO_AWAY`

```json
{
  "provider_connection_epoch": 1,
  "time_left_ms": 10000
}
```

## `PROVIDER_RECONNECTED`

```json
{
  "previous_provider_connection_epoch": 1,
  "provider_connection_epoch": 2,
  "mode": "RESUMED | CLEAN_RESTART"
}
```

## `MEDIA_CLOSED`

```json
{
  "reason": "TELNYX_STOP | TERMINATED | ERROR"
}
```

## `EDGE_ERROR`

```json
{
  "category": "bounded_stable_code",
  "terminal": true
}
```

No incluye excepción raw, URL, token, prompt ni payload provider.

---

# 6. Worker / DO → Edge

## `TURN_AUTHORIZED`

```json
{
  "command_id": "cmd_...",
  "turn_id": "turn_..."
}
```

Autoriza liberar output de ese caller turn conforme a ownership actual.

## `TURN_REJECTED`

```json
{
  "command_id": "cmd_...",
  "turn_id": "turn_...",
  "policy_code": "CALLER_SECURITY_REJECTED",
  "terminal": true
}
```

Baseline v1:

- rechazo de seguridad es terminal;
- Edge descarta output quarantined y no ejecuta tools;
- para rechazo no terminal se requiere la política de clean-session recovery de D5 antes de habilitarla.

## `TOOL_RESULT`

```json
{
  "command_id": "cmd_...",
  "turn_id": "turn_...",
  "tool_call_id": "toolcall_...",
  "tool_name": "restaurant_reservation_create",
  "result": {}
}
```

Efecto esperado:

```text
FunctionResponse enviado exactamente una vez al tool_call_id real
```

ACK esperado con effect:

```text
FUNCTION_RESPONSE_SENT
```

La idempotencia de negocio/backend se controla separadamente del `command_id` de transporte.

## `TOOL_REJECTED`

```json
{
  "command_id": "cmd_...",
  "turn_id": "turn_...",
  "tool_call_id": "toolcall_...",
  "tool_name": "...",
  "policy_code": "TOOL_NOT_AUTHORIZED",
  "terminal": false
}
```

El Edge no decide cómo transformar esto en éxito. Si la llamada continúa, sólo se devuelve al proveedor una respuesta estructurada de denegación aprobada por el DO.

## `CLEAR_PLAYBACK`

```json
{
  "command_id": "cmd_...",
  "generation_id": "gen_...",
  "reason": "BARGE_IN | TERMINAL | POLICY"
}
```

ACK effect:

```text
PLAYBACK_CLEAR_SENT | PLAYBACK_ALREADY_CLEAR
```

## `SET_PROTECTED_INPUT`

```json
{
  "command_id": "cmd_...",
  "enabled": true,
  "control_turn_id": "control_... | null"
}
```

Cuando `enabled=true`, caller audio no se convierte en caller turn de Gemini.

## `START_CONTROL_TURN`

```json
{
  "command_id": "cmd_...",
  "control_turn_id": "control_...",
  "control_kind": "GREETING | PRESENCE | RECOVERY | HANDOFF_ANNOUNCEMENT | TERMINAL_MESSAGE"
}
```

No transporta texto arbitrario desde callers. La implementación exacta Gemini-native queda sujeta al probe D2.

ACK inicial significa únicamente que el control turn fue aceptado para ejecución. Su final audible se confirma después mediante generation/playback events.

## `TERMINATE_MEDIA`

```json
{
  "command_id": "cmd_...",
  "reason": "CALL_TERMINAL | SECURITY | HANDOFF | PROVIDER_FAILURE"
}
```

ACK effect:

```text
MEDIA_TERMINATION_STARTED | MEDIA_ALREADY_CLOSED
```

---

# 7. Reglas de orden y replay

## 7.1 Recepción normal

Para cada sender:

```text
expected = last_applied_remote_sequence + 1
```

- `sequence == expected`: validar/aplicar;
- `sequence <= last_applied`: deduplicar por `message_id`; devolver ACK duplicate si corresponde;
- `sequence > expected`: NACK `OUT_OF_ORDER_SEQUENCE`; no saltar silenciosamente.

## 7.2 Efectos

Antes de aplicar un comando con `command_id`:

1. validar binding;
2. validar lifecycle state;
3. comprobar `command_id` en ventana/idempotency store;
4. si ya aplicado, no repetir efecto y devolver ACK duplicate;
5. si nuevo, aplicar una vez;
6. registrar resultado bounded de aplicación;
7. devolver ACK.

## 7.3 Reconnect WSS

Al reconectar, ambas partes intercambian un `SYNC` inicial antes de nuevos efectos.

### `SYNC`

```json
{
  "last_remote_sequence_applied": 18,
  "last_local_sequence_emitted": 21,
  "edge_session_id": "edge_..."
}
```

Reglas:

- `SYNC` no cambia business state;
- cada lado retransmite sólo mensajes `ack_required=true` aún no confirmados dentro de la ventana;
- retransmisión conserva `message_id`, `sequence` y `command_id`;
- no se reconstruye un tool result inventando un nuevo command id;
- si la divergencia excede replay window, la sesión falla cerrado o ejecuta recuperación explícita; nunca adivina.

---

# 8. Estado mínimo persistente en `GeminiCallSession` DO

Persistir en fronteras de control, no por audio frame:

```text
contract_version
call_session_id
call_control_id
tenant_id
lifecycle_state
edge_session_id
last_edge_sequence_applied
last_worker_sequence_emitted
recent_applied_message_ids bounded
recent_applied_command_ids bounded
active_turn_id
active_generation_id
pending_tool_calls bounded
terminal_state
business_state_reference / trusted state necesario
```

El WebSocket attachment puede contener:

```text
call_session_id
edge_session_id
contract_version
```

pero no sustituye storage para estado que deba sobrevivir socket close/reconnect.

---

# 9. Lifecycle invariants v1

## I1 — una sesión terminal es absorbente

Después de `TERMINAL` no se aceptan nuevos caller turns, tool effects ni generations normales.

## I2 — un caller turn tiene un único `turn_id`

No se reasigna por transcript, tool call ni reconnect.

## I3 — tool identity es provider-real

`tool_call_id` nunca se sintetiza.

## I4 — una tool no ejecuta efecto por existir en Gemini

ToolGateway sólo se invoca tras autorización completa del DO.

## I5 — backend idempotency ≠ transport idempotency

`command_id` evita duplicar el envío Edge; la operación empresarial usa su propia clave/contrato de idempotencia.

## I6 — generation complete ≠ playback complete

No liberar protected state ni cerrar llamada sólo porque Gemini terminó de generar; usar evidencia de playback cuando la política lo requiera.

## I7 — control turn ≠ caller turn

Control speech nunca crea caller evidence ni autorización de tools.

## I8 — session resumption ≠ trust rollback

Resumption no elimina turnos rechazados.

## I9 — raw sensitive payload is transient

Transcript, tool args y tool result cruzan sólo las fronteras necesarias y se redactan antes de diagnóstico durable.

## I10 — no sticky poison

Un mensaje inválido/fallido no bloquea mensajes futuros no relacionados salvo que la política marque la sesión terminal/protocol-violated.

---

# 10. Tests contract-first requeridos

Antes de conectar el nuevo Worker a tráfico, deben existir tests para:

1. valid envelope v1;
2. version mismatch fail-closed;
3. call-session binding mismatch;
4. monotonic sequence;
5. duplicate message returns duplicate ACK without effect;
6. out-of-order NACK;
7. duplicate `TOOL_RESULT` does not resend FunctionResponse;
8. duplicate backend operation protected independently;
9. reconnect + SYNC + replay of unacked effect;
10. replay window exceeded fail-closed;
11. NACK one command does not poison following independent command;
12. terminal session absorbs new commands/events;
13. raw transcript rejected from diagnostic serializer;
14. oversized transcript/tool payload rejected;
15. tool identity mismatch fails closed;
16. generation complete does not imply playback complete;
17. control turn cannot authorize tool;
18. TURN_REJECTED terminal discards pending output/tool effect;
19. DO state recovery after simulated hibernation/constructor recreation;
20. ACK/NACK correlation by `message_id` + sequence.

---

# 11. Fuera de alcance de v1

No entra todavía:

- audio frames;
- OpenAI wire;
- generic provider commands;
- provider selector;
- arbitrary remote prompts;
- non-terminal security rejection without D5 clean-session proof;
- dynamic migration/failover a OpenAI;
- multiple Media Edge owners simultáneos por una llamada;
- N-Supabase provisioning.

---

# 12. Próxima implementación

Implementar primero como **código puro sin tráfico**:

```text
apps/gemini-control-plane/
  src/control-contract/v1.ts
  src/control-contract/v1.test.mjs
```

Funciones mínimas:

```text
parseEnvelopeV1
validatePayloadV1
applyInboundSequence
classifyReplay
buildAckV1
buildNackV1
```

Después añadir `GeminiCallSession` skeleton y persistencia sólo cuando los invariantes del contrato estén cubiertos por tests.
