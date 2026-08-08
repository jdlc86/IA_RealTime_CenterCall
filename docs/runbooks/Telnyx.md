# Runbook — Telnyx FASE 0

> **Estado:** vigente  
> **Fecha:** 2026-08-08

## Objetivo

Configurar Telnyx como proveedor telefónico inicial de FASE 0 usando Programmable Voice / Voice API Application, manteniendo Cloudflare como Control Plane y OpenAI Realtime como proveedor conversacional.

## Estado actual

Completado:

- [x] Telnyx seleccionado como proveedor inicial de F0.
- [x] SIP Trunking/FQDN evaluado y descartado como ruta principal de esta implementación.
- [x] Voice API Application creada.
- [x] Nombre: `IA-RealTime-CenterCall-F0`.
- [x] Webhook API v2 seleccionado.
- [x] Configuración inbound iniciada.
- [x] Outbound Voice Profile creado para Europa.
- [x] OVP asociado a la aplicación.

Pendiente:

- [ ] finalizar configuración de la Voice API Application;
- [ ] asociar número +34;
- [ ] implementar/verificar webhook `/webhooks/telnyx`;
- [ ] ejecutar routing/dial hacia OpenAI Realtime;
- [ ] validar primera llamada.

## Voice API Application

Ruta aproximada:

```text
Telnyx → Voice → Programmable Voice → Create Voice API Application
```

Nombre:

```text
IA-RealTime-CenterCall-F0
```

Webhook URL:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev/webhooks/telnyx
```

Webhook API Version:

```text
API v2
```

## Inbound

Configurar un SIP subdomain identificable para F0.

Baseline de codec prioritario:

```text
G711U / PCMU
```

No optimizar codecs antes de conseguir la primera llamada funcional.

## Outbound Voice Profile

Se ha creado un OVP para Europa y se ha asociado a la Voice API Application.

El OVP forma parte de la configuración necesaria para comandos salientes/routing de Telnyx hacia destinos externos.

## OpenAI Realtime

El destino SIP se expresa mediante la plantilla:

```text
sip:<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls
```

No registrar el Project ID real ni secretos en este runbook.

## Arquitectura de control

```text
PSTN
  ↓
Número Telnyx
  ↓
Voice API Application
  ↓ webhook
Cloudflare Worker
  ↓
CallOrchestrator
  ↓
RoutingDecision
  ↓
OpenAI Realtime
```

Cloudflare participa en control y routing; no debe actuar como relay continuo de audio.

## Diagnóstico

```text
¿Número asociado correctamente?
  ↓
¿Telnyx emite webhook?
  ↓
¿Worker recibe /webhooks/telnyx?
  ↓
¿CallOrchestrator produce routing válido?
  ↓
¿Telnyx establece destino SIP?
  ↓
¿OpenAI genera realtime.call.incoming?
  ↓
¿Worker acepta call_id?
  ↓
¿Audio bidireccional?
```

Registrar cualquier fallo con timestamp, identificador de llamada, etapa y respuesta del proveedor, sin incluir secretos.
