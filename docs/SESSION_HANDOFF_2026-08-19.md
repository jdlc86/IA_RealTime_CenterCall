# SESSION HANDOFF — 2026-08-19

> Repositorio: `jdlc86/IA_RealTime_CenterCall`
> Rama: `rebuild/v39-stable-baseline`
> Snapshot estable: `stable/pre-gemini-2026-08-19`
> Baseline funcional: `ce23ac070558825ea909cbd7eb973b249bfe0a9e`
> Zona horaria: `Europe/Madrid`

## 1. Baseline estable pre-Gemini

No mover:

```text
stable/pre-gemini-2026-08-19
→ ce23ac070558825ea909cbd7eb973b249bfe0a9e
```

Validación baseline:

```text
Control Plane CI #536 — SUCCESS
E2E call_id = rtc_u2_EENcyA4JsYIao1IsOI6n4
145 eventos
warn/error/critical = 0
```

Flujo validado:

```text
V26 post-tool gobernado
→ V41 more-help
→ "No gracias"
→ cierre contextual directo
→ lifecycle terminal
→ drain 750 ms
→ Telnyx source-leg hangup HTTP 200
→ HANGUP_COMPLETED
```

Este snapshot es el punto de comparación si los gates posteriores rompen comportamiento.

## 2. Objetivo multi-provider

```text
TenantConfiguration / KV override
              ↓
      RealtimeProviderSelector
        ┌─────┴─────┐
        ↓           ↓
     OpenAI      Gemini Live (futuro)
```

Hasta cerrar los gates pre-Gemini, `OPENAI` sigue siendo el único provider registrable/activo.

## 3. Estado de gates

```text
A ProviderSelector tenant/KV       ✅ IMPLEMENTADO + CI VERDE
B V40/V44 provider-neutral         🟡 REABIERTO / FIX CI VERDE / NUEVO E2E PENDIENTE
C ProviderCapabilities             ⛔ NO INICIAR HASTA CERRAR B
D MediaTransport contract          ⛔ NO INICIAR HASTA CERRAR C
Gemini                              ⛔ NO INICIAR HASTA CERRAR A-D
```

### Gate A

Commit:

```text
76b54a9f5eba354a2cd8b99a96094897382474d9
feat(gate-a): add tenant realtime provider selection
```

CI:

```text
Control Plane CI #540 — SUCCESS
```

Implementación:

- `realtime-provider-selector.ts` centraliza selección.
- `OPENAI` es el único provider registrado.
- `TENANT_CONFIG` puede contener override operativo por tenant.
- unknown/unregistered provider falla cerrado.
- `realtime-provider-runtime.ts` centraliza binding/factory.
- `call-session-v49-provider-selection.ts` hace bootstrap antes del resto de CallSession.
- `index-v6.ts` es el entrypoint configurado en Wrangler.
- media path sin cambios.

### Gate B — neutralización provider-neutral

Commits base:

```text
43e5d64cd209f4da0b6932f542192278dd601cc0
refactor(gate-b): neutralize v40 v44 realtime boundary

9de3b7829ea5031e5967b1d42722b597e15c18ef
fix(gate-b): preserve lifecycle speech-kind contract
```

CI base:

```text
#541 — FAILURE
TS2322: HANDOFF no pertenecía al speech-kind cerrado del lifecycle

#542 — SUCCESS
Run tests        — SUCCESS
Wrangler dry-run — SUCCESS
```

Neutralización Gate B:

- V40 usa `adaptRealtimeProviderEvents()` y `realtimeCommandPortFor()` de la fachada neutral.
- V44 usa eventos neutrales para raw VAD/playback.
- `raw-vad-barge-in-routing.ts` decide sobre `CALLER_SPEECH_STARTED`, no sobre `input_audio_buffer.speech_started`.
- El adapter OpenAI expone `TEXT_DECISION_COMPLETED` y `sourceItemId` para el clasificador de barge-in.
- V40/V44 conservan la protección del handoff; lifecycle conserva su contrato histórico.
- reducers/effects de response ownership no se modificaron.

Invariantes:

```text
raw VAD = evidencia acústica, no autoridad semántica
protected speech = no interrumpible
INTERRUPT = no espera response.done
IGNORE = no entra al pipeline semántico
single response owner
```

No se tocaron durante Gate B:

```text
v36
v46
V41 closing
ConversationTurnLifecycle v18
HangupController
TERMINAL_TRANSPORT_DRAIN_MS = 750
Telnyx → OpenAI direct SIP
```

## 4. Gate B reabierto por falso IGNORE E2E

Llamada que revela la regresión:

```text
call_id = rtc_u7_EEU8v4REv6CCm7t4Ssb80
fecha local ≈ 2026-08-19 08:32 Europe/Madrid
```

Caso real:

```text
caller pide MENU
→ restaurant_business_info topics=[MENU]
→ Lucía empieza a responder
→ caller interrumpe: pregunta por horario
→ RAW_VAD_ROUTED_TO_V40_ONLY_V44
→ BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
→ BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
→ BARGE_IN_IGNORED_V40_REBUILD
   semantic_pipeline_entered=false
→ la primera pregunta de horario se pierde
```

