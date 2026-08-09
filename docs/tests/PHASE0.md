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
8. cuelgue automático por intención de terminar funciona de forma consistente, confirma cuando corresponde y no introduce falsos positivos obvios;
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
- **F0-T08** — cierre automático por intención de terminar.

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
| F0-T08 | [ ] | | | | | pendiente | v6 implementada: intención → confirmación → respuesta o timeout de silencio → despedida → hangup. |

`F0-T01` se marca **parcial** porque el setup y la respuesta de voz están demostrados, pero todavía falta medir el baseline de tiempo de establecimiento/saludo.

## F0-T08 — procedimiento v6

La v6 cambia el cierre de una colección de frases a una máquina de estados:

```text
CONVERSANDO
   ↓ señal de intención de terminar
CONFIRMACION_PENDIENTE
   ├─ usuario confirma que no necesita nada más → CIERRE
   ├─ usuario quiere continuar → CONVERSANDO
   └─ usuario no responde hasta idle timeout → CIERRE

CIERRE
   ↓
despedida breve
   ↓
POST /v1/realtime/calls/{call_id}/hangup
```

La transcripción auxiliar se usa como señal de control; el modelo Realtime sigue procesando el audio nativamente.

### A. Intenciones de terminar — deben provocar confirmación

Probar, en llamadas separadas o durante una conversación:

```text
«Adiós»
«Hasta luego»
«Eso es todo»
«No necesito nada más»
«No, no, en nada más»
«Ya terminé la consulta»
«No tengo más preguntas»
«No quiero seguir hablando»
«Lo dejamos aquí»
«Me tengo que ir»
«Gracias»
«Perfecto, gracias»
```

Esperado: salvo una orden explícita de colgar, el Core entra en confirmación y la IA dice algo equivalente a:

```text
«Entiendo que ya has terminado. ¿Necesitas algo más antes de que cierre la llamada?»
```

### B. Confirmación con respuesta de cierre

Después de la pregunta anterior probar:

```text
«No»
«No, gracias»
«No, no»
«No, no, en nada más»
«En nada más»
«Nada más»
«No tengo nada más»
«Ya terminé»
```

Esperado:

1. `end_call_confirmation_classified result=close` o cierre inferido equivalente;
2. despedida breve;
3. `/hangup` devuelve 200;
4. la llamada termina automáticamente.

### C. Confirmación sin respuesta — debe cerrar automáticamente

1. Expresar una intención de terminar.
2. Escuchar la pregunta de confirmación.
3. No decir absolutamente nada.
4. No colgar manualmente.

Esperado: al alcanzar el `idle_timeout_ms` configurado, OpenAI emite `input_audio_buffer.timeout_triggered`. Si el Core sigue en `CONFIRMACION_PENDIENTE`, ese silencio se interpreta como confirmación implícita de cierre.

Secuencia esperada:

```text
end_call_confirmation_requested
input_audio_buffer.timeout_triggered
end_call_confirmation_timeout
end_call_intent_detected source=confirmation_timeout
end_call_farewell_requested
end_call_hangup_triggered
end_call_hangup_result status=200
Telnyx call.hangup
```

**Importante:** un silencio ordinario fuera de `CONFIRMACION_PENDIENTE` no debe colgar la llamada.

### D. El usuario quiere continuar — no debe cerrar

Después de la confirmación responder:

```text
«Sí, necesito otra cosa»
«Tengo otra pregunta»
«Espera»
«Quiero preguntar otra cosa»
```

Esperado:

```text
end_call_confirmation_classified result=continue
end_call_confirmation_cleared reason=user_wants_to_continue
```

La conversación continúa normalmente.

### E. Orden explícita de colgar

Probar:

```text
«Cuelga»
«Puedes colgar ahora»
«Finaliza la llamada»
```

Esperado: puede pasar directamente a despedida + hangup sin una segunda confirmación innecesaria.

### F. Pruebas negativas — no deben iniciar cierre

```text
silencio 10 s sin señal previa de cierre
«Mi amigo se despidió diciendo adiós»
«¿Qué significa adiós?»
«¿Cómo se dice adiós en inglés?»
«Cuando alguien dice hasta luego, ¿qué quiere decir?»
```

Esperado: la llamada continúa.

### G. Guarda de compromiso verbal de la IA

Si por cualquier motivo la IA dice explícitamente algo como:

```text
«Voy a colgar la llamada ahora»
```

sin haber completado el flujo de tool/confirmación, el Core mantiene la guarda v5: esa declaración verbal debe convertirse en un hangup técnico real y no quedar solo como una frase.

## Logs relevantes

```text
end_call_intent_classified
end_call_confirmation_requested
end_call_confirmation_classified
end_call_confirmation_inferred_close
end_call_confirmation_cleared
end_call_confirmation_timeout
end_call_assistant_farewell_observed
end_call_assistant_commitment_without_tool
end_call_intent_detected
end_call_farewell_requested
end_call_farewell_response_created
end_call_hangup_triggered
end_call_hangup_result
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

El E2E mínimo de voz está validado, pero **FASE 0 todavía no está cerrada**. F0-T08 debe repetirse con la v6 para confirmar consistencia del nuevo cierre por confirmación y silencio, y siguen pendientes los demás casos no marcados junto al baseline de latencia/setup.
