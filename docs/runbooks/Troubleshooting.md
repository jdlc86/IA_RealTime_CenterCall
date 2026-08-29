# Runbook — troubleshooting por producto y plano

> **Estado:** vigente
> **Última revisión:** 2026-08-29

Diagnosticar una capa cada vez y no modificar OpenAI para corregir Gemini, ni Gemini para corregir OpenAI.

## Secuencia común

```text
1. Identidad: rama, SHA, workflow, versión/revisión y bindings efectivos
2. Telefonía: webhook, firma, call_id, tenant y routing
3. Control: admission/bootstrap/capabilities
4. Media: stream, codec, sockets y primer audio
5. Provider: setup, turn, tool call y respuesta
6. Efecto: autorización, backend/Telnyx/Supabase
7. Lifecycle: cierre, handoff, callback y persistencia
```

## Gemini Fast

Comprobar Fast Worker y Fast Media Edge por separado. La ruta efectiva depende de `GEMINI_FAST_CANARY_EDGE_URL`; una revisión etiquetada puede atender llamadas con `0%` de tráfico general de Cloud Run.

Un fallo de persistencia sideband no demuestra un fallo de audio. Un HTTP 2xx o evento de control tampoco demuestra que el caller oyera TTS/ringback.

## Restricción de latencia

No añadir inferencias, RPC, persistencia, `sleep`, buffers, resampling o trabajo por chunk para “probar” una hipótesis. Primero obtener evidencia causal y baseline; cualquier cambio de hot path exige presupuesto y p50/p95/p99.

## Seguridad y privacidad

- No persistir audio, prompts, secretos, payload hostil o transcript crudo.
- Usar IDs, estados, categorías y metadatos redactados.
- No repetir ataques o llamadas reales sin autorización expresa.

Para consultas y comandos concretos, usar [`CROSS_PLANE_CALL_DIAGNOSTICS.md`](./CROSS_PLANE_CALL_DIAGNOSTICS.md).
