# IA_RealTime_CenterCall — Guía de Implementación FASE 0

> **Versión:** 2.0  
> **Estado:** vigente  
> **Arquitectura:** [`../architecture/SYSTEM_ARCHITECTURE.md`](../architecture/SYSTEM_ARCHITECTURE.md)

## 1. Objetivo

Demostrar que una persona puede llamar desde un teléfono real, ser atendida por OpenAI Realtime, conversar, interrumpir a la IA y colgar correctamente.

FASE 0 no incluye citas, CRM, reservas, ToolGateway, D1, MCP, RAG, dashboard ni multi-tenant productivo.

## 2. Arquitectura F0

```text
Teléfono
   ↓
Twilio / PSTN
   ↓ SIP/RTP
OpenAI Realtime
   ↑ control
Cloudflare Worker
```

Cloudflare no transporta audio.

## 3. Desarrollo cloud-first

Flujo oficial:

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

## 4. Estado actual

### Completado

- [x] Código inicial del Worker creado en `apps/control-plane/`.
- [x] Repositorio conectado a Cloudflare Workers Builds.
- [x] Root directory configurado: `apps/control-plane`.
- [x] Deploy command: `npx wrangler deploy` / `npm run deploy` según configuración del proyecto.
- [x] Build/deploy automático ejecutado correctamente.
- [x] Worker público desplegado.
- [x] `/health` validado con `ok: true`.
- [x] Nombre de Worker alineado a `ia-realtime-centercall`.
- [x] `workers_dev` declarado explícitamente.
- [x] `preview_urls` declarado explícitamente.

Worker actual:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev
```

Health:

```text
GET /health
```

### Pendiente

- [ ] Crear/configurar proyecto OpenAI Platform.
- [ ] Crear `OPENAI_API_KEY`.
- [ ] Guardar `OPENAI_API_KEY` como Secret en Cloudflare.
- [ ] Crear webhook OpenAI hacia `/webhooks/openai`.
- [ ] Suscribir `realtime.call.incoming`.
- [ ] Guardar `OPENAI_WEBHOOK_SECRET` como Secret en Cloudflare.
- [ ] Obtener/configurar endpoint SIP de OpenAI Realtime.
- [ ] Configurar Twilio / Elastic SIP Trunk.
- [ ] Asociar número telefónico.
- [ ] Ejecutar primera llamada real.
- [ ] Completar batería F0 y Gate F0.

## 5. Código actual

El código fuente canónico está en:

```text
apps/control-plane/src/index.ts
```

Responsabilidades actuales:

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

No duplicar el código completo en esta guía. GitHub contiene la versión ejecutable y evita que documentación y código diverjan.

## 6. Configuración Cloudflare

Archivo canónico:

```text
apps/control-plane/wrangler.jsonc
```

Configuración relevante actual:

```text
name = ia-realtime-centercall
ENVIRONMENT = dev
DEFAULT_TENANT_ID = dev-clinic
REALTIME_MODEL = gpt-realtime
REALTIME_VOICE = marin
workers_dev = true
preview_urls = true
```

Los secretos nunca se añaden a `wrangler.jsonc`.

## 7. Configurar OpenAI

Desde el navegador:

1. Abrir OpenAI Platform.
2. Crear/seleccionar el proyecto del desarrollo.
3. Crear una API key.
4. En Cloudflare Worker → Settings → Variables/Secrets, crear `OPENAI_API_KEY` como **Secret**.
5. En OpenAI configurar un webhook a:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev/webhooks/openai
```

6. Suscribir el evento:

```text
realtime.call.incoming
```

7. Copiar el signing secret del webhook.
8. Guardarlo en Cloudflare como `OPENAI_WEBHOOK_SECRET` tipo **Secret**.

No pegar secretos en GitHub, documentación, issues ni logs.

## 8. Configurar Twilio

Objetivo:

```text
Número Twilio → SIP → OpenAI Realtime
```

Procedimiento general:

1. Crear/verificar cuenta Twilio.
2. Adquirir/asociar un número con voz.
3. Crear Elastic SIP Trunk.
4. Configurar Origination hacia el endpoint SIP de OpenAI indicado por el proyecto OpenAI.
5. Asociar el número al trunk.
6. Mantener codec compatible con la configuración Realtime (baseline F0: PCMU/G.711 μ-law).

No inventar el SIP URI de OpenAI: copiar literalmente el endpoint mostrado por la plataforma del proyecto.

## 9. Primera llamada

Secuencia esperada:

```text
1. Se llama al número Twilio.
2. Twilio envía SIP a OpenAI Realtime.
3. OpenAI genera realtime.call.incoming.
4. OpenAI llama al webhook del Worker.
5. Worker verifica firma.
6. Worker acepta/configura call_id.
7. Audio queda Twilio ↔ OpenAI.
8. Usuario conversa con la IA.
```

Primera validación: `llamar → decir "hola" → recibir respuesta → conversar → interrumpir → colgar`.

## 10. Diagnóstico por capas

```text
¿Twilio recibe la llamada?
   no → número/cuenta
   sí
   ↓
¿Twilio envía SIP?
   no → trunk/origination
   sí
   ↓
¿OpenAI genera realtime.call.incoming?
   no → SIP/OpenAI
   sí
   ↓
¿Worker recibe webhook válido?
   no → URL/firma/secreto
   sí
   ↓
¿/accept devuelve éxito?
   no → API key/model/config
   sí
   ↓
¿Audio bidireccional?
   no → SIP/codec/media
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
