# Runbook — OpenAI Realtime

## FASE 0

Objetivo: recibir una llamada SIP, generar `realtime.call.incoming` y permitir que el Worker acepte/configure la llamada.

## Configuración necesaria

1. Proyecto OpenAI dedicado al desarrollo.
2. API key del proyecto.
3. Webhook público:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev/webhooks/openai
```

4. Evento: `realtime.call.incoming`.
5. Signing secret del webhook.
6. Endpoint SIP del proyecto OpenAI Realtime.

## Secretos

Guardar en Cloudflare:

```text
OPENAI_API_KEY
OPENAI_WEBHOOK_SECRET
```

## Flujo esperado

```text
SIP inbound
  ↓
OpenAI Realtime
  ↓ realtime.call.incoming
Worker
  ↓ verify signature
POST /v1/realtime/calls/{call_id}/accept
  ↓
conversation active
```

## Reglas

- Copiar el endpoint SIP exactamente desde OpenAI Platform.
- No almacenar API keys en GitHub.
- No saltarse la verificación de firma del webhook.
- F0 no habilita tools empresariales.
