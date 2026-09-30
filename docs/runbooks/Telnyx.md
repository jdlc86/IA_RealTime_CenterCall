# Runbook de Telnyx

## Ruta vigente

Telnyx entrega el webhook firmado al Gemini Fast Worker. El Worker resuelve el
tenant, evalúa admission y caller-security, registra bootstrap y ordena
`streaming_start` hacia la URL WSS etiquetada del Fast Media Edge.

El audio continuo fluye directamente entre Telnyx y Cloud Run.

## Comprobaciones

- firma y timestamp del webhook;
- `call_control_id` y número llamado;
- routing tenant en KV;
- caller normalizado desde contexto confiable;
- binding `GEMINI_FAST_CANARY_EDGE_URL`;
- formato Telnyx `L16/16000`, mono;
- credencial HMAC y frame `start` coincidentes;
- eventos de transferencia y target leg.

No cambiar codecs, VAD o resampling para corregir un fallo de señalización sin
evidencia causal.
