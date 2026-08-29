# Runbook — Telnyx

> **Estado:** vigente
> **Última revisión:** 2026-08-29

## Alcance

Telnyx es el carrier actual de ambos productos realtime. El routing confiable del número llamado determina tenant y producto antes de iniciar conversación específica del negocio.

## Separación de rutas

### OpenAI

Telnyx usa la ruta de señalización/media propia del producto OpenAI descrita por su runtime.

### Gemini Fast

```text
Telnyx webhook firmado
  → Gemini Fast Worker
  → credencial/bootstrap acotado
  → Telnyx media WSS ↔ Fast Media Edge ↔ Gemini Live
```

Para transferencia humana, el destino procede exclusivamente de la configuración privada del tenant. El modelo nunca proporciona un teléfono arbitrario.

## Diagnóstico por llamada

1. Capturar el `call_id` y la hora exacta.
2. Verificar webhook/firma, routing y tenant binding.
3. Distinguir leg origen, leg destino de transferencia y stream media.
4. Correlacionar eventos `call.answered`, streaming, transfer, `call.bridged` y terminación.
5. No interpretar `call.bridged` o `call.speak.ended` como prueba de audio audible.
6. No registrar API keys, firmas completas, teléfonos sin necesidad ni audio/transcript crudo.

La reconstrucción completa está en [`CROSS_PLANE_CALL_DIAGNOSTICS.md`](./CROSS_PLANE_CALL_DIAGNOSTICS.md).
