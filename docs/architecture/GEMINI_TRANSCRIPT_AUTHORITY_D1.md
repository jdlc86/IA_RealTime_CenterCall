# D1 — Transcript authority del producto Gemini independiente

> **Estado:** HISTÓRICO / SUPERADO PARA FAST PATH  
> **Fecha original:** 2026-08-26  
> **Archivado:** 2026-08-27  
> **Runtime vigente:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

La decisión D1 original establecía Google Cloud Speech-to-Text v2 como autoridad textual del caller turn para una arquitectura Gemini independiente con gating externo.

**Esa decisión ya no es baseline del Gemini Fast Path.**

## Motivo de supersession

ADR-004 cambió explícitamente el camino normal para minimizar hops y latencia:

```text
Telnyx media
  → Fast Media Edge
  → Gemini Live
```

El audio del caller no espera Google STT ni semantic preselection antes de participar en la conversación normal.

## Autoridad actual para handoff semántico

En `transfer_call`, Gemini aporta la interpretación semántica y evidencia textual del caller. El kernel valida que la evidencia esté grounded en el transcript capturado para el tool call y valida estado/capability/tenant; no usa Google STT externo como gate obligatorio ni listas rígidas de frases.

La evidencia utilizada por el tool se snapshottea antes de `turnComplete`/cleanup para evitar carreras de estado.

Ver [`../HUMAN_HANDOFF.md`](../HUMAN_HANDOFF.md).

## Qué sigue siendo válido del análisis original

- no inventar finality que el provider no entregue;
- no usar timers para fabricar ordering;
- separar transcript auxiliar de autoridad de efectos;
- exigir grounding/identidad suficiente cuando un efecto lo necesite;
- benchmarkear cualquier reintroducción de STT externo antes de ponerlo en el hot path.

## Uso correcto

Este archivo explica por qué se exploró STT externo como autoridad. No debe citarse para afirmar que una llamada Fast actual requiere `TRANSCRIPT_AUTHORITY_COMPLETED`, Google STT por turno o quarantine antes de responder.

El análisis detallado original permanece en el historial Git.