# Runbook — producto OpenAI Realtime

> **Estado:** vigente
> **Última revisión:** 2026-08-29

## Alcance

Este runbook corresponde sólo al producto OpenAI (`apps/control-plane` + `apps/media-edge`). Gemini Fast no usa su SDK, socket, voz, lifecycle ni estado efímero.

## Flujo

```text
Telnyx / SIP y señalización
  → OpenAI Control Plane
  → OpenAI Realtime
  → tools y dominio autorizados
```

Cloudflare participa en control/bootstrap y permanece fuera del audio continuo.

## Diagnóstico mínimo

1. Verificar la rama y el SHA desplegado antes de cambiar nada.
2. Comprobar `/health`, recepción y firma de webhooks.
3. Correlacionar `call_id` entre Telnyx, Worker, OpenAI y Supabase.
4. Separar aceptación/configuración de llamada, sideband, tool execution y lifecycle terminal.
5. No tocar Gemini para corregir una incidencia OpenAI ni introducir failover entre providers a mitad de llamada.

Los nombres/valores de secretos se verifican en configuración remota; nunca se copian a documentación o logs.

## Validación

Desde `apps/control-plane`:

```powershell
npm test
npm run check
```

Una incidencia de voz requiere evidencia E2E proporcional; CI verde no demuestra audio real.
