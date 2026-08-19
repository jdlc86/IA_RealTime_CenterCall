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

No se tocaron:

```text
v36
v46
V41 closing
ConversationTurnLifecycle v18
HangupController
TERMINAL_TRANSPORT_DRAIN_MS = 750
Telnyx → OpenAI direct SIP
business/reservation semantics
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
INTERRUPT                       → INTERRUPT
IGNORE_CONFIRMED                → IGNORE
IGNORE antiguo                  → INTERRUPT
salida ambigua/malformada       → INTERRUPT
sin texto/fallback del classifier → INTERRUPT
```

El prompt solo permite `IGNORE_CONFIRMED` cuando el contenido es inequívocamente fondo/eco/TV/radio/ruido o no dirigido. Ante duda se conserva el turno como `INTERRUPT`.

No se añadió un segundo clasificador. Se consideró y se descartó ese diseño para no crear una segunda autoridad paralela. El diff funcional final respecto al checkpoint documental previo afecta solo:

```text
apps/control-plane/src/barge-in-confirmation.ts
apps/control-plane/src/barge-in-confirmation.test.mjs
```

V40/V44, reducers, v36, V41, lifecycle, hangup y 750 ms quedan sin cambios.

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
