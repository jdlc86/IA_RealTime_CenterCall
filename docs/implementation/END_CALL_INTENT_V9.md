# Cierre de llamada por intención semántica — v9

> Estado: **flujo canónico implementado**. Pendiente únicamente de completar validación E2E repetida de F0-T08.
>
> Código canónico: `apps/control-plane/src/call-session.ts` y `apps/control-plane/src/index.ts`.
>
> Persistencia por llamada: `CallSession` Durable Object, uno por `call_id`.

## 1. Objetivo

El sistema debe finalizar una llamada de forma natural cuando el usuario realmente quiere terminar la conversación, sin depender de una lista de palabras o frases prefijadas y sin introducir falsos cuelgues por menciones contextuales.

La decisión primaria pertenece al modelo Realtime, que interpreta semánticamente la intervención actual usando el contexto completo de la conversación. El Core no intenta sustituir esa comprensión mediante coincidencia léxica; recibe una intención estructurada y aplica una política determinista y auditable.

Las tres intenciones válidas son:

```text
CONTINUE
END_AMBIGUOUS
END_CLEAR
```

## 2. Principio de diseño

Se separan tres responsabilidades:

```text
Modelo Realtime
    ↓
comprensión semántica + contexto conversacional
    ↓
CONTINUE | END_AMBIGUOUS | END_CLEAR

CallSession Durable Object
    ↓
estado + ambiguous_count + política
    ↓
continuar | pedir confirmación natural | cerrar

OpenAI Realtime / SIP
    ↓
despedida final + /hangup
```

El modelo **clasifica intención**. El `CallSession` **decide la acción**. El modelo no ejecuta directamente `/hangup`.

## 3. Clasificación semántica

### 3.1 CONTINUE

Se usa cuando el usuario quiere seguir conversando, hace una nueva pregunta, solicita más ayuda, corrige algo, cambia de tema o cuando no existe evidencia razonable de que quiera finalizar la llamada.

Efecto obligatorio:

```text
state = ACTIVE
ambiguous_count = 0
respuesta normal
```

El reset a cero es una regla formal del sistema.

`ambiguous_count` representa únicamente **ambigüedades consecutivas dentro de un mismo intento de cierre**. Nunca acumula ambigüedades independientes a lo largo de una llamada larga.

Ejemplo conceptual:

```text
END_AMBIGUOUS → count=1
usuario formula una nueva consulta real
CONTINUE → count=0
```

### 3.2 END_CLEAR

Se usa cuando, considerando el contexto completo, la intención de finalizar la conversación es suficientemente clara.

No se añade una segunda pregunta de confirmación porque generaría fricción innecesaria.

Flujo:

```text
END_CLEAR
    ↓
CLOSING
    ↓
despedida breve y natural
    ↓
output_audio_buffer.stopped o watchdog
    ↓
POST /v1/realtime/calls/{call_id}/hangup
```

### 3.3 END_AMBIGUOUS

Se usa cuando parece que el usuario puede estar terminando, pero el contexto todavía permite razonablemente que quiera continuar.

Flujo:

```text
END_AMBIGUOUS
    ↓
ambiguous_count += 1
    ↓
¿count >= 3?
   │
   ├─ sí → CLOSING → despedida → HANGUP
   │
   └─ no → preguntar de forma natural:
          «¿Puedo ayudarte en algo más?»
          ↓
          esperar siguiente turno o timeout
```

La pregunta no debe mencionar "ambigüedad", "clasificación", "intención" ni ningún mecanismo interno.

## 4. Máquina de estados canónica

```text
                              ┌──────────────────────┐
                              │        ACTIVE        │
                              └──────────┬───────────┘
                                         │
                 ┌───────────────────────┼────────────────────────┐
                 │                       │                        │
              CONTINUE             END_AMBIGUOUS             END_CLEAR
                 │                       │                        │
                 │                       ▼                        │
                 │              ┌─────────────────┐               │
                 │              │    AMBIGUOUS    │               │
                 │              └────────┬────────┘               │
                 │                       │                        │
                 │       ┌───────────────┼───────────────┐        │
                 │       │               │               │        │
                 │    CONTINUE       END_CLEAR      END_AMBIGUOUS  │
                 │       │               │               │        │
                 │       │               │           count += 1   │
                 │       │               │               │        │
                 │       │               │       count < 3 / >= 3 │
                 │       │               │               │        │
                 └───────┴──→ ACTIVE     │        preguntar /     │
                     count=0             │          cerrar         │
                                         │               │        │
                                         └───────┬───────┴────────┘
                                                 ▼
                                        ┌─────────────────┐
                                        │     CLOSING     │
                                        └────────┬────────┘
                                                 │
                                      despedida final breve
                                                 │
                               output_audio_buffer.stopped
                                       o watchdog de cierre
                                                 │
                                                 ▼
                                              HANGUP
```

Estados efectivos de F0:

