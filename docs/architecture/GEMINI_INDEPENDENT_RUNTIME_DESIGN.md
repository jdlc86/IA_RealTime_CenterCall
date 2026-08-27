# Diseño — producto Gemini independiente

> **Estado:** HISTÓRICO / SUPERADO EN PARTE POR ADR-004  
> **Fecha original:** 2026-08-26  
> **Archivado:** 2026-08-27  
> **Decisión estructural vigente:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Runtime Gemini vigente:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

Este diseño fue una etapa de transición importante para construir un producto Gemini independiente de OpenAI. **No es la especificación del Fast Path actual.**

## Decisiones que permanecen válidas

- Gemini debe poder operar sin runtime, SDK ni credenciales OpenAI.
- El audio continuo queda fuera de Cloudflare.
- Tenant, permisos y fuentes empresariales no pertenecen al modelo.
- Ownership, causalidad e idempotencia deben ser explícitos.
- El diagnóstico debe evitar audio, secretos y PII innecesaria.
- Supabase/dominio pueden compartirse sólo mediante contratos realmente neutrales.

## Elementos del diseño original que ya no son obligatorios en Fast

El diseño original exploró/propuso mecanismos como:

- `GeminiCallSession` Durable Object como autoridad de control por turno;
- Google STT como transcript authority;
- control WSS Worker↔Media Edge por cada lifecycle;
- semantic preselection;
- authorization quarantine;
- governed TTS/playback;
- recovery coordinado mediante esa arquitectura.

ADR-004 los supersede como requisitos del camino conversacional normal Fast.

## Runtime actual

```text
Telnyx media WSS
      ↕
Fast Media Edge
      ↕
Gemini Live
```

con Fast Worker separado para tenant/config/admission/control/tools/diagnóstico fuera del audio continuo.

## Uso correcto de este archivo

Úsalo únicamente para comprender decisiones, riesgos y alternativas consideradas el 2026-08-26. Para implementar o diagnosticar producción, empezar por:

- [`SYSTEM_ARCHITECTURE.md`](./SYSTEM_ARCHITECTURE.md)
- [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)
- [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md)

El documento detallado original permanece en el historial Git.