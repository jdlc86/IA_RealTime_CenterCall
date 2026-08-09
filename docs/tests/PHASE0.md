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
8. cuelgue automático por intención clara de despedida funciona de forma consistente y sin falsos positivos obvios;
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
- **F0-T08** — cuelgue automático por intención de despedida.

## Evidencia

| Test | Estado | Setup ms | Voz | Barge-in | Duración | Cierre | Observaciones |
|---|---|---:|---|---|---:|---|---|
| F0-T01 | [x] parcial | pendiente baseline | sí | no evaluado | prueba corta | observado | Llamada PSTN real; Telnyx `call.bridged`; OpenAI webhook; tras fix de `await unwrap()` la IA respondió por voz. |
| F0-T02 | [ ] | | | | | | |
| F0-T03 | [ ] | | | | | | |
| F0-T04 | [ ] | | | | | | |
| F0-T05 | [x] | | sí | | 5–10 s de silencio | llamada permanece activa | La IA indica que no ha escuchado, espera y permite reanudar la conversación normalmente. |
| F0-T06 | [x] | | sí | | | `normal_clearing` | Al colgar el llamante, Telnyx registra terminación normal. |
| F0-T07 | [ ] | | | | | | |
| F0-T08 | [ ] | | | | | pendiente | Versión híbrida v4 implementada; validar intención clara, confirmación ambigua y falsos positivos. |

`F0-T01` se marca **parcial** porque el setup y la respuesta de voz están demostrados, pero todavía falta medir el baseline de tiempo de establecimiento/saludo.

## F0-T08 — procedimiento híbrido v4

La detección usa dos capas:

```text
transcripción de entrada
  → detector determinista conservador
  → CLEAR      → despedida + hangup
  → PROBABLE   → confirmar «¿Necesitas algo más?»
  → NONE       → continuar

modelo Realtime
  → semántica general
  → tool end_call cuando detecta intención clara
```

La transcripción se usa como señal auxiliar de control. El modelo Realtime continúa procesando el audio nativamente.

### A. Intenciones claras — deben cerrar

Realizar llamadas separadas y probar al menos:

```text
«Adiós»
«Hasta luego»
«Eso es todo»
«No necesito nada más»
«Gracias, eso es todo»
«Puedes colgar»
«Hemos terminado»
```

Esperado:

1. se detecta intención clara;
2. IA emite una despedida final breve;
3. usuario no cuelga manualmente;
4. llamada termina automáticamente.

### B. Intenciones probables — deben confirmar

Probar:

```text
«Gracias»
«Muchas gracias»
«Perfecto, gracias»
```

Esperado: la IA pregunta aproximadamente «¿Necesitas algo más?» en vez de cerrar inmediatamente.

Si el usuario responde:

```text
«No»
«No, gracias»
«Nada más»
```

la llamada debe cerrar tras la despedida.

Si responde:

```text
«Sí»
«Sí, necesito otra cosa»
«Tengo otra pregunta»
```

la conversación debe continuar y el estado de cierre debe cancelarse.

### C. Doble despedida — debe elevar confianza

1. Conseguir que la IA ya se haya despedido.
2. Responder «gracias», «hasta luego» o equivalente final.
3. La segunda señal debe forzar el cierre sin volver a preguntar si necesita algo más.

### D. Pruebas negativas — no deben cerrar

```text
silencio 10 s
«Mi amigo se despidió diciendo adiós»
«¿Qué significa adiós?»
«¿Cómo se dice adiós en inglés?»
«Cuando alguien dice hasta luego, ¿qué quiere decir?»
```

Esperado: la llamada continúa.

### E. Logs esperados

Según el camino pueden aparecer:

```text
end_call_intent_classified
end_call_confirmation_requested
end_call_confirmation_classified
end_call_confirmation_cleared
end_call_assistant_farewell_observed
end_call_intent_detected
end_call_farewell_requested
end_call_farewell_response_created
end_call_hangup_triggered
end_call_hangup_result   status=200
realtime_sideband_closed
Telnyx call.hangup
```

Para privacidad, el trazado no guarda el texto completo de la transcripción: registra clasificación, regla y longitud.

## Evidencia técnica de la primera llamada E2E

Fecha: 2026-08-09.

Cadena demostrada:

```text
PSTN
→ número +34 Telnyx
→ Voice API Application
→ Cloudflare /webhooks/telnyx
→ CallOrchestrator
→ Telnyx transfer
→ OpenAI SIP/TLS
→ call.bridged
→ realtime.call.incoming
→ Cloudflare /webhooks/openai
→ OpenAI /accept
→ respuesta de voz al llamante
```

Incidencias resueltas durante la prueba:

1. `telnyx.webhooks.constructEvent is not a function` → verificación Ed25519 migrada a Cloudflare Web Crypto.
2. Secrets visibles pero no disponibles en runtime → configurados explícitamente como tipo Secret y validados mediante `/health.runtime_config`.
3. OpenAI webhook registrado como `unknown` → corregido procesamiento asíncrono usando `await client.webhooks.unwrap(...)`.

Resultado: **la IA respondió por voz en una llamada PSTN real**.

## Infraestructura validada

- [x] Repositorio canónico `jdlc86/IA_RealTime_CenterCall`.
- [x] GitHub → Cloudflare Workers Builds.
- [x] Deploy automático desde `main` con root `apps/control-plane`.
- [x] Worker público.
- [x] `/health` responde `ok: true`.
- [x] Secrets OpenAI/Telnyx disponibles en runtime.
- [x] Firma webhook Telnyx validada mediante Ed25519/Web Crypto.
- [x] Telnyx Call Control transfer a OpenAI SIP/TLS.
- [x] `call.bridged` observado.
- [x] Webhook OpenAI recibido y verificado.
- [x] `/accept` ejecutado tras reconocer `realtime.call.incoming`.
- [x] Audio de respuesta de OpenAI recibido por el llamante.

## Estado

El E2E mínimo de voz está validado, pero **FASE 0 todavía no está cerrada**. Deben completarse las pruebas pendientes y obtener el baseline de latencia/setup antes de declarar PASS del Gate F0.
