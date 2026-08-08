# IA_RealTime_CenterCall — Guía de Implementación FASE 0

> **Versión:** 2.1  
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
   ↓ webhook de control
Cloudflare Worker / CallOrchestrator
   ↓ decisión de routing
OpenAI Realtime
   ↓
conversación
```

Cloudflare participa en control, bootstrap y routing, pero no debe actuar como relay continuo de audio.

## 3. Desarrollo cloud-first

```text
GitHub main
   ↓
Cloudflare Workers Builds
   ↓
build + deploy
   ↓
Worker público
```

No se requiere PC local para el flujo normal.

## 4. Execution Record

### F0-001 — Proyecto OpenAI

- [x] Proyecto OpenAI creado.
- [x] API Key creada.
- [x] `OPENAI_API_KEY` guardada como Secret en Cloudflare.

### F0-002 — Webhook OpenAI

- [x] Webhook creado en OpenAI Platform.
- [x] URL configurada:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev/webhooks/openai
```

- [x] Evento `realtime.call.incoming` suscrito.
- [x] Signing secret obtenido.
- [x] `OPENAI_WEBHOOK_SECRET` guardado como Secret en Cloudflare.

### F0-003 — Worker y despliegue

- [x] Código inicial en `apps/control-plane/`.
- [x] GitHub conectado a Cloudflare Workers Builds.
- [x] Root directory `apps/control-plane`.
- [x] Deploy automático correcto.
- [x] Worker público operativo.
- [x] `/health` validado.
- [x] Nombre alineado: `ia-realtime-centercall`.

Worker:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev
```

### F0-004 — Selección del proveedor telefónico

- [x] Twilio evaluado inicialmente.
- [x] Se detectó indisponibilidad de numeración española adecuada en el flujo probado.
- [x] Se adopta **Telnyx** como proveedor telefónico inicial de F0.
- [x] Twilio queda como alternativa futura mediante `TelephonyProvider`.

### F0-005 — Evaluación SIP Trunking/FQDN en Telnyx

- [x] Creación de SIP Connection evaluada.
- [x] Tipo FQDN probado conceptualmente.
- [x] FQDN `sip.api.openai.com` y puerto TLS evaluados.
- [x] Este camino se descarta como ruta principal de F0 para evitar acoplar el routing a una configuración rígida del trunk.

### F0-006 — Programmable Voice / Voice API Application

- [x] Creada aplicación:

```text
IA-RealTime-CenterCall-F0
```

- [x] AnchorSite configurado en modo orientado a latencia.
- [x] Webhook API v2 seleccionado.
- [x] Webhook Telnyx configurado/apuntado conceptualmente a:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev/webhooks/telnyx
```

- [x] SIP subdomain de aplicación configurado para F0.
- [x] Recepción inbound configurada.

### F0-007 — Outbound Voice Profile

- [x] Outbound Voice Profile creado para Europa.
- [x] OVP asociado a `IA-RealTime-CenterCall-F0`.

### F0-008 — Estado pendiente inmediato

- [ ] Finalizar las pantallas restantes de la Voice API Application.
- [ ] Adquirir/asociar número +34.
- [ ] Implementar `POST /webhooks/telnyx` en el Worker.
- [ ] Validar firma/eventos de Telnyx.
- [ ] Implementar `CallOrchestrator` mínimo F0.
- [ ] Enrutar/dial hacia OpenAI Realtime usando configuración del proyecto.
- [ ] Confirmar que OpenAI genera `realtime.call.incoming`.
- [ ] Confirmar que `/webhooks/openai` acepta/configura el `call_id`.
- [ ] Primera llamada real.
- [ ] Gate F0.

## 5. Código actual

Canónico:

```text
apps/control-plane/src/index.ts
```

Responsabilidades implementadas actualmente:

```text
GET /health
POST /webhooks/openai
  ↓
verificar firma OpenAI
  ↓
procesar realtime.call.incoming
  ↓
binding tenant dev
  ↓
construir configuración Realtime
  ↓
POST /v1/realtime/calls/{call_id}/accept
```

