# Test Plan — FASE 0

> **Estado:** activo — primera llamada E2E con voz validada

## Gate F0

PASS solo si:

1. llamada PSTN real entra;
2. IA atiende automáticamente;
3. audio bidireccional funciona;
4. conversación multi-turno coherente;
5. barge-in razonable;
6. llamada ≥5 minutos estable;
7. cuelgue limpia la sesión;
8. ≥19/20 llamadas consecutivas completan setup/conversación básica;
9. baseline de setup y latencia documentado.

## Casos

- **F0-T01** — setup y saludo.
- **F0-T02** — conversación ≥5 preguntas.
- **F0-T03** — llamada ≥5 minutos.
- **F0-T04** — interrupción mientras habla la IA.
- **F0-T05** — silencio 5–10 s.
- **F0-T06** — cuelgue del cliente.
- **F0-T07** — 20 llamadas consecutivas.

## Evidencia

| Test | Estado | Setup ms | Voz | Barge-in | Duración | Cierre | Observaciones |
|---|---|---:|---|---|---:|---|---|
| F0-T01 | [x] parcial | pendiente baseline | sí | no evaluado | prueba corta | observado | Llamada PSTN real; Telnyx `call.bridged`; OpenAI webhook; tras fix de `await unwrap()` la IA respondió por voz. |
| F0-T02 | [ ] | | | | | | |
| F0-T03 | [ ] | | | | | | |
| F0-T04 | [ ] | | | | | | |
| F0-T05 | [ ] | | | | | | |
| F0-T06 | [ ] | | | | | | |
| F0-T07 | [ ] | | | | | | |

`F0-T01` se marca **parcial** porque el setup y la respuesta de voz están demostrados, pero todavía falta medir el baseline de tiempo de establecimiento/saludo.

## Evidencia técnica de la primera llamada E2E

Fecha: 2026-08-09.

Cadena demostrada:

```text
PSTN
→ número +34 Telnyx
→ Voice API Application
→ Cloudflare /webhooks/telnyx
→ CallOrchestrator
→ Telnyx transfer
→ OpenAI SIP/TLS
→ call.bridged
→ realtime.call.incoming
→ Cloudflare /webhooks/openai
→ OpenAI /accept
→ respuesta de voz al llamante
```

Incidencias resueltas durante la prueba:

1. `telnyx.webhooks.constructEvent is not a function` → verificación Ed25519 migrada a Cloudflare Web Crypto.
2. Secrets visibles pero no disponibles en runtime → configurados explícitamente como tipo Secret y validados mediante `/health.runtime_config`.
3. OpenAI webhook registrado como `unknown` → corregido procesamiento asíncrono usando `await client.webhooks.unwrap(...)`.

Resultado: **la IA respondió por voz en una llamada PSTN real**.

## Infraestructura validada

- [x] Repositorio canónico `jdlc86/IA_RealTime_CenterCall`.
- [x] GitHub → Cloudflare Workers Builds.
- [x] Deploy automático desde `main` con root `apps/control-plane`.
- [x] Worker público.
- [x] `/health` responde `ok: true`.
- [x] Secrets OpenAI/Telnyx disponibles en runtime.
- [x] Firma webhook Telnyx validada mediante Ed25519/Web Crypto.
- [x] Telnyx Call Control transfer a OpenAI SIP/TLS.
- [x] `call.bridged` observado.
- [x] Webhook OpenAI recibido y verificado.
- [x] `/accept` ejecutado tras reconocer `realtime.call.incoming`.
- [x] Audio de respuesta de OpenAI recibido por el llamante.

## Estado

El E2E mínimo de voz está validado, pero **FASE 0 todavía no está cerrada**. Deben completarse F0-T02 a F0-T07 y obtener el baseline de latencia/setup antes de declarar PASS del Gate F0.
