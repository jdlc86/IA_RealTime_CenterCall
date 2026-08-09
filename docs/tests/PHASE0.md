# Test Plan — FASE 0

> **Estado:** activo — primera llamada E2E con voz validada

## Gate F0

PASS solo si:

1. llamada PSTN real entra;
2. IA atiende automáticamente;
3. audio bidireccional funciona;
4. conversación multi-turno coherente;
5. barge-in razonable;
6. llamada ≥5 minutos estable;
7. cuelgue manual limpia la sesión;
8. cuelgue automático por intención de terminar funciona de forma consistente y sin falsos positivos obvios;
9. ≥19/20 llamadas consecutivas completan setup/conversación básica;
10. baseline de setup y latencia documentado.

## Casos

- **F0-T01** — setup y saludo.
- **F0-T02** — conversación ≥5 preguntas.
- **F0-T03** — llamada ≥5 minutos.
- **F0-T04** — interrupción mientras habla la IA.
- **F0-T05** — silencio 5–10 s.
- **F0-T06** — cuelgue manual del cliente.
- **F0-T07** — 20 llamadas consecutivas.
- **F0-T08** — cierre automático por intención semántica.

## Evidencia

| Test | Estado | Voz | Cierre | Observaciones |
|---|---|---|---|---|
| F0-T01 | [x] parcial | sí | observado | Llamada PSTN real; Telnyx `call.bridged`; OpenAI webhook; IA respondió por voz. |
| F0-T02 | [ ] | | | |
| F0-T03 | [ ] | | | |
| F0-T04 | [ ] | | | |
| F0-T05 | [x] | sí | llamada permanece activa | Silencio ordinario no termina la llamada y la conversación puede reanudarse. |
| F0-T06 | [x] | sí | `normal_clearing` | Al colgar el llamante, Telnyx registra terminación normal. |
| F0-T07 | [ ] | | | |
| F0-T08 | [ ] | sí | pendiente validación v9 | Modelo clasifica `CONTINUE`, `END_AMBIGUOUS`, `END_CLEAR`; Core aplica política y hangup. |

## F0-T08 — procedimiento v9

Documento de diseño: `docs/implementation/END_CALL_INTENT_V9.md`.

La detección primaria ya no depende de listas de palabras. El modelo Realtime clasifica semánticamente cada turno con contexto completo mediante la tool obligatoria `conversation_intent`.

```text
CONTINUE
END_AMBIGUOUS
END_CLEAR
```

### A. END_CLEAR — cierre directo

Probar distintas formas naturales de terminar, no solo expresiones predefinidas.

Ejemplos orientativos:

```text
«Creo que con esto ya está, muchas gracias.»
«Perfecto, era todo lo que necesitaba.»
«No necesito nada más, gracias por la ayuda.»
```

Esperado:

```text
call_intent_classified intent=END_CLEAR
call_intent_end_clear
end_call_closing_started
end_call_final_farewell_requested
end_call_hangup_triggered
end_call_hangup_result status=200
Telnyx call.hangup
```

No debe realizar una confirmación adicional si el modelo considera clara la intención.

### B. END_AMBIGUOUS — preguntar si necesita más ayuda

Probar intervenciones cuyo significado contextual pueda ser de cierre pero no sea suficientemente claro.

Esperado:

```text
call_intent_classified intent=END_AMBIGUOUS
call_intent_ambiguous ambiguous_count=1
```

La IA pregunta una sola vez algo equivalente a:

```text
«¿Puedo ayudarte en algo más?»
```

### C. Ambigüedad + nueva consulta real

Después de una detección ambigua, realizar una nueva consulta real.

Esperado:

```text
call_intent_classified intent=CONTINUE
call_intent_continue
call_intent_ambiguity_reset
ambiguous_count=0
```

Esta regla es obligatoria: las ambigüedades separadas durante una llamada larga no se acumulan.

### D. Ambigüedad + intención clara posterior

Después de la pregunta «¿Puedo ayudarte en algo más?», expresar claramente que se ha terminado.

Esperado:

```text
END_AMBIGUOUS (count=1)
→ END_CLEAR
→ despedida
→ hangup
```

### E. Ambigüedad + silencio

1. Provocar `END_AMBIGUOUS`.
2. Escuchar la pregunta de seguimiento.
3. No responder.
4. No colgar manualmente.

Esperado: al alcanzar el timeout configurado (~10 s), solo estando en estado `AMBIGUOUS`:

```text
input_audio_buffer.timeout_triggered
call_intent_ambiguous_silence_timeout
end_call_closing_started
end_call_hangup_result status=200
```

**Importante:** un silencio ordinario estando en `ACTIVE` no debe cerrar la llamada.

### F. Tres ambigüedades consecutivas

Repetir tres veces una respuesta que el modelo clasifique como `END_AMBIGUOUS`, sin volver realmente a una consulta normal.

Esperado:

```text
END_AMBIGUOUS → count=1
END_AMBIGUOUS → count=2
END_AMBIGUOUS → count=3
→ CLOSING
→ despedida
→ hangup
```

En F0 el límite es `3`. En una fase futura este punto podrá activar handoff humano en lugar de hangup.

### G. CONTINUE desde conversación normal

Realizar preguntas normales durante varios turnos.

Esperado: cada turno se clasifica como `CONTINUE`, se responde normalmente y `ambiguous_count` permanece en 0.

### H. Prueba contextual negativa

Usar frases cuyo texto superficial pueda parecer una despedida pero cuyo significado contextual no sea terminar la llamada, por ejemplo hablar sobre cómo otra persona se despidió o preguntar por el significado de una despedida.

Esperado:

```text
call_intent_classified intent=CONTINUE
```

La llamada continúa. La clasificación debe depender del significado y contexto, no de coincidencias léxicas.

### I. Guarda de seguridad de salida de la IA

Si por un fallo el asistente anuncia verbalmente que va a colgar sin que el Core ya esté en `CLOSING`, permanece una guarda secundaria que convierte esa promesa en cierre técnico.

## Logs v9 relevantes

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
Telnyx call.hangup
```

La transcripción auxiliar se conserva para observabilidad de longitud/flujo, no como detector primario de intención.

## Infraestructura validada

- [x] GitHub → Cloudflare Workers Builds.
- [x] Worker público y `/health` operativo.
- [x] Telnyx → OpenAI SIP/TLS.
- [x] OpenAI `realtime.call.incoming` + `/accept`.
- [x] Audio bidireccional.
- [x] `CallSession` Durable Object por `call_id`.
- [x] Sideband Realtime persistente fuera de `waitUntil()`.
- [x] Reintento de `/hangup` y recuperación a `ACTIVE` si el cierre técnico falla.

## Estado

El E2E mínimo de voz está validado. **F0-T08 debe repetirse con v9** para validar la nueva política semántica, especialmente `END_CLEAR`, `END_AMBIGUOUS`, reset a cero tras `CONTINUE`, timeout durante ambigüedad y límite de tres ambigüedades consecutivas.
