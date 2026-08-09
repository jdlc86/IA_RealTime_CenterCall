# Test Plan — FASE 0

> **Estado:** ✅ CERRADA / PASS — validación E2E manual completada

## Gate F0

PASS si:

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

## Resultado final

| Test | Estado | Evidencia / observación |
|---|---|---|
| F0-T01 — setup y saludo | [x] PASS | Llamada PSTN real, bridge Telnyx/OpenAI, atención automática y respuesta de voz verificadas. |
| F0-T02 — conversación ≥5 preguntas | [x] PASS manual | Conversación multi-turno prolongada validada durante las pruebas E2E. |
| F0-T03 — llamada ≥5 minutos | [x] PASS manual | Llamada real mantenida durante más de 5 minutos con conversación funcional. |
| F0-T04 — barge-in/interrupciones | [x] PASS manual | Interrupciones durante la respuesta de la IA probadas satisfactoriamente; la conversación continúa. |
| F0-T05 — silencio 5–10 s | [x] PASS manual | El silencio ordinario no termina la llamada y la conversación puede reanudarse. |
| F0-T06 — cuelgue manual | [x] PASS | Telnyx registra terminación normal (`normal_clearing`). |
| F0-T07 — 20 llamadas consecutivas | [x] PASS manual | Se realizaron 20 llamadas consecutivas de validación de setup y conversación básica. |
| F0-T08 — cierre automático semántico | [x] PASS manual v9 | Validados cierre claro, ambigüedad, continuación con reset, silencio tras ambigüedad y casos contextuales negativos. |

## F0-T08 — política v9 validada

Documento de diseño canónico: `docs/implementation/END_CALL_INTENT_V9.md`.

La detección primaria no depende de listas de palabras. El modelo Realtime clasifica semánticamente cada turno con contexto completo mediante la tool obligatoria `conversation_intent`:

```text
CONTINUE
END_AMBIGUOUS
END_CLEAR
```

### END_CLEAR

```text
END_CLEAR
→ CLOSING
→ despedida breve
→ /hangup
```

### END_AMBIGUOUS

```text
END_AMBIGUOUS
→ ambiguous_count += 1
→ «¿Puedo ayudarte en algo más?»
```

Si el usuario vuelve realmente a una consulta normal:

```text
CONTINUE
→ ACTIVE
→ ambiguous_count = 0
```

`ambiguous_count` representa ambigüedades consecutivas de un mismo intento de cierre y no se acumula durante toda la llamada.

Si tras la ambigüedad aparece una intención clara:

```text
END_AMBIGUOUS
→ END_CLEAR
→ despedida
→ hangup
```

Si, después de preguntar si necesita algo más, el usuario permanece en silencio hasta `idle_timeout_ms` (~10 s):

```text
AMBIGUOUS
→ input_audio_buffer.timeout_triggered
→ call_intent_ambiguous_silence_timeout
→ CLOSING
→ despedida
→ hangup
```

Un silencio ordinario en `ACTIVE` no debe cerrar la llamada.

Con tres ambigüedades consecutivas:

```text
END_AMBIGUOUS → count=1
END_AMBIGUOUS → count=2
END_AMBIGUOUS → count=3
→ CLOSING
→ despedida
→ hangup
```

`AMBIGUOUS_LIMIT = 3`. En una fase futura este límite podrá activar transferencia a un agente humano en lugar de hangup.

Las menciones de despedidas dentro de otra intención conversacional se clasifican por significado y contexto, no por coincidencias léxicas. Los diálogos de prueba incluyeron casos negativos y no produjeron cierres indebidos apreciables.

Permanece una guarda secundaria: si el asistente anuncia verbalmente que va a colgar sin que el Core esté ya en `CLOSING`, el sistema convierte esa promesa en cierre técnico.

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
- [x] Conversación multi-turno validada manualmente.
- [x] Llamada ≥5 minutos estable validada manualmente.
- [x] Barge-in/interrupciones validado manualmente.
- [x] Silencio y reanudación validados manualmente.
- [x] 20 llamadas consecutivas realizadas como prueba de estabilidad/setup.
- [x] Política semántica v9 de cierre validada manualmente.

## Baseline de setup y latencia

La experiencia de setup y latencia fue validada manualmente durante las pruebas E2E y aceptada para el cierre de F0. En esta fase no se registraron todavía métricas cuantitativas reproducibles (p50/p95). Esa instrumentación queda como deuda explícita para la fase de observabilidad y no debe confundirse con una medición numérica inexistente.

## Decisión de cierre

**FASE 0: ✅ PASS / CERRADA.**

El cierre se realiza tras la confirmación del responsable del proyecto de que el conjunto completo de pruebas F0 ha sido ejecutado satisfactoriamente. Las pruebas ya validadas no se repetirán salvo regresión o modificación relevante del flujo de voz.

La ausencia de métricas cuantitativas p50/p95 queda documentada explícitamente; no se inventan valores. La validación funcional y perceptual realizada es suficiente para aceptar F0 y avanzar a FASE 1.
