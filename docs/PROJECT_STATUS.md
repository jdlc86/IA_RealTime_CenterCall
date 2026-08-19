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
F2 Latencia + barge-in                        🟡 GATE B FIX #560 / NUEVO E2E PENDIENTE
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
Gate B V40/V44 provider-neutral         🟡 FIX #560 SUCCESS / NUEVO E2E PENDIENTE
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

Fix de falso IGNORE usable:

```text
188ae177fda6544b40c3f014ebe8d36edcd3a520
Control Plane CI #547 — SUCCESS
```

Fix de desfase por reanudación sintética tras IGNORE:

```text
6abd28f08aed43712572d7c6d7dca57d370c0191
Control Plane CI #555 — SUCCESS
```

La E2E `rtc_u7_EEX3EdnY9EpeQoPn47sr7` confirmó que el primer fix permitía que interrupciones legítimas llegaran al pipeline, pero descubrió otra política incorrecta: un `IGNORE` con playback cleared podía cancelar la respuesta original y crear una respuesta sintética `resume_assistant`. Esa reanudación podía arrancar mientras el caller ya había iniciado otro turno y también podía repetir la pregunta de continuación.

Nueva política de IGNORE:

```text
IGNORE
→ no cancel_response
→ no resume_assistant
→ no create_caller_response
→ conservar respuesta activa si existe

INTERRUPT
→ mantiene cancel/clear/promoción semántica cuando corresponda
```

No se añadió timer/delay para esa corrección.

### Gate B — fix V41 de cierre contextual posterior al transcript

E2E que reveló el fallo:

```text
call_id = rtc_u7_EEXVOfvJ2jOV8iLcEBoq7
fecha local ≈ 2026-08-19 12:08–12:10 Europe/Madrid
```

La interrupción legítima MENU → HOURS funcionó al primer intento y no reapareció la reanudación sintética anterior. Sin embargo, después de que Lucía preguntara si podía ayudar en algo más, una despedida explícita del caller no llegó al hangup.

Secuencia observada del fallo:

```text
ASSISTANT_RESPONSE_COMPLETED
→ después llega CALLER_TRANSCRIPT_COMPLETED usable
→ MORE_HELP_QUESTION_RESOLVED_V41 = UNRESOLVED
→ CONTEXTUAL_MORE_HELP_AWAITING_SEMANTIC_RESOLUTION_V41
→ ningún restaurant_end_call
→ ningún V41_CLOSE_COMMITTED_TO_LIFECYCLE
→ ningún LIFECYCLE_END_CALL_REQUESTED_V18
→ sideband 1006 con hangup_started=false
```

Causa raíz: V41 activaba `moreHelpSemanticResolutionPendingV41` después de recibir el transcript final, pero la liberación/resolución dependía de una respuesta normal del modelo cuyo `response.done` podía haber ocurrido antes. Era una carrera de orden de eventos; no un problema del drain terminal de 750 ms.

Fix:

```text
e58fc1469333a1dc422a2acaf38a6ba59202ee4a
fix(v41): resolve contextual close after transcript
Control Plane CI #557 — SUCCESS
```

Política nueva:

```text
respuesta a “¿algo más?”
→ resolver determinista
   ├─ CLOSE reconocido → cierre contextual directo
   ├─ CONTINUE reconocido → conversación normal
   └─ UNRESOLVED
       → text decision provider-neutral dedicado
       → correlacionado al source_item_id del caller
       → CLOSE solo con salida explícita CLOSE
       → cualquier salida ambigua/malformada = CONTINUE fail-safe
```

El decisor dedicado nace **después** del transcript final y posee su propio `response_id`; por tanto no depende de un `response.done` anterior de la respuesta normal. Las respuestas de ese decisor se interceptan como internas de V41 y no se entregan al lower response owner como si fueran habla de Lucía.

