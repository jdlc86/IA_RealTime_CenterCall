# IA_RealTime_CenterCall — PROJECT STATUS

> **Estado operativo actual**
> **Fecha:** 2026-08-19
> Arquitectura normativa: `docs/architecture/SYSTEM_ARCHITECTURE.md`
> Reglas: `docs/architecture/DESIGN_RULES.md`
> Handoff: `docs/SESSION_HANDOFF_2026-08-19.md`

## Estado resumido

```text
F0 Voz E2E                                    ✅ CERRADA
F1 Baseline + observabilidad + TenantResolver ✅ CERRADA
F2 Latencia + barge-in                        🟡 GATE B CI VERDE / E2E PENDIENTE
F3 ToolGateway / direct tools                 🟡 EN CURSO, frontera realtime neutralizada
F4 Clínica + multi-negocio                    🟡 EN CURSO
F5 Persistencia empresarial + Supabase        🟡 EN CURSO
F6 Handoff humano                             🟡 IMPLEMENTADO / validado parcialmente E2E
F7 Concurrencia                               🟡 ESTABLE en baseline, no tocar sin evidencia
F8 Hardening producción                       🟡 EN CURSO
F9 App de gestión                             ⬜ NO INICIADA
Multi-provider Realtime                       🟡 GATES PRE-GEMINI
```

## Baseline estable de recuperación

```text
stable/pre-gemini-2026-08-19
→ ce23ac070558825ea909cbd7eb973b249bfe0a9e
```

Validación baseline:

```text
Control Plane CI #536 — SUCCESS
call_id = rtc_u2_EENcyA4JsYIao1IsOI6n4
145 eventos
warn/error/critical = 0
```

Este snapshot no se mueve con la rama de desarrollo.

## Multi-provider — estado actual

OpenAI sigue siendo el único provider activo/registrado. Gemini no está habilitado.

```text
Gate A ProviderSelector tenant/KV       ✅ IMPLEMENTADO + CI #540 SUCCESS
Gate B V40/V44 provider-neutral         🟡 IMPLEMENTADO + CI #542 SUCCESS / E2E PENDIENTE
Gate C ProviderCapabilities             ⛔ BLOQUEADO POR B
Gate D MediaTransport contract          ⛔ BLOQUEADO POR C
Gemini                                  ⛔ NO INICIAR
```

### Gate A

Commit:

```text
76b54a9f5eba354a2cd8b99a96094897382474d9
```

Características:

- selector central por tenant/configuración;
- override operativo en `TENANT_CONFIG`;
- solo `OPENAI` registrado;
- provider desconocido falla cerrado;
- binding/factory centralizados en runtime neutral;
- bootstrap en `call-session-v49-provider-selection.ts`;
- entrypoint `index-v6.ts`;
- media path sin cambios.

Estado:

```text
IMPLEMENTADO = ✅
CI VERDE = ✅
DESPLEGADO = no confirmado
VALIDADO E2E = no afirmado
```

### Gate B

Commits de código:

```text
43e5d64cd209f4da0b6932f542192278dd601cc0
9de3b7829ea5031e5967b1d42722b597e15c18ef
```

CI:

```text
#541 = FAILURE por incompatibilidad de tipo HANDOFF/lifecycle
#542 = SUCCESS
Run tests = SUCCESS
Wrangler dry-run = SUCCESS
```

Estado funcional del refactor:

- V40 consume `RealtimeProviderEvent` y el command port neutral.
- V44 consume raw-VAD/playback mediante eventos neutrales.
- `raw-vad-barge-in-routing.ts` ya no conoce nombres wire OpenAI.
- el resultado de clasificador se representa como `TEXT_DECISION_COMPLETED`.
- correlación del clasificador conserva `sourceItemId`.
- anuncio de handoff sigue protegido en V40/V44.
- lifecycle conserva su speech-kind previo mediante proyección `HANDOFF → NORMAL` en su adapter.
- reducers/effects de response ownership no cambiaron.

Invariantes Gate B:

```text
VAD bruto no cancela semánticamente
protected speech no se interrumpe
INTERRUPT no espera response.done
IGNORE no entra al pipeline semántico
un único response owner
```

No se modificaron:

```text
v36
v46
V41
ConversationTurnLifecycle v18
HangupController
TERMINAL_TRANSPORT_DRAIN_MS = 750
Telnyx → OpenAI direct SIP
```

Estado Gate B:

```text
IMPLEMENTADO = ✅
CI VERDE = ✅
DESPLEGADO = ❌ no confirmado
VALIDADO E2E = ❌ pendiente
```

## Bloqueo deliberado antes de Gate C

Gate B exige llamada E2E real con:

1. turno normal;
2. interrupción legítima;
3. ruido/background → IGNORE;
4. continuación tras la interrupción.

La sesión que completó el código no dispone de credenciales/CLI Cloudflare autenticado. En `.github/workflows` solo existe `control-plane-ci.yml`, que ejecuta tests y Wrangler dry-run, no deploy.

Por metodología, **no comenzar Gate C hasta validar B E2E**.

## E2E Gate B — evidencia requerida

Después de desplegar el HEAD actual, consultar `public.call_diagnostic_events` para la llamada y verificar al menos:

```text
BARGE_IN_PLAYBACK_WINDOW_OPENED_V40_REBUILD
RAW_VAD_ROUTED_TO_V40_ONLY_V44
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
BARGE_IN_CONFIRMED_V40_REBUILD       # interrupción real
BARGE_IN_IGNORED_V40_REBUILD         # ruido/background
```

También comprobar:

- no `RESPONSE_OWNERSHIP_CONFLICT_V40_REBUILD` no esperado;
- no warnings/errors críticos;
- INTERRUPT no espera `response.done`;
- IGNORE no entra al pipeline semántico;
- Lucía continúa correctamente después de la interrupción.

Ante cualquier fallo de llamada, consultar primero diagnósticos; no modificar código por intuición.

## Cierre / terminal / hangup

Baseline vigente:

```text
V41 close authority
→ ConversationTurnLifecycle v18
→ terminal playback
→ TERMINAL_TRANSPORT_DRAIN_MS = 750
→ HangupController
→ TELNYX_SOURCE_LEG
```

El drain de 750 ms es provisional pero validado. No modificarlo durante gates pre-Gemini.

## Media plane

Actual:

```text
PSTN → Telnyx → OpenAI Realtime vía SIP/RTP
```

Cloudflare no transporta audio continuo.

Gate D deberá formalizar, sin alterar aún este path:

```text
TelephonyProvider
MediaTransport
RealtimeProvider
```

Cualquier bridge Gemini futuro requiere ADR + benchmark conforme a RA-003/RA-005.

## Supabase / observabilidad

```text
project_id = vutekfkbtvfogouwcfvc
diagnostics = public.call_diagnostic_events
```

## Metodología obligatoria

1. Leer Master + handoff + Project Status antes de cada write.
2. Verificar HEAD real en GitHub.
3. Un gate por vez.
4. Tests + Wrangler dry-run verdes.
5. Si el gate exige llamada real, no sustituirla por test sintético.
6. CI verde != deploy.
7. Distinguir siempre `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO`, `VALIDADO E2E`.
8. Consultar diagnósticos antes de corregir regresiones de llamada.
9. Root cause; no parches/timers acumulativos.
10. No tocar v36/v46/HangupController/750 ms sin evidencia directa.
11. No habilitar Gemini hasta cerrar A-D.
