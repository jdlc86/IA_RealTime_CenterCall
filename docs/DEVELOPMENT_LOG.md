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
- [x] `TELNYX_API_KEY` y `TELNYX_PUBLIC_KEY` configurados como Secrets.
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

### Próximo hito

Repetir la llamada y confirmar, en orden:

1. `telnyx_webhook_received` (`call.initiated`, incoming);
2. `telnyx_transfer_requested`;
3. `realtime_call_incoming`;
4. `realtime_call_accepted`;
5. audio bidireccional y conversación.
