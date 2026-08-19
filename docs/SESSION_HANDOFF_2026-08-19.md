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
B V40/V44 provider-neutral         🟡 IMPLEMENTADO + CI VERDE / DEPLOY+E2E PENDIENTE
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

Estado:

```text
IMPLEMENTADO = sí
CI VERDE = sí
DESPLEGADO = no confirmado
VALIDADO E2E = no afirmado
```

### Gate B

Commits:

```text
43e5d64cd209f4da0b6932f542192278dd601cc0
refactor(gate-b): neutralize v40 v44 realtime boundary

9de3b7829ea5031e5967b1d42722b597e15c18ef
fix(gate-b): preserve lifecycle speech-kind contract
```

CI:

```text
#541 — FAILURE
TS2322: HANDOFF no pertenecía al speech-kind cerrado del lifecycle

#542 — SUCCESS
Run tests        — SUCCESS
Wrangler dry-run — SUCCESS
```

Causa del fallo #541 y resolución:

- V40/V44 necesitaban conservar la protección del anuncio de handoff que antes provenía de metadata OpenAI.
- El primer cambio representó `HANDOFF` como `AssistantSpeechKind`, lo que amplió accidentalmente el contrato consumido por el lifecycle.
- La corrección no modificó `ConversationTurnLifecycle`: `realtime-turn-lifecycle-adapter.ts` proyecta `HANDOFF → NORMAL` únicamente para lifecycle, preservando su comportamiento histórico; V40/V44 siguen viendo `HANDOFF` y lo tratan como speech protegido.

Neutralización Gate B:

- V40 usa `adaptRealtimeProviderEvents()` y `realtimeCommandPortFor()` de la fachada neutral.
- V44 usa eventos neutrales para raw VAD/playback.
- `raw-vad-barge-in-routing.ts` decide sobre `CALLER_SPEECH_STARTED`, no sobre `input_audio_buffer.speech_started`.
- El adapter OpenAI expone `TEXT_DECISION_COMPLETED` y `sourceItemId` para el clasificador de barge-in.
- tests de regresión impiden reintroducir nombres wire OpenAI en V40/V44.

Invariantes preservados:

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

## 4. Gate B todavía NO está cerrado

La metodología acordada exige llamada E2E real con:

1. turno normal;
2. interrupción legítima (`INTERRUPT`);
3. ruido/background input (`IGNORE`);
4. continuación correcta después de la interrupción.

La sesión que implementó el código comprobó que:

- GitHub solo contiene `.github/workflows/control-plane-ci.yml`;
- ese workflow hace tests + Wrangler dry-run, no deploy;
- no había Wrangler autenticado ni credenciales Cloudflare disponibles en la sesión.

Por tanto no afirmar:

```text
DESPLEGADO
VALIDADO E2E
```

para Gate B hasta tener evidencia real.

## 5. Próximo paso exacto

1. Verificar HEAD real de `rebuild/v39-stable-baseline`.
2. Desplegar el HEAD que contiene Gate B.
3. Ejecutar llamada E2E de barge-in.
4. Consultar `public.call_diagnostic_events` antes de cualquier corrección.
5. Buscar al menos:

```text
BARGE_IN_PLAYBACK_WINDOW_OPENED_V40_REBUILD
RAW_VAD_ROUTED_TO_V40_ONLY_V44
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
BARGE_IN_CONFIRMED_V40_REBUILD
BARGE_IN_IGNORED_V40_REBUILD
BARGE_IN_UNCLASSIFIABLE_IGNORED_V40_REBUILD
```

6. Confirmar ausencia de warning/error y ownership incoherente.
7. Solo entonces cerrar B y comenzar Gate C automáticamente.

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
7. No saltar Gate B por conveniencia: C permanece bloqueado hasta E2E real.
