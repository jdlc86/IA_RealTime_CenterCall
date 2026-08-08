# IA_RealTime_CenterCall — Guía de Implementación FASE 0

> **Versión:** 2.2  
> **Estado:** vigente  
> **Arquitectura:** [`../architecture/SYSTEM_ARCHITECTURE.md`](../architecture/SYSTEM_ARCHITECTURE.md)

## 1. Objetivo

Demostrar que una persona puede llamar desde un teléfono real, ser atendida por OpenAI Realtime, conversar, interrumpir a la IA y colgar correctamente.

FASE 0 no incluye citas, CRM, reservas, ToolGateway, D1, MCP, RAG, dashboard ni multi-tenant productivo.

## 2. Arquitectura F0 actual

```text
Teléfono
   ↓ PSTN
Número +34 / Telnyx
   ↓
Telnyx Programmable Voice / Voice API Application
   ↓ webhook firmado
Cloudflare Worker / CallOrchestrator
   ↓ Call Control transfer (TLS)
OpenAI Realtime SIP
   ↓ realtime.call.incoming
Cloudflare Worker
   ↓ /accept
OpenAI Realtime
   ↓
Conversación
```

Cloudflare controla routing/bootstrap, pero no actúa como relay continuo de audio.

## 3. Desarrollo cloud-first

```text
GitHub main → Cloudflare Workers Builds → build + deploy → Worker público
```

No se requiere PC local para el flujo normal.

## 4. Execution Record

### F0-001 — OpenAI

- [x] Project OpenAI creado.
- [x] API Key creada y guardada en Cloudflare como `OPENAI_API_KEY`.
- [x] Webhook creado hacia `/webhooks/openai`.
- [x] Evento `realtime.call.incoming` suscrito.
- [x] Signing secret guardado como `OPENAI_WEBHOOK_SECRET`.
- [x] Project ID localizado y configurado como variable no secreta `OPENAI_PROJECT_ID`.

### F0-002 — Cloudflare Worker

- [x] Código inicial en `apps/control-plane/`.
- [x] GitHub conectado a Cloudflare Workers Builds.
- [x] Root directory `apps/control-plane`.
- [x] Deploy automático operativo.
- [x] `/health` validado.
- [x] Worker `ia-realtime-centercall` operativo.

### F0-003 — Proveedor telefónico

- [x] Twilio evaluado.
- [x] Telnyx adoptado como proveedor inicial por mejor ajuste a numeración española.
- [x] SIP Trunking/FQDN evaluado y descartado como ruta principal de F0.
- [x] Programmable Voice adoptado.

### F0-004 — Telnyx Voice API Application

- [x] Creada `IA-RealTime-CenterCall-F0`.
- [x] Webhook API v2.
- [x] Webhook:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev/webhooks/telnyx
```

- [x] Configuración inbound realizada.
- [x] OVP Europa creado y asociado.
- [x] Número +34 asociado a la aplicación.

### F0-005 — CallOrchestrator Telnyx

- [x] Dependencia oficial `telnyx` añadida al Worker.
- [x] Implementado `POST /webhooks/telnyx`.
- [x] Verificación de firma Ed25519 mediante SDK Telnyx.
- [x] Rechazo de webhooks con timestamp >5 minutos.
- [x] Procesamiento de `call.initiated` únicamente para dirección `incoming`.
- [x] `call_control_id` utilizado para controlar el leg entrante.
- [x] Transferencia asíncrona mediante `ctx.waitUntil()`.
- [x] `command_id` basado en el event ID para reducir duplicados.
- [x] Transferencia a OpenAI usando:

```text
sip:<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls
```

- [x] `sip_transport_protocol = TLS`.
- [x] Cloudflare continúa fuera del media path.

### F0-006 — Secretos Telnyx pendientes antes de prueba real

Configurar en Cloudflare Worker → Settings → Variables and Secrets como **Secret**:

```text
TELNYX_API_KEY
TELNYX_PUBLIC_KEY
```

`TELNYX_PUBLIC_KEY` se obtiene en Telnyx Mission Control → Keys & Credentials → Public Key.

No guardar sus valores en GitHub.

### F0-007 — Próximo hito

- [ ] Confirmar build/deploy automático del commit F0-013.
- [ ] Configurar `TELNYX_API_KEY` en Cloudflare.
- [ ] Configurar `TELNYX_PUBLIC_KEY` en Cloudflare.
- [ ] Validar nuevamente `GET /health`.
- [ ] Realizar primera llamada al número +34.
- [ ] Confirmar evento `call.initiated` en logs.
- [ ] Confirmar `telnyx_transfer_requested`.
- [ ] Confirmar `realtime.call.incoming` de OpenAI.
- [ ] Confirmar `realtime_call_accepted`.
- [ ] Validar audio bidireccional.

## 5. Código actual

Canónico:

```text
apps/control-plane/src/index.ts
```

Flujo implementado:

```text
POST /webhooks/telnyx
  ↓
