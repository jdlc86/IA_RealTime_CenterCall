# Cierre de llamada por intención semántica — v9

> **Estado:** vigente para el producto OpenAI; VALIDADO MANUALMENTE EN E2E (F0-T08 = PASS)
> **Última revisión documental:** 2026-08-29

Este diseño registra la política OpenAI. No se debe imponer su lifecycle o wire al producto Gemini Fast; ambos preservan la invariante de cierre mediante owners propios.

## 1. Objetivo

El cierre de llamada no se basa en una lista de palabras del usuario. El modelo Realtime clasifica semánticamente cada turno usando la intervención actual y el contexto completo de la conversación.

El Core aplica una política determinista sobre tres intenciones estructuradas:

```text
CONTINUE
END_AMBIGUOUS
END_CLEAR
```

La responsabilidad queda separada de forma explícita:

```text
Modelo Realtime → comprende intención y contexto
CallSession      → aplica política y mantiene estado
OpenAI /hangup   → termina técnicamente la llamada
```

## 2. Principio de diseño

La pregunta relevante no es si la frase contiene palabras como «adiós», «gracias» o «hasta luego». La pregunta es:

> ¿Qué intención expresa el usuario en este momento, teniendo en cuenta el turno actual y toda la conversación previa?

Por eso una frase que mencione una despedida dentro de otra consulta puede ser `CONTINUE`, mientras que una frase sin ninguna palabra típica de despedida puede ser `END_CLEAR` si el contexto indica claramente que el usuario ha terminado.

## 3. Clasificación semántica

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

## 4. Flujo canónico

```text
                     TURNO DEL USUARIO
                            ↓
                MODELO + CONTEXTO COMPLETO
                            ↓
           ┌────────────────┼─────────────────┐
           ↓                ↓                 ↓
       CONTINUE       END_AMBIGUOUS       END_CLEAR
           │                │                 │
   ambiguous_count=0   count = count+1        │
           │                │                 │
   respuesta normal    count < 3 ?            │
                            │                  │
                   «¿Puedo ayudarte           │
                    en algo más?»             │
                            │                  │
             ┌──────────────┼────────────┐     │
             ↓              ↓            ↓     │
         CONTINUE       END_CLEAR    END_AMBIGUOUS
             │              │            │
          count=0           │         count+1
             │              │            │
           ACTIVE           │       count >= 3
                            │            │
                            └──────┬─────┘
                                   ↓
                               CLOSING
                                   ↓
                           despedida final
                                   ↓
                                HANGUP
```

## 5. Respuesta posterior a una ambigüedad

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

## 6. Regla del contador de ambigüedades

Versión F0:

```text
AMBIGUOUS_LIMIT = 3
```

La regla formal es:

```text
END_AMBIGUOUS → ambiguous_count += 1
CONTINUE      → ambiguous_count = 0
END_CLEAR     → CLOSING
count >= 3    → CLOSING
```

El contador representa exclusivamente ambigüedades **consecutivas dentro del mismo intento de cierre**.

Ejemplo correcto:

```text
END_AMBIGUOUS → count=1
usuario hace una pregunta real
CONTINUE      → count=0
...
END_AMBIGUOUS → count=1, no 2
```

Esto evita terminar injustificadamente una llamada larga por ambigüedades independientes ocurridas en momentos diferentes.

## 7. Silencio

El silencio tiene significado distinto según el estado.

### Silencio en ACTIVE

No provoca cierre.

```text
ACTIVE + silencio
→ la llamada permanece disponible
```

### Silencio después de END_AMBIGUOUS

El sistema ya preguntó si puede ayudar en algo más. Si el usuario no responde durante el `idle_timeout_ms` configurado (~10 s), el silencio se acepta como confirmación implícita de que no desea continuar.

```text
AMBIGUOUS
→ pregunta de continuación
→ silencio
→ input_audio_buffer.timeout_triggered
→ CLOSING
→ despedida
→ HANGUP
```

## 8. Integración Realtime

La sesión configura:

```text
tool_choice = required
```

con la herramienta:

```text
conversation_intent(intent, reason)
```

El modelo clasifica cada turno real antes de generar una respuesta hablada.