Además, `resolveReplyToMoreHelpQuestion()` reutiliza ahora la evidencia determinista de despedida explícita (`adiós`, `hasta luego`, `hasta otra`, `nos vemos`, `chao/chau`, `que vaya bien`, etc.) después de aplicar primero la precedencia de una nueva petición. Así `“hasta luego... espera, una cosa más”` sigue siendo continuación y no un cierre falso.

No se añadió timer/delay. En este fix no se modificaron:

```text
v36
v40/v44
v46
ConversationTurnLifecycle v18
HangupController
TERMINAL_TRANSPORT_DRAIN_MS = 750
Telnyx → OpenAI direct SIP
```

### Gate B — fix de intervención partida / item ordering

E2E que reveló el fallo:

```text
call_id = rtc_u7_EEYu68y4jbqyPmYSYuePD
fecha local ≈ 2026-08-19 13:37 Europe/Madrid
warn/error/critical = 0
```

Patrón reproducido también en `rtc_u7_EEYqL9d7IOx0yJ1ekGYqJ`.

Secuencia causal observada:

```text
fragmento A empieza durante playback
→ A se transcribe y entra al classifier V40
→ antes de resolver A, empieza fragmento B con un item_id nuevo
→ classifier confirma INTERRUPT para A
→ V40 antiguo promovía A inmediatamente
→ V29 podía elegir una tool usando A + contexto anterior
→ comienza respuesta de Lucía
→ llega transcript usable de B
→ TURN_CONCURRENCY_LATE_TRANSCRIPT_BYPASSED_V36
→ SEMANTIC_GATE_LATE_TRANSCRIPT_BYPASSED_V29
→ B queda perdido
```

En la llamada `rtc_u7_EEYu68y4jbqyPmYSYuePD`, el item antiguo `item_EEYueRREAypYWogKblgAm` acabó autorizando `restaurant_business_info topics=[MENU]`; el item más nuevo `item_EEYufIujElqEdD790osCc` llegó después y fue tratado como late transcript. El problema no era un timeout: era una carrera de identidad/orden entre items del caller.

Corrección en dos commits:

```text
5cfc0f1190fc31827c263a03807492b92592e6a4
fix(gate-b): preserve newest split barge-in fragment
Control Plane CI #559 — SUCCESS

5f442b1d91855acdf8c12451f45e6586b72b57f4
fix(gate-b): reset split-turn bookkeeping on suppressed vad
Control Plane CI #560 — SUCCESS
```

Nueva política:

```text
speech_started expone item_id provider-neutral cuando el provider lo entrega
→ V40 conserva el item de voz más nuevo
→ V44, aunque suprima raw VAD del lower stack, resetea solo el bookkeeping V29 del nuevo item
   semantic_authority_acquired=false
   tool_gate_armed=false
   transcript_still_required=true
→ si classifier(A)=INTERRUPT y ya empezó B
   ├─ A puede autorizar cancel/clear del playback
   └─ A NO puede autorizar response.create
→ si B ya terminó, su transcript entra al pipeline y entonces se libera response.create
→ si B aún no terminó, response.create queda diferido hasta transcript.completed(B)
→ si aparece C antes de B, el target avanza a C
→ un transcript intermedio no puede adquirir la decisión del turno más nuevo
→ si el transcript exacto más nuevo es unusable, fallback al source A ya confirmado
```

No se introdujo `setTimeout`, `sleep`, ventana temporal ni segundo clasificador. El ordering usa exclusivamente `item_id`, `speech_started` y `transcript.completed`. La identidad `item_id` de `CALLER_SPEECH_STARTED` se transporta por la frontera provider-neutral; OpenAI la aporta en su evento de inicio de voz.

No se modificaron:

```text
v36
v46
ConversationTurnLifecycle v18
HangupController
TERMINAL_TRANSPORT_DRAIN_MS = 750
media path Telnyx → OpenAI SIP/RTP
```

Estado Gate B:

```text
IMPLEMENTADO = ✅
CI VERDE = ✅ #560
DESPLEGADO = ❌ no afirmado para 5f442b1d…
VALIDADO E2E = ❌ requiere nueva llamada limpia sobre runtime desplegado con este HEAD
```

