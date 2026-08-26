# D3/D5 — Authorization quarantine y trust recovery

> **Estado:** BASELINE ARQUITECTÓNICO DEFINIDO / integración real pendiente de Fase 3  
> **Fecha:** 2026-08-26  
> **Relacionado:** `GEMINI_TRANSCRIPT_AUTHORITY_D1.md`, `GEMINI_CONTROL_CONTRACT_V1.md`

## 1. Problema

El diseño Gemini independiente envía audio del caller a Gemini Live inmediatamente para no pagar la latencia STT antes de que el modelo empiece a procesar. En paralelo, Google STT produce la evidencia textual autoritativa para seguridad/tool gating.

Esto crea una ventana en la que Gemini puede producir audio o tool calls antes de recibir `TURN_AUTHORIZED`.

Además, si el caller turn termina siendo rechazado, ese input puede haber entrado ya en el contexto del proveedor. **Descartar output no elimina ese contexto.**

Por ello existen dos mecanismos separados:

1. **D3 output/effect quarantine** — impide que output/tool effects no autorizados salgan al mundo exterior.
2. **D5 trust recovery** — impide continuar una conversación desde un contexto Gemini que ya contiene input rechazado.

## 2. D3 — owner físico en Media Edge

Se introduce `TurnAuthorizationQuarantine` en:

`apps/gemini-media-edge/src/authorization-quarantine.mjs`

El owner no usa timers. Se libera/rechaza exclusivamente por identidad exacta de `turn_id`/`generation_id` y evidencia explícita del Control Plane.

Mientras el caller turn está pendiente:

- audio Gemini nativo se retiene en memoria;
- tool calls se retienen y **no se ejecutan**;
- ninguna salida retenida se envía a Telnyx;
- ninguna tool retenida llega a producir efecto empresarial.

### Límite inicial

Output Gemini nativo es PCM16 mono 24 kHz:

```text
24,000 samples/s × 2 bytes = 48,000 bytes/s
```

Baseline:

```text
MAX_QUARANTINE_AUDIO_BYTES = 128 KiB
≈ 2.73 s de PCM nativo
```

La evidencia D1 de Google STT real mostró:

```text
p50 445.0 ms
p95 598.4 ms
max 648 ms (37 completados)
```

128 KiB proporciona aproximadamente 4.5× el p95 observado sin permitir crecimiento no acotado por sesión.

Este límite es baseline, no SLA. La integración de Fase 3 medirá `activityEnd → TURN_AUTHORIZED` y el high-water mark real antes de tráfico productivo.

### Resultado por autorización

`TURN_AUTHORIZED(turn_id)`:

```text
quarantine
→ libera PCM en orden
→ libera tool call(s) hacia el flujo de autorización/ToolGateway
```

El release no significa que una tool quede automáticamente autorizada: sigue aplicando catálogo, capability, schema, business invariant y confirmación cuando corresponda.

### Resultado por rechazo

`TURN_REJECTED(terminal=true)`:

```text
descartar PCM
descartar tool calls
→ TERMINATE_PROVIDER / política de cierre
```

`TURN_REJECTED(terminal=false)` después de haber enviado el input a Gemini:

```text
descartar PCM
descartar tool calls
→ CLEAN_RESTART_REQUIRED
```

### Overflow

Si audio o tool queue supera el límite antes de autorización:

```text
NO release parcial
NO timer de gracia
NO crecimiento adicional
→ fail closed
→ CLEAN_RESTART_REQUIRED
```

La razón estable para audio es `QUARANTINE_AUDIO_LIMIT`.

## 3. D5 — autoridad en GeminiCallSession DO

Se introduce el planner:

`apps/gemini-control-plane/src/call-lifecycle/rejected-turn-recovery.ts`

Regla normativa:

> Si un turno no confiable entró en Gemini Live, session resumption NO puede utilizarse como recuperación de confianza.

`sessionResumption` preserva contexto; exactamente por eso no sirve para limpiar contexto rechazado.

### Rechazo terminal

```text
TURN_REJECTED terminal
→ TERMINATE_CALL
→ allowSessionResumption = false
```

### Rechazo no terminal con contexto contaminado

```text
TURN_REJECTED non-terminal
+ enteredProviderContext = true
→ CLEAN_RESTART_PROVIDER
→ cerrar conexión Gemini contaminada
→ NO resumption handle
→ crear sesión Gemini nueva
→ mismo system/business trusted state permitido
→ provider_connection_epoch nuevo
→ esperar PROVIDER_RECONNECTED(mode=CLEAN_RESTART)
→ sólo entonces LISTENING
```

No se reconstruye el rejected transcript dentro de la sesión nueva.

## 4. Qué significa “trusted state”

Puede reconstruirse únicamente estado cuya autoridad no dependa del contenido rechazado, por ejemplo:

- system instruction versionada;
- tenant/business configuration;
- catálogo de tools permitido;
- reserva/estado empresarial ya confirmado por backend antes del turno rechazado;
- datos de sesión explícitamente aprobados por policy.

No se transporta automáticamente:

- raw rejected transcript;
- provider conversation history posterior al último trusted checkpoint;
- tool call no autorizado;
- output Gemini de la generación rechazada;
- session resumption handle de la sesión contaminada.

## 5. Relación con `gemini-control.v1`

El contrato v1 ya contiene las señales necesarias:

```text
TURN_AUTHORIZED
TURN_REJECTED { terminal }
PROVIDER_RECONNECTED { mode: CLEAN_RESTART | RESUMED }
```

No se añade otro protocolo sólo para D5.

Invariante:

```text
TURN_REJECTED non-terminal con provider context
MUST eventually be followed by
PROVIDER_RECONNECTED(mode=CLEAN_RESTART)
before a new caller turn can become active.
```

`RESUMED` en esa ruta es una violación de seguridad/lifecycle.

## 6. Tests ya creados

Media Edge quarantine tests cubren:

- release sólo tras autorización exacta;
- tool retenida hasta autorización;
- rechazo no terminal → clean restart;
- rechazo terminal → terminate;
- overflow bounded sin timers;
- mismatch de `turn_id`/`generation_id` fail-closed;
- duplicate tool call ID fail-closed;
- budget default ≈2.73 s.

Control Plane trust-recovery tests cubren:

- terminal rejection nunca habilita resumption;
- rejected context no terminal exige fresh provider connection;
- no se inventa un reset si el contenido nunca entró en provider context.

## 7. Evidencia que aún pertenece a Fase 3

Antes de tráfico productivo hay que medir en el camino integrado:

- `activityEnd → TURN_AUTHORIZED` p50/p95/p99;
- quarantine audio high-water bytes;
- número de generaciones con output antes de auth;
- número de tool calls antes de auth;
- overflow rate;
- clean-restart latency;
- prueba E2E de rechazo no terminal seguida de sesión limpia;
- prueba de que un marcador efímero del turno rechazado no se reinyecta en trusted bootstrap.

Estas métricas no requieren persistir audio ni raw transcript.

## 8. Resultado

D3/D5 dejan de ser incógnitas de diseño:

- **quarantine:** bounded, identity-driven, no timers;
- **tools:** cero efectos antes de autorización;
- **rejected context:** nunca se “limpia” con resumption;
- **non-terminal recovery:** fresh Gemini session desde trusted state;
- **terminal recovery:** cierre.

La integración y benchmark reales se ejecutan en Fase 3 antes de habilitar tráfico del nuevo Gemini Worker.