Al repetir la pregunta:

```text
→ BARGE_IN_CONFIRMED_V40_REBUILD
→ CONFIRMED_BARGE_IN_SEMANTIC_TURN_STARTED_V29
→ restaurant_business_info topics=[HOURS]
```

Conclusión: la neutralización mecánica V40/V44 funcionaba, pero un único `IGNORE` del clasificador auxiliar tenía autoridad destructiva suficiente para borrar una transcripción usable del caller.

### Causa raíz

Antes del fix, `barge-in-confirmation.ts`:

- pedía `IGNORE` ante duda;
- `parseBargeInDecision()` trataba cualquier salida distinta de `INTERRUPT` como `IGNORE`;
- V40 podía entonces descartar el item y no promoverlo a la semántica V29.

La petición real podía perderse por una sola clasificación conservadora o salida imperfecta del modelo.

### Fix aplicado

Estado de código tras la corrección:

```text
188ae177fda6544b40c3f014ebe8d36edcd3a520
Control Plane CI #547 — SUCCESS
Run tests          — SUCCESS
Wrangler dry-run   — SUCCESS
```

La política nueva exige una certificación positiva para una decisión destructiva:

```text
INTERRUPT                         → INTERRUPT
IGNORE_CONFIRMED                  → IGNORE
IGNORE antiguo                    → INTERRUPT
salida ambigua/malformada         → INTERRUPT
sin texto/fallback del classifier → INTERRUPT
```

El prompt solo permite `IGNORE_CONFIRMED` cuando el contenido es inequívocamente fondo/eco/TV/radio/ruido o no dirigido. Ante duda se conserva el turno como `INTERRUPT`.

No se añadió un segundo clasificador. Se consideró y se descartó ese diseño para no crear una segunda autoridad paralela.

## 5. Gate B todavía NO está cerrado

El fix está IMPLEMENTADO y CI-verde, pero exige un nuevo deploy + E2E.

Prueba obligatoria:

1. pedir menú;
2. durante la respuesta interrumpir con `¿A qué hora cierran?`;
3. comprobar que la primera interrupción llega a `BARGE_IN_CONFIRMED_V40_REBUILD` y luego a `restaurant_business_info topics=[HOURS]`;
4. durante otra respuesta generar una frase realmente de fondo y comprobar que solo se ignora si el classifier certifica fondo;
5. verificar continuación normal y ausencia de warnings/errors.

Eventos clave:

```text
BARGE_IN_PLAYBACK_WINDOW_OPENED_V40_REBUILD
RAW_VAD_ROUTED_TO_V40_ONLY_V44
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
BARGE_IN_CONFIRMED_V40_REBUILD
BARGE_IN_IGNORED_V40_REBUILD
BARGE_IN_UNCLASSIFIABLE_IGNORED_V40_REBUILD
CONFIRMED_BARGE_IN_SEMANTIC_TURN_STARTED_V29
DEBUG_MODEL_TOOL_DECISION_V29
```

No comenzar Gate C hasta que esta prueba sea E2E-verde.

## 6. Gate C — cuando B quede E2E verde

Definir `ProviderCapabilities` explícito, sin asumir paridad entre proveedores:

```text
audio input/output
VAD
interruption
function calling
input transcription
output transcription
direct SIP
```

No habilitar Gemini durante C.

## 7. Gate D — después de C

Separar formalmente:

```text
TelephonyProvider
MediaTransport
RealtimeProvider
```

Mantener OpenAI actual intacto:

```text
Telnyx → OpenAI Direct SIP
```

El futuro Gemini deberá usar un `MediaTransport`/bridge separado si no dispone de SIP directo; no convertir el Worker actual en relay de audio sin ADR + benchmark.

## 8. Fuentes de verdad y restricciones

```text
Supabase project_id = vutekfkbtvfogouwcfvc
Diagnostics          = public.call_diagnostic_events
KV                   = TENANT_CONFIG
```

Metodología:

1. Antes de cada write leer Master + este handoff + Project Status.
2. Verificar HEAD real antes de escribir.
3. Un gate = cambio mínimo + tests + CI + E2E cuando se exige.
4. CI verde != deploy.
5. No apilar timers/parches.
6. No tocar v36/v46/HangupController/750 ms sin evidencia directa.
7. No saltar Gate B: C permanece bloqueado hasta E2E real.

## 9. Concurrencia de reservas simultáneas — hardening 2026-08-19

Cambio solicitado explícitamente para el caso de dos callers que intentan reservar simultáneamente la misma capacidad. **No se implementó HOLD** y no se introdujo ningún delay/retry temporal para resolver la carrera.

### Política de arbitraje

La disponibilidad mostrada durante la conversación es informativa; la adjudicación ocurre únicamente en el commit de reserva:

