# Cierre Fase 1 — inventario de runtime OpenAI / Gemini

> **Estado:** FASE 1 CERRADA  
> **Fecha:** 2026-08-26  
> **ADR autoridad:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Inventario detallado:** [`PROVIDER_RUNTIME_INVENTORY.md`](./PROVIDER_RUNTIME_INVENTORY.md)  
> **Plan vivo:** [`OPENAI_GEMINI_SEPARATION_WORKPLAN.md`](./OPENAI_GEMINI_SEPARATION_WORKPLAN.md)

## 1. Decisión de salida de Fase 1

Existe evidencia suficiente para comenzar el diseño del Gemini Worker independiente sin mover todavía el runtime existente.

La Fase 1 demuestra que:

1. el Worker actual es OpenAI-first y debe convertirse posteriormente en el producto OpenAI limpio;
2. Gemini está ampliamente incrustado dentro de `apps/control-plane/src`, no sólo en el Media Edge;
3. varias abstracciones etiquetadas históricamente como provider-neutral son en realidad compatibilidad para hacer coexistir OpenAI y Gemini;
4. sí existe un núcleo empresarial/persistente compartible —ToolGateway, reservas, autorización, seguridad, diagnóstico, Supabase— pero su composición debe desacoplarse del Worker actual;
5. el Gemini Media Edge actual contiene mucha orchestration y no debe preservarse monolíticamente por inercia;
6. el camino Gemini actual introduce saltos adicionales que deben reevaluarse por coste/garantía;
7. el diseño de Fase 2 debe partir de la semántica real de Gemini Live, no de la interfaz OpenAI ni de la cadena `CallSession Vx` existente.

No se ha modificado runtime durante este inventario.

---

# 2. Clasificación definitiva de fronteras

## 2.1 `SHARED_DOMAIN` / shared platform contracts

Estas capacidades se consideran compartibles entre los dos productos, aunque alguna composición concreta actual necesite refactor:

- `ToolGateway` y autorización de herramientas;
- lógica de reservas, horarios, disponibilidad y confirmación backend;
- contratos de persistencia;
- Supabase como fuente de verdad empresarial única en esta fase;
- identidad/normalización empresarial y temporal cuando no dependan del proveedor;
- seguridad de caller y persistencia de señales;
- redacción/minimización de PII en diagnóstico;
- contrato de diagnóstico cross-plane y persistencia en Supabase;
- políticas empresariales de handoff/consentimiento que no conozcan wire realtime.

### Nota de composición

Que una capacidad sea compartible no significa que el archivo actual deba copiarse tal cual. Por ejemplo, `caller-security-port.ts`, `restaurant-reservation-port.ts` y el port de diagnósticos construyen adapters desde `host.env`; esa composición deberá inyectarse desde cada Worker.

## 2.2 `OPENAI_NATIVE`

Se mantiene como responsabilidad del producto OpenAI:

- webhook `realtime.call.incoming` de OpenAI;
- correlación SIP OpenAI↔Telnyx;
- `openai-realtime-command-adapter.ts`;
- semántica `response.create`, `response.cancel`, `conversation.item.*`, `session.update` y buffers OpenAI;
- cualquier lifecycle o transporte que sólo exista por OpenAI Realtime, sujeto a simplificación en Fase 4.

El Worker actual es la base física de este producto, no una especificación intocable.

## 2.3 `GEMINI_NATIVE`

Debe pertenecer al producto Gemini:

- Gemini Live setup/session owner/event/command adapters;
- conexión Gemini Live;
- admission y credenciales del Gemini Media Edge;
- Telnyx Media Streaming `answer/start/stop` hacia el Edge;
- VAD/caller input/playback necesarios para el camino Gemini;
- correlación de tools Gemini;
- seguridad de binding tenant/call/stream del Edge;
- observabilidad específica del proveedor;
- Media Edge y sus tests/benchmarks.

La ubicación exacta Gemini Worker vs Media Edge se decide en Fase 2.

## 2.4 `LEGACY_COMPAT_REDESSIGN`

No debe copiarse automáticamente a ninguno de los dos productos:

- `realtime-provider-runtime.ts` actual;
- selección OPENAI/GEMINI dentro de una misma `CallSession`;
- `realtime-provider-call-session-composition.ts`;
- `call-session-v49-provider-selection.ts`;
- `realtime-provider-selector.ts` usado como selector por llamada dentro de un runtime universal;
- cadena de herencia `CallSession V2…V54` como patrón de construcción del nuevo Gemini Worker;
- sideband actual como protocolo obligatorio;
- deterministic post-tool provider rotation;
- doble motor de voz Gemini Live + Google TTS;
- semantic preselection + tool call de Live como doble decisión obligatoria;
- ports Telnyx que mezclan transporte neutral con fallback o TTL de proveedor.

