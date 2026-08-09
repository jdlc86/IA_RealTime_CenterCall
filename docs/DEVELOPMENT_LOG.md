# IA_RealTime_CenterCall — Development Log

## 2026-08-08

### Documentación v2.0

- [x] Creado `docs/README.md` como índice oficial.
- [x] Creado `SYSTEM_OVERVIEW.md`.
- [x] Creado `architecture/SYSTEM_ARCHITECTURE.md` como arquitectura canónica.
- [x] Creado `architecture/DESIGN_RULES.md`.
- [x] Creado `architecture/GLOSSARY.md`.
- [x] Migrada la guía F0 a `implementation/PHASE_0_IMPLEMENTATION_GUIDE.md`.

### FASE 0 — Cloudflare / GitHub

- [x] Código inicial de `apps/control-plane/` creado.
- [x] GitHub conectado con Cloudflare Workers Builds.
- [x] Root directory configurado como `apps/control-plane`.
- [x] Primer build/deploy automático correcto.
- [x] Worker público operativo.
- [x] `/health` validado.
- [x] Nombre del Worker alineado: `ia-realtime-centercall`.
- [x] `workers_dev` y `preview_urls` declarados explícitamente.

### FASE 0 — OpenAI

- [x] Project OpenAI creado.
- [x] API Key creada.
- [x] `OPENAI_API_KEY` guardada como Secret en Cloudflare.
- [x] Webhook OpenAI creado hacia `/webhooks/openai`.
- [x] Evento `realtime.call.incoming` suscrito.
- [x] `OPENAI_WEBHOOK_SECRET` guardado como Secret en Cloudflare.
- [x] Project ID configurado como `OPENAI_PROJECT_ID` para routing SIP.

### FASE 0 — Telefonía Telnyx

- [x] Twilio evaluado y sustituido como proveedor inicial de F0.
- [x] Telnyx adoptado por mejor ajuste a numeración española.
- [x] SIP Trunking/FQDN evaluado y descartado como ruta principal.
- [x] Creada Voice API Application `IA-RealTime-CenterCall-F0`.
- [x] Webhook API v2 y webhook `/webhooks/telnyx` configurados.
- [x] Configuración inbound realizada.
- [x] OVP Europa creado y asociado.
- [x] Número +34 asociado a la aplicación.

### FASE 0 — CallOrchestrator

- [x] Implementado `POST /webhooks/telnyx`.
- [x] Tolerancia anti-replay de 5 minutos.
- [x] Procesamiento exclusivo de `call.initiated` inbound para routing inicial.
- [x] Transferencia del leg entrante a OpenAI SIP mediante Telnyx Call Control.
- [x] TLS explícito para el tramo SIP.
- [x] Procesamiento asíncrono con `ctx.waitUntil()` para responder rápido al webhook.
- [x] `command_id` usado para mitigar comandos duplicados.
- [x] `/health` extendido con `telephony_provider=telnyx` y `call_orchestrator=true`.

## 2026-08-09

### CI/CD y primera llamada

- [x] Detectado repositorio GitHub duplicado conectado por error a Cloudflare.
- [x] Cloudflare reconectado al repositorio canónico `jdlc86/IA_RealTime_CenterCall`.
- [x] Root directory corregido a `apps/control-plane`.
- [x] Deploy automático GitHub → Cloudflare validado.
- [x] Los cuatro valores sensibles (`OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`) configurados como Secrets del runtime de Cloudflare.
- [x] `/health` confirmó los cinco parámetros runtime requeridos, incluido `OPENAI_PROJECT_ID`.
- [x] Primera llamada real al número Telnyx alcanzó `/webhooks/telnyx`.

### Incidencia F0-013-A — verificación webhook Telnyx

La primera llamada reveló el error runtime:

```text
telnyx.webhooks.constructEvent is not a function
```

Conclusión: la integración de red Telnyx → Cloudflare estaba funcionando, pero la verificación dependía de una API del SDK no disponible en el runtime instalado.