## Bloqueo deliberado antes de Gate C

Gate B exige una llamada E2E real después de desplegar el HEAD que contenga `5f442b1d…`. CI verde no sustituye el deploy ni la llamada real.

La E2E debe cubrir conjuntamente:

1. turno normal de negocio;
2. primera interrupción legítima → `INTERRUPT` y semántica correcta;
3. intervención partida en 2 items → la respuesta debe corresponder al fragmento/turno más nuevo, nunca al contexto anterior;
4. frase realmente de fondo → `IGNORE_CONFIRMED`, sin `resume_assistant` sintético;
5. continuación correcta y sin ownership conflict;
6. cierre después de `¿Puedo ayudarte en algo más?` con despedida explícita;
7. hangup completo por lifecycle/HangupController.

## E2E Gate B — evidencia requerida

Interrupción legítima sin fragmentación:

```text
BARGE_IN_PLAYBACK_WINDOW_OPENED_V40_REBUILD
RAW_VAD_ROUTED_TO_V40_ONLY_V44
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
BARGE_IN_CONFIRMED_V40_REBUILD
CONFIRMED_BARGE_IN_SEMANTIC_TURN_STARTED_V29
restaurant_business_info topics=[HOURS]
```

Si la intervención se fragmenta en varios `item_id`, se espera según el orden real:

```text
SEMANTIC_TURN_BOOKKEEPING_RESET_FROM_ACOUSTIC_EVIDENCE_V29
BARGE_IN_NEWER_SPEECH_OBSERVED_V40_REBUILD
BARGE_IN_CONFIRMED_DEFERRED_TO_NEWER_SPEECH_V40_REBUILD
→ BARGE_IN_NEWER_COMPLETED_FRAGMENT_RESPONSE_RELEASED_V40_REBUILD
  o
→ BARGE_IN_DEFERRED_LATEST_FRAGMENT_PROMOTED_V40_REBUILD
```

Y el item sustantivo más nuevo debe producir la tool correcta; para la prueba MENU → pregunta por cierre:

```text
restaurant_business_info topics=[HOURS]
```

No debe aparecer `SEMANTIC_GATE_LATE_TRANSCRIPT_BYPASSED_V29` para el item sustantivo más nuevo ni una nueva respuesta MENU disparada por el fragmento antiguo.

Background/ruido:

```text
IGNORE_CONFIRMED
→ BARGE_IN_IGNORED_V40_REBUILD
→ no resume_assistant sintético
→ no nueva respuesta artificial de Lucía
```

Cierre contextual directo esperado para una despedida reconocible:

```text
MORE_HELP_QUESTION_OPENED_V41
→ CONTEXTUAL_CLOSE_RESOLVED_V41
→ V41_CLOSE_COMMITTED_TO_LIFECYCLE
→ LIFECYCLE_END_CALL_REQUESTED_V18
→ terminal playback
→ drain 750 ms
→ HANGUP_STARTED (TELNYX_SOURCE_LEG)
→ Telnyx HTTP 200
→ HANGUP_COMPLETED
```

Si el transcript queda determinísticamente `UNRESOLVED`, se espera además:

```text
CONTEXTUAL_MORE_HELP_DECISION_REQUESTED_V41
→ CONTEXTUAL_MORE_HELP_DECISION_BOUND_V41
→ TEXT_DECISION_COMPLETED
→ CONTEXTUAL_CLOSE_RESOLVED_V41
   resolution_source=DEDICATED_MORE_HELP_DECISION_V41
```

También comprobar:

```text
RESPONSE_OWNERSHIP_CONFLICT_V40_REBUILD = 0
warn/error/critical inesperados = 0
```

`TURN_CONCURRENCY_LATE_TRANSCRIPT_BYPASSED_V36` debe revisarse si reaparece para el item nuevo, pero v36 no se modificará sin evidencia causal directa.

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
WORKER DESPLEGADO  = ❌ no afirmado para HEAD actual
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
