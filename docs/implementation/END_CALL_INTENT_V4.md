# EndCallIntentDetector — diseño híbrido v4

> Estado: implementado, pendiente de validación estadística F0-T08.

## Objetivo

Cerrar una llamada automáticamente cuando el usuario realmente desea terminarla, reduciendo simultáneamente:

- falsos negativos: el usuario se despide pero la llamada queda abierta;
- falsos positivos: una palabra como «adiós» aparece en otro contexto y la llamada se corta.

Esta capacidad pertenece al Core conversacional y no debe depender del tipo de negocio.

## Arquitectura

```text
Audio del usuario
  ↓
OpenAI Realtime
  ├─ comprensión nativa de audio + tool end_call
  └─ transcripción auxiliar gpt-4o-mini-transcribe
          ↓
     EndCallIntentDetector
          ↓
     CLEAR / PROBABLE / NONE
```

### CLEAR

Intención inequívoca de terminar.

Ejemplos:

```text
Adiós
Hasta luego
Eso es todo
No necesito nada más
Puedes colgar
Hemos terminado
```

Acción:

```text
cancelar respuesta ordinaria si existe
→ generar despedida final breve
→ esperar fin de audio
→ POST /v1/realtime/calls/{call_id}/hangup
```

### PROBABLE

Expresión que puede ser cortesía o cierre.

Ejemplos:

```text
Gracias
Muchas gracias
Perfecto, gracias
```

Acción:

```text
preguntar «¿Necesitas algo más?»
```

Respuesta negativa (`no`, `no gracias`, `nada más`) → CLEAR.

Respuesta afirmativa (`sí`, `tengo otra pregunta`, etc.) → se limpia el estado de cierre y continúa la conversación.

### NONE

No existe señal suficiente de cierre.

Incluye silencios y menciones contextuales como:

```text
Mi amigo se despidió diciendo adiós
¿Qué significa adiós?
¿Cómo se dice adiós en inglés?
```

No se ejecuta hangup.

## Estado conversacional

El sideband mantiene durante la llamada:

```text
endCallPending
hangupStarted
confirmationPendingAt
assistantFarewellAt
closingResponseId
endCallReason
```

La confirmación y la despedida previa expiran a los 30 s para evitar que una señal antigua afecte a turnos posteriores.

## Doble despedida

Si la IA acaba de despedirse y el usuario responde con un agradecimiento o despedida final, la intención se eleva a CLEAR. Esto evita el caso observado donde ambas partes se despiden pero la llamada permanece abierta.

## Privacidad

La transcripción auxiliar se usa para decisión en memoria durante la llamada. Los logs no almacenan el texto completo; registran únicamente:

```text
nivel de clasificación
regla activada
longitud de la transcripción
estado de confirmación/despedida
```

## Observabilidad

Eventos principales:

```text
end_call_intent_classified
end_call_confirmation_requested
end_call_confirmation_classified
end_call_confirmation_cleared
end_call_assistant_farewell_observed
end_call_intent_detected
end_call_farewell_requested
end_call_hangup_triggered
end_call_hangup_result
```

## Health

La versión v4 se identifica mediante:

```json
{
  "tracing": "f0-e2e-v4",
  "intent_hangup": true,
  "intent_hangup_mode": "hybrid",
  "input_transcription": "gpt-4o-mini-transcribe"
}
```

## Criterio de aceptación

No declarar F0-T08 estable por una sola llamada correcta. Deben probarse varias formulaciones positivas, ambiguas y negativas descritas en `docs/tests/PHASE0.md` y verificar ausencia de falsos positivos obvios.