```text
ACTIVE
AMBIGUOUS
CLOSING
```

`COMPLETED` se representa operativamente por el cierre de la llamada/SIP y del sideband.

## 5. Política después de END_AMBIGUOUS

Después de una clasificación ambigua, la IA hace una única pregunta breve equivalente a:

```text
¿Puedo ayudarte en algo más?
```

A partir de ahí existen cuatro caminos.

### A. El usuario vuelve a una consulta normal

```text
usuario pide ayuda o formula nueva consulta
    ↓
modelo = CONTINUE
    ↓
ambiguous_count = 0
    ↓
ACTIVE
    ↓
la conversación continúa normalmente
```

Este reset evita que tres ambigüedades totalmente separadas en una llamada larga provoquen un cuelgue injustificado.

### B. El usuario expresa una intención clara de terminar

```text
modelo = END_CLEAR
    ↓
despedida
    ↓
HANGUP
```

No se vuelve a preguntar si necesita ayuda.

### C. El usuario vuelve a ser ambiguo

```text
modelo = END_AMBIGUOUS
    ↓
ambiguous_count += 1
```

Si todavía es menor que 3, puede hacerse otra confirmación natural. Si alcanza 3, F0 cierra la llamada.

### D. El usuario guarda silencio

Si el estado es `AMBIGUOUS` y se alcanza `idle_timeout_ms` después de la pregunta de confirmación:

```text
AMBIGUOUS
    ↓
silencio hasta timeout
    ↓
CLOSING
    ↓
despedida
    ↓
HANGUP
```

Un silencio ordinario en `ACTIVE` **no debe cerrar la llamada**.

## 6. Límite de ambigüedades

Configuración F0:

```text
AMBIGUOUS_LIMIT = 3
```

La regla completa es:

```text
END_AMBIGUOUS → count += 1
CONTINUE      → count = 0
END_CLEAR     → cerrar
count >= 3    → cerrar
```

El contador mide una secuencia continua de incertidumbre de cierre, no una puntuación acumulativa de toda la llamada.

## 7. Evolución futura: handoff humano

En F0, tres ambigüedades consecutivas terminan la llamada de forma educada. La política está preparada para evolucionar sin cambiar la clasificación semántica:

```text
ambiguous_count >= limit
        ↓
¿human_handoff habilitado?
   │                  │
   sí                 no
   │                  │
   ▼                  ▼
transferencia      despedida
agente humano      + hangup
```

El handoff humano **no forma parte de F0** y no debe marcarse todavía como implementado.

## 8. Integración con OpenAI Realtime

La sesión Realtime expone una herramienta obligatoria:

```text
conversation_intent(intent, reason)
```

con:

```text
tool_choice = required
```

El modelo debe clasificar cada turno real del usuario antes de producir la respuesta controlada por el Core.

Contrato conceptual:

```json
{
  "intent": "CONTINUE | END_AMBIGUOUS | END_CLEAR",
  "reason": "explicación breve basada en el contexto conversacional"
}
```

Después de recibir la tool-call, `CallSession` envía el resultado de la herramienta y crea la respuesta hablada apropiada usando:

```text
tool_choice = none
```

Esto evita ciclos en los que una respuesta generada por el propio Core vuelva a invocar el clasificador.

## 9. Rol de la transcripción auxiliar

`gpt-4o-mini-transcribe` continúa habilitado, pero en v9 su función es **observabilidad**.

No es el detector primario de intención y no se utiliza una lista de frases para decidir `CONTINUE`, `END_AMBIGUOUS` o `END_CLEAR`.

```text
audio del usuario
    ↓
Modelo Realtime + contexto → intención semántica

transcripción auxiliar
    ↓
logs / diagnóstico
```

Esto permite inspeccionar el sistema sin convertir la transcripción literal en la fuente de verdad de la intención.

## 10. Cierre técnico

Cuando la política entra en `CLOSING`:

1. se bloquea un segundo flujo de cierre concurrente;
2. se solicita una despedida final de una sola frase;
3. se espera el drenado del audio final mediante `output_audio_buffer.stopped` cuando es posible;
4. existe un watchdog para no quedar esperando indefinidamente;
5. se ejecuta:

```text
POST /v1/realtime/calls/{call_id}/hangup
```

6. `/hangup` tiene reintento;
7. Telnyx debe terminar observando `call.hangup`.

Si todos los intentos de `/hangup` fallan, el sistema **no puede permanecer conectado y mudo en `CLOSING`**. El `CallSession` vuelve a `ACTIVE`, resetea el contador y avisa brevemente de que la llamada sigue activa.

## 11. Guardas secundarias

Las guardas no sustituyen al clasificador semántico; solo protegen invariantes operativas.

- Una promesa verbal de la IA de que va a colgar no debe quedarse sin acción técnica.
- `response_cancel_not_active` se trata como no-op recuperable.
- El sideband vive en `CallSession` Durable Object y no depende de `waitUntil()` durante toda la llamada.
- Un fallo de hangup debe reactivar la sesión antes que dejar una llamada muda.
- El estado `CLOSING` no acepta un segundo cierre paralelo.

