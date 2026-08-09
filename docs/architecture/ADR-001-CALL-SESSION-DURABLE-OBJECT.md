# ADR-001 — CallSession persistente con Cloudflare Durable Objects

> **Estado:** Aceptado  
> **Fecha:** 2026-08-09  
> **Ámbito:** FASE 0 / Control Plane / OpenAI Realtime sideband

## Contexto

La primera implementación del sideband de OpenAI Realtime se abría desde el handler `POST /webhooks/openai` y se mantenía mediante `ctx.waitUntil()`.

Durante pruebas reales aparecieron llamadas que seguían conectadas pero dejaban de responder o no ejecutaban el cierre automático. Cloudflare registró:

```text
waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled
```

También apareció ocasionalmente:

```text
response_cancel_not_active
```

El segundo error es recuperable y significa únicamente que se intentó cancelar una respuesta que ya no estaba activa. No explica la pérdida prolongada del controlador de llamada.

El primer mensaje sí identifica la causa raíz: `waitUntil()` extiende el trabajo asociado a una invocación HTTP, pero no es un contenedor de ciclo de vida para una conexión WebSocket que debe sobrevivir durante toda una llamada telefónica.

## Decisión

Cada llamada OpenAI Realtime tendrá un Durable Object `CallSession` identificado de forma determinista por `call_id`.

```text
OpenAI realtime.call.incoming
        ↓
Cloudflare Worker
        ↓ accept
OpenAI Realtime SIP
        ↓
CALL_SESSIONS.idFromName(call_id)
        ↓
CallSession Durable Object
        ↓ outbound WebSocket sideband
OpenAI Realtime
```

`CallSession` es propietario de:

- WebSocket sideband de OpenAI asociado al `call_id`;
- máquina de estados `ACTIVE → CONFIRMING → CLOSING`;
- detección auxiliar de intención de fin de consulta;
- confirmación de intención;
- silencio durante confirmación;
- tool `end_call`;
- despedida final;
- ejecución de `/v1/realtime/calls/{call_id}/hangup`;
- reintento de hangup;
- protección frente a una llamada conectada pero muda.

El Worker HTTP conserva:

- webhooks Telnyx/OpenAI;
- validación de firmas;
- `CallOrchestrator`;
- transferencia Telnyx → OpenAI SIP;
- `/accept` de OpenAI;
- creación/arranque del `CallSession`.

## Persistencia y configuración

El namespace usa Durable Objects con almacenamiento SQLite y configuración declarativa de Wrangler:

```json
"durable_objects": {
  "bindings": [
    {
      "name": "CALL_SESSIONS",
      "class_name": "CallSession"
    }
  ]
},
"exports": {
  "CallSession": {
    "type": "durable-object",
    "storage": "sqlite"
  }
}
```

El `call_id` se usa con `idFromName(call_id)` para garantizar un único actor lógico por llamada.

## Regla de ciclo de vida

Está prohibido volver a mantener el sideband de una llamada mediante `ctx.waitUntil()` del webhook.

`waitUntil()` puede seguir usándose para tareas cortas asociadas al webhook, por ejemplo el comando HTTP de transferencia a Telnyx, pero no como dueño de una sesión realtime de duración arbitraria.

El sideband saliente abierto por `CallSession` mantiene vivo el Durable Object mientras la conexión está activa según el modelo de ciclo de vida de Cloudflare. La plataforma aplica un límite de protección frente a eviction de 15 minutos por conexión saliente; si en fases posteriores se requieren llamadas superiores a ese horizonte, deberá diseñarse explícitamente la continuidad/reconexión y documentarse en otro ADR.

## Cierre de llamada v8

```text
ACTIVE
  ↓ señal de fin
CONFIRMING
  ├─ usuario confirma → CLOSING
  ├─ usuario quiere continuar → ACTIVE
  └─ silence timeout → CLOSING

CLOSING
  ↓ despedida final
output_audio_buffer.stopped
  ↓
OpenAI /hangup
  ↓
Telnyx call.hangup
```

Una orden explícita como «cuelga la llamada» puede entrar directamente en `CLOSING`.

Si `/hangup` falla, `CallSession` reintenta. Si los intentos fallan, el estado vuelve a `ACTIVE` y la IA informa que la llamada continúa, evitando una sesión conectada pero permanentemente muda.

El error `response_cancel_not_active` se registra como no-op informativo y no se trata como fallo de sesión.

## Consecuencias

### Positivas

- ciclo de vida de sideband desacoplado del webhook HTTP;
- estado por llamada aislado;
- elimina la causa observada de cancelación por `waitUntil()`;
- base adecuada para concurrencia y estado futuro de llamada;
- mejor observabilidad del cierre;
- evita que un fallo de hangup deje la llamada muda indefinidamente.

### Costes / limitaciones

- se introduce Durable Objects en F0;
- existe coste de duración del objeto mientras el outbound WebSocket lo mantiene activo;
- despliegues de nuevas versiones pueden afectar conexiones WebSocket existentes;
- llamadas >15 min requieren una estrategia posterior de continuidad/reconexión.

## Criterio de validación

La corrección se considera validada cuando una llamada real demuestra simultáneamente:

1. sideband continúa operativo más allá del periodo en que antes aparecía la cancelación de `waitUntil()`;
2. conversación sigue respondiendo después de varios minutos;
3. intención de cierre entra en `CONFIRMING`;
4. confirmación o silencio conduce a despedida;
5. `/hangup` devuelve éxito;
6. Telnyx registra `call.hangup`;
7. no aparece el warning de cancelación del sideband por `waitUntil()`.
