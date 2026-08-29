# ADR-002 — Media plane externo para Gemini Live

> **Estado:** Aceptado históricamente; IMPLEMENTADO y posteriormente SUPERADO EN PARTE por ADR-004
> **Fecha original:** 2026-08-23
> **Última aclaración:** 2026-08-27
> **Ámbito:** Gemini Live / Telnyx Media Streaming / separación control-media
> **Decisión posterior:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

## Contexto original

La arquitectura estable exigía que Cloudflare no transportara audio continuo. OpenAI podía resolver media mediante su camino SIP, mientras que Gemini Live necesitaba terminar Telnyx Media Streaming y mantener un WebSocket con Gemini.

La decisión relevante de este ADR fue crear un **Media Edge externo y dedicado**:

```text
PSTN
  ↕
Telnyx
  ↕ WSS media
Gemini Media Edge
  ↕ WSS
Gemini Live

Cloudflare Control Plane
  └─ routing / admission / control
```

## Decisión que sigue vigente

Estas conclusiones de ADR-002 siguen siendo normativas:

1. Cloudflare no transporta audio continuo.
2. Gemini puede tener un media plane distinto del producto OpenAI.
3. El Media Edge es una frontera explícita, desplegable y observable.
4. Tenant, permisos y configuración segura se resuelven fuera del audio transport.
5. Añadir hops obligatorios al media path necesita justificación y benchmark.

## Qué fue superado

La versión original de este ADR trataba Gemini como provider todavía deshabilitado y definía gates para una arquitectura previa al Fast Path.

Eso **ya no describe producción**.

ADR-004 adoptó un Fast Path donde:

```text
Telnyx media
   ↕
Fast Media Edge
   ↕
Gemini Live
```

es el camino conversacional normal, mientras el Gemini Fast Worker se mantiene fuera del audio continuo y posee admission/tenant/control/tools/diagnóstico.

No son requisitos actuales del hot path Fast sólo porque aparecieran en diseños intermedios:

- Google STT autoritativo por cada turno;
- semantic preselection obligatoria;
- output quarantine normal por respuesta;
- `GeminiCallSession`/DO en cada turno;
- governed TTS como voz conversacional estándar.

## Estado operativo

Gemini ya ha atendido llamadas reales mediante el Fast Path. La antigua frase “Gemini permanece registrado y deshabilitado para tráfico” es histórica y **no debe reutilizarse**.

Para estado actual consultar:

- [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md)
- [`SYSTEM_ARCHITECTURE.md`](./SYSTEM_ARCHITECTURE.md)
- [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

## Consecuencia documental

ADR-002 se conserva porque explica por qué existe un Media Edge externo. No es fuente de verdad para decidir si Gemini está habilitado, qué revisión atiende llamadas ni qué mecanismos de turn authorization son obligatorios hoy.