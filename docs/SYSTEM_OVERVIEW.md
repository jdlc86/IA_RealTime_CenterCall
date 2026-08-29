# IA_RealTime_CenterCall — visión del sistema

> **Estado:** vigente
> **Última revisión:** 2026-08-29
> **Carácter:** resumen canónico; el detalle normativo vive en `architecture/SYSTEM_ARCHITECTURE.md` y ADRs aplicables.

## Producto

Plataforma multi-tenant de atención telefónica con IA de voz en tiempo real. El repositorio mantiene dos productos realtime estructuralmente independientes, OpenAI y Gemini, que pueden compartir dominio/persistencia cuando los contratos sean realmente neutrales.

## Topología actual

```text
                         dominio / persistencia neutral
                                  │
                               Supabase
                                  │
             ┌────────────────────┴────────────────────┐
             │                                         │
             ▼                                         ▼
       PRODUCTO OPENAI                          PRODUCTO GEMINI FAST

Caller/PSTN                                  Caller/PSTN
    ↕                                            ↕
  Telnyx                                       Telnyx
    ↕                                            │ webhook/control
OpenAI control/runtime                           ▼
    ↕                                      Gemini Fast Worker
OpenAI Realtime                                  │ admission + tenant/KV
                                                 │ control/tools + diagnóstico
                                                 ▼
                                           Fast Media Edge
                                              ↕       ↕
                                        Telnyx media  Gemini Live
```

Cloudflare permanece fuera del transporte continuo de audio. En Gemini Fast, el Worker dirige la llamada a una revisión etiquetada del Media Edge; una revisión con `0%` de tráfico general de Cloud Run puede seguir atendiendo llamadas mediante esa URL explícita.

## Responsabilidades

### Producto Gemini Fast

- **Fast Worker (`apps/gemini-control-plane`)**: verificación Telnyx, tenant routing/KV, configuración, admission/credenciales, autorización/control de efectos, handoff y diagnóstico.
- **Fast Media Edge (`apps/gemini-media-edge`)**: sockets Telnyx/Gemini, audio, VAD/turn-taking Gemini, barge-in, playback, parser Gemini y coordinación realtime local.
- **Gemini Live**: comprensión/expresión conversacional y function calling dentro del contrato autorizado.

### Producto OpenAI

- `apps/control-plane` y `apps/media-edge` conservan la ruta OpenAI independiente.
- No se introduce estado efímero, wire protocol ni secretos Gemini en el runtime OpenAI, ni viceversa.

### Compartido cuando es neutral

- tenant/domain contracts;
- reglas de negocio;
- persistencia Supabase;
- seguridad/autorización de backend;
- observabilidad y adapters empresariales que no dependan del runtime de voz.

El kernel compartido distingue capacidades transversales —seguridad, admission/identidad, voz/lifecycle, autorización, handoff, tiempo, diagnóstico y comunicaciones— de las capacidades verticales del tenant, como reservas o citas. WhatsApp se autoriza por separado como `message.whatsapp.transactional` y `message.whatsapp.realtime_support`.

## Autoridad semántica y determinista

El modelo interpreta lenguaje natural; el sistema determinista posee permisos, tenant, schema, capabilities, idempotencia, invariantes empresariales y efectos.

Toda tool declara un contrato cerrado: nombre/schema, autoridad, efecto, capability, evidencia, handler y contexto tenant/call; una mutación añade idempotencia, confirmación e invariantes de dominio.

En Gemini Fast la autorización no depende sólo del orden del runtime: el kernel emite un recibo opaco ligado a la call y al contexto autenticado. Tanto el executor como `transfer_call` validan ese recibo en el sink y ejecutan exclusivamente la instantánea de argumentos autorizada. Así, una invocación directa del handler/executor o un `ALLOW` fabricado falla cerrado sin side effects.

Para human handoff Fast, Gemini declara una autoridad semántica estructurada y evidencia del caller. El kernel valida que el valor de autoridad sea soportado y que la evidencia esté realmente grounded en el transcript snapshot del tool call. **El kernel no vuelve a interpretar el español mediante listas rígidas y actualmente no reconstruye por sí mismo que existiera una oferta previa para `CONFIRMED_OFFER`.**

La definición completa está en [`HUMAN_HANDOFF.md`](./HUMAN_HANDOFF.md).

## Invariantes visibles

- Cloudflare no transporta audio continuo.
- No se introduce un hop remoto obligatorio en el hot path Gemini para resolver problemas de control.
- OpenAI y Gemini no comparten estado efímero de llamada.
- Ninguna operación empresarial se confirma sin evidencia válida del backend/sistema fuente.
- El tenant se deriva de routing confiable, no del texto libre del caller/modelo.
- La intención abierta pertenece al modelo; permisos e invariantes pertenecen al kernel.
- No se usan catálogos crecientes de frases para sustituir comprensión lingüística.
- `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO` y `VALIDADO E2E` son estados diferentes.
- Evidencia de control no demuestra por sí sola experiencia acústica.
- No se añade latencia evitable: todo nuevo hop síncrono en audio/turn/post-tool requiere baseline, presupuesto y p50/p95/p99; el trabajo por chunk exige ADR+benchmark.

## Estado operativo y limitaciones

Este archivo no duplica la lista viva de incidencias o despliegues. Consultar:

- [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — estado operativo, evidencia y siguiente validación;
- [`HUMAN_HANDOFF.md`](./HUMAN_HANDOFF.md) — transferencia, ringback/TTS y contrato semántico;
- [`runbooks/Deployment.md`](./runbooks/Deployment.md) — deploy y preflight;
- [`runbooks/CROSS_PLANE_CALL_DIAGNOSTICS.md`](./runbooks/CROSS_PLANE_CALL_DIAGNOSTICS.md) — investigación de llamadas.

## Dónde profundizar

- Arquitectura: [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md)
- Gemini Fast: [`architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)
- Reglas: [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md)
- Estado operativo: [`PROJECT_STATUS.md`](./PROJECT_STATUS.md)
- Relevo: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)
- Seguridad: [`../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx`](../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx)
