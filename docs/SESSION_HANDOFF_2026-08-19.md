# SESSION HANDOFF — 2026-08-19

> Continuación operativa posterior a la neutralización de la frontera Realtime y a la validación E2E de cierre contextual.
>
> Repositorio: `jdlc86/IA_RealTime_CenterCall`
> Rama de trabajo: `rebuild/v39-stable-baseline`
> Snapshot estable de recuperación: `stable/pre-gemini-2026-08-19`
> Runtime estable validado: `ce23ac070558825ea909cbd7eb973b249bfe0a9e`
> Zona horaria de negocio: `Europe/Madrid`

## 1. Punto de partida estable antes de Gemini

El commit siguiente queda registrado como baseline funcional estable previo a los trabajos de selección multi-provider y Gemini:

```text
ce23ac070558825ea909cbd7eb973b249bfe0a9e
```

GitHub Actions:

```text
Control Plane CI #536 — SUCCESS
Run tests          — SUCCESS
Wrangler dry-run   — SUCCESS
```

Validación E2E posterior al despliegue actualizado:

```text
call_id = rtc_u2_EENcyA4JsYIao1IsOI6n4
fecha local = 2026-08-19 ~01:35 Europe/Madrid
eventos = 145
warn/error/critical = 0
```

Secuencia de cierre validada:

```text
DIRECT_POST_TOOL_RESPONSE_GOVERNED_V26
→ MORE_HELP_QUESTION_OPENED_V41
→ caller: "No gracias"
→ V41_CLOSE_COMMITTED_TO_LIFECYCLE
→ CONTEXTUAL_CLOSE_RESOLVED_V41
   context = ANSWER_TO_MORE_HELP_QUESTION
   caller_resolution = NO_MORE_HELP
   arbitration_required = false
   explicit_close_confirmation_required = false
→ LIFECYCLE_END_CALL_REQUESTED_V18
→ terminal playback
→ drain 750 ms
→ HANGUP_STARTED (TELNYX_SOURCE_LEG)
→ Telnyx HTTP 200
→ HANGUP_COMPLETED
```

No apareció segunda confirmación de cierre. El sideband `1006` ocurrió después de `hangup_started=true` y sigue tratándose como consecuencia del cierre, no como causa.

### Regla de recuperación

Si un cambio posterior rompe comportamiento validado y no puede aislarse rápidamente por gate, comparar primero contra:

```text
stable/pre-gemini-2026-08-19
ce23ac070558825ea909cbd7eb973b249bfe0a9e
```

No hacer rollback ciego: reconstruir primero la llamada afectada y distinguir la garantía realmente codificada del comportamiento de facto.

## 2. Objetivo comercial multi-provider

El producto debe permitir seleccionar el proveedor realtime por tenant/configuración operativa, no mediante forks del Core.

Objetivo final:

```text
TenantConfiguration / KV override
              │
              ▼
      RealtimeProviderSelector
          ┌──────┴──────┐
          ▼             ▼
       OpenAI         Gemini Live
```

La selección de provider deberá poder depender del tenant y de la política comercial/coste contratada por el cliente final.

OpenAI NO se elimina. Gemini se incorporará como proveedor adicional.

## 3. Restricción vigente hasta terminar los gates pre-Gemini

Hasta que se cierre explícitamente la fase de preparación:

```text
ACTIVE_REALTIME_PROVIDER = OPENAI
```

OpenAI sigue siendo el único provider activo. Ningún gate de limpieza previo a Gemini debe cambiar comportamiento conversacional, media path, reservas, closing, hangup ni transportes validados.

## 4. Trabajo completado — neutralización Realtime

### 4.1 Frontera central provider-neutral

Existe una fachada/contrato provider-neutral para comandos y eventos realtime. El adaptador OpenAI traduce esa intención al protocolo OpenAI actual.

Conceptualmente:

```text
Core / CallSession
      │
      ▼
Realtime provider-neutral boundary
      │
      ▼
OpenAIRealtimeCommandAdapter / OpenAI event adapter
      │
      ▼
OpenAI Realtime
```

La selección todavía está fijada a OpenAI deliberadamente.

### 4.2 V26

V26 ya no debe depender de nombres wire OpenAI para:

- entrada de tool calls;
- correlación de `callId`;
- post-tool terminal policy;
- creación de respuesta posterior a tools;
- bootstrap/update de sesión.

La política funcional sigue siendo la misma:

- BOOKED sin marketing pendiente → continuación determinista;
- BOOKED con marketing pendiente → marketing primero;
- query/cancel/modify/business_info terminales → continuación determinista;
- marketing completado → continuación determinista;
- herramientas deshabilitadas en la respuesta gobernada.

Pregunta formal vigente:

```text
¿Necesitas algo más en lo que pueda ayudarte?
```

### 4.3 V41

La semántica de cierre se conserva, pero los eventos/tools/session policy tienen ruta provider-neutral.

Invariantes actuales:

```text
pregunta de más ayuda + respuesta negativa clara -> cierre contextual directo
pregunta de más ayuda + nueva petición           -> continuar
cierre espontáneo + consenso fuerte              -> cerrar
cierre espontáneo ambiguo                        -> confirmar explícitamente
cortesía aislada fuera de contexto                -> no cerrar por sí sola
```

Regresión corregida y validada: `No gracias` después de la pregunta de continuidad debe cerrar sin una segunda confirmación.

También se endureció el estado contextual para no consumir prematuramente la autoridad cuando un transcript queda semánticamente `UNRESOLVED`.

### 4.4 Tool executors

Las superficies directas principales ya usan frontera neutral para selección y resultados:

