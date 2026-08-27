# Gemini independiente — Fase 3 histórica

> **Estado:** ARCHIVADO / SUPERADO  
> **Última actualización como documento vivo:** 2026-08-26  
> **Archivado:** 2026-08-27  
> **Sustituido como estado operativo por:** [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md)  
> **Arquitectura Gemini vigente:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

Este archivo **ya no es un checkpoint operativo** y no debe actualizarse como plan activo.

La Fase 3 documentada originalmente exploraba/construía una arquitectura Gemini independiente basada, entre otros elementos, en:

- `GeminiCallSession` / Durable Object;
- contrato WSS de control Worker↔Edge;
- Google Speech v2 como transcript authority;
- semantic preselection;
- `TurnAuthorizationQuarantine`;
- governed speech/TTS;
- recovery/reconnect gobernado;
- gates de admission antes de permitir tráfico productivo.

Ese trabajo produjo aprendizajes, componentes y pruebas útiles, pero **no representa el hot path Gemini Fast que atiende llamadas actualmente**.

## Por qué quedó superado

ADR-004 cambió explícitamente el objetivo de runtime hacia un camino audio→audio de latencia mínima:

```text
Telnyx media WSS
      ↕
Fast Media Edge
      ↕
Gemini Live
```

El Fast Worker conserva routing, tenant/config, admission, seguridad, tools/control y diagnóstico, pero no participa en cada chunk/turno de audio.

Por tanto, dejaron de ser requisitos obligatorios del camino conversacional normal Fast:

- STT externo antes de entregar cada turno a Gemini;
- semantic preselection aislada por turno;
- quarantine como gate normal de cada respuesta;
- DO/control WSS como owner de cada turno;
- TTS externo como voz conversacional normal.

La mera presencia de esos módulos/tests en `apps/gemini-media-edge` no implica que formen parte de `server-fast.mjs` / `fast-runtime.mjs`.

## Qué decisiones siguen siendo útiles

Del trabajo de Fase 3 sobreviven principios que siguen vigentes:

- OpenAI y Gemini deben ser productos/runtimes independientes;
- Cloudflare no transporta audio continuo;
- tenant, permisos e invariantes no pertenecen al modelo;
- efectos requieren contratos/identidad/capabilities;
- ordering debe resolverse por evidencia/identidad, no por sleeps;
- observabilidad debe ser bounded y redactada;
- una capability sintética no sustituye una validación E2E.

Estos principios están consolidados en [`DESIGN_RULES.md`](./DESIGN_RULES.md).

## Estado actual

No usar los checkboxes, SHAs, revisiones o frases originales de este documento para responder preguntas como:

- “¿Gemini recibe tráfico?”
- “¿qué Worker atiende la llamada?”
- “¿Google STT es obligatorio?”
- “¿puedo hacer una llamada manual?”
- “¿qué revisión Cloud Run está usando Fast?”

Para esas preguntas consultar [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md), [`SYSTEM_ARCHITECTURE.md`](./SYSTEM_ARCHITECTURE.md), la configuración remota y los workflows actuales.

## Trazabilidad histórica

El contenido detallado original de este checkpoint permanece disponible en el historial Git anterior a este archivado. No se replica aquí porque mantener un segundo plan exhaustivo “casi vigente” fue precisamente una fuente de confusión documental.