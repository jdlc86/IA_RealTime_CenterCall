# Inventario de runtime — separación OpenAI / Gemini

> **Estado:** ACTIVO / EN PROGRESO  
> **Fecha:** 2026-08-26  
> **Autoridad:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Plan:** [`OPENAI_GEMINI_SEPARATION_WORKPLAN.md`](./OPENAI_GEMINI_SEPARATION_WORKPLAN.md)  
> **Rama:** `rebuild/v39-stable-baseline`  
> **PR:** `#85`

## 1. Propósito

Este documento registra el inventario arquitectónico previo a cualquier separación física de runtime. El objetivo no es describir el código por carpeta, sino identificar **qué responsabilidad posee cada pieza, por qué existe y a qué producto debe pertenecer**.

El código actual se trata como evidencia histórica y funcional; no se asume que sea el diseño óptimo de OpenAI ni de Gemini.

Clasificaciones usadas:

- `SHARED_DOMAIN` — dominio/persistencia/contrato realmente neutral al proveedor.
- `OPENAI_NATIVE` — runtime específico de OpenAI que debe permanecer en el producto OpenAI, sujeto a futura optimización.
- `GEMINI_NATIVE` — runtime específico de Gemini que debe pertenecer al producto Gemini.
- `LEGACY_COMPAT_REDESSIGN` — compatibilidad histórica o abstracción que debe rediseñarse antes de conservarse.
- `UNRESOLVED` — evidencia insuficiente; no mover ni borrar todavía.

Acciones propuestas:

- `KEEP` — conservar en el producto correspondiente.
- `MOVE` — trasladar al producto correcto sin cambiar semántica salvo adaptación de dependencias.
- `EXTRACT` — extraer como pieza compartida neutral.
- `REWRITE` — conservar capacidad, no implementación actual.
- `DELETE_LATER` — retirar después de demostrar que el nuevo camino la sustituye.
- `INVESTIGATE` — requiere más evidencia.

---

# 2. Topología física observada

## 2.1 Apps existentes

En `apps/` existen actualmente:

```text
apps/
  control-plane/
  gemini-media-edge/
  gemini-media-edge-benchmark/
```

No existe todavía un `gemini-control-plane` / Gemini Worker independiente.

### Clasificación preliminar

| Ruta | Responsabilidad observada | Clasificación | Acción |
|---|---|---|---|
| `apps/control-plane/` | Worker Cloudflare principal; OpenAI-first pero hoy contiene integración Gemini | `LEGACY_COMPAT_REDESSIGN` como conjunto físico | `INVESTIGATE` y dividir responsabilidades; conservar luego como producto OpenAI |
| `apps/gemini-media-edge/` | Media edge Gemini Live desplegable en Node/Cloud Run | `GEMINI_NATIVE` | `KEEP`, revisar acoplamiento al Control Plane actual |
| `apps/gemini-media-edge-benchmark/` | benchmark específico del media edge Gemini | `GEMINI_NATIVE` | `KEEP` mientras siga siendo útil para rendimiento/hosting |

## 2.2 Pipelines observados

Workflows existentes:

```text
.github/workflows/control-plane-ci.yml
.github/workflows/gemini-media-edge-ci.yml
.github/workflows/gemini-media-edge-benchmark-ci.yml
.github/workflows/gemini-media-edge-canary-deploy.yml
```

Existe separación CI/deploy del Media Edge Gemini, pero **no existe CI/deploy de un Gemini Control Plane independiente**, porque ese Worker aún no existe.

### Clasificación preliminar

| Workflow | Clasificación | Acción |
|---|---|---|
| `control-plane-ci.yml` | `LEGACY_COMPAT_REDESSIGN` como frontera de producto | convertir progresivamente en CI del producto OpenAI y extraer comprobaciones realmente compartidas |
| `gemini-media-edge-ci.yml` | `GEMINI_NATIVE` | `KEEP` |
| `gemini-media-edge-benchmark-ci.yml` | `GEMINI_NATIVE` | `KEEP` |
| `gemini-media-edge-canary-deploy.yml` | `GEMINI_NATIVE` | `KEEP`; más adelante coordinarlo con deploy del nuevo Gemini Worker |

---

# 3. Worker actual (`apps/control-plane`)

## 3.1 Identidad y configuración física

`wrangler.jsonc` demuestra que el Worker actual es originalmente OpenAI-first:

```text
name               ia-realtime-centercall
main               src/index-v6.ts
REALTIME_MODEL     gpt-realtime
REALTIME_VOICE     marin
OPENAI_PROJECT_ID  configurado
Durable Object     CALL_SESSIONS → CallSession
```

