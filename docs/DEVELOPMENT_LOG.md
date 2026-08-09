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

### Estado del Gate F0

La primera conversación con voz **no implica todavía PASS completo de F0**. Quedan por ejecutar y registrar las pruebas de estabilidad, multi-turno, barge-in, silencio, duración ≥5 min y 20 llamadas consecutivas definidas en `docs/tests/PHASE0.md`.

### Próximo hito

Completar el Gate F0 y obtener baseline de latencia/setup. Después, avanzar al routing de tenant por número llamado sin introducir todavía lógica productiva de citas/CRM en F0.
