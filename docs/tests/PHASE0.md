# Test Plan — FASE 0

> **Estado:** activo — E2E de voz, estabilidad ≥5 min, barge-in, 20 llamadas consecutivas y cierre semántico v9 validados manualmente

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
| F0-T03 | [x] | sí | estable | PASS manual: llamada real mantenida durante más de 5 minutos con conversación funcional. |
| F0-T04 | [x] | sí | continúa | PASS manual: interrupciones/barge-in durante la respuesta de la IA probadas satisfactoriamente y la conversación continúa. |
| F0-T05 | [x] | sí | llamada permanece activa | Silencio ordinario no termina la llamada y la conversación puede reanudarse. |
| F0-T06 | [x] | sí | `normal_clearing` | Al colgar el llamante, Telnyx registra terminación normal. |
| F0-T07 | [x] | sí | estable | PASS manual: se realizaron 20 llamadas consecutivas de validación del setup y conversación básica. |
| F0-T08 | [x] | sí | PASS manual v9 | Probados los diálogos de validación: cierre claro, ambigüedad, continuación con reset, silencio tras ambigüedad y casos contextuales negativos. El flujo fue considerado satisfactorio. |

## F0-T08 — política v9 validada

Documento de diseño canónico: `docs/implementation/END_CALL_INTENT_V9.md`.

La detección primaria no depende de listas de palabras. El modelo Realtime clasifica semánticamente cada turno con contexto completo mediante la tool obligatoria `conversation_intent`:

```text
CONTINUE
END_AMBIGUOUS
END_CLEAR
```

La validación manual confirmó el comportamiento funcional esperado de esta política.

### A. END_CLEAR — cierre directo

Cuando el contexto hace clara la intención de terminar:

```text
END_CLEAR
→ CLOSING
→ despedida breve
→ /hangup
```

No se añade una confirmación innecesaria.

### B. END_AMBIGUOUS — pregunta de continuación

Cuando la intención de terminar es probable pero no suficientemente segura:

```text
END_AMBIGUOUS
→ ambiguous_count += 1
→ «¿Puedo ayudarte en algo más?»
```

### C. Ambigüedad + nueva consulta real

Si el usuario vuelve realmente a una consulta normal:

```text
CONTINUE
→ ACTIVE
→ ambiguous_count = 0
```

Esta regla está validada y es obligatoria: `ambiguous_count` representa ambigüedades consecutivas de un mismo intento de cierre y no se acumula durante toda la llamada.

### D. Ambigüedad + intención clara posterior

```text
END_AMBIGUOUS
→ END_CLEAR
→ despedida
→ hangup
```

### E. Ambigüedad + silencio

Si el sistema ha preguntado si puede ayudar en algo más y el usuario no responde hasta el `idle_timeout_ms` (~10 s):

```text
AMBIGUOUS
→ input_audio_buffer.timeout_triggered
→ call_intent_ambiguous_silence_timeout
→ CLOSING
→ despedida
→ hangup
```

Un silencio ordinario en `ACTIVE` no debe cerrar la llamada.

### F. Tres ambigüedades consecutivas

En F0:

```text
END_AMBIGUOUS → count=1
END_AMBIGUOUS → count=2
END_AMBIGUOUS → count=3
→ CLOSING
→ despedida
→ hangup
```

`AMBIGUOUS_LIMIT = 3`.

En una fase futura este límite podrá activar transferencia a un agente humano en lugar de hangup.

### G. Prueba contextual negativa

Las menciones de despedidas dentro de otra intención conversacional deben clasificarse por significado y contexto, no por coincidencias léxicas. Los diálogos de prueba incluyeron ejemplos de este tipo y no produjeron cierres indebidos apreciables.

### H. Guarda de seguridad

Si por un fallo el asistente anuncia verbalmente que va a colgar sin que el Core esté ya en `CLOSING`, permanece una guarda secundaria que convierte esa promesa en cierre técnico.

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

La transcripción auxiliar se conserva para observabilidad, no como detector primario de intención.

## Infraestructura validada

- [x] GitHub → Cloudflare Workers Builds.
- [x] Worker público y `/health` operativo.
- [x] Telnyx → OpenAI SIP/TLS.
- [x] OpenAI `realtime.call.incoming` + `/accept`.
- [x] Audio bidireccional.
- [x] `CallSession` Durable Object por `call_id`.
- [x] Sideband Realtime persistente fuera de `waitUntil()`.
- [x] Reintento de `/hangup` y recuperación a `ACTIVE` si el cierre técnico falla.
- [x] Llamada ≥5 minutos estable validada manualmente.
- [x] Barge-in/interrupciones validado manualmente.
- [x] 20 llamadas consecutivas realizadas como prueba de estabilidad/setup.
- [x] Política semántica v9 de cierre validada manualmente.

## Estado

**F0-T03, F0-T04, F0-T07 y F0-T08 quedan marcados PASS manual.** No es necesario repetir estas pruebas salvo modificación relevante o regresión.

FASE 0 todavía no debe declararse PASS global mientras permanezcan sin evidencia los demás casos del Gate, especialmente F0-T02 y el baseline de setup/latencia.