Corrección aplicada:

- [x] Eliminada la dependencia del SDK Telnyx para verificación de webhooks.
- [x] Implementada verificación Ed25519 directamente con Cloudflare Web Crypto.
- [x] La firma se verifica sobre `telnyx-timestamp + "|" + rawBody`.
- [x] Se mantienen los 5 minutos de tolerancia anti-replay.
- [x] Soporte de clave pública Telnyx en formato raw base64 y PEM/SPKI.
- [x] Eliminada la dependencia `telnyx` de `package.json`.
- [x] `/health` expone `telnyx_webhook_verification=webcrypto-ed25519` para comprobar la versión activa.

### Incidencia F0-013-B — Secrets presentes en Dashboard pero no en runtime

La instrumentación de `/health` mostró inicialmente `false` para los cuatro secretos. En Cloudflare existían como variables `Plaintext`, pero no estaban disponibles como Secrets en el runtime desplegado.

Corrección aplicada:

- [x] Recreados/configurados como tipo **Secret**.
- [x] Despliegue aplicado.
- [x] `/health.runtime_config` confirmó `true` para todos los parámetros requeridos.
- [x] La ruta `/health` expone únicamente booleanos de presencia; nunca valores secretos.

### Incidencia F0-013-C — webhook OpenAI interpretado como `unknown`

Durante la primera prueba SIP completa, la evidencia mostró:

```text
Telnyx call.bridged → OpenAI SIP
OpenAI POST /webhooks/openai → HTTP 200
openai_event.type → unknown
```

El webhook estaba firmado y llegaba correctamente, pero el resultado de `client.webhooks.unwrap(...)` no se estaba esperando antes de inspeccionar `event.type`. Por ello no se ejecutaba la rama `realtime.call.incoming` ni el `/accept` de la llamada.

Corrección aplicada:

- [x] `await client.webhooks.unwrap(rawBody, request.headers)`.
- [x] Añadido `raw_event_type` al trazado para comparar el JSON recibido con el evento verificado.
- [x] Trazado actualizado a `f0-e2e-v2`.

### Primera llamada E2E con voz — ÉXITO

Tras desplegar la corrección anterior se realizó una nueva llamada PSTN real y la IA respondió por voz al llamante.

Cadena validada en esta prueba:

```text
Teléfono real
  → PSTN / número +34 Telnyx
  → Telnyx Voice API
  → webhook firmado /webhooks/telnyx
  → CallOrchestrator
  → Telnyx Call Control transfer
  → SIP/TLS OpenAI Realtime
  → realtime.call.incoming
  → webhook firmado /webhooks/openai
  → POST /v1/realtime/calls/{call_id}/accept
  → OpenAI Realtime
  → audio de respuesta hacia el llamante
```

Evidencia observada antes de la corrección final y útil para aislar el problema:

- [x] Ambos legs llegaron a `call.bridged`.
- [x] El leg destino fue `sip:<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls`.
- [x] OpenAI envió el webhook al Worker.
- [x] Telnyx cerró la llamada de prueba con eventos `call.hangup`.
- [x] Después del fix de `unwrap()`, la IA respondió por voz.

**Conclusión:** el objetivo técnico mínimo de F0 — llamada PSTN real con respuesta de voz de OpenAI Realtime a través de Telnyx y Cloudflare — queda demostrado.

### Pruebas funcionales manuales adicionales

- [x] Silencio 5–10 s: la IA permanece activa, solicita repetir/continúa esperando y la conversación puede reanudarse.
- [x] Cuelgue manual del llamante: Telnyx registra `hangup_cause=normal_clearing`.
- [ ] Cuelgue automático por intención de despedida: funcional pero todavía bajo endurecimiento y prueba repetida.

### F0-014 — Cuelgue automático por intención

Se implementó una acción controlada `end_call` en la sesión Realtime.

Diseño inicial:

