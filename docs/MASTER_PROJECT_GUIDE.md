# IA_RealTime_CenterCall — guía maestra

## Propósito

Construir una plataforma multi-tenant de agentes telefónicos Gemini con kernel
transversal seguro y verticales configurables por tenant.

Estado actual: [`PROJECT_STATUS.md`](./PROJECT_STATUS.md).
Relevo: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md).
Mantenimiento: [`DOCUMENTATION_MAINTENANCE.md`](./DOCUMENTATION_MAINTENANCE.md).

## Producto

```text
Telnyx → Gemini Fast Worker → Fast Media Edge ↔ Gemini Live
```

El Fast Worker posee señalización, tenant routing, admission, seguridad,
capabilities, tools y control. El Media Edge posee el hot path de audio. Supabase
posee la verdad durable.

## Kernel transversal

- identidad y admission Telnyx;
- caller-security y reputación;
- lifecycle de voz y barge-in;
- autorización de tools;
- transferencia humana;
- autoridad temporal;
- diagnóstico y privacidad;
- comunicaciones externas.

WhatsApp se separa en `message.whatsapp.transactional` y
`message.whatsapp.realtime_support`; ambas capacidades son opt-in por tenant.

## Verticales

Reservas, disponibilidad, horarios, mesas, citas y demás reglas empresariales
son módulos de dominio. Consumen capacidades transversales, pero no duplican ni
debilitan sus controles.

## Contrato obligatorio

Toda tool tiene schema cerrado, authority, effect, capability, evidence, handler
permitido y contexto tenant/call. Las mutaciones añaden confirmación,
idempotencia y constraints de dominio. Gemini interpreta y propone; el kernel
autoriza; el dominio valida; el backend ejecuta.

## Reglas operativas

- Sin audio continuo por Cloudflare.
- Sin RTT, inferencia o persistencia por chunk.
- Sin fallback silencioso.
- Sin secretos, prompts, audio o transcript bruto en diagnóstico.
- Sin escalado horizontal mientras el estado call-scoped siga in-memory.
- Un único workflow integral: `Gemini Fast Canary Deploy`.
- `IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E`.

## Desarrollo

```bash
cd apps/gemini-control-plane
npm install
npm run check

cd ../gemini-media-edge
npm ci
npm run check
npm test
```

Git conserva el historial retirado. No se restauran productos o prototipos
anteriores como atajo para implementar una capability nueva.
