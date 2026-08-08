# Runbook — Troubleshooting FASE 0

Diagnosticar siempre por capas y no cambiar varias cosas a la vez.

```text
A. ¿/health funciona?
   no → Cloudflare/build/deploy
   sí
   ↓
B. ¿Twilio recibe la llamada?
   no → número/cuenta
   sí
   ↓
C. ¿Twilio envía SIP a OpenAI?
   no → trunk/origination
   sí
   ↓
D. ¿OpenAI genera realtime.call.incoming?
   no → SIP/OpenAI Project
   sí
   ↓
E. ¿Worker recibe/verifica webhook?
   no → URL/signing secret
   sí
   ↓
F. ¿/accept funciona?
   no → API key/model/payload
   sí
   ↓
G. ¿Audio bidireccional?
   no → codec/SIP/media
   sí
   ↓
FASE 0 funcional
```

## Reglas de diagnóstico

- Registrar `call_id` y timestamps.
- No imprimir secretos.
- No desactivar la verificación de firma como solución permanente.
- No introducir Cloudflare en el media path para “arreglar” audio sin ADR/benchmark.
- Corregir primero el primer punto que falla en la cadena.
