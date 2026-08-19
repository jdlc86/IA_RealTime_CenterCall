# IA_RealTime_CenterCall — MASTER PROJECT GUIDE

> **Path estable de compatibilidad. NO RENOMBRAR NI ELIMINAR.**

Este archivo es la puerta de entrada permanente a la documentación del proyecto.

## Continuación operativa más reciente

Estado actualizado al **19 de agosto de 2026**.

Antes de cualquier cambio técnico leer, en este orden:

1. `docs/MASTER_PROJECT_GUIDE.md`
2. `docs/SESSION_HANDOFF_2026-08-19.md`
3. `docs/PROJECT_STATUS.md`

Y verificar siempre el HEAD real de `rebuild/v39-stable-baseline` en GitHub antes de escribir.

## Fuentes de verdad arquitectónicas

- `docs/architecture/SYSTEM_ARCHITECTURE.md`
- `docs/architecture/DESIGN_RULES.md`
- `docs/architecture/BUSINESS_VERTICALS.md`
- `docs/architecture/HUMAN_HANDOFF.md`

## Baseline estable pre-Gemini — NO MOVER

Repositorio/rama de trabajo:

```text
jdlc86/IA_RealTime_CenterCall
rebuild/v39-stable-baseline
```

Snapshot estable de recuperación:

```text
stable/pre-gemini-2026-08-19
→ ce23ac070558825ea909cbd7eb973b249bfe0a9e
```

Baseline funcional:

```text
ce23ac070558825ea909cbd7eb973b249bfe0a9e
Control Plane CI #536 — SUCCESS
```

E2E estable asociado:

```text
call_id = rtc_u2_EENcyA4JsYIao1IsOI6n4
fecha local ≈ 2026-08-19 01:35 Europe/Madrid
145 eventos
warn/error/critical = 0
```

Secuencia validada:

```text
DIRECT_POST_TOOL_RESPONSE_GOVERNED_V26
→ MORE_HELP_QUESTION_OPENED_V41
→ caller: "No gracias"
→ V41_CLOSE_COMMITTED_TO_LIFECYCLE
→ CONTEXTUAL_CLOSE_RESOLVED_V41
→ LIFECYCLE_END_CALL_REQUESTED_V18
→ terminal playback
→ drain 750 ms
→ HANGUP_STARTED (TELNYX_SOURCE_LEG)
→ Telnyx HTTP 200
→ HANGUP_COMPLETED
```

Si un gate posterior introduce una regresión, comparar primero contra este snapshot antes de añadir parches. No hacer rollback ciego.

## Estado pre-Gemini actual

OpenAI sigue siendo el **único provider registrable/activo**. Gemini todavía no está habilitado.

```text
Gate A — ProviderSelector tenant/KV       ✅ IMPLEMENTADO + CI VERDE
Gate B — V40/V44 provider-neutral         🟡 IMPLEMENTADO + CI VERDE / E2E PENDIENTE
Gate C — ProviderCapabilities             ⛔ BLOQUEADO POR E2E DE B
Gate D — MediaTransport contract          ⛔ BLOQUEADO POR C
Gemini                                    ⛔ NO INICIAR
```

### Gate A

Commit:

```text
76b54a9f5eba354a2cd8b99a96094897382474d9
feat(gate-a): add tenant realtime provider selection
Control Plane CI #540 — SUCCESS
```

Implementado:

```text
TenantConfiguration
  + optional TENANT_CONFIG KV override
        ↓
RealtimeProviderSelector
        ↓
Provider registry
        ↓
OPENAI
```

- `OPENAI` es el único provider registrado.
- override `OPENAI` permitido.
- provider desconocido/no registrado falla cerrado.
- selección/binding centralizados; no se dispersan `if (provider === ...)` por CallSession.
- `call-session-v49-provider-selection.ts` hace el bootstrap antes de la cadena existente.
- `index-v6.ts` es el entrypoint actual configurado por Wrangler.
- no cambió el media path.

Estado Gate A:

```text
IMPLEMENTADO = sí
CI VERDE = sí
DESPLEGADO = no confirmado en esta sesión
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
causa: HANDOFF amplió accidentalmente el speech-kind aceptado por lifecycle

#542 — SUCCESS
Run tests        — SUCCESS
Wrangler dry-run — SUCCESS
```

