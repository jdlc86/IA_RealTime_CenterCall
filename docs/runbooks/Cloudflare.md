# Runbook — Cloudflare Workers

> **Estado:** vigente
> **Última revisión:** 2026-08-29

## Productos

```text
OpenAI Worker       apps/control-plane
Gemini Fast Worker  apps/gemini-control-plane
```

Son productos independientes. Ambos pueden usar contratos neutrales y Supabase, pero no comparten sockets, audio, lifecycle ni estado efímero de llamada.

## Reglas operativas

- GitHub y un SHA publicado son la fuente de verdad.
- No editar código desde el dashboard salvo diagnóstico excepcional; cualquier cambio remoto debe reconciliarse.
- Verificar nombre del Worker, versión efectiva, bindings, KV, secrets y rutas del producto afectado.
- El Fast Worker debe apuntar mediante `GEMINI_FAST_CANARY_EDGE_URL` a la revisión etiquetada del Media Edge prevista.
- No inferir que Gemini está inactivo porque Cloud Run muestre `0%` de tráfico general.
- No mostrar valores de secrets en comandos, logs o documentación.

## Workflows vigentes Gemini Fast

- `Gemini Control Plane CI`
- `Gemini Fast Worker Deploy`
- `Gemini Fast Canary Deploy`
- `Gemini Fast Live Preflight`
- `Gemini Fast Runtime Preflight`
- `Gemini Fast Worker Secret Sync` sólo para sincronización explícitamente autorizada.

Antes de un deploy, consultar [`Deployment.md`](./Deployment.md) y verificar que el workflow hará checkout del SHA exacto.