```text
v19  create reservation
v23  query/cancel/modify/business_info/end-call executor compatibility
v24  marketing
v25  tool authorization
v45  barge-in tool deferral
```

Los resultados se devuelven mediante el port neutral, aunque OpenAI siga siendo el traductor efectivo.

### 4.5 V35 / V48

- V35 consume ya la fachada provider-neutral para observación/configuración relevante.
- V48 dispone de ruta neutral para transcript y transformación de política de sesión.
- Los transforms de sesión se componen de forma ordenada; V41 y V48 no deben sobrescribirse entre sí.

## 5. Componentes deliberadamente NO modificados

Durante la limpieza pre-Gemini se preservaron deliberadamente:

```text
v36 turn concurrency
v46 terminal sideband close observation
HangupController
ConversationTurnLifecycle v18
TERMINAL_TRANSPORT_DRAIN_MS = 750
Telnyx → OpenAI direct SIP media path
reservas/Supabase business semantics
human handoff transport
```

El workaround de 750 ms sigue siendo provisional pero VALIDADO en la topología OpenAI actual. No modificarlo durante los gates de provider selection.

## 6. Acoplamientos OpenAI todavía relevantes

La arquitectura conversacional está mucho más limpia, pero NO se considera Gemini plug-and-play todavía.

Quedan dos áreas sensibles:

### 6.1 V40 / V44

V40/V44 participan en response ownership, barge-in y VAD. Todavía conocen aspectos OpenAI/direct realtime que requieren neutralización cuidadosa.

No hacer refactor agresivo. Se debe preservar:

```text
VAD bruto no autoriza interrupción semántica
protected speech no se interrumpe
INTERRUPT no depende de response.done
IGNORE no entra al pipeline semántico
un único response owner
```

Estos cambios exigen CI y llamada E2E específica de barge-in.

### 6.2 Media transport

La topología estable actual sigue siendo:

```text
PSTN
↕
Telnyx
↕ SIP/RTP
OpenAI Realtime
```

Cloudflare permanece fuera del audio path.

Gemini Live no debe introducirse haciendo que el Worker actual se convierta improvisadamente en relay de audio. La arquitectura normativa exige benchmark + ADR antes de ampliar el media plane.

Debe distinguirse formalmente:

```text
TelephonyProvider
MediaTransport
RealtimeProvider
```

OpenAI puede mantener un `DirectSipMediaTransport`; Gemini probablemente requerirá un media bridge/streaming transport independiente.

## 7. Metodología obligatoria

1. Antes de cada write, leer:
   - `docs/MASTER_PROJECT_GUIDE.md`
   - este handoff
   - `docs/PROJECT_STATUS.md`
2. Verificar HEAD real de `rebuild/v39-stable-baseline` en GitHub.
3. No asumir que un SHA documentado sigue siendo HEAD.
4. Un gate = cambio mínimo + tests + CI verde antes del gate siguiente.
5. No mezclar limpieza provider-neutral con habilitación de Gemini.
6. No tocar media path durante los gates conversacionales.
7. Ante fallo E2E: consultar `public.call_diagnostic_events` antes de modificar código.
8. Diferenciar siempre:
   - IMPLEMENTADO
   - CI VERDE
   - DESPLEGADO
   - VALIDADO E2E
9. Para cierre/handoff/WRITE, el modelo nunca es autoridad irreversible única.
10. No apilar timers o sleeps para ocultar ownership/races.
11. No modificar v36/v46/HangupController/750 ms sin evidencia directa.

## 8. Conectores y fuentes de verdad

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

Supabase diagnostics son la evidencia E2E principal para llamadas.

### Cloudflare

`TENANT_CONFIG` KV existe como configuración operativa rápida. No afirmar deploy real si la sesión no dispone de una herramienta capaz de ejecutarlo/verificarlo.

## 9. Gates pre-Gemini acordados

Ejecutar en este orden, sin habilitar Gemini todavía:

### Gate A — ProviderSelector por tenant/KV

Objetivo:

```text
TenantConfiguration
   + optional KV override
          ↓
RealtimeProviderSelector
          ↓
OPENAI
```

Durante este gate OpenAI será el único provider registrable. Un valor desconocido debe seguir una política explícita y testeada; no debe dispersar `if (provider === ...)` por CallSession.

### Gate B — V40/V44 provider-neutral

Neutralizar únicamente los acoplamientos necesarios, preservando exactamente la autoridad de barge-in actual.

Requiere llamada E2E con:

- turno normal;
- interrupción legítima;
- ruido/IGNORE;
- continuación tras interrupción.

### Gate C — ProviderCapabilities

Definir contrato explícito de capacidades, por ejemplo:

```text
audio input/output
VAD
interruption
function calling
input/output transcription
direct SIP
```

No asumir que todos los providers soportan las mismas capacidades.

### Gate D — MediaTransport contract

Separar formalmente `RealtimeProvider` de `MediaTransport`, manteniendo la implementación OpenAI actual intacta.

Objetivo conceptual:

```text
TelephonyProvider: Telnyx

MediaTransport:
- OpenAI Direct SIP
- futuro Streaming Media Bridge

RealtimeProvider:
- OpenAI
- futuro Gemini Live
```

Solo después de cerrar A-D debe comenzar la implementación Gemini.

## 10. Primer paso después de este handoff

Comenzar Gate A: resolver provider por tenant/configuración operativa, con OpenAI como único provider activo y fallback/error explícito testeado.

No esperar confirmación adicional del usuario para avanzar entre estos gates; avanzar únicamente cuando el gate anterior tenga evidencia suficiente según esta metodología.
