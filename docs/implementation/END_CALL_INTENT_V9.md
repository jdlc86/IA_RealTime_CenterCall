# Cierre de llamada por intención semántica — v9

> Estado: implementado, pendiente de validación E2E repetida.

## Objetivo

El cierre de llamada no se basa en una lista de palabras del usuario. El modelo Realtime clasifica semánticamente cada turno usando la intervención actual y el contexto completo de la conversación.

El Core aplica una política determinista sobre tres intenciones estructuradas:

```text
CONTINUE
END_AMBIGUOUS
END_CLEAR
```

## Clasificación

### CONTINUE

El usuario quiere continuar, formula una nueva consulta, pide más ayuda o no existe evidencia suficiente de cierre.

Efecto:

```text
state = ACTIVE
ambiguous_count = 0
respuesta normal
```

El reset a cero es obligatorio. `ambiguous_count` representa ambigüedades consecutivas de un mismo intento de cierre; nunca se acumula a lo largo de toda la llamada.

### END_CLEAR

El contexto conversacional hace clara la intención de finalizar la conversación o llamada.

Efecto:

```text
END_CLEAR
→ CLOSING
→ despedida breve
→ /hangup
```

No se añade una confirmación innecesaria.

### END_AMBIGUOUS

Parece que el usuario podría estar terminando, pero el modelo no tiene suficiente seguridad contextual.

Efecto:

```text
ambiguous_count += 1

si ambiguous_count < 3:
    preguntar brevemente si necesita algo más
    esperar

si ambiguous_count >= 3:
    despedida
    /hangup
```

## Respuesta posterior a una ambigüedad

Después de `END_AMBIGUOUS`, el sistema pregunta de forma natural algo equivalente a:

```text
¿Puedo ayudarte en algo más?
```

A continuación:

```text
usuario pide ayuda / nueva consulta
→ modelo: CONTINUE
→ ambiguous_count = 0
→ ACTIVE

usuario expresa cierre claro
→ modelo: END_CLEAR
→ despedida
→ HANGUP

usuario vuelve a ser ambiguo
→ modelo: END_AMBIGUOUS
→ ambiguous_count += 1

silencio hasta idle_timeout
→ despedida
→ HANGUP
```

## Límite de ambigüedades

Versión F0:

```text
AMBIGUOUS_LIMIT = 3
```

Tres ambigüedades consecutivas dentro del mismo intento de cierre provocan despedida y cierre automático.

Evolución prevista:

```text
ambiguous_count >= limit
        ↓
¿human_handoff habilitado?
   sí              no
   ↓               ↓
agente humano   despedida + hangup
```

El handoff humano no forma parte de F0.

## Integración Realtime

La sesión configura:

```text
tool_choice = required
```

con una herramienta:

```text
conversation_intent(intent, reason)
```

El modelo debe clasificar cada turno real antes de generar una respuesta hablada.

`CallSession` recibe la tool-call por el sideband persistente del Durable Object y aplica la política. Las respuestas habladas que crea el Core usan `tool_choice = none` para evitar que la respuesta de control vuelva a invocar el clasificador.

## Responsabilidades

```text
Modelo Realtime
→ comprensión semántica y clasificación contextual

CallSession Durable Object
→ estado
→ ambiguous_count
→ política de cierre
→ timeout
→ despedida final
→ /hangup

Transcripción auxiliar
→ observabilidad únicamente
```

La transcripción de `gpt-4o-mini-transcribe` deja de utilizarse como detector primario basado en frases.

## Estados

```text
ACTIVE
  ├─ CONTINUE ───────────────→ ACTIVE (count=0)
  ├─ END_CLEAR ──────────────→ CLOSING
  └─ END_AMBIGUOUS ─────────→ AMBIGUOUS
                                  │
                                  ├─ CONTINUE → ACTIVE (count=0)
                                  ├─ END_CLEAR → CLOSING
                                  ├─ END_AMBIGUOUS → count+1
                                  ├─ count >= 3 → CLOSING
                                  └─ timeout → CLOSING

CLOSING
  → despedida final
  → output_audio_buffer.stopped o watchdog
  → POST /v1/realtime/calls/{call_id}/hangup
```

## Invariantes de seguridad

- Una nueva consulta real resetea `ambiguous_count` a 0.
- El silencio ordinario en `ACTIVE` no debe cerrar la llamada.
- El silencio en `AMBIGUOUS`, después de preguntar si necesita más ayuda, sí puede cerrar por timeout.
- `END_CLEAR` no requiere otra pregunta de confirmación.
- El modelo no ejecuta `/hangup`; solo clasifica intención.
- Si `/hangup` falla tras los reintentos, la sesión vuelve a `ACTIVE` para evitar una llamada conectada y muda.
- Se mantiene una guarda secundaria: si la IA llega a anunciar verbalmente que va a colgar sin que el Core esté cerrando, el Core convierte esa promesa en cierre técnico.

## Logs principales

```text
call_intent_classified
call_intent_continue
call_intent_ambiguous
call_intent_ambiguity_reset
call_intent_end_clear
call_intent_ambiguous_silence_timeout
end_call_closing_started
end_call_final_farewell_requested
end_call_hangup_triggered
end_call_hangup_start
end_call_hangup_result
```