## 2.5 `UNRESOLVED`, trasladado a Fase 2

No bloquean el cierre del inventario porque son decisiones de diseño/benchmark, no desconocimiento del sistema actual:

- si Google Speech STT batch sigue siendo necesario;
- si la semantic preselection aislada debe existir;
- reparto definitivo de VAD/STT/playback entre Gemini Worker y Media Edge;
- si `ResponseCoordinator`/turn ownership merecen reutilización o implementaciones separadas;
- qué forma tendrá el canal de control Worker↔Edge;
- qué partes de Telnyx conviene extraer como paquete realmente neutral.

---

# 3. Camino crítico Gemini actual y veredicto por salto

| Salto / responsabilidad | Veredicto Fase 1 | Razón |
|---|---|---|
| PSTN ↔ Telnyx | `ESSENTIAL` | carrier/telefonía del producto |
| Telnyx Media Streaming ↔ Gemini Media Edge | `ESSENTIAL` en topología actual | Gemini necesita media bridge; no hay SIP directo equivalente en esta arquitectura |
| autenticación/binding call↔stream | `KEEP_FOR_INVARIANT` | evita sesiones/streams no autorizados |
| reorder bounded de chunks Telnyx | `KEEP_FOR_INVARIANT` mientras usemos Media Streaming | ordering del audio no puede depender de llegada arbitraria |
| codec/resampling necesario Telnyx↔Gemini | `ESSENTIAL` si formatos difieren | conversión física de media |
| VAD propio del Edge | `BENCHMARK/DESIGN` | puede ser necesario para barge-in/turn authority, pero no se hereda automáticamente |
| Google Speech v2 batch STT | `BENCHMARK` | aporta transcript authority pero añade un request externo tras cada turno |
| isolated semantic preselection REST | `REMOVE_OR_COLLAPSE` como arquitectura obligatoria; invariantes `KEEP_FOR_INVARIANT` | la autorización/tool ownership debe sobrevivir, no necesariamente una segunda inferencia |
| semantic gate fail-closed | `KEEP_FOR_INVARIANT` | una tool/turno, autorización y no output indebido son garantías valiosas |
| sideband WSS actual | `REWRITE` | hace falta coordinación Worker↔Edge, pero protocolo/cola/owners actuales nacieron del híbrido |
| Cloudflare Gemini Worker futuro | `ESSENTIAL` | autoridad de llamada, tools, negocio y persistencia Gemini independiente |
| ToolGateway / dominio | `ESSENTIAL` + shared | autoridad empresarial común |
| Supabase | `ESSENTIAL` en esta fase cuando una operación lo requiere | fuente de verdad empresarial compartida |
| retorno de tool result a Gemini | `ESSENTIAL` | continuidad de operación model/tool |
| deterministic provider rotation | `REMOVE_OR_COLLAPSE` | cierre/reapertura de Live es fragilidad de compatibilidad hasta demostrar necesidad nativa |
| Google TTS separado para governed speech | `REMOVE_OR_COLLAPSE` como segunda identidad vocal | produce el cambio de voz observado; el contenido autorizado puede mantenerse sin motor vocal distinto |
| Gemini Live audio | `ESSENTIAL` si se adopta voz nativa Gemini como motor único | identidad vocal/prosodia de la sesión |
| Telnyx playback mark/clear/correlación | `KEEP_FOR_INVARIANT` | evidencia real de reproducción/interrupción |
| diagnóstico cross-plane | `KEEP_FOR_INVARIANT` | necesario para reconstrucción E2E sin audio/PII |

`BENCHMARK` no significa conservar. Significa que Fase 2 debe comparar alternativas con métricas antes de decidir.

---

# 4. Seguridad, diagnóstico y Telnyx

## 4.1 Seguridad compartible

`caller-security.ts` no depende de OpenAI/Gemini. Evalúa seguridad, rate/risk y persiste por Supabase.

**Decisión:** compartir contrato/servicio, pero extraer la creación desde `host.env` para que cada producto lo componga por inyección.

Los matchers léxicos actuales son implementación existente, no justificación para ampliar listas; cualquier rediseño de seguridad se hará aparte.

## 4.2 Diagnóstico compartible

`call-diagnostic-persistence-port.ts` define un evento cross-plane con planes `worker`, `call_session`, `media_edge`, `provider`, limita campos y rechaza detalles sensibles. `technical-diagnostic-redaction.ts` elimina secretos/audio/prompts y redacta PII.

**Decisión:** estos contratos y reglas de minimización son shared platform capabilities. Cada producto añadirá identidad inequívoca de runtime/deployment sin compartir estado conversacional.

## 4.3 Telnyx: no todo es neutral

- `telnyx-gemini-streaming-port.ts`: `GEMINI_NATIVE`, porque configura `streaming_start` L16 bidireccional al Media Edge.
- `telnyx-webhook-admission-identity.ts`: mezcla identidad retry-stable útil con `GEMINI_MEDIA_EDGE_CREDENTIAL_TTL_MS`; debe dividirse antes de compartir.
- `call-termination-port.ts`: mezcla hangup Telnyx source leg con `OPENAI_REALTIME_FALLBACK`; debe dividir transportes. El hangup Telnyx puede ser neutral, el fallback OpenAI es `OPENAI_NATIVE`.

**Regla Fase 2/4:** compartir sólo primitivas Telnyx que tengan exactamente la misma semántica en ambos productos.

---

# 5. Hallazgos adicionales que afectan al diseño Gemini

## 5.1 Sideband sticky failure

`InMemoryControlSidebandRegistry` conserva `session.commandFailure`; una falla en la cadena de comandos hace que comandos posteriores puedan volver a lanzar ese error.

Esto ya había aparecido como riesgo operativo y ahora queda clasificado como evidencia para **no trasladar literalmente el registry actual** al nuevo diseño. El nuevo contrato debe definir explícitamente política de error, recuperación y terminalidad.

## 5.2 Dos voces confirmadas por implementación

El servidor del Media Edge crea Google Text-to-Speech para `GOVERNED_SPEECH`, mientras el camino normal reproduce PCM generado por Gemini Live.

La Fase 2 deberá decidir **un único motor/identidad vocal por sesión**. La autoridad sobre el texto puede seguir siendo determinista sin exigir un segundo sintetizador.

## 5.3 Dos decisiones antes de una tool de Live

El camino actual puede ejecutar:

```text
Google STT
→ isolated Gemini classifier
→ Gemini Live
```

Esto se diseñó para preservar transcript/tool authority, pero no se convierte en requisito del producto nuevo. La Fase 2 debe intentar obtener las mismas garantías con menos saltos y medir cualquier alternativa.

---

# 6. Definition of Done de Fase 1

- [x] topología/entrypoints inventariados;
- [x] Worker OpenAI-first identificado;
- [x] superficie Gemini dentro del Worker identificada;
- [x] Gemini Media Edge auditado a nivel de ownership/camino crítico;
- [x] principales abstracciones híbridas clasificadas;
- [x] ejemplos sólidos de shared/OpenAI/Gemini identificados;
- [x] CallSession/response/turn concurrency evaluados suficientemente para no copiar la arquitectura actual;
- [x] seguridad/diagnóstico/Telnyx clasificados;
- [x] camino crítico Gemini reconstruido;
- [x] saltos etiquetados `ESSENTIAL`, `KEEP_FOR_INVARIANT`, `REMOVE_OR_COLLAPSE`, `REWRITE` o `BENCHMARK`;
- [x] cuestiones restantes convertidas en decisiones explícitas de Fase 2;
- [x] no se modificó runtime durante el inventario.

**Fase 1: CERRADA.**

---

# 7. Primera misión de Fase 2

Diseñar, antes de implementar, la arquitectura del **Gemini Control Plane Worker independiente** con estos objetivos:

1. el Worker Gemini no importa ni requiere runtime/SDK/credenciales OpenAI;
2. no existe provider selector OpenAI/Gemini dentro de su `CallSession`;
3. el lifecycle parte de Gemini Live real;
4. el Media Edge se reduce a responsabilidades justificadas por media/latencia/seguridad;
5. Worker↔Edge tiene un contrato explícito más pequeño y recuperable;
6. ToolGateway/dominio/Supabase se consumen como contratos compartidos;
7. una sola identidad vocal por sesión;
8. no se rota la sesión Gemini después de una tool salvo evidencia de que la API lo exige;
9. no se añaden STT/clasificadores auxiliares sin justificar su garantía y coste;
10. los tests de errores reales existentes se convierten en criterios de comportamiento del producto nuevo, no en requisitos de conservar la arquitectura vieja.

**Entregable siguiente:** `docs/architecture/GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`.