La corrección conserva el contrato del lifecycle: el adapter neutral proyecta `HANDOFF → NORMAL` únicamente al lifecycle, mientras V40/V44 siguen viendo `HANDOFF` como categoría protegida para barge-in.

V40/V44 ya no dependen directamente de nombres wire OpenAI para su lógica de barge-in:

```text
CALLER_SPEECH_STARTED
CALLER_TRANSCRIPT_COMPLETED
ASSISTANT_RESPONSE_STARTED / COMPLETED
ASSISTANT_AUDIO_STARTED / STOPPED / CLEARED
TEXT_DECISION_COMPLETED
```

El adapter OpenAI sigue siendo quien traduce el protocolo OpenAI actual a esos eventos neutrales.

Invariantes preservados:

```text
VAD bruto no autoriza interrupción semántica
protected speech no se interrumpe
INTERRUPT no espera response.done
IGNORE no entra al pipeline semántico
un único response owner
```

No se modificaron los reducers/effects de response ownership.

Gate B **NO está cerrado todavía**. Requiere deploy + llamada E2E real con:

1. turno normal;
2. interrupción legítima → `INTERRUPT`;
3. ruido/background input → `IGNORE`;
4. continuación correcta después de la interrupción.

La sesión que implementó Gate B no disponía de credenciales/CLI Cloudflare autenticado. El repo solo contiene `.github/workflows/control-plane-ci.yml`; no existe workflow de deploy. Por tanto CI verde no se debe presentar como deploy ni como E2E.

## Componentes deliberadamente preservados

No modificar durante estos gates sin evidencia directa:

```text
v36 turn concurrency
v46 terminal sideband close observation
ConversationTurnLifecycle v18
HangupController
TERMINAL_TRANSPORT_DRAIN_MS = 750
Telnyx → OpenAI direct SIP media path
reservas/Supabase business semantics
human handoff transport
```

El drain de 750 ms sigue siendo una heurística provisional pero validada en la topología OpenAI estable.

## Media plane

Topología estable:

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

No convertir el Worker/DO actual en relay de audio improvisado. Cualquier ampliación del media plane requiere benchmark + ADR conforme a RA-003/RA-005.

## Próximo paso obligatorio

No comenzar Gate C todavía.

Primero:

```text
1. desplegar el HEAD que contiene Gate B;
2. ejecutar la llamada E2E INTERRUPT/IGNORE;
3. consultar public.call_diagnostic_events;
4. verificar ausencia de regresiones y ownership correcto;
5. solo entonces marcar Gate B como cerrado y abrir Gate C.
```

Eventos útiles para la validación:

```text
BARGE_IN_PLAYBACK_WINDOW_OPENED_V40_REBUILD
RAW_VAD_ROUTED_TO_V40_ONLY_V44
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
BARGE_IN_CONFIRMED_V40_REBUILD
BARGE_IN_IGNORED_V40_REBUILD
BARGE_IN_UNCLASSIFIABLE_IGNORED_V40_REBUILD
```

## Infraestructura conocida

```text
GitHub repo  = jdlc86/IA_RealTime_CenterCall
work branch  = rebuild/v39-stable-baseline
stable ref   = stable/pre-gemini-2026-08-19
Supabase     = vutekfkbtvfogouwcfvc
Diagnostics  = public.call_diagnostic_events
KV           = TENANT_CONFIG
```

## Metodología obligatoria

1. Leer Master + handoff + Project Status antes de cada write.
2. Verificar HEAD real antes de cada write.
3. Un gate por vez.
4. Tests + CI verde antes de avanzar.
5. Cuando el gate exige E2E, no sustituirlo por tests sintéticos.
6. Diferenciar `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO`, `VALIDADO E2E`.
7. Ante regresión E2E, consultar diagnósticos antes de cambiar código.
8. No apilar timers/parches para esconder ownership/races.
9. No tocar v36/v46/HangupController/750 ms sin evidencia directa.
10. No habilitar Gemini ni ampliar media plane antes de cerrar A-D.