`package.json` tiene dependencia runtime directa de `openai` y no de un SDK Gemini.

### Conclusión

La dirección objetivo es que este Worker evolucione hacia el **producto OpenAI independiente**, no que siga creciendo como Worker universal.

**Clasificación:** `OPENAI_NATIVE` como producto físico objetivo, con contaminación `GEMINI_NATIVE` y piezas `LEGACY_COMPAT_REDESSIGN` internas todavía por separar.

**Acción:** `KEEP` como base del producto OpenAI; auditar y limpiar después de extraer Gemini.

## 3.2 Entrypoint `src/index-v6.ts`

Responsabilidades observadas:

- envuelve `index-v6-runtime-core`;
- exporta `CallSession` V54;
- consume cola de seguridad compartida;
- conoce `SUPABASE_URL` / `SUPABASE_SECRET_KEY`;
- conoce `GEMINI_MEDIA_EDGE_URL`;
- conoce `MEDIA_EDGE_CONTROL_PLANE_TOKEN`;
- interpreta respuestas `start_gemini_media_stream`;
- persiste `GEMINI_ADMISSION_COMPLETED`;
- construye `/internal/diagnostics` del Gemini Media Edge;
- al `call.hangup`, consulta directamente diagnósticos del Media Edge y los persiste.

### Descomposición preliminar

| Responsabilidad | Clasificación | Acción |
|---|---|---|
| consumo de `CALLER_SECURITY_SIGNALS` | `SHARED_DOMAIN` / infraestructura neutral probable | `INVESTIGATE` para extraer contrato común sin asumir ubicación final |
| persistencia de diagnósticos cross-plane | `SHARED_DOMAIN` probable | `INVESTIGATE` / posible `EXTRACT` |
| observación Telnyx genérica de `call.hangup` | `UNRESOLVED` | distinguir telefonía neutral de correlación Gemini específica |
| `GEMINI_MEDIA_EDGE_URL` | `GEMINI_NATIVE` | `MOVE` al futuro Gemini Worker |
| `MEDIA_EDGE_CONTROL_PLANE_TOKEN` | `GEMINI_NATIVE` | `MOVE` al futuro Gemini Worker |
| `GeminiAdmissionResponse` | `GEMINI_NATIVE` | `MOVE` / posiblemente `REWRITE` según nuevo contrato Gemini |
| `workerAdmissionEvent(... GEMINI ...)` | `GEMINI_NATIVE` | `MOVE` |
| `mediaDiagnosticEndpoint()` | `GEMINI_NATIVE` | `MOVE` |
| `pullAndPersistMediaEdgeDiagnostics()` | `GEMINI_NATIVE` | `MOVE` o `REWRITE` si el nuevo diseño elimina pull al hangup |

### Dependencia cruzada ya demostrada

El **entrypoint productivo del Worker OpenAI-first conoce directamente el servicio Gemini Media Edge**. Esta es una frontera de separación prioritaria porque impide que el producto OpenAI sea operacionalmente independiente de configuración Gemini.

No se elimina todavía: primero debe existir el nuevo Worker Gemini y una ruta funcional equivalente.

## 3.3 `src/index-v6-runtime-core.ts`

Responsabilidades observadas:

- delega a `index-v5`;
- exporta el mismo `CallSession` V54;
- contiene cola de seguridad;
- no contiene, en el tramo inspeccionado, referencias Gemini directas.

**Clasificación provisional:** `LEGACY_COMPAT_REDESSIGN` como capa de composición histórica; sus responsabilidades individuales parecen repartirse entre `SHARED_DOMAIN` (seguridad) y `OPENAI_NATIVE`/infraestructura del Worker.

**Acción:** `INVESTIGATE`. No copiar esta cadena de wrappers al nuevo Gemini Worker.

## 3.4 `src/index-v5.ts`

Responsabilidades observadas:

- delega a `index-v4`;
- expone `CallSession` de una generación anterior para composición;
- procesa específicamente `/webhooks/openai`;
- parsea `realtime.call.incoming`;
- extrae headers SIP relacionados con Telnyx;
- adjunta contexto de handoff al Durable Object;
- añade metadata de versión a `/health`.

### Clasificación preliminar