verificar Ed25519 + timestamp
  ↓
call.initiated (incoming)
  ↓
CallOrchestrator F0
  ↓
Telnyx transfer → OpenAI SIP por TLS

POST /webhooks/openai
  ↓
verificar firma OpenAI
  ↓
realtime.call.incoming
  ↓
binding tenant dev
  ↓
construir RealtimeSessionConfiguration
  ↓
POST /v1/realtime/calls/{call_id}/accept
```

No duplicar el código completo en esta guía; GitHub contiene la implementación ejecutable.

## 6. Configuración no secreta

Archivo canónico: `apps/control-plane/wrangler.jsonc`.

```text
name = ia-realtime-centercall
ENVIRONMENT = dev
DEFAULT_TENANT_ID = dev-clinic
REALTIME_MODEL = gpt-realtime
REALTIME_VOICE = marin
OPENAI_PROJECT_ID = <Project ID del proyecto OpenAI>
workers_dev = true
preview_urls = true
```

Secretos requeridos:

```text
OPENAI_API_KEY
OPENAI_WEBHOOK_SECRET
TELNYX_API_KEY
TELNYX_PUBLIC_KEY
```

## 7. Configuración Telnyx reproducible

1. Crear Voice API Application `IA-RealTime-CenterCall-F0`.
2. Usar Webhook API v2.
3. Configurar URL `/webhooks/telnyx` del Worker.
4. Completar inbound.
5. Crear OVP para Europa y asociarlo.
6. Adquirir/asociar número +34.
7. Copiar API Key de Telnyx a Cloudflare como `TELNYX_API_KEY`.
8. Copiar Public Key de Telnyx a Cloudflare como `TELNYX_PUBLIC_KEY`.
9. No utilizar esos valores en archivos versionados.

## 8. Secuencia esperada de primera llamada

```text
1. Cliente llama al número +34.
2. Telnyx genera call.initiated (incoming).
3. Telnyx POST /webhooks/telnyx.
4. Worker verifica firma/timestamp y responde 2xx rápidamente.
5. CallOrchestrator solicita transfer del leg a OpenAI SIP por TLS.
6. OpenAI recibe SIP INVITE y genera realtime.call.incoming.
7. OpenAI POST /webhooks/openai.
8. Worker verifica firma y ejecuta /accept con configuración F0.
9. Telnyx ↔ OpenAI mantienen el media path.
10. Usuario conversa, interrumpe y cuelga.
```

## 9. Diagnóstico por capas

```text
¿Telnyx recibe la llamada?
   no → número/asociación/regulación
   sí
   ↓
¿/webhooks/telnyx recibe call.initiated?
   no → Voice API Application/webhook
   sí
   ↓
¿firma Telnyx válida?
   no → TELNYX_PUBLIC_KEY / timestamp
   sí
   ↓
¿transfer devuelve éxito?
   no → TELNYX_API_KEY / OVP / SIP routing
   sí
   ↓
¿OpenAI genera realtime.call.incoming?
   no → SIP/TLS/OPENAI_PROJECT_ID
   sí
   ↓
¿/accept devuelve éxito?
   no → OpenAI secret/API/config
   sí
   ↓
¿audio bidireccional?
   no → codecs/media/SIP
   sí
   ↓
F0 funcional
```

## 10. Gate F0

PASS solo si:

1. llamada PSTN real entra;
2. IA atiende automáticamente;
3. audio bidireccional funciona;
4. conversación multi-turno coherente;
5. barge-in razonable;
6. llamada ≥5 minutos estable;
7. cuelgue limpia la sesión;
8. ≥19/20 llamadas consecutivas completan setup/conversación básica;
9. baseline de setup y latencia queda documentado.

La evidencia se registra en [`../tests/PHASE0.md`](../tests/PHASE0.md).
