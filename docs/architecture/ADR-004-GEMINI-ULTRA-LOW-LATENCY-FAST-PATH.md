# ADR-004 — Gemini Ultra-Low-Latency Production Fast Path

> **Estado:** Aceptado — IMPLEMENTADO / operativo  
> **Fecha:** 2026-08-26  
> **Última aclaración:** 2026-08-27  
> **Ámbito:** producto Gemini / realtime / media / tools / latencia / producción  
> **Supersede parcialmente:** decisiones de Fase 2/3 que obligaban a Google STT, semantic preselection, quarantine o `GeminiCallSession`/control WSS en cada turno  
> **No supersede:** ADR-003 sobre independencia OpenAI/Gemini ni la prohibición de Cloudflare en audio continuo

## Contexto

El runtime Gemini histórico acumuló mecanismos creados para convivir con una arquitectura OpenAI-first: Google Speech autoritativo por turno, semantic preselection, governed TTS, provider rotation, sideband, quarantine y múltiples owners de playback/turn state.

Aunque esos mecanismos podían ser correctos de forma aislada, añadían hops, esperas y estados que no son inherentes al modelo audio→audio Gemini Live.

El objetivo del Fast Path es mantener la conversación Gemini lo más directa posible sin renunciar a tenant binding, seguridad, capabilities, effects ni observabilidad.

## Decisión

El producto Gemini adopta como camino normal:

```text
PSTN
  ↕
Telnyx
  ↕ WebSocket media
Fast Gemini Media Edge (Cloud Run)
  ↕ WebSocket Live
Gemini 3.1 Flash Live
```

El Gemini Fast Worker participa antes/alrededor del media path, no dentro del transporte continuo:

```text
Telnyx webhook
   ↓
Gemini Fast Worker
   ├── tenant/KV
   ├── session config
   ├── admission/credentials
   ├── transfer/control
   └── diagnostics ingest
           │
           └──► tagged Fast Media Edge URL
```

## Principio de hot path

> **Ningún hop remoto es obligatorio entre audio del caller y Gemini ni entre audio de Gemini y Telnyx.**

Por defecto, el Worker/DO no participa en:

- cada chunk de audio;
- inicio/fin de habla normal;
- cada decisión de turn authorization;
- semantic preselection por turno;
- playback normal;
- respuesta oral normal.

Una tool/effect puede requerir control/autorización externa sin convertir esa frontera en relay de audio.

## Owners del Fast Media Edge

Por llamada, el Fast Media Edge posee:

- socket Telnyx media;
- socket Gemini Live;
- ingestión/forwarding de audio;
- VAD/turn-taking Gemini;
- interruption/barge-in;
- playback;
- parser de frames Gemini;
- tool calls pendientes y su ejecución realtime local cuando corresponda;
- reconnect/resumption Gemini;
- métricas de latencia del tramo realtime.

No posee:

- tenant selection;
- número privado de handoff;
- permissions/capabilities empresariales;
- persistencia empresarial como fuente de verdad.

## Baseline Gemini Fast

La implementación actual usa como baseline:

```text
model: gemini-3.1-flash-live-preview
voice: Kore
language: es-ES
response: AUDIO
thinking: MINIMAL
Gemini automatic VAD: enabled
activityHandling: START_OF_ACTIVITY_INTERRUPTS
```

Estos valores son configuración de implementación actual, no una obligación eterna del ADR. Cambiarlos exige benchmark/regresión adecuados si afectan latencia o experiencia acústica.

## Audio

Entrada caller:

```text
Telnyx PCM/L16 → Media Edge → Gemini realtime input
```

Salida assistant:

```text
Gemini native PCM → conversión/resampling necesario → Telnyx media
```

No introducir STT externo, base de datos o Worker como gate obligatorio para audio normal.

## Tools

Gemini function calling es secuencial respecto a su `FunctionResponse`, por lo que el Fast runtime puede ejecutar una tool sin reconstruir una arquitectura de autorización conversacional por turnos completa.

Aun así, toda tool sensible debe preservar:

- tenant/call identity;
- schema;
- capability;
- idempotency;
- business invariants;
- confirmación/autoridad cuando aplique;
- diagnóstico proporcional.

### Handoff humano

La comprensión lingüística pertenece a Gemini; el kernel valida autoridad grounded y estado. No se utilizan listas rígidas de frases para decidir si el caller “realmente quiso decir sí”.

El transcript/evidencia necesario para el tool se captura antes de encolar la ejecución asíncrona para evitar carreras con `turnComplete`.

## Observabilidad

La observabilidad Fast debe ser bounded y no bloquear el audio.

El Media Edge puede acumular diagnóstico seguro y enviarlo/persistirlo fuera del tramo crítico. No registrar audio, API keys, bearer/HMAC tokens ni transcripts crudos por defecto.

## Deployment con revisión etiquetada

El Fast Media Edge se despliega de forma deliberada como revisión etiquetada con `--no-traffic` general. El Worker se configura después con la URL WSS etiquetada.

```text
Cloud Run service general traffic: revisión estable previa puede seguir 100%
Fast tagged revision: 0% general
Fast Worker binding: apunta directamente al tag
```

Por tanto, **0% general no significa 0 llamadas Fast**.

El estado real debe comprobarse desde el binding `GEMINI_FAST_CANARY_EDGE_URL`, readiness del tag y Worker correspondiente.

## Gates de producción

El Fast Path ya cruzó los gates que históricamente impedían llamadas reales. A partir de ahora, cada cambio debe demostrar sólo los gates que le correspondan:

1. tests/checks del componente modificado;
2. build/deploy del SHA exacto;
3. readiness/health/bindings;
4. bootstrap/HMAC preflight cuando el gate esté operativo;
5. E2E de llamada si el cambio afecta comportamiento telefónico/acústico.

No volver a interpretar esta sección como “Gemini no puede recibir tráfico hasta una futura fase”.

## Limitaciones conocidas fuera del core audio

Al 2026-08-27 siguen abiertas:

- ringback determinista para el caller durante una transferencia humana;
- audibilidad fiable del TTS terminal tras `NO_ANSWER`/fallo;
- coherencia final del preflight workflow Gemini Fast Canary;
- limpieza de referencias de prompt heredadas de la política antigua de handoff.

Estas limitaciones no autorizan a modificar VAD/audio bridge/codecs/resampler sin demostrar causalidad.

## Consecuencias

### Positivas

- menos hops y menor latencia;
- ownership realtime más claro;
- Gemini evoluciona sin arrastrar lifecycle OpenAI;
- problemas de control pueden corregirse sin tocar audio estable;
- arquitectura medible y desplegable por revisión inmutable/tag.

### Riesgos

- la baja latencia no puede conseguirse saltándose permisos/invariantes;
- tools locales requieren disciplina estricta de schema/idempotency;
- una revisión etiquetada puede confundirse con “sin tráfico” si se mira sólo el porcentaje general de Cloud Run;
- módulos históricos pueden inducir a reintroducir complejidad si no están claramente marcados.

## Relación con otros documentos

- [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md) — separación estructural de productos.
- [`SYSTEM_ARCHITECTURE.md`](./SYSTEM_ARCHITECTURE.md) — topología completa actual.
- [`DESIGN_RULES.md`](./DESIGN_RULES.md) — invariantes transversales.
- [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md) — estado operativo y limitaciones actuales.
- [`../HUMAN_HANDOFF.md`](../HUMAN_HANDOFF.md) — contrato/UX de transferencia humana.

## Decisión final

El Fast Path es la arquitectura Gemini operativa de referencia. Los diseños previos de STT/quarantine/DO/semantic preselection se conservan como historia/compatibilidad, no como requisitos implícitos del camino de producción.