# Runbook — Deployment

## Flujo oficial

```text
commit/push a main
   ↓
Cloudflare Workers Builds
   ↓
instalación de dependencias
   ↓
wrangler deploy
   ↓
Worker actualizado
```

## Directorio raíz

```text
apps/control-plane
```

## Verificación

Tras cada deploy de F0:

1. Build finaliza con `Success`.
2. Worker desplegado como `ia-realtime-centercall`.
3. Abrir `https://ia-realtime-centercall.julopezcardona.workers.dev/health`.
4. Confirmar JSON con `ok: true`.
5. Si hay cambios de webhook, revisar logs antes de realizar llamada.

## Regla

El despliegue local con Wrangler es una contingencia, no el flujo normal. GitHub debe contener siempre la versión efectiva del código.
