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
F7 Concurrencia reservas                      🟡 HARDENED APP+DB / E2E VOZ PENDIENTE
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
Gate B V40/V44 provider-neutral         🟡 IMPLEMENTADO + FIX #547 SUCCESS / E2E PENDIENTE
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

Commits de código base:

```text
43e5d64cd209f4da0b6932f542192278dd601cc0
9de3b7829ea5031e5967b1d42722b597e15c18ef
```

Fix de falso IGNORE:

```text
188ae177fda6544b40c3f014ebe8d36edcd3a520
Control Plane CI #547 — SUCCESS
```

Estado funcional:

- V40/V44 consumen la frontera Realtime provider-neutral.
- raw VAD sigue siendo evidencia acústica, no autoridad semántica.
- `IGNORE_CONFIRMED` es la única salida del classifier que permite el descarte destructivo de una transcripción usable.
- salida `IGNORE` antigua, ambigua, malformada o fallback conserva el turno como `INTERRUPT`.
- reducers/effects de response ownership no cambiaron.

No se modificaron durante Gate B:

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

Gate B exige llamada E2E real con turno normal, interrupción legítima, background/ruido y continuación correcta. CI verde no sustituye el deploy ni la llamada real.

## E2E Gate B — evidencia requerida

Después de desplegar el HEAD actual, consultar `public.call_diagnostic_events` para la llamada y verificar al menos:

```text
BARGE_IN_PLAYBACK_WINDOW_OPENED_V40_REBUILD
RAW_VAD_ROUTED_TO_V40_ONLY_V44
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
BARGE_IN_CONFIRMED_V40_REBUILD
BARGE_IN_IGNORED_V40_REBUILD
```

También comprobar ausencia de `RESPONSE_OWNERSHIP_CONFLICT_V40_REBUILD` inesperado, warnings/errors críticos y pérdida del primer turno legítimo.

## Concurrencia de reservas simultáneas

Hardening implementado por solicitud explícita, **sin HOLD**:

```text
Capa 1 — AVAILABILITY_CHANGED en conflicto de commit
  commits 3e08c392… / 3747b0af… / 5bb5692d…
  CI #551 SUCCESS

Capa 2 — exclusion constraint por mesa + rango temporal
  commit 1ec885b8…
  CI #552 SUCCESS
  Supabase migration aplicada y verificada

Capa 3 — recuperación hablada determinista
  commit 98c13fee…
  CI #553 SUCCESS
```

Arbitraje:

```text
confirmación explícita
→ transacción PostgreSQL
→ lock de restaurant_tables
→ recheck
→ un ganador BOOKED / perdedor AVAILABILITY_CHANGED
```

No hay lock durante la conversación. No se promete FIFO por hora de llamada. El esquema impide dos asignaciones activas de la misma mesa en rangos temporales solapados incluso si una futura ruta intenta saltarse la RPC normal.

La prueba real de la constraint produjo `exclusion_violation` para una asignación conflictiva y dejó `0` filas ficticias persistidas.

El caller que pierde oye que la disponibilidad cambió y que no se creó ninguna reserva, y se le pregunta si quiere buscar horarios cercanos del mismo día. La búsqueda no se ejecuta en la misma respuesta para no leer un estado MVCC anterior al commit del ganador. Si el caller acepta, `restaurant_reservation_search` se usa en el siguiente turno; cualquier opción elegida exige nueva confirmación explícita.

Estado:

```text
APP/CI             = ✅
DB APLICADA        = ✅
DB VERIFICADA      = ✅
HOLD               = ❌ no implementado
WORKER DESPLEGADO  = ❌ no afirmado
E2E VOZ            = ⏳ pendiente
```

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
3. Un gate/cambio de riesgo por vez.
4. Tests + Wrangler dry-run verdes.
5. Si el gate exige llamada real, no sustituirla por test sintético.
6. CI verde != deploy.
7. Distinguir siempre `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO`, `VALIDADO E2E`.
8. Consultar diagnósticos antes de corregir regresiones de llamada.
9. Root cause; no parches/timers acumulativos.
10. No tocar v36/v46/HangupController/750 ms sin evidencia directa.
11. No habilitar Gemini hasta cerrar A-D.
