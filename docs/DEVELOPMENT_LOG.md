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

- [x] Añadido SDK oficial Telnyx al Worker.
- [x] Implementado `POST /webhooks/telnyx`.
- [x] Verificación Ed25519 y tolerancia anti-replay de 5 minutos.
- [x] Procesamiento exclusivo de `call.initiated` inbound para routing inicial.
- [x] Transferencia del leg entrante a OpenAI SIP mediante Telnyx Call Control.
- [x] TLS explícito para el tramo SIP.
- [x] Procesamiento asíncrono con `ctx.waitUntil()` para responder rápido al webhook.
- [x] `command_id` usado para mitigar comandos duplicados.
- [x] `/health` extendido con `telephony_provider=telnyx` y `call_orchestrator=true`.

### Pendiente manual antes de primera llamada

- [ ] Configurar `TELNYX_API_KEY` como Secret en Cloudflare.
- [ ] Configurar `TELNYX_PUBLIC_KEY` como Secret en Cloudflare.
- [ ] Confirmar build/deploy automático del último commit.
- [ ] Verificar `/health`.

### Próximo hito

Realizar la primera llamada al número +34 y confirmar, en orden:

1. `telnyx_webhook_received` (`call.initiated`, incoming);
2. `telnyx_transfer_requested`;
3. `realtime_call_incoming`;
4. `realtime_call_accepted`;
5. audio bidireccional y conversación.
