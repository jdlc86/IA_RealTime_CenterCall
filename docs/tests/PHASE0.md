# Test Plan — FASE 0

> **Estado:** activo

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
| F0-T01 | [ ] | | | | | | |
| F0-T02 | [ ] | | | | | | |
| F0-T03 | [ ] | | | | | | |
| F0-T04 | [ ] | | | | | | |
| F0-T05 | [ ] | | | | | | |
| F0-T06 | [ ] | | | | | | |
| F0-T07 | [ ] | | | | | | |

## Infraestructura ya validada

- [x] GitHub → Cloudflare Workers Builds.
- [x] Deploy automático.
- [x] Worker público.
- [x] `/health` responde `ok: true`.

La validación del audio/telefonía comenzará tras configurar OpenAI + Twilio.