## 12. Invariantes funcionales

Estas reglas son canónicas:

1. **El significado y el contexto mandan; no las palabras aisladas.**
2. `CONTINUE` resetea siempre `ambiguous_count = 0`.
3. `END_CLEAR` cierra sin confirmación adicional.
4. `END_AMBIGUOUS` solicita ayuda adicional de forma natural.
5. Solo el silencio posterior a una ambigüedad pendiente puede confirmar cierre por timeout.
6. Tres `END_AMBIGUOUS` consecutivos cierran en F0.
7. Una nueva consulta real rompe la cadena de ambigüedades.
8. Una mención contextual de una despedida no implica por sí sola que el usuario quiera terminar.
9. La despedida final ocurre antes del hangup siempre que el canal de audio lo permita.
10. El Core ejecuta el hangup; el modelo únicamente aporta la intención.

## 13. Escenarios de validación

### T1 — intención clara

```text
Usuario: Perfecto, ya no necesito nada más. Me voy. Hasta luego.
Esperado: END_CLEAR → despedida → HANGUP
```

### T2 — ambigüedad + silencio

```text
Usuario: Bueno... creo que ya está.
Esperado: END_AMBIGUOUS, count=1
IA: ¿Puedo ayudarte en algo más?
Usuario: [silencio]
Esperado: timeout → despedida → HANGUP
```

### T3 — ambigüedad + nueva consulta

```text
Usuario: Bueno... creo que ya está.
Esperado: END_AMBIGUOUS, count=1
IA: ¿Puedo ayudarte en algo más?
Usuario: Sí, otra cosa. ¿Cuál es la velocidad de la luz?
Esperado: CONTINUE → count=0 → respuesta normal
```

### T4 — tres ambigüedades consecutivas

```text
Usuario: Bueno... creo que ya está.
→ END_AMBIGUOUS, count=1

Usuario: No sé... supongo que no.
→ END_AMBIGUOUS, count=2

Usuario: Pues... parece que eso es todo, creo.
→ END_AMBIGUOUS, count=3
→ despedida → HANGUP
```

### T5 — falso positivo contextual

```text
Usuario: Mi amigo terminó la conversación diciendo «hasta luego». ¿Te parece una despedida educada?
Esperado: CONTINUE
```

### T6 — palabra de despedida dentro de una consulta

```text
Usuario: ¿Cómo se dice «adiós» en inglés y en francés?
Esperado: CONTINUE
```

### T7 — cambio de opinión

```text
Usuario: Bueno, creo que ya hemos terminado.
→ END_AMBIGUOUS

IA: ¿Puedo ayudarte en algo más?
Usuario: Espera, sí. Se me olvidó preguntarte una cosa.
→ CONTINUE
→ ambiguous_count = 0
```

## 14. Observabilidad

Eventos principales de v9:

```text
call_intent_classified
call_intent_continue
call_intent_ambiguous
call_intent_ambiguity_reset
call_intent_end_clear
call_intent_ambiguous_silence_timeout
call_user_transcription_observed
end_call_closing_started
end_call_final_farewell_requested
end_call_final_response_created
end_call_hangup_triggered
end_call_hangup_start
end_call_hangup_result
realtime_sideband_closed
```

Para diagnosticar una llamada hay que correlacionar por `call_id` y observar, como mínimo:

```text
intent
state_before
ambiguous_count_before
ambiguous_count
reason
hangup status
Telnyx call.hangup
```

No debe guardarse contenido conversacional completo innecesariamente en logs.

## 15. Health esperado

La versión v9 debe anunciar una configuración equivalente a:

```json
{
  "tracing": "f0-e2e-v9",
  "intent_hangup": true,
  "intent_hangup_mode": "semantic_intent_v9",
  "intent_classifier": "conversation_intent",
  "intent_classifier_required": true,
  "ambiguous_limit": 3,
  "ambiguity_reset_on_continue": true,
  "realtime_sideband_lifecycle": "durable_object"
}
```

## 16. Criterio de aceptación F0-T08

El flujo puede considerarse estable cuando pruebas repetidas demuestren simultáneamente:

- `END_CLEAR` termina la llamada de forma consistente;
- `END_AMBIGUOUS` no produce cuelgues prematuros;
- silencio tras una ambigüedad termina correctamente;
- `CONTINUE` restaura `ACTIVE` y resetea el contador;
- tres ambigüedades consecutivas aplican la política definida;
- consultas que contienen palabras de despedida no generan falsos positivos obvios;
- el sideband permanece operativo durante llamadas prolongadas;
- `/hangup` termina en éxito y Telnyx registra cierre normal.

Hasta completar esa repetición, la arquitectura y política v9 son canónicas, pero el Gate F0-T08 continúa bajo validación.