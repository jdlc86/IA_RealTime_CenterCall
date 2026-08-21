# Runbook — Deployment

## Flujo oficial

```text
commit/push a main
   ↓
Cloudflare Workers Builds
   ↓
instalación de dependencias
   ↓
npm run upload:production
    ↓
versión candidata inmutable
    ↓
promoción deliberada con deploy explícito
    ↓
Worker actualizado
```

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

CI ejecuta `npm run check`, que construye los tres perfiles sin desplegar.
Workers Builds sube una versión candidata sin promoverla. Los secretos, KV y
demás recursos remotos se configuran por Worker; nunca se copian valores
sensibles al repositorio.

## Verificación

Tras cada deploy de F0:

1. Build finaliza con `Success`.
2. Worker desplegado como `ia-realtime-centercall`.
3. Abrir `https://ia-realtime-centercall.julopezcardona.workers.dev/health`.
4. Confirmar JSON con `ok: true`.
5. Confirmar `environment: "production"` y un `worker_version.id` no vacío.
6. Ejecutar `npm run test:e2e:health -- --url https://ia-realtime-centercall.julopezcardona.workers.dev --environment production`.
7. Si hay cambios de webhook, revisar logs antes de realizar llamada.

## Regla

El despliegue local con Wrangler es una contingencia, no el flujo normal. GitHub debe contener siempre la versión efectiva del código.
