# IA_RealTime_CenterCall — Guía de Implementación FASE 0

> **Versión:** 2.3  
> **Estado:** E2E de voz validado; Gate F0 completo pendiente  
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

Repositorio canónico:

```text
jdlc86/IA_RealTime_CenterCall
```

En Cloudflare Workers Builds:

```text
Production branch: main
Deploy command: npx wrangler deploy
Root directory: apps/control-plane
```

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

- [x] Implementado `POST /webhooks/telnyx`.
- [x] Verificación Ed25519 implementada directamente con Cloudflare Web Crypto.
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

### F0-006 — Secrets de runtime

Configurar en Cloudflare Worker → Settings → Variables and Secrets como **Secret**:

```text
OPENAI_API_KEY
OPENAI_WEBHOOK_SECRET
TELNYX_API_KEY
TELNYX_PUBLIC_KEY
```

Variable no secreta:

```text
OPENAI_PROJECT_ID
```

No basta con que los valores aparezcan en el Dashboard: después del despliegue debe comprobarse `/health.runtime_config` y obtener `true` para los cinco parámetros. No guardar los valores secretos en GitHub.

### F0-007 — Primera llamada E2E

- [x] Build/deploy automático GitHub → Cloudflare validado.
- [x] `GET /health` validado con secretos disponibles en runtime.
- [x] Llamada PSTN real recibida por Telnyx.
- [x] `call.initiated` inbound recibido por el Worker.
- [x] Transferencia Telnyx → OpenAI SIP/TLS ejecutada.
- [x] `call.bridged` observado en ambos legs.
- [x] `realtime.call.incoming` recibido desde OpenAI.
- [x] Llamada aceptada mediante `/v1/realtime/calls/{call_id}/accept` tras corregir el procesamiento asíncrono del webhook.
- [x] IA respondió por voz al llamante.
- [x] Cadena E2E mínima de voz validada.

Pendiente para cerrar el Gate F0:

- [ ] conversación ≥5 preguntas;
- [ ] llamada ≥5 minutos;
- [ ] barge-in/interrupción;
- [ ] silencio 5–10 s;
- [ ] cierre limpio al colgar;
- [ ] 20 llamadas consecutivas;
- [ ] baseline de setup y latencia.

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
await client.webhooks.unwrap(...)
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
7. Copiar API Key de Telnyx a Cloudflare como Secret `TELNYX_API_KEY`.
8. Copiar Public Key de Telnyx a Cloudflare como Secret `TELNYX_PUBLIC_KEY`.
9. Configurar `OPENAI_API_KEY` y `OPENAI_WEBHOOK_SECRET` como Secrets, no Plaintext.
10. Aplicar/desplegar los cambios del Worker.
11. Comprobar `/health.runtime_config` antes de llamar.
12. No utilizar valores secretos en archivos versionados ni logs.

## 8. Secuencia validada de llamada

```text
1. Cliente llama al número +34.
2. Telnyx genera call.initiated (incoming).
3. Telnyx POST /webhooks/telnyx.
4. Worker verifica firma Ed25519/timestamp y responde 2xx rápidamente.
5. CallOrchestrator solicita transfer del leg a OpenAI SIP por TLS.
6. Telnyx establece el segundo leg; call.bridged confirma el puente.
7. OpenAI recibe SIP INVITE y genera realtime.call.incoming.
8. OpenAI POST /webhooks/openai.
9. Worker verifica la firma y espera `client.webhooks.unwrap(...)`.
10. Worker obtiene call_id y ejecuta /accept con configuración F0.
11. Telnyx ↔ OpenAI mantienen el media path.
12. OpenAI Realtime procesa la voz y devuelve audio al llamante.
13. En la prueba E2E del 2026-08-09 la IA respondió por voz correctamente.
```

## 9. Incidencias encontradas y correcciones

### A. SDK Telnyx: `constructEvent is not a function`

Se sustituyó la verificación mediante SDK por verificación Ed25519 con Web Crypto. La firma usa:

```text
telnyx-timestamp + "|" + rawBody
```

### B. Secrets no disponibles en runtime

Aunque estaban visibles inicialmente en Cloudflare, los cuatro valores sensibles no estaban disponibles al Worker. Se configuraron explícitamente como **Secret**, se desplegó y se verificó su presencia mediante booleanos en `/health`.

### C. OpenAI webhook registrado como `unknown`

Síntoma:

```text
openai_webhook_received
openai_event.type = unknown
```

Mientras tanto, Telnyx ya mostraba `call.bridged`, por lo que SIP/TLS no era el fallo.

Causa: se inspeccionaba el resultado de `client.webhooks.unwrap(...)` sin esperar su resolución.

Corrección:

```text
await client.webhooks.unwrap(rawBody, request.headers)
```

Después de desplegar este cambio, la IA respondió por voz en la siguiente llamada.

## 10. Observabilidad F0

El trazado E2E actual es `f0-e2e-v2` y registra, entre otros:

```text
telnyx_event
call_orchestrator_route_selected
telnyx_transfer_start
telnyx_transfer_response
openai_webhook_received
openai_event
realtime_call_incoming
openai_accept_start
openai_accept_http
realtime_accept_result
```

Los logs deben evitar secretos y limitar cualquier body de diagnóstico.

## 11. Diagnóstico por capas

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
¿Telnyx genera call.bridged?
   no → establecimiento del segundo leg/SIP
   sí
   ↓
¿OpenAI genera realtime.call.incoming?
   no → SIP/TLS/OPENAI_PROJECT_ID
   sí
   ↓
¿Worker reconoce event.type?
   no → revisar unwrap/verificación/parsing
   sí
   ↓
¿/accept devuelve éxito?
   no → OpenAI API/configuración de sesión
   sí
   ↓
¿audio bidireccional?
   no → codecs/media/SIP
   sí
   ↓
E2E de voz funcional
```

## 12. Gate F0

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

**Estado actual:** los puntos 1–3 han quedado demostrados en la primera llamada E2E exitosa. Esto todavía no equivale a PASS completo del Gate F0.

La evidencia restante se registra en [`../tests/PHASE0.md`](../tests/PHASE0.md).
