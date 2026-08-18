# IA_RealTime_CenterCall — MASTER PROJECT GUIDE

> **Path estable de compatibilidad. NO RENOMBRAR NI ELIMINAR.**

Este archivo es la puerta de entrada permanente a la documentación del proyecto.

## Continuación operativa más reciente

Estado actualizado al **19 de agosto de 2026**.

Antes de hacer cualquier cambio técnico leer, en este orden:

1. [`docs/MASTER_PROJECT_GUIDE.md`](./MASTER_PROJECT_GUIDE.md)
2. [`docs/SESSION_HANDOFF_2026-08-19.md`](./SESSION_HANDOFF_2026-08-19.md)
3. [`docs/PROJECT_STATUS.md`](./PROJECT_STATUS.md)

El handoff del 17 de agosto se conserva como contexto histórico de la reconstrucción v39+:

- [`docs/SESSION_HANDOFF_2026-08-17.md`](./SESSION_HANDOFF_2026-08-17.md)

## Fuentes de verdad arquitectónicas

- [`docs/architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — arquitectura normativa y media/control plane.
- [`docs/architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — reglas no negociables.
- [`docs/architecture/BUSINESS_VERTICALS.md`](./architecture/BUSINESS_VERTICALS.md) — verticales de negocio.
- [`docs/architecture/HUMAN_HANDOFF.md`](./architecture/HUMAN_HANDOFF.md) — handoff humano transversal.
- [`docs/README.md`](./README.md) — índice documental.

## Baseline estable pre-Gemini — 2026-08-19

Repositorio y rama de trabajo:

```text
jdlc86/IA_RealTime_CenterCall
rebuild/v39-stable-baseline
```

Snapshot estable de recuperación:

```text
stable/pre-gemini-2026-08-19
```

Commit funcional estable validado:

```text
ce23ac070558825ea909cbd7eb973b249bfe0a9e
Control Plane CI #536 — SUCCESS
Run tests          — SUCCESS
Wrangler dry-run   — SUCCESS
```

Validación E2E posterior al deploy correcto:

```text
call_id = rtc_u2_EENcyA4JsYIao1IsOI6n4
fecha local ≈ 2026-08-19 01:35 Europe/Madrid
145 eventos
0 warn / 0 error / 0 critical
```

Secuencia clave validada:

```text
DIRECT_POST_TOOL_RESPONSE_GOVERNED_V26
→ MORE_HELP_QUESTION_OPENED_V41
→ caller: "No gracias"
→ V41_CLOSE_COMMITTED_TO_LIFECYCLE
→ CONTEXTUAL_CLOSE_RESOLVED_V41
   caller_resolution = NO_MORE_HELP
   explicit_close_confirmation_required = false
→ LIFECYCLE_END_CALL_REQUESTED_V18
→ terminal playback
→ drain 750 ms
→ HANGUP_STARTED (TELNYX_SOURCE_LEG)
→ Telnyx HTTP 200
→ HANGUP_COMPLETED
```

Este commit es el **punto de partida estable previo a provider selection/Gemini**. Si un gate posterior rompe comportamiento, comparar contra el snapshot antes de introducir un parche. No hacer rollback ciego sin reconstruir la llamada real.

## Estado Realtime actual

Objetivo comercial: soportar múltiples proveedores realtime por tenant/configuración, manteniendo OpenAI y añadiendo Gemini como alternativa futura.

Actualmente:

```text
ACTIVE_REALTIME_PROVIDER = OPENAI
```

OpenAI sigue siendo el único provider activo.

La limpieza provider-neutral completada incluye:

```text
v19  create reservation tool executor
v23  query/cancel/modify/business_info/end-call compatibility executor
v24  marketing
v25  tool authorization
v26  direct agent runtime / post-tool / session bootstrap
v35  provider-neutral observation/configuration path
v41  contextual closing policy + neutral tool/session/event path
v45  barge-in tool deferral
v48  authoritative clock/session transform path
```

La lógica funcional de reservas, marketing, closing y hangup no fue reemplazada por Gemini ni alterada deliberadamente durante esta limpieza.

## Componentes deliberadamente preservados

No modificar sin evidencia directa:

```text
v36 turn concurrency
v46 terminal sideband close observation
ConversationTurnLifecycle v18
HangupController
TERMINAL_TRANSPORT_DRAIN_MS = 750
Telnyx → OpenAI direct SIP media path
human handoff transport
```

El drain de 750 ms sigue siendo una heurística provisional, pero está validado en la topología OpenAI actual. No usar este trabajo de multi-provider como excusa para tocarlo.

## Cierre contextual v41 — invariantes vigentes

Después de una pregunta explícita de continuidad como:

```text
¿Necesitas algo más en lo que pueda ayudarte?
```

una respuesta clara como:

```text
No gracias
No, gracias
Nada más
```

debe resolverse como cierre contextual directo:

```text
contexto ya resuelto
→ no nueva arbitraje
→ no segunda confirmación
→ despedida
→ lifecycle terminal
→ hangup
```

Una nueva petición prevalece y debe continuar la conversación:

```text
No necesito nada más, pero dime el horario
Gracias, ¿a qué hora cerráis?
```

Fuera del contexto de la pregunta de continuidad, el cierre espontáneo sigue usando las reglas de consenso/ambigüedad definidas por v41.

## Barge-in

La arquitectura v40 sigue siendo autoridad para response ownership/barge-in.

Invariantes:

```text
VAD bruto no autoriza interrupción semántica
protected speech no se interrumpe
INTERRUPT no espera response.done
IGNORE no entra al pipeline semántico
un único response owner
```

V40/V44 todavía requieren limpieza provider-neutral cuidadosa antes de considerar Gemini plug-and-play. No hacer un refactor grande de esas capas sin gate y E2E específico.

## Media plane

Arquitectura estable actual:

```text
PSTN → Telnyx → OpenAI Realtime vía SIP/RTP
```

Cloudflare permanece fuera del transporte continuo de audio.

Para Gemini se debe separar formalmente:

```text
TelephonyProvider
MediaTransport
RealtimeProvider
```

Cualquier media bridge nuevo requiere benchmark, justificación y ADR conforme a `RA-003` y `RA-005`.

## Gates pre-Gemini acordados

Ejecutar secuencialmente, manteniendo OpenAI como único provider activo:

### Gate A — ProviderSelector tenant/KV

- resolver provider desde `TenantConfiguration` y override operativo explícito;
- registry centralizado;
- solo `OPENAI` registrable inicialmente;
- unknown/unsupported provider con política explícita testeada;
- ningún `if (provider === ...)` disperso por CallSession.

### Gate B — V40/V44 provider-neutral

- neutralizar acoplamientos estrictamente necesarios;
- preservar autoridad actual de barge-in;
- CI + E2E con INTERRUPT/IGNORE.

### Gate C — ProviderCapabilities

Contrato explícito de capacidades: audio, VAD, interruption, function calling, transcription, direct SIP, etc.

### Gate D — MediaTransport contract

Separar RealtimeProvider de transporte de audio sin modificar la topología OpenAI estable.

Solo después de cerrar A-D comienza la implementación Gemini.

## Metodología obligatoria

1. Verificar HEAD real de `rebuild/v39-stable-baseline` antes de escribir.
2. No asumir que un SHA documentado sigue siendo el HEAD.
3. Ante un síntoma E2E, recuperar primero `public.call_diagnostic_events`.
4. Reconstruir cronología y ownership antes de cambiar código.
5. Distinguir causa raíz de síntoma.
6. No apilar condiciones/timers para tapar carreras.
7. Un gate = cambio mínimo + prueba + CI verde antes del siguiente.
8. Diferenciar siempre `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO` y `VALIDADO E2E`.
9. Para hangup/handoff/WRITE el modelo no es autoridad irreversible única.
10. No ampliar media plane sin ADR + benchmark.
11. OpenAI y otros proveedores deben permanecer detrás de contratos/adaptadores.
12. No crear forks del Core por tenant.

## Infraestructura conocida

### GitHub

```text
repo = jdlc86/IA_RealTime_CenterCall
work branch = rebuild/v39-stable-baseline
stable snapshot = stable/pre-gemini-2026-08-19
```

### Supabase

```text
project_id = vutekfkbtvfogouwcfvc
diagnostics = public.call_diagnostic_events
```

### Cloudflare

El control-plane vive en Workers. Configuración rápida por tenant usa `TENANT_CONFIG` KV.

No afirmar que un deploy real se ejecutó si la sesión no dispone de una herramienta capaz de ejecutarlo/verificarlo. `Wrangler dry-run` en CI no equivale a deploy.

## Regla de mantenimiento

1. Este archivo no se elimina ni se renombra.
2. La arquitectura normativa sigue en `SYSTEM_ARCHITECTURE.md` y `DESIGN_RULES.md`.
3. El estado operativo actual se mantiene en `PROJECT_STATUS.md` y el handoff más reciente.
4. Una conducta no es `VALIDADA E2E` por tener tests o CI verde.
5. El snapshot `stable/pre-gemini-2026-08-19` no es rama de desarrollo.
6. Antes de modificar el snapshot estable, crear otro checkpoint explícito; no moverlo silenciosamente.