Próxima extensión del Worker:

```text
POST /webhooks/telnyx
  ↓
verificar evento
  ↓
CallOrchestrator F0
  ↓
routing/dial a RealtimeProvider
```

No duplicar código completo en esta guía; GitHub contiene la versión ejecutable.

## 6. Configuración Cloudflare

Archivo canónico:

```text
apps/control-plane/wrangler.jsonc
```

Configuración no secreta relevante:

```text
name = ia-realtime-centercall
ENVIRONMENT = dev
DEFAULT_TENANT_ID = dev-clinic
REALTIME_MODEL = gpt-realtime
REALTIME_VOICE = marin
workers_dev = true
preview_urls = true
```

Secretos ya configurados:

```text
OPENAI_API_KEY
OPENAI_WEBHOOK_SECRET
```

Nunca almacenar sus valores en GitHub.

## 7. Configuración OpenAI reproducible

1. Entrar en OpenAI Platform.
2. Seleccionar/crear el Project del sistema.
3. Crear API Key del proyecto.
4. Guardarla en Cloudflare como `OPENAI_API_KEY` tipo Secret.
5. En Project Settings abrir **Webhooks**.
6. Crear webhook con URL:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev/webhooks/openai
```

7. Suscribir:

```text
realtime.call.incoming
```

8. Copiar el webhook signing secret.
9. Guardarlo en Cloudflare como `OPENAI_WEBHOOK_SECRET` tipo Secret.
10. Localizar el Project ID para la configuración SIP. No registrar el valor real en esta guía.

Destino SIP conceptual de OpenAI:

```text
sip:<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls
```

## 8. Configuración Telnyx reproducible

### 8.1 Crear Voice API Application

Ruta:

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

### 8.2 Inbound

Configurar un SIP subdomain identificable para F0 y recepción inbound según necesidades de prueba.

Mantener codecs compatibles con telefonía/Reatime. Baseline principal: G.711 μ-law (`G711U`/PCMU). No optimizar codecs antes de la primera llamada funcional.

### 8.3 Outbound Voice Profile

Crear un OVP para Europa y asociarlo a la Voice API Application.

Objetivo: permitir comandos salientes/routing controlados por Telnyx cuando la aplicación necesite establecer el tramo hacia el destino SIP.

### 8.4 Numeración

Pendiente:

1. adquirir/verificar número +34;
2. satisfacer documentación regulatoria requerida por Telnyx;
3. asociar el número a la Voice API Application.

## 9. Flujo esperado de primera llamada

```text
1. Cliente llama al número +34 Telnyx.
2. Telnyx genera evento Voice API.
3. Telnyx llama a /webhooks/telnyx.
4. Worker valida y procesa evento.
5. CallOrchestrator F0 decide OpenAI Realtime.
6. Telnyx establece/ruta el tramo hacia el SIP URI de OpenAI.
7. OpenAI genera realtime.call.incoming.
8. OpenAI llama a /webhooks/openai.
9. Worker verifica firma OpenAI.
10. Worker hace binding tenant dev y /accept del call_id.
11. Se establece conversación de voz.
12. Cliente interrumpe/habla/cuelga.
```

## 10. Diagnóstico por capas

```text
¿Número Telnyx recibe la llamada?
   no → número/regulación/asociación
   sí
   ↓
¿Telnyx genera webhook Voice API?
   no → Voice API Application/routing
   sí
   ↓
¿Worker procesa /webhooks/telnyx?
   no → URL/firma/código
   sí
   ↓
¿Telnyx establece destino Realtime?
   no → Call Control/OVP/SIP URI
   sí
   ↓
¿OpenAI genera realtime.call.incoming?
   no → SIP/OpenAI Project
   sí
   ↓
¿Worker valida webhook OpenAI y /accept funciona?
   no → secret/API key/config
   sí
   ↓
¿Audio bidireccional?
   no → media/codec/SIP
   sí
   ↓
F0 funcional
```

## 11. Gate F0

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
