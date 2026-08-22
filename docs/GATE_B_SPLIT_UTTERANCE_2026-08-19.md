# Gate B — intervención partida / item ordering — 2026-08-19

> Continuación del handoff operativo `docs/SESSION_HANDOFF_2026-08-19.md`.
> Esta nota supersede únicamente el HEAD/E2E requerido de Gate B descrito en secciones anteriores; no cambia el baseline estable de recuperación.

## Evidencia E2E

Llamada principal:

```text
call_id = rtc_u7_EEYu68y4jbqyPmYSYuePD
fecha local ≈ 2026-08-19 13:37 Europe/Madrid
179 eventos
warn/error/critical = 0
```

Patrón reproducido también en:

```text
rtc_u7_EEYqL9d7IOx0yJ1ekGYqJ
```

Secuencia causal:

```text
item A empieza durante playback
→ transcript A entra al classifier V40
→ antes de resolver A empieza item B con un item_id nuevo
→ classifier(A)=INTERRUPT
→ implementación anterior promovía A inmediatamente
→ V29 podía seleccionar una tool usando A + contexto anterior
→ comienza respuesta de Lucía
→ después completa transcript B
→ TURN_CONCURRENCY_LATE_TRANSCRIPT_BYPASSED_V36
→ SEMANTIC_GATE_LATE_TRANSCRIPT_BYPASSED_V29
→ B queda perdido
```

En la llamada principal:

```text
item A = item_EEYueRREAypYWogKblgAm
item B = item_EEYufIujElqEdD790osCc
```

El item antiguo terminó autorizando `restaurant_business_info topics=[MENU]`; el item nuevo llegó después y quedó tratado como late transcript. La causa raíz era una carrera de identidad/orden entre items del caller, no un timeout.

## Corrección

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
CALLER_SPEECH_STARTED conserva itemId cuando el provider lo entrega
→ V40 recuerda el item de voz más nuevo
→ V44 conserva esa identidad aunque suprima raw VAD del lower stack
→ V44 resetea solo bookkeeping V29 para el nuevo item
   semantic_authority_acquired=false
   tool_gate_armed=false
   transcript_still_required=true

classifier(A)=INTERRUPT y ya empezó B
→ A puede autorizar cancel/clear del playback
→ A NO puede autorizar response.create

si B ya terminó
→ B entra al pipeline semántico
→ luego se libera response.create

si B aún no terminó
→ response.create queda diferido hasta transcript.completed(B)

si aparece C antes de B
→ el target avanza a C

transcript intermedio
→ no adquiere la decisión del turno más nuevo

último transcript exacto unusable
→ fallback al source A ya confirmado
```

No se añadió `setTimeout`, `sleep`, ventana temporal ni segundo clasificador. El ordering usa `item_id`, `speech_started` y `transcript.completed`.

No se modificaron:

```text
v36
v46
ConversationTurnLifecycle v18
HangupController
TERMINAL_TRANSPORT_DRAIN_MS = 750
media path Telnyx → OpenAI SIP/RTP
```

## Estado

```text
FIX CÓDIGO = ✅
CI #560   = ✅ SUCCESS
DEPLOY    = ❌ no afirmado
E2E       = ⏳ repetir después de desplegar HEAD que contenga 5f442b1d…
Gate B    = 🟡 abierto
Gate C    = ⛔ bloqueado
```

## E2E obligatoria siguiente

Además de turno normal, background `IGNORE_CONFIRMED`, continuación, cierre V41 y hangup completo, la llamada debe probar una intervención legítima que pueda fragmentarse en varios items.

Si hay fragmentación real, buscar:

```text
SEMANTIC_TURN_BOOKKEEPING_RESET_FROM_ACOUSTIC_EVIDENCE_V29
BARGE_IN_NEWER_SPEECH_OBSERVED_V40_REBUILD
BARGE_IN_CONFIRMED_DEFERRED_TO_NEWER_SPEECH_V40_REBUILD
→ BARGE_IN_NEWER_COMPLETED_FRAGMENT_RESPONSE_RELEASED_V40_REBUILD
  o
→ BARGE_IN_DEFERRED_LATEST_FRAGMENT_PROMOTED_V40_REBUILD
```

Para MENU → pregunta por cierre, el item sustantivo más nuevo debe terminar en:

```text
restaurant_business_info topics=[HOURS]
```

No debe aparecer `SEMANTIC_GATE_LATE_TRANSCRIPT_BYPASSED_V29` para el item sustantivo más nuevo ni una nueva respuesta MENU disparada por el fragmento antiguo.
