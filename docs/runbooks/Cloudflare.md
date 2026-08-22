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

El perfil por defecto es producción. Los perfiles nombrados son:

- `preview` → `ia-realtime-centercall-preview`;
- `dev` → `ia-realtime-centercall-dev`.

Workers Builds usa estos comandos:

- Build command: `npm run types && npm run check`;
- Deploy command de `main`: `npm test && npm run check && npx wrangler deploy --env=""`;
- Version command de ramas no productivas: `npm test && npm run check && npx wrangler versions upload --env=""`.

El Version command sube una versión inmutable sin cambiar el tráfico. El Deploy
command sólo se ejecuta para `main`. La validación está embebida en ambos para
que no dependa de si Cloudflare ejecuta el campo Build command. Para una
operación manual, usar siempre los scripts `upload:*` o `deploy:*`; no ejecutar
Wrangler sin destino explícito.

Este Worker implementa un Durable Object. Cloudflare no genera Version Preview
URLs para Workers con Durable Objects, aunque `preview_urls` esté habilitado.
Por eso la comprobación previa a promoción se ejecuta con Workerd y el E2E HTTP
se ejecuta inmediatamente después del deploy sobre la versión efectiva.

## Configuración no secreta

Definida en `apps/control-plane/wrangler.jsonc`.

## Configuración sensible F5

Deben existir en Cloudflare para que el flujo completo pueda operar:

- `OPENAI_API_KEY`
- `OPENAI_WEBHOOK_SECRET`
- `TELNYX_API_KEY`
- `TELNYX_PUBLIC_KEY`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

Las credenciales y claves privadas se guardan como Secrets y nunca se escriben
en GitHub. `SUPABASE_URL` puede configurarse como variable por entorno.

## Verificación tras deploy

1. Confirmar build `Success`.
2. Confirmar ausencia de warning de nombre del Worker.
3. Abrir `/health`.
4. Confirmar `ok: true`, `phase: F5`, `environment: production`.
5. Confirmar `worker_version.id` y `worker_version.timestamp`.
6. Ejecutar el verificador E2E HTTP de `apps/control-plane`.
7. Revisar logs si el webhook falla.