| Responsabilidad | Clasificación | Acción |
|---|---|---|
| `/webhooks/openai` y evento `realtime.call.incoming` | `OPENAI_NATIVE` | `KEEP` sujeto a futura simplificación |
| correlación SIP OpenAI ↔ Telnyx | `OPENAI_NATIVE` | `KEEP` si sigue siendo necesaria en arquitectura OpenAI final |
| health + metadata de versión | `SHARED_DOMAIN`/infra neutral probable | posible `EXTRACT`, sólo si hay beneficio real |
| cadena `index-v5 → index-v4 → ...` | `LEGACY_COMPAT_REDESSIGN` | auditar; no replicar en Gemini |

---

# 4. Gemini Media Edge

## 4.1 Identidad del servicio

`apps/gemini-media-edge/package.json`:

```text
runtime       Node 24
entrypoint    src/server.mjs
transport     ws 8.21.3
E2E           test:e2e:cloud-run
```

No depende del paquete `openai`.

**Clasificación general:** `GEMINI_NATIVE`.

## 4.2 Componentes observados por estructura/nombres

El inventario de `src/` confirma al menos las siguientes áreas:

- `bootstrap.mjs`
- `caller-input-core.mjs`
- `caller-input.mjs`
- `control-sideband.mjs`
- `credential.mjs`
- además de tests específicos de overlap, sideband y bootstrap.

El script `check` del paquete confirma además:

- `diagnostic-journal.mjs`
- `google-speech.mjs`
- `playback.mjs`
- `live-provider-contract.mjs`
- `live-provider-contract-probe.mjs`
- `server.mjs`
- `runtime-core.mjs`
- `runtime.mjs`

### Clasificación preliminar por responsabilidad

| Pieza | Responsabilidad inferida/observada | Clasificación | Acción |
|---|---|---|---|
| `bootstrap.mjs` | bootstrap autorizado de sesión Gemini | `GEMINI_NATIVE` | `KEEP`, revisar qué parte debe venir del nuevo Gemini Worker |
| `caller-input-core.mjs` | owner/estado de candidatos de caller | `GEMINI_NATIVE` | `KEEP` como capacidad; evaluar si implementación actual sigue siendo óptima |
| `caller-input.mjs` | VAD/STT/input pipeline | `GEMINI_NATIVE` | `KEEP`/`INVESTIGATE` |
| `control-sideband.mjs` | canal de control Gemini Worker ↔ Media Edge actual | `GEMINI_NATIVE` pero contrato actual posiblemente `LEGACY_COMPAT_REDESSIGN` | `REWRITE` si el nuevo Worker permite contrato más directo |
| `credential.mjs` | autenticación/credenciales del edge | `GEMINI_NATIVE` | `KEEP` si cumple frontera final |
| `diagnostic-journal.mjs` | journal técnico del edge | `GEMINI_NATIVE` con contrato diagnóstico potencialmente compartido | `KEEP`; evaluar interfaz neutral de persistencia |
| `google-speech.mjs` | STT Google usado por Gemini path actual | `GEMINI_NATIVE` en topología actual | `INVESTIGATE` si sigue siendo necesario en diseño Gemini óptimo |
| `playback.mjs` | playback Telnyx/marks/clear | `GEMINI_NATIVE` | `KEEP` como capacidad; revisar diseño |
| `live-provider-contract*.mjs` | contrato/probe de Gemini Live | `GEMINI_NATIVE` | `KEEP` |
| `runtime-core.mjs` / `runtime.mjs` | orchestration principal Media Edge | `GEMINI_NATIVE` con posible deuda híbrida | auditoría profunda necesaria |
| `server.mjs` | servidor HTTP/WSS/health | `GEMINI_NATIVE` | `KEEP` sujeto a frontera final |

## 4.3 Evidencia histórica que debe conservarse como tests, no como arquitectura

Los tests actuales documentan fallos reales ya encontrados, entre ellos:

- overlap de fragmentos de caller;
- comandos sideband asíncronos;
- bootstrap;
- semantic continuation / preselection (por inspeccionar en detalle en siguiente bloque).

Estos tests son evidencia valiosa de comportamiento y carreras. **No implica que el nuevo producto Gemini tenga que conservar exactamente la misma estructura interna o el mismo sideband.**

---

# 5. Hallazgos arquitectónicos cerrados hasta ahora

## H1 — No existe Gemini Worker independiente

**Estado:** CONFIRMADO.

La lógica Gemini de control está parcialmente incrustada en `apps/control-plane`, mientras el transporte/audio está separado en `apps/gemini-media-edge`.

**Implicación:** la Fase 2 deberá diseñar explícitamente la frontera del nuevo Gemini Worker en lugar de renombrar el Worker actual.

## H2 — El Worker actual debe tender a OpenAI

**Estado:** CONFIRMADO.

Configuración, dependencia npm, webhook y modelo/voz demuestran una base OpenAI-first.

