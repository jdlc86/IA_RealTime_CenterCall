# ADR-004 — Gemini Ultra-Low-Latency Production Fast Path

- **Estado:** Aceptado — implementación activa
- **Fecha:** 2026-08-26
- **Ámbito:** producto Gemini / realtime / media / tools / latencia / producción
- **Supersede parcialmente:** decisiones de Fase 2/3 que obligaban a Google STT, semantic preselection, quarantine o `GeminiCallSession`/control WSS en cada turno del camino conversacional.
- **No supersede:** ADR-003 sobre independencia OpenAI/Gemini ni la separación del producto Gemini respecto a OpenAI.

## Contexto

El objetivo inmediato del producto cambia: sacar cuanto antes un sistema Gemini autónomo, con arquitectura limpia, medible y de latencia conversacional mínima.

El runtime Gemini histórico acumuló mecanismos creados para convivir con un control plane OpenAI-first: Google Speech autoritativo por turno, semantic preselection aislada, governed TTS, provider rotation, sideband, quarantine y múltiples owners de playback/turn state. Aunque varios mecanismos son correctos en aislamiento, juntos introducen hops, esperas y estados que no son inherentes a Gemini Live.

Gemini 3.1 Flash Live está diseñado como modelo audio→audio de baja latencia. Su VAD puede operar sobre el flujo continuo y su function calling es secuencial: cuando el modelo llama una función, espera el FunctionResponse antes de continuar. Esto permite un diseño mucho más directo.

## Decisión

El producto Gemini adopta un **fast path realtime único**:

```text
PSTN
  ↕
Telnyx
  ↕ WebSocket media PCM
Gemini Media Runtime (Cloud Run)
  ↕ WebSocket Live
Gemini 3.1 Flash Live
```

El `Gemini Media Runtime` es el único owner del estado efímero de la conversación activa:

- socket Telnyx;
- socket Gemini Live;
- ingestión de audio;
- turn-taking/VAD;
- barge-in/interruption;
- reproducción;
- tool calls pendientes;
- reconnect/resumption de Gemini;
- métricas de latencia de la llamada.

### Principio de hot path

> **Ningún hop remoto es obligatorio entre audio del caller y Gemini, ni entre audio de Gemini y Telnyx.**

El Worker/DO no participa por defecto en:

- cada chunk de audio;
- inicio/fin de habla;
- `EDGE_READY`;
- `MEDIA_STARTED`;
- playback start/complete;
- turn authorization conversacional;
- semantic preselection;
- respuesta oral normal.

## Configuración baseline Gemini

Para el candidato de producción:

- modelo: `gemini-3.1-flash-live-preview` mientras sea el modelo Live de menor latencia validado;
- `responseModalities: [AUDIO]`;
- `thinkingLevel: minimal` salvo prueba A/B que demuestre necesidad de más razonamiento;
- una única voz nativa Gemini para toda la conversación;
- VAD automático Gemini como baseline;
- `START_OF_ACTIVITY_INTERRUPTS` para barge-in natural;
- VAD configurable, comenzando con `prefixPaddingMs=20` y `silenceDurationMs=100`;
- procesar **todas** las parts de cada evento de Gemini 3.1, porque un evento puede contener varias simultáneamente;
- `inputAudioTranscription`/`outputAudioTranscription` pueden habilitarse para diagnóstico, pero no bloquean el audio.

## Audio

### Caller → Gemini

Si el stream Telnyx está verificado como PCM16 little-endian a 16 kHz, el runtime debe reutilizar el payload de audio sin decode/re-encode innecesario y enviarlo como:

`audio/pcm;rate=16000`

Si el formato real difiere, se hará una sola transformación en el Media Runtime.

### Gemini → Telnyx

Gemini Live produce PCM16 a 24 kHz. El Media Runtime realiza una única conversión 24→16 kHz sólo si Telnyx requiere 16 kHz.

No se usa Google TTS en la ruta normal.

## Turn-taking y STT

Google Speech deja de ser autoridad obligatoria de cada turno en el fast path.

- Gemini recibe el audio inmediatamente.
- El VAD de Gemini determina el turno conversacional por defecto.
- La transcripción externa puede ejecutarse como dark/observability path, nunca delante de Gemini.
- Políticas de negocio críticas se validan en el tool boundary, no retrasando toda conversación.