`CallSession` recibe la tool-call por el sideband persistente del Durable Object y aplica la política. Las respuestas habladas creadas por el Core usan:

```text
tool_choice = none
```

para evitar que una respuesta de control vuelva a invocar el clasificador.

## 9. Responsabilidades

```text
Modelo Realtime
→ comprensión semántica
→ contexto completo
→ CONTINUE / END_AMBIGUOUS / END_CLEAR

CallSession Durable Object
→ estado por call_id
→ ambiguous_count
→ reset del contador
→ política de silencio
→ límite de ambigüedades
→ despedida final
→ reintento de /hangup

Transcripción auxiliar
→ observabilidad únicamente
```

La transcripción de `gpt-4o-mini-transcribe` no se utiliza como detector primario basado en frases.

## 10. Estados

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

## 11. Invariantes de seguridad

- Una nueva consulta real resetea `ambiguous_count` a 0.
- El silencio ordinario en `ACTIVE` no debe cerrar la llamada.
- El silencio en `AMBIGUOUS`, después de preguntar si necesita más ayuda, sí puede cerrar por timeout.
- `END_CLEAR` no requiere otra pregunta de confirmación.
- El modelo no ejecuta `/hangup`; solo clasifica intención.
- Si `/hangup` falla tras los reintentos, la sesión vuelve a `ACTIVE` para evitar una llamada conectada y muda.
- Se mantiene una guarda secundaria: si la IA anuncia verbalmente que va a colgar sin que el Core esté cerrando, el Core convierte esa promesa en cierre técnico.
- Un fallo del clasificador no debe dejar la llamada en un estado muerto; se favorece continuar la conversación.

## 12. Escenarios de validación manual

La v9 fue probada manualmente con diálogos que cubren las siguientes familias:

### Caso 1 — cierre claro

```text
Usuario realiza una consulta
IA responde
Usuario expresa inequívocamente que ya no necesita nada más
```

Esperado y validado funcionalmente:

```text
END_CLEAR
→ despedida
→ hangup
```

### Caso 2 — ambigüedad + silencio

```text
Usuario expresa una posible intención de cierre no concluyente
→ END_AMBIGUOUS
IA pregunta si puede ayudar en algo más
Usuario guarda silencio
```

Esperado y validado funcionalmente:

```text
timeout
→ despedida
→ hangup
```

### Caso 3 — ambigüedad + nueva consulta

```text
END_AMBIGUOUS → count=1
IA pregunta si puede ayudar en algo más
Usuario realiza una nueva consulta real
```

Esperado y validado:

```text
CONTINUE
→ ambiguous_count=0
→ conversación normal
```

### Caso 4 — ambigüedades consecutivas

```text
END_AMBIGUOUS → 1
END_AMBIGUOUS → 2
END_AMBIGUOUS → 3
```

Esperado:

```text
CLOSING
→ despedida
→ hangup
```

### Caso 5 — falso positivo contextual

Se habla sobre una despedida dentro de otra consulta, sin querer terminar la llamada.

Esperado y validado:

```text
CONTINUE
```

### Caso 6 — cambio de opinión

```text
END_AMBIGUOUS
→ pregunta de continuación
→ usuario recuerda otra consulta
→ CONTINUE
→ count=0
```

## 13. Criterio de aceptación F0-T08

F0-T08 se considera **PASS manual** porque los diálogos de validación de la v9 se ejecutaron satisfactoriamente y el flujo conversacional resultó adecuado para esta fase.

La prueba deberá repetirse únicamente si:

- cambia la política semántica;
- cambia el modelo Realtime;
- cambia la implementación de `CallSession` relacionada con estados o cierre;
- aparece una regresión observada en llamadas reales.

## 14. Logs principales

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
realtime_sideband_closed
```

## 15. Evolución futura: agente humano

La política está diseñada para evolucionar sin cambiar la clasificación semántica:

```text
ambiguous_count >= AMBIGUOUS_LIMIT
              ↓
     ¿human_handoff habilitado?
          │              │
         sí             no
          ↓              ↓
   agente humano    despedida + hangup
```

La transferencia a agente humano no forma parte de F0. En la versión actual, alcanzar el límite provoca despedida y cierre automático.