**Implicación:** se preservará como punto de partida del producto OpenAI, pero no se considerará automáticamente óptimo.

## H3 — Existe contaminación Gemini en el entrypoint productivo

**Estado:** CONFIRMADO.

El Worker principal conoce URL/token del Media Edge, admission Gemini y pull de diagnósticos Gemini.

**Implicación:** esas responsabilidades deberán migrar o rediseñarse en el Gemini Worker antes de limpiar OpenAI.

## H4 — El Media Edge Gemini ya posee bastante lógica de conversación, no sólo relay de bytes

**Estado:** CONFIRMADO POR ESTRUCTURA; detalle interno aún en auditoría.

VAD/STT, candidate ownership, semantic gate/preselection, playback, sideband, reconnect y runtime viven o han vivido en el Media Edge.

**Implicación:** durante Fase 2 habrá que decidir conscientemente qué debe permanecer en Media Edge y qué debe subir al Gemini Worker. No se asumirá que el reparto actual es óptimo.

## H5 — La separación operacional está parcialmente adelantada

**Estado:** CONFIRMADO.

Gemini Media Edge ya tiene CI, benchmark y canary deploy propios. Falta el equivalente para un Gemini Control Plane independiente.

---

# 6. Riesgos / deuda ya identificados

1. **Cadena histórica de entrypoints y CallSession Vx.** El Worker actual está compuesto mediante múltiples generaciones. Puede contener hardening útil, pero también compatibilidad acumulada. Se auditará antes de optimizar OpenAI.
2. **Sideband como frontera heredada.** El nuevo Worker Gemini podría simplificar el contrato con Media Edge; no preservar sideband por inercia.
3. **STT externo en Gemini.** `google-speech.mjs` existe y hoy aporta autoridad de transcript. Evaluar si sigue siendo la opción eficiente bajo el nuevo diseño.
4. **Dos rutas de voz actuales.** El sistema híbrido ha usado audio Gemini Live y governed speech/TTS; el producto Gemini final debe garantizar una sola identidad vocal.
5. **Diagnóstico pull al hangup.** Puede ser una solución de trazabilidad útil, pero añade acoplamiento Worker→Media Edge. Evaluar push/event stream/persistencia directa u otra frontera, sin decidir prematuramente.
6. **Tests pueden codificar arquitectura histórica.** Preservar comportamiento demostrado, no necesariamente wire, sideband o owners actuales.

---

# 7. Próximos bloques de inventario

## 7.1 Control Plane

Pendiente inspeccionar y clasificar por símbolos:

- cadena completa `index-v4` hacia abajo;
- `CallSession` V31–V54 y composición real final;
- `ResponseCoordinator` y response ownership;
- turn/concurrency/watchdogs;
- realtime provider registry/adapters;
- módulos Gemini dentro de `apps/control-plane/src`;
- ToolGateway;
- reservas/horarios/contact identity;
- Supabase adapters;
- seguridad;
- observabilidad;
- Telnyx neutral vs específico OpenAI/Gemini.

## 7.2 Gemini Media Edge

Pendiente inspeccionar en detalle:

- `runtime-core.mjs` / `runtime.mjs`;
- `control-sideband.mjs`;
- `semantic-preselection.mjs`;
- `semantic-tool-gate.mjs`;
- `playback.mjs`;
- `google-speech.mjs`;
- `server.mjs`;
- reconnect/session rotation;
- governed speech/TTS;
- ownership de herramientas y continuidad post-tool.

## 7.3 Dependencias y latencia

Pendiente construir el grafo causal de un turno real:

```text
Telnyx → Worker → Media Edge → STT/semantic → Worker → tool/domain/Supabase → Worker → Media Edge → Gemini/TTS → Telnyx
```

para determinar qué saltos son esenciales y cuáles existen sólo por compatibilidad histórica.

---

# 8. Registro de inventario

## 2026-08-26 — Bloque inicial

**Completado:**

- topología raíz y `apps/`;
- entrypoint y configuración física del Worker actual;
- dependencia runtime OpenAI del Control Plane;
- contaminación Gemini demostrada en `index-v6.ts`;
- carácter OpenAI-specific de `index-v5.ts`;
- identidad/package y superficie principal del Gemini Media Edge;
- workflows CI/deploy existentes.

**No se modificó runtime.**

**Siguiente acción exacta:** auditar componentes Gemini incrustados en `apps/control-plane/src` y la composición final de `CallSession`/response ownership, y completar el inventario con dependencias cruzadas antes de diseñar el nuevo Worker Gemini.
