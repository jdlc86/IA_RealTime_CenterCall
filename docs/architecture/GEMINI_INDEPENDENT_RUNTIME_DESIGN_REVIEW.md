# Revisión — diseño del producto Gemini independiente

> **Estado:** HISTÓRICO / YA NO NORMATIVO PARA FAST PATH  
> **Fecha original:** 2026-08-26  
> **Archivado:** 2026-08-27  
> **Documento revisado:** [`GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`](./GEMINI_INDEPENDENT_RUNTIME_DESIGN.md)  
> **Runtime vigente:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

Esta revisión fue normativa durante la Fase 2 del diseño independiente Gemini. Evaluó una arquitectura basada en `GeminiCallSession`, control Worker↔Edge, transcript authority externo y mecanismos de autorización/recovery asociados.

ADR-004 cambió posteriormente el runtime objetivo hacia el Fast Path y, por tanto, **las enmiendas de esta review no prevalecen sobre ADR-004 ni sobre `SYSTEM_ARCHITECTURE.md` actual**.

## Valor histórico

La review sigue siendo útil para entender:

- diferencias semánticas reales entre Gemini Live y OpenAI Realtime;
- riesgos de falsa abstracción provider-neutral;
- importancia de ownership, idempotencia y causalidad;
- límites de transcripts/events del provider;
- decisiones que motivaron la separación física de productos.

## No usar para afirmar

- que Fase 2 sigue activa;
- que el control WSS/DO por turno es obligatorio hoy;
- que Google STT/quarantine son baseline Fast;
- que el runtime Gemini todavía está pendiente de producción.

Para implementación/diagnóstico actual consultar ADR-004, [`SYSTEM_ARCHITECTURE.md`](./SYSTEM_ARCHITECTURE.md) y [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md).

El contenido técnico completo original permanece en el historial Git.