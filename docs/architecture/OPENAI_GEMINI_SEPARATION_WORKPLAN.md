# Plan de trabajo — separación OpenAI / Gemini

> **Estado:** ARCHIVADO / OBJETIVO ESTRUCTURAL COMPLETADO  
> **Fecha de inicio:** 2026-08-26  
> **Archivado:** 2026-08-27  
> **ADR autoridad:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Runtime Gemini vigente:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

Este archivo fue el plan vivo para separar OpenAI y Gemini. **Ya no es un workplan activo.**

El objetivo estructural se materializó en aplicaciones separadas:

```text
OpenAI
  apps/control-plane
  apps/media-edge

Gemini
  apps/gemini-control-plane
  apps/gemini-media-edge
```

La arquitectura Gemini evolucionó además desde el diseño inicial con `GeminiCallSession`/control por turno hacia el Fast Path definido por ADR-004.

## Qué no debe inferirse de este plan histórico

No usar su contenido original para afirmar que:

- la separación sigue pendiente;
- `GeminiCallSession` Durable Object es el owner actual del turno Fast;
- Google STT/quarantine/control WSS son obligatorios en el hot path;
- Gemini no puede recibir tráfico;
- una fase numerada antigua sigue siendo la próxima misión.

## Estado actual

Consultar:

- [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md) — estado operativo;
- [`../SESSION_HANDOFF.md`](../SESSION_HANDOFF.md) — siguiente misión;
- [`SYSTEM_ARCHITECTURE.md`](./SYSTEM_ARCHITECTURE.md) — topología actual;
- [`DESIGN_RULES.md`](./DESIGN_RULES.md) — invariantes.

## Trazabilidad

El detalle original de tareas, slices y checklist permanece en el historial Git anterior a este archivado. No se mantiene aquí una segunda lista viva porque duplicaría `PROJECT_STATUS.md` y volvería a introducir ambigüedad.