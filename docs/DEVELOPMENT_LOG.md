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
- [x] Signing secret del webhook obtenido.
- [x] `OPENAI_WEBHOOK_SECRET` guardado como Secret en Cloudflare.
- [x] Project ID localizado para routing SIP; el valor real no se registra en documentación.

### FASE 0 — Telefonía

- [x] Twilio evaluado como carrier inicial.
- [x] Se detectó indisponibilidad de numeración española adecuada en el flujo probado.
- [x] Telnyx adoptado como proveedor telefónico inicial de F0.
- [x] SIP Trunking/FQDN evaluado y descartado como ruta principal de esta implementación.
- [x] Creada Voice API Application `IA-RealTime-CenterCall-F0`.
- [x] Webhook API v2 seleccionado.
- [x] Configuración inbound iniciada.
- [x] Outbound Voice Profile creado para Europa.
- [x] OVP asociado a la Voice API Application.

### Evolución arquitectónica

- [x] `TelephonyProvider` mantiene independencia Telnyx/Twilio.
- [x] Se introduce separación conceptual `NumberProvider` / `TelephonyProvider`.
- [x] Se introduce `CallOrchestrator` dentro del Control Plane.
- [x] Cloudflare decide el routing de llamada sin convertirse en relay continuo de audio.

### Próximo hito

1. Finalizar configuración de la Voice API Application.
2. Asociar número +34.
3. Implementar `POST /webhooks/telnyx` en el Worker.
4. Implementar CallOrchestrator mínimo de F0.
5. Enrutar/dial hacia OpenAI Realtime.
6. Verificar `realtime.call.incoming` y `/accept`.
7. Realizar primera llamada real.