```text
consulta disponibilidad
→ recopilar datos
→ confirmación explícita
→ create_restaurant_reservation / create_restaurant_reservation_multi
→ lock PostgreSQL sobre restaurant_tables
→ recheck de solape
→ BOOKED o conflicto
```

Para reserva simple la RPC ya usa `FOR UPDATE ... SKIP LOCKED`; para multimesa bloquea el conjunto elegido con `FOR UPDATE`. El lock técnico dura solo la transacción de base de datos, no la conversación. No existe prioridad FIFO por hora de inicio de llamada; gana la transacción que consigue adjudicar capacidad válida al confirmar.

### Capa 1 — conflicto de negocio explícito

Commits:

```text
3e08c39272855ba093e7c1595ea9c1d4920ad131
fix(reservations): handle commit-time availability races

3747b0af9e31f23f3a2c870ae25f2c93c5593582
test(reservations): compile concurrency policy in CI

5bb5692d0d94b427d831e6073186159e019e8e60
fix(reservations): narrow tool failure structurally
```

CI:

```text
#549 FAILURE — el nuevo helper no estaba en la lista explícita de tsc
#550 FAILURE — narrowing TypeScript de ToolResult insuficiente
#551 SUCCESS — tests + Wrangler dry-run
```

`call-session-v19.ts` convierte `no_availability`, `no_multitable_availability` y conflicto de exclusión 23P01 en:

```text
AVAILABILITY_CHANGED
reservation_created=false
requires_new_confirmation=true
```

También invalida la disponibilidad cacheada y desarma `confirm=true`, pero conserva nombre/teléfono ya recogidos.

### Capa 2 — invariante declarativo en PostgreSQL

Commit:

```text
1ec885b84ef74c4bddeffa19297470fc6a2e3bfa
feat(reservations): enforce table overlap invariant
Control Plane CI #552 — SUCCESS
```

Migración versionada en repo:

```text
supabase/migrations/20260819111000_reservation_table_overlap_invariant.sql
```

Aplicada en Supabase con versión registrada:

```text
20260819091029 reservation_table_overlap_invariant
```

Implementado:

- `btree_gist` en schema `extensions`;
- ventana temporal materializada por asignación en `reservation_tables`;
- triggers hijo/padre para mantenerla sincronizada;
- constraint `reservation_tables_no_active_overlap`:
  - mismo `table_id`;
  - rangos `[start,end)` que se solapan;
  - solo asignaciones activas (`HELD`/`BOOKED` según semántica de estado ya existente);
- `modify_restaurant_reservation` libera la asignación antigua dentro de la misma transacción antes de cambiar la ventana y reasignar mesas, evitando conflicto transitorio falso.

No se creó ningún mecanismo de expiración o reserva temporal HELD.

Verificación real en DB:

```text
allocation/parent mismatches = 0
```

Se intentó insertar deliberadamente una segunda asignación BOOKED sobre la misma mesa e intervalo. PostgreSQL produjo `exclusion_violation`; la subtransacción se revirtió y la comprobación posterior mostró:

```text
persisted_test_rows = 0
```

### Capa 3 — qué oye el caller que pierde la carrera

Commit:

```text
98c13fee3288b04f80c650e1ab5de6402842d4cc
feat(reservations): govern concurrent booking recovery
Control Plane CI #553 — SUCCESS
```

V26 gobierna `AVAILABILITY_CHANGED` como recuperación no terminal, con tools deshabilitadas en esa respuesta. Frase prevista:

```text
Justo al confirmar, esa disponibilidad dejó de estar disponible y no se ha creado ninguna reserva. ¿Quieres que busque horarios cercanos para ese mismo día?
```

No se ejecuta `restaurant_reservation_search` en esa misma respuesta. Motivo: durante la carrera, la transacción ganadora podría seguir sin `COMMIT`; una lectura MVCC inmediata podría ver todavía la capacidad antigua. Si el caller acepta buscar alternativas, la búsqueda ocurre en el turno siguiente y queda limitada inicialmente a la misma fecha. Cualquier alternativa elegida vuelve a pasar por `restaurant_reservation_create` y exige una confirmación explícita nueva.

Invariantes del flujo:

```text
máximo una asignación activa por mesa + intervalo solapado
BOOKED solo con evidencia backend
conflicto de capacidad != error técnico
sin HOLD conversacional
sin timer/retry para arbitraje
sin reutilizar confirmación anterior
sin búsqueda automática dentro del mismo instante de contención
```

No se modificaron v36, v40/v44, V41, v46, ConversationTurnLifecycle, HangupController ni `TERMINAL_TRANSPORT_DRAIN_MS=750` durante este hardening.

Estado actual de este hardening:

```text
CÓDIGO APP        = ✅ CI VERDE
INVARIANTE DB     = ✅ APLICADO + VERIFICADO
WORKER DESPLEGADO = ❌ no afirmado
E2E VOZ           = ⏳ pendiente; se probará junto con los cambios anteriores
```

Gate B permanece abierto hasta su E2E específico; este trabajo de reservas no autoriza saltar a Gate C.
