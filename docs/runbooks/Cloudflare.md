# Runbook — Cloudflare

## Worker

Nombre: `ia-realtime-centercall`

URL actual:

```text
https://ia-realtime-centercall.julopezcardona.workers.dev
```

Health:

```text
GET /health
```

## Build/deploy

Fuente: GitHub `main`.

Root directory:

```text
apps/control-plane
```

El despliegue normal se realiza mediante Cloudflare Workers Builds. No editar código directamente en Cloudflare salvo diagnóstico excepcional.

## Configuración no secreta

Definida en `apps/control-plane/wrangler.jsonc`.

## Secretos F0

Deben existir como Secrets en Cloudflare cuando se configure OpenAI:

- `OPENAI_API_KEY`
- `OPENAI_WEBHOOK_SECRET`

Nunca se escriben en GitHub.

## Verificación tras deploy

1. Confirmar build `Success`.
2. Confirmar ausencia de warning de nombre del Worker.
3. Abrir `/health`.
4. Confirmar `ok: true`, `phase: F0`, `environment: dev`.
5. Revisar logs si el webhook falla.