```text
usuario expresa intención clara de terminar
  → modelo solicita tool end_call
  → sideband Realtime del Worker recibe function_call
  → Worker confirma tool result
  → Worker solicita despedida final breve
  → output_audio_buffer.stopped o fallback
  → POST /v1/realtime/calls/{call_id}/hangup
  → SIP BYE / Telnyx call.hangup
```

### F0-014-B/C/D — endurecimiento del cierre

Durante pruebas sucesivas se añadieron detector híbrido, confirmación, timeout de silencio y guardas sobre la salida verbal de la IA. Estas versiones demostraron que la lógica conversacional era necesaria, pero todavía aparecían llamadas conectadas que dejaban de responder o no llegaban a ejecutar `/hangup`.

### Incidencia F0-015 — causa raíz: sideband mantenido con `waitUntil()`

En una llamada donde la IA dejó de responder después de una despedida aparecieron dos eventos relevantes:

```text
realtime_sideband_error_event
error_code=response_cancel_not_active
```

seguido de:

```text
waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled
```

Diagnóstico:

- `response_cancel_not_active` es un error recuperable/no-op: se intentó cancelar una respuesta inexistente.
- El warning de Cloudflare sí identifica la causa raíz.
- El sideband WebSocket de OpenAI estaba abierto dentro de la invocación `POST /webhooks/openai` y su vida dependía de `ctx.waitUntil()`.
- Cuando Cloudflare cancelaba la tarea, desaparecía el listener del sideband y con él la máquina de estados y la capacidad de ejecutar `/hangup`, aunque la llamada SIP continuara conectada.

Esto explica de forma unificada los síntomas observados: cierre inconsistente, llamadas mudas después de una despedida y pérdida del controlador en llamadas más largas.

### F0-016 — CallSession Durable Object (v8)

Corrección arquitectónica aplicada:

```text
OpenAI realtime.call.incoming
        ↓
Cloudflare Worker
        ↓ /accept
OpenAI Realtime
        ↓
CALL_SESSIONS.idFromName(call_id)
        ↓
CallSession Durable Object
        ↓ outbound WebSocket sideband
OpenAI Realtime
```

Cambios:

- [x] Creado `apps/control-plane/src/call-session.ts`.
- [x] `CallSession` extiende `DurableObject`.
- [x] Un objeto lógico por `call_id` usando `idFromName(call_id)`.
- [x] El WebSocket sideband ya no depende de `ctx.waitUntil()`.
- [x] Máquina `ACTIVE → CONFIRMING → CLOSING` movida a `CallSession`.
- [x] `end_call`, detector auxiliar, confirmación, timeout y despedida viven dentro del objeto por llamada.
- [x] `/hangup` tiene reintento.
- [x] Si todos los intentos de hangup fallan, la sesión vuelve a `ACTIVE` y avisa al usuario en lugar de quedar conectada y muda.
- [x] `response_cancel_not_active` se degrada a no-op informativo.
- [x] `output_audio_buffer.stopped` se correlaciona con la respuesta final cuando existe `response_id`.
- [x] Binding `CALL_SESSIONS` añadido a Wrangler.
- [x] Durable Object declarado con almacenamiento SQLite mediante `exports`.
- [x] Trazado actualizado a `f0-e2e-v8`.
- [x] Creado ADR `docs/architecture/ADR-001-CALL-SESSION-DURABLE-OBJECT.md`.

### Estado de validación v8

La causa raíz queda corregida en código, pero **F0-T08 sigue pendiente de validación E2E** tras el despliegue de v8.

Próxima prueba requerida:

1. confirmar `/health.tracing = f0-e2e-v8`;
2. mantener una llamada activa varios minutos;
3. comprobar que la IA sigue respondiendo;
4. decir «hasta luego» o equivalente;
5. confirmar cierre o guardar silencio tras la confirmación;
6. verificar `end_call_hangup_result status=200` y `Telnyx call.hangup`;
7. confirmar que ya no aparece el warning de cancelación del sideband por `waitUntil()`.