Si una política futura exige bloquear contenido antes de que Gemini lo procese, debe justificar explícitamente el coste de latencia y pertenecer a un modo de seguridad distinto del baseline ultrarrápido.

## Tools y efectos de negocio

Gemini function calling es la única puerta normal a efectos externos.

Flujo:

```text
Gemini toolCall(id, name, args)
  → ToolExecutor local/low-latency
  → validación determinista de tenant + schema + business rules
  → shared domain / Supabase
  → FunctionResponse con el mismo id
  → misma sesión Gemini Live continúa
```

Reglas:

1. no hay efecto antes de validar tool name, id, argumentos y tenant;
2. business idempotency es independiente de transport idempotency;
3. un tool call no necesita semantic preselection previa;
4. el modelo no recibe un segundo generador/TTS para continuar;
5. outside-hours, disponibilidad, reserva progresiva y booking se resuelven en contratos de dominio deterministas;
6. el ToolExecutor puede vivir dentro del Media Runtime para el MVP si esto reduce hops y mantiene una frontera de código clara.

## Worker / Durable Object

El Gemini Worker sigue siendo útil para tareas **fuera del hot path**:

- webhook/admission pre-call;
- tenant routing/configuración;
- emisión de credenciales efímeras;
- administración;
- observabilidad o coordinación que no bloquee audio.

`GeminiCallSession` DO deja de ser requisito del MVP de baja latencia. Sólo se mantiene si una prueba demuestra valor para:

- coordinación multi-conexión;
- recuperación que el Media Runtime no pueda resolver;
- persistencia fuerte de estado no derivable.

No se seguirá implementando `SYNC/replay` simplemente por completar una abstracción si no es necesario para el producto de producción.

## Observabilidad

El hot path sólo emite métricas bounded y no bloqueantes:

- `telnyx_audio_received → gemini_send`;
- `caller_activity_end → gemini_first_audio`;
- `gemini_audio_received → telnyx_send`;
- tool call → tool result;
- reconnect/resumption;
- barge-in clear;
- buffer high-water;
- error category.

Persistencia/telemetría remota se realiza fuera del tramo crítico siempre que sea posible.

No almacenar audio, API keys, credentials, teléfonos ni transcripts crudos en diagnóstico por defecto.

## Budgets iniciales de rendimiento

Estos son gates de ingeniería, no promesas comerciales:

- Media Runtime processing caller chunk: **p95 ≤ 10 ms**;
- Gemini audio chunk → Telnyx queue: **p95 ≤ 10 ms**;
- overhead local de tool dispatch excluyendo I/O: **p95 ≤ 5 ms**;
- caller end → first Gemini audio: medir primero; objetivo inicial **p50 < 500 ms, p95 < 900 ms** en llamadas reales sanas;
- cero espera artificial basada en timers para ordering.

Los objetivos se ajustan con evidencia de producción/canary.

## Estrategia de implementación

1. crear un nuevo fast-path core independiente del runtime híbrido;
2. implementar parser de eventos Gemini 3.1 que consume todas las parts;
3. implementar audio pass-through caller→Gemini y playback Gemini→Telnyx;
4. usar VAD automático Gemini y barge-in nativo;
5. implementar tool executor en la misma sesión;
6. añadir benchmark sintético de overhead local;
7. añadir E2E real contra Gemini Live;
8. desplegar como canary separado/no productivo;
9. probar llamada manual de producción controlada;
10. sólo después retirar módulos híbridos que ya no formen parte del producto.

## Fuera de alcance del fast path inicial

- coexistencia OpenAI/Gemini en una misma llamada;
- failover cross-provider;
- semantic preselection;
- governed Google TTS para conversación ordinaria;
- Google STT como gate de cada turno;
- control WSS/DO como requisito de cada transición;
- provider rotation para simular semántica de otro proveedor.

## Criterio de éxito

El producto Gemini puede desplegarse y probarse independientemente con esta cadena:

`Telnyx ↔ Gemini Media Runtime ↔ Gemini Live ↔ ToolExecutor ↔ dominio/Supabase`

sin OpenAI, sin sideband híbrido y sin servicios auxiliares en la ruta normal de una respuesta hablada.