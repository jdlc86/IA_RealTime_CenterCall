# IA_RealTime_CenterCall — PROJECT STATUS

> **Estado operativo actual del proyecto**
> **Fecha:** 2026-08-19
> Arquitectura normativa: `docs/architecture/SYSTEM_ARCHITECTURE.md`
> Reglas obligatorias: `docs/architecture/DESIGN_RULES.md`
> Continuación operativa: `docs/SESSION_HANDOFF_2026-08-19.md`

## Estado resumido

```text
F0 Voz E2E                                   ✅ CERRADA
F1 Baseline + observabilidad + TenantResolver ✅ CERRADA
F2 Latencia + barge-in                       🟡 ESTABLE / pendiente neutralización V40/V44
F3 ToolGateway / direct tools                🟡 EN CURSO, frontera realtime neutralizada
F4 Clínica + multi-negocio                   🟡 EN CURSO
F5 Persistencia empresarial + Supabase       🟡 EN CURSO
F6 Handoff humano                            🟡 IMPLEMENTADO / validado parcialmente E2E
F7 Concurrencia                              🟡 ESTABLE en baseline, no tocar sin evidencia
F8 Hardening producción                      🟡 EN CURSO
F9 App de gestión                            ⬜ NO INICIADA
Multi-provider Realtime                      🟡 PREPARACIÓN PRE-GEMINI
```

## Baseline estable actual

Rama de trabajo:

```text
rebuild/v39-stable-baseline
```

Snapshot de recuperación previo a Gemini:

```text
stable/pre-gemini-2026-08-19
```

Runtime estable validado:

```text
ce23ac070558825ea909cbd7eb973b249bfe0a9e
```

Validación:

```text
Control Plane CI #536 — SUCCESS
Run tests          — SUCCESS
Wrangler dry-run   — SUCCESS
```

E2E confirmado tras deploy actualizado:

```text
call_id = rtc_u2_EENcyA4JsYIao1IsOI6n4
fecha local ≈ 2026-08-19 01:35 Europe/Madrid
145 eventos
warn/error/critical = 0
```

Estado del baseline:

- IMPLEMENTADO: ✅
- CI VERDE: ✅
- DESPLEGADO: ✅ confirmado por la prueba posterior al deploy actualizado
- VALIDADO E2E: ✅ para el flujo probado de business info → continuidad → `No gracias` → cierre → hangup

## Objetivo multi-provider

El producto debe soportar selección de proveedor realtime por tenant/configuración comercial, manteniendo OpenAI como opción y añadiendo Gemini como alternativa.

Objetivo:

```text
TenantConfiguration / KV override
              │
              ▼
      RealtimeProviderSelector
          ┌──────┴──────┐
          ▼             ▼
       OpenAI         Gemini Live
```

Estado actual:

```text
ACTIVE_REALTIME_PROVIDER = OPENAI
```

**Gemini todavía no está habilitado. OpenAI es el único provider activo.**

## Limpieza provider-neutral completada

Las capas siguientes ya disponen de frontera neutral para los aspectos relevantes de Realtime:

```text
v19  create reservation
v23  query/cancel/modify/business_info/end-call executor compatibility
v24  marketing
v25  tool authorization
v26  direct-agent runtime, tool ingress, post-tool policy y session bootstrap
v35  provider-neutral observation/configuration
v41  contextual closing, tool/session/event boundary
v45  tool deferral durante barge-in
v48  authoritative clock + session transform
```

El adaptador OpenAI sigue siendo la única traducción activa hacia el protocolo realtime real.

## Cierre v41 — estado validado

Regla formal vigente:

```text
Lucía: ¿Necesitas algo más en lo que pueda ayudarte?
Caller: No gracias
```

Debe producir:

```text
MORE_HELP_QUESTION_OPENED_V41
→ V41_CLOSE_COMMITTED_TO_LIFECYCLE
→ CONTEXTUAL_CLOSE_RESOLVED_V41
   context = ANSWER_TO_MORE_HELP_QUESTION
   caller_resolution = NO_MORE_HELP
   explicit_close_confirmation_required = false
→ LIFECYCLE_END_CALL_REQUESTED_V18
```

Esto fue validado E2E en `rtc_u2_EENcyA4JsYIao1IsOI6n4`.

No debe aparecer una segunda pregunta de confirmación.

Una petición sustantiva posterior sigue teniendo prioridad y debe mantener la llamada abierta.

## Terminal/hangup

Topología y ownership vigentes:

```text
ConversationTurnLifecycle v18
→ terminal playback
→ TERMINAL_TRANSPORT_DRAIN_MS = 750
→ HangupController
→ TELNYX_SOURCE_LEG
```

E2E del baseline:

```text
LIFECYCLE_TERMINAL_DRAIN_ARMED_V18 drain_ms=750
→ LIFECYCLE_TERMINAL_DRAIN_COMPLETED_V18
→ LIFECYCLE_HANGUP_DISPATCHED_V18
→ HANGUP_STARTED transport_authority=TELNYX_SOURCE_LEG
→ HANGUP_REQUEST_ACCEPTED http_status=200
→ HANGUP_COMPLETED
```

El sideband `1006` posterior a `hangup_started=true` sigue siendo consecuencia del cierre.

No modificar v18/HangupController/750 ms durante los gates pre-Gemini salvo nueva evidencia directa.

## Barge-in v40/v44

La autoridad actual se conserva y todavía requiere neutralización cuidadosa antes de Gemini.

Invariantes:

- VAD bruto no cancela semánticamente;
- protected speech no se interrumpe;
- playback normal usa escucha no interruptiva;
- candidato se clasifica `INTERRUPT | IGNORE`;
- `INTERRUPT` no espera `response.done`;
- `IGNORE` no entra al pipeline semántico;
- un único response owner.

No hacer refactor masivo. El gate V40/V44 exige E2E específico de interrupción y ruido.

## Reservas / restaurante

Estado funcional vigente:

- CREATE con disponibilidad y datos incrementales;
- QUERY por tenant/caller;
- CANCEL individual/múltiple;
- MODIFY según flujo implementado;
- código público `R-######` separado de UUID interno;
- validación de horarios/duración en backend;
- Truth Guard para no afirmar resultados no confirmados;
- marketing separado del estado de reserva;
- continuación post-tool determinista en V26.

La neutralización Realtime no cambió intencionalmente estas reglas.

## Human handoff

Permanece implementado sobre la autoridad v37/v39. No fue modificado por la limpieza provider-neutral.

Reglas mantenidas:

- transporte irreversible no se duplica en capas posteriores;
- `call.answered` del target leg es evidencia autoritativa de transferencia contestada;
- no usar el modelo como única autoridad de handoff irreversible.

## Media plane

Topología estable actual:

```text
PSTN → Telnyx → OpenAI Realtime vía SIP/RTP
```

Cloudflare no transporta audio continuo.

Gemini requerirá separar formalmente `RealtimeProvider` de `MediaTransport`; cualquier relay nuevo debe cumplir RA-003/RA-005 y requiere benchmark + ADR.

## Supabase / observabilidad

```text
project_id = vutekfkbtvfogouwcfvc
principal diagnostic table = public.call_diagnostic_events
```

Toda regresión de llamada se investiga primero en esta tabla.

## Cloudflare

- control-plane en Workers;
- configuración rápida por tenant en `TENANT_CONFIG` KV;
- CI valida con Wrangler dry-run;
- CI verde NO equivale a deploy real;
- no afirmar despliegue si la sesión no dispone de herramienta de despliegue/verificación.

## Gates pre-Gemini activos

### Gate A — ProviderSelector tenant/KV

Estado: **SIGUIENTE**.

Objetivo:

```text
TenantConfiguration + optional KV override
→ RealtimeProviderSelector
→ OPENAI
```

Condiciones:

- solo OpenAI registrable inicialmente;
- unsupported/unknown provider con política centralizada y tests;
- no dispersar condicionales por CallSession;
- cero cambio funcional.

### Gate B — V40/V44 provider-neutral

Estado: PENDIENTE Gate A.

Debe conservar barge-in actual y validarse con llamada real INTERRUPT/IGNORE.

### Gate C — ProviderCapabilities

Estado: PENDIENTE Gate B.

Contrato explícito para capacidades distintas entre proveedores.

### Gate D — MediaTransport contract

Estado: PENDIENTE Gate C.

Separar transporte de audio de RealtimeProvider sin alterar OpenAI SIP actual.

### Gemini

Estado: **NO INICIAR hasta cerrar A-D**.

## Metodología obligatoria

1. Leer Master + handoff actual + Project Status antes de cambios.
2. Verificar HEAD real en GitHub.
3. Un gate por vez.
4. Añadir tests/regresión apropiada.
5. Exigir `Run tests` + `Wrangler dry-run` verdes.
6. Confirmar deploy antes de interpretar E2E.
7. Consultar diagnósticos antes de corregir cualquier llamada.
8. No apilar timers/parches.
9. Distinguir garantía codificada de comportamiento histórico de facto.
10. Mantener una sola autoridad por comportamiento irreversible.
11. Si un gate rompe algo, comparar contra `stable/pre-gemini-2026-08-19` / `ce23ac07...` antes de ampliar el cambio.
