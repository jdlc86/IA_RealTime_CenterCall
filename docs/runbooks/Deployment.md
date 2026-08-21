# Runbook — Deployment

## Flujo oficial

```text
rama no productiva ─→ Build command ─→ Version command ─→ versión candidata

main ───────────────→ Build command ─→ Deploy command ──→ Worker actualizado
```

Los comandos de versión y deploy ejecutan primero `npm test && npm run check` e
incluyen siempre `--env=""` para seleccionar explícitamente el perfil productivo
por defecto. La puerta no depende de que el panel ejecute el campo Build command.

## Directorio raíz

```text
apps/control-plane
```

## Perfiles Wrangler

| Perfil | Worker | Comando dry-run | Subir versión | Promover a tráfico |
|---|---|---|---|---|
| production (por defecto) | `ia-realtime-centercall` | `npm run check:production` | `npm run upload:production` | `npm run deploy:production` |
| preview | `ia-realtime-centercall-preview` | `npm run check:preview` | `npm run upload:preview` | `npm run deploy:preview` |
| dev | `ia-realtime-centercall-dev` | `npm run check:dev` | `npm run upload:dev` | `npm run deploy:dev` |

CI ejecuta `npm run check`, que construye los tres perfiles sin desplegar. En
ramas no productivas, Workers Builds sube una versión candidata sin promoverla;
en `main`, su Deploy command actualiza el Worker. Los secretos, KV y demás
recursos remotos se configuran por Worker; nunca se copian valores sensibles al
repositorio.

Cloudflare no ofrece Version Preview URLs cuando el Worker implementa Durable
Objects. Antes de promoción, la prueba de runtime se ejecuta en Workerd; después
del deploy, el verificador HTTP confirma `/health` y el `worker_version.id` de la
versión efectiva.

## Verificación

Tras cada deploy de F5:

1. Build finaliza con `Success`.
2. Worker desplegado como `ia-realtime-centercall`.
3. Abrir `https://ia-realtime-centercall.julopezcardona.workers.dev/health`.
4. Confirmar JSON con `ok: true`.
5. Confirmar `environment: "production"` y un `worker_version.id` no vacío.
6. Ejecutar `npm run test:e2e:health -- --url https://ia-realtime-centercall.julopezcardona.workers.dev --environment production`.
7. Si hay cambios de webhook, revisar logs antes de realizar llamada.

## Regla

El despliegue local con Wrangler es una contingencia, no el flujo normal. GitHub debe contener siempre la versión efectiva del código.
