# Inventario de runtime — separación OpenAI / Gemini

> **Estado:** ACTIVO / EN PROGRESO  
> **Fecha:** 2026-08-26  
> **Autoridad:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Plan:** [`OPENAI_GEMINI_SEPARATION_WORKPLAN.md`](./OPENAI_GEMINI_SEPARATION_WORKPLAN.md)  
> **Rama:** `rebuild/v39-stable-baseline`  
> **PR:** `#85`

## 1. Objetivo y método

Este inventario precede cualquier separación física de runtime. El código actual es **evidencia histórica y funcional, no especificación arquitectónica**. No se asume que una pieza deba conservarse por estar hoy en el Worker principal, ni que el diseño actual sea óptimo para OpenAI.

Clasificaciones:

- `SHARED_DOMAIN` — dominio/persistencia/contrato neutral al proveedor.
- `OPENAI_NATIVE` — comportamiento/runtime específico de OpenAI.
- `GEMINI_NATIVE` — comportamiento/runtime específico de Gemini.
- `LEGACY_COMPAT_REDESSIGN` — compatibilidad histórica o abstracción creada para convivencia que debe reevaluarse.
- `UNRESOLVED` — evidencia insuficiente.

Acciones: `KEEP`, `MOVE`, `EXTRACT`, `REWRITE`, `DELETE_LATER`, `INVESTIGATE`.

Para cada pieza relevante se evalúan responsabilidad, owner de estado, dependencias, proveedor de origen, camino crítico, tests y acción futura.

---

# 2. Topología física actual

## 2.1 Apps

```text
apps/
  control-plane/
  gemini-media-edge/
  gemini-media-edge-benchmark/
```

**No existe todavía un Gemini Control Plane Worker independiente.**

| Ruta | Clasificación | Acción |
|---|---|---|
| `apps/control-plane/` | producto físico OpenAI-first contaminado por Gemini + compatibilidad | conservar como base OpenAI; separar Gemini y auditar legacy |
| `apps/gemini-media-edge/` | `GEMINI_NATIVE` | `KEEP`; revisar reparto Worker↔Edge |
| `apps/gemini-media-edge-benchmark/` | `GEMINI_NATIVE` | `KEEP` mientras aporte evidencia de rendimiento |

## 2.2 CI/deploy

Existen:

```text
.github/workflows/control-plane-ci.yml
.github/workflows/gemini-media-edge-ci.yml
.github/workflows/gemini-media-edge-benchmark-ci.yml
.github/workflows/gemini-media-edge-canary-deploy.yml
```

El Media Edge Gemini ya tiene CI/benchmark/canary propios. Falta CI/deploy para un Gemini Worker independiente. `control-plane-ci.yml` deberá tender a ser CI del producto OpenAI, extrayendo sólo checks realmente compartidos.

---

# 3. Producto OpenAI actual: identidad y contaminación

## 3.1 Configuración física

`apps/control-plane/wrangler.jsonc` demuestra una base OpenAI-first:

```text
Worker             ia-realtime-centercall
entrypoint         src/index-v6.ts
REALTIME_MODEL     gpt-realtime
REALTIME_VOICE     marin
OPENAI_PROJECT_ID  configurado
Durable Object     CALL_SESSIONS → CallSession
```

`apps/control-plane/package.json` depende de `openai` y no de un SDK Gemini.

**Conclusión:** este Worker debe evolucionar hacia el **producto OpenAI independiente**. No será el Worker Gemini final.

## 3.2 `src/index-v6.ts`

El entrypoint productivo conoce directamente Gemini:

- `GEMINI_MEDIA_EDGE_URL`;
- `MEDIA_EDGE_CONTROL_PLANE_TOKEN`;
- `GeminiAdmissionResponse`;
- `start_gemini_media_stream`;
- `GEMINI_ADMISSION_COMPLETED`;
- `/internal/diagnostics` del Media Edge;
- pull de diagnósticos Gemini al `call.hangup`.

| Responsabilidad | Clasificación | Acción |
|---|---|---|
| integración/admission Media Edge | `GEMINI_NATIVE` | `MOVE`/`REWRITE` en Gemini Worker |
| token/URL Media Edge | `GEMINI_NATIVE` | `MOVE` |
| pull de diagnóstico Gemini al hangup | `GEMINI_NATIVE` + acoplamiento actual | reevaluar contrato; no preservar por inercia |
| consumo de seguridad | probable `SHARED_DOMAIN`/infra | `INVESTIGATE` para extracción neutral |
| persistencia diagnóstica | compartible como contrato | separar de mecanismo Gemini concreto |

**Dependencia crítica:** el Worker OpenAI-first necesita hoy conocer infraestructura Gemini. Esta dependencia debe desaparecer antes de declarar autónomo el producto OpenAI.

## 3.3 `index-v6-runtime-core.ts` / `index-v5.ts`

`index-v6-runtime-core.ts` es una capa de composición histórica que delega a generaciones anteriores. `index-v5.ts` contiene flujo OpenAI real:

- `/webhooks/openai`;
- `realtime.call.incoming`;
- correlación SIP OpenAI↔Telnyx;
- handoff transport context;
- health/version metadata.

Clasificación:

- webhook/eventos/correlación SIP: `OPENAI_NATIVE`, `KEEP` sujeto a simplificación posterior;
- cadena `index-v6 → v5 → v4 → ...`: `LEGACY_COMPAT_REDESSIGN`; **no copiar al Gemini Worker**.

---

# 4. Superficie Gemini dentro de `apps/control-plane/src`

La contaminación no se limita al entrypoint. El árbol contiene una implementación Gemini extensa.

## 4.1 Gemini Live/session

Archivos demostrados:

```text
gemini-live-command-adapter.ts
gemini-live-event-adapter.ts
gemini-live-session-owner.ts
gemini-live-session-runtime.ts
gemini-live-websocket-connector.ts
gemini-live-caller-activity-owner.ts
```

`gemini-live-session-runtime.ts` posee semántica Gemini real:

- setup inmutable;
- owner de lifecycle Gemini;
- estados y response identities Gemini;
- `activityStart` / `activityEnd`;
- tool continuation automática/provider-owned;
- correlación de tool calls;
- adaptación de eventos Gemini.

**Clasificación:** `GEMINI_NATIVE`.

**Acción:** `MOVE` al producto Gemini. Revisar en Fase 2 si debe vivir en Gemini Worker o parcialmente en Media Edge; no mantenerlo dentro del producto OpenAI.

## 4.2 Gemini Media Edge/control sideband dentro del Worker

Archivos demostrados incluyen:

```text
gemini-media-edge-admission-composition.ts
gemini-media-edge-bootstrap-registration.ts
gemini-media-edge-caller-turn-disposition.ts
gemini-media-edge-credential-consumption.ts
gemini-media-edge-hmac-credential-issuer.ts
gemini-media-edge-inbound-admission.ts
gemini-media-edge-isolated-generation.ts
gemini-media-edge-semantic-decision.ts
gemini-media-edge-session-contract.ts
gemini-media-edge-sideband-connector.ts
gemini-media-edge-sideband-runtime.ts
gemini-media-edge-start-authorization.ts
gemini-media-edge-telnyx-start-authority.ts
```

`gemini-media-edge-sideband-runtime.ts` demuestra que el Control Plane actual:

- traduce tools al sideband;
- gobierna `PLAYBACK_BINDING`, `PLAYBACK_DRAIN`, `PLAYBACK_CLEAR`;
- envía `GOVERNED_SPEECH`;
- decide `CALLER_TURN_DECISION`;
- arma/libera semantic gate;
- controla input detection;
- mantiene identidad de caller/playback;
- contiene bypass determinista post-tool;
- reconstruye `GeminiLiveSessionRuntime` tras provider reset.

**Clasificación:** capacidad funcional `GEMINI_NATIVE`, pero el **contrato sideband actual es `LEGACY_COMPAT_REDESSIGN`** porque fue creado para conectar Gemini con el Control Plane híbrido.

**Acción:** conservar comportamiento probado como requisitos/tests, pero rediseñar la frontera Gemini Worker↔Media Edge desde la arquitectura nueva.

## 4.3 Admission/provisioning Gemini

`gemini-media-edge-admission-composition.ts` valida:

- provider affinity `GEMINI`;
- traffic admission;
- `GEMINI_MEDIA_BRIDGE`;
- WSS obligatorio;
- tenant/call binding;
- credential issuance antes de streaming.

La seguridad y fail-closed son invariantes valiosos, pero la dependencia de `RealtimeProviderSelection`/selector común proviene de la convivencia actual.

**Clasificación:**

- invariantes de seguridad/admission: `GEMINI_NATIVE` valioso;
- selección multi-provider común: `LEGACY_COMPAT_REDESSIGN`.

**Acción:** `REWRITE` la composición en Gemini Worker preservando las garantías.

## 4.4 Caller input/barge-in/media Gemini en Control Plane

El árbol contiene además:

```text
gemini-authorized-barge-in-commit-adapter.ts
gemini-authorized-barge-in-effect-runtime.ts
gemini-deferred-barge-in-acoustic-runtime.ts
gemini-deferred-barge-in-candidate-owner.ts
gemini-deferred-barge-in-transcription-runtime.ts
gemini-normal-caller-turn-commit-adapter.ts
gemini-telnyx-acoustic-vad.ts
gemini-telnyx-deferred-input-coordinator.ts
gemini-inbound-media-transport.ts
gemini-telnyx-media-bridge.ts
gemini-telnyx-media-contract.ts
gemini-telnyx-playback-owner.ts
gemini-telnyx-session-bridge.ts
telnyx-gemini-media-stream-owner.ts
telnyx-gemini-streaming-port.ts
google-cloud-speech-v2-transcription-adapter.ts
```

**Clasificación preliminar:** `GEMINI_NATIVE`. La ubicación final Worker vs Media Edge queda `UNRESOLVED` hasta diseñar el camino óptimo Gemini.

No se trasladarán mecánicamente: algunas responsabilidades pueden estar duplicadas con `apps/gemini-media-edge` o existir por restricciones del modelo híbrido.

---

# 5. Abstracciones multi-provider que deben reevaluarse

## 5.1 `realtime-provider-runtime.ts`

Esta clase se presentó como neutral, pero contiene acoplamiento de convivencia:

- imports de adapters OpenAI y runtime externo;
- `switch(provider)` con `OPENAI`/`GEMINI`;
- `this.provider === "GEMINI"`;
- `GEMINI_DETERMINISTIC_RESPONSE`;
- governed speech común;
- default-response replacement/defer;
- selección/admission/capabilities comunes;
- fallback de parsing a OpenAI wire.

**Clasificación:** `LEGACY_COMPAT_REDESSIGN`.

**Acción:** no compartir esta implementación entre los dos productos. Extraer más adelante sólo tipos/invariantes que demuestren neutralidad real.

## 5.2 `realtime-provider-call-session-composition.ts`

Hace `switch(selection.provider)`, conecta sideband Gemini y modifica `host.socket`; para OpenAI sólo bindea el provider.

**Clasificación:** `LEGACY_COMPAT_REDESSIGN`.

**Acción:** `DELETE_LATER`/`REWRITE` después de separar productos. El Gemini Worker compondrá Gemini directamente; OpenAI no necesitará decidir Gemini.

## 5.3 `call-session-v49-provider-selection.ts`

Esta generación existe para seleccionar `OPENAI`/`GEMINI` dentro de la misma `CallSession`, con tenant/KV override, affinity, admission y estado sideband.

**Clasificación:** `LEGACY_COMPAT_REDESSIGN`.

**Acción:** retirar del producto OpenAI cuando la separación esté probada. No copiar al Gemini Worker. La elección de producto/deployment debe ocurrir antes del runtime conversacional.

## 5.4 `realtime-provider-selector.ts`

Implementa `KV_OVERRIDE > TENANT_CONFIG > OPENAI default` para elegir provider dentro de la plataforma única.

**Clasificación bajo ADR-003:** `LEGACY_COMPAT_REDESSIGN` para el runtime. Puede quedar algún concepto de configuración/provisioning futuro, pero no debe gobernar llamadas dentro de cada producto independiente.

---

# 6. Response ownership: no clasificar prematuramente como shared

## 6.1 `response-coordinator.ts` / `realtime-response-owner.ts`

Aspectos valiosos y potencialmente neutrales:

- una respuesta activa;
- identidad `responseId`;
- interrupción vs ignore;
- playback separado de generación;
- terminal absorbente;
- resolución por identidad, no por timers.

Sin embargo, la especificación actual está expresada alrededor de `response.create`, `response.cancel` y una semántica de liberación de respuesta que nació en OpenAI y luego se intentó mapear a Gemini.

**Clasificación actual:** `UNRESOLVED`.

**Acción:** conservar tests/invariantes como referencia; en Fase 2 diseñar Gemini desde su lifecycle nativo. Sólo extraer un coordinator compartido si ambos productos terminan demostrando la misma máquina de estados, no antes.

---

# 7. OpenAI específico ya identificado

`openai-realtime-command-adapter.ts` traduce explícitamente a:

- `response.create`;
- `response.cancel`;
- `conversation.item.create/delete`;
- `function_call_output`;
- `session.update`;
- `input_audio_buffer.clear`;
- `output_audio_buffer.clear`;
- server VAD OpenAI.

**Clasificación:** `OPENAI_NATIVE`.

**Acción:** `KEEP` en producto OpenAI y revisar en Fase 4 si existen capas redundantes alrededor de él. No usar esta semántica como interfaz obligatoria de Gemini.

---

# 8. Dominio y persistencia compartibles

## 8.1 `tool-gateway.ts`

Conoce tenant, nombre de tool, allowlist, validación y ejecución. No importa SDK/wire OpenAI o Gemini.

**Clasificación:** `SHARED_DOMAIN`.

**Acción:** `EXTRACT` como paquete compartido cuando comience la separación física.

## 8.2 `restaurant-reservation-port.ts`

La capacidad de reservas es proveedor-neutral, pero la composición actual instancia directamente `SupabaseAdapter` leyendo `host.env`.

**Clasificación:**

- contratos/operaciones de reserva: `SHARED_DOMAIN`;
- construcción desde Worker host/env: `LEGACY_COMPAT_REDESSIGN` de composición.

**Acción:** separar interfaz/runtime de negocio de la creación del adapter para que OpenAI Worker y Gemini Worker inyecten la misma implementación de persistencia.

## 8.3 `supabase-adapter.ts`

No depende de OpenAI/Gemini y encapsula REST/RPC de Supabase para servicios, horarios, reservas, diagnóstico, etc.

**Clasificación:** shared data adapter, actualmente monolítico.

**Acción:** conservar como base compartida; más adelante modularizar por dominio si reduce acoplamiento. No duplicar Supabase por proveedor en esta fase.

---

# 9. Gemini Media Edge externo

`apps/gemini-media-edge` es `GEMINI_NATIVE` y ya posee, entre otros:

- bootstrap;
- caller input owner;
- VAD/STT pipeline;
- control sideband;
- credential validation;
- diagnostic journal;
- Google Speech;
- playback/mark/clear;
- Gemini Live contract/probe;
- runtime/server;
- reconnect/session rotation;
- semantic preselection/tool gate.

**Hallazgo:** el Media Edge actual no es un relay mínimo; ya posee bastante orchestration conversacional.

**Implicación:** Fase 2 debe decidir explícitamente qué ownership queda en Gemini Worker y cuál en Media Edge. No se asumirá que el reparto actual es óptimo.

Los tests de carreras reales (reconnect, split caller fragments, semantic continuation, sideband) se preservarán como **evidencia de comportamiento**, no como obligación de conservar el wire/arquitectura actual.

---

# 10. Hallazgos cerrados

## H1 — No existe Gemini Worker independiente
**CONFIRMADO.** Debe diseñarse, no renombrarse el Worker actual.

## H2 — El Worker actual es OpenAI-first
**CONFIRMADO.** Debe convertirse en producto OpenAI limpio después de extraer Gemini.

## H3 — La contaminación Gemini dentro del Worker es sustancial
**CONFIRMADO.** Incluye session/runtime, Media Edge admission/sideband, barge-in, media, VAD/STT, semantic decision y Telnyx bridge; no sólo ramas puntuales.

## H4 — Parte del “provider-neutral core” es compatibilidad híbrida
**CONFIRMADO.** `realtime-provider-runtime`, composition, selector y CallSession V49 contienen ramas/provider selection explícitas. No deben convertirse automáticamente en base común futura.

## H5 — Existe dominio realmente compartible
**CONFIRMADO.** `ToolGateway` es neutral; reservas y Supabase son compartibles tras limpiar composición/configuración.

## H6 — Response ownership aún no está resuelto como shared vs específico
**CONFIRMADO COMO PENDIENTE.** Sus invariantes son valiosas, pero la implementación actual está condicionada por semántica OpenAI. No compartir preventivamente.

## H7 — La separación operacional está parcialmente adelantada
**CONFIRMADO.** Media Edge tiene CI/deploy propios; falta Gemini Worker y su pipeline.

---

# 11. Deuda/riesgos

1. Cadena histórica `index-v*` / `CallSession V2…V54`: puede esconder compatibilidad acumulada; auditar antes de optimizar OpenAI.
2. Sideband actual: preservar garantías, no necesariamente protocolo/ubicación.
3. Google STT en Gemini: reevaluar coste/latencia/necesidad en diseño nativo.
4. Dos rutas de voz actuales: producto Gemini final debe garantizar una identidad vocal única.
5. Pull de diagnósticos al hangup: acoplamiento Worker→Edge; reevaluar.
6. Tests pueden fijar arquitectura histórica: conservar comportamiento, no wire.
7. `SupabaseAdapter` y reservation port son compartibles pero necesitan composición limpia para dos Workers.
8. No duplicar automáticamente coordinadores del Worker actual en el Gemini Worker.

---

# 12. Estado de Fase 1

## 1A — Topología y entrypoints

- [x] apps/servicios principales enumerados.
- [x] Worker productivo actual y bindings principales identificados.
- [x] Gemini Media Edge identificado como servicio separado.
- [x] pipelines CI/deploy principales identificados.

## 1B — Worker / Control Plane

- [x] entrypoint/configuración OpenAI-first identificados.
- [x] superficie Gemini dentro de `apps/control-plane/src` localizada.
- [x] provider selection/composition híbridos clasificados.
- [x] adapter OpenAI representativo clasificado.
- [ ] cadena completa de `CallSession` y capas Vx auditada.
- [ ] turn/concurrency/watchdogs auditados.
- [ ] seguridad/diagnóstico/Telnyx neutral vs específico auditados.
- [x] `ToolGateway` representativo clasificado.
- [x] reservas/Supabase representativos clasificados.

## 1C — Gemini Media Edge

- [x] superficie principal identificada.
- [ ] `runtime-core.mjs`/`runtime.mjs` auditados en profundidad.
- [ ] `semantic-preselection.mjs`/`semantic-tool-gate.mjs` auditados.
- [ ] playback/Google STT/reconnect/governed speech auditados.

## 1D — Clasificación/dependencias

- [x] dependencias cruzadas principales Worker↔Gemini demostradas.
- [x] abstracciones multi-provider híbridas principales marcadas `LEGACY_COMPAT_REDESSIGN`.
- [x] ejemplos sólidos de `OPENAI_NATIVE`, `GEMINI_NATIVE` y `SHARED_DOMAIN` demostrados.
- [ ] grafo de camino crítico y latencia de un turno completo.
- [ ] inventario final de piezas `UNRESOLVED` antes de Fase 2.

---

# 13. Registro de trabajo

## 2026-08-26 — Bloque 1: topología

Completado: apps, entrypoints, configuración Worker, Media Edge, workflows y contaminación Gemini en `index-v6.ts`. No se modificó runtime.

## 2026-08-26 — Bloque 2: frontera de runtime

Completado:

- se demostró que `realtime-provider-runtime.ts` mezcla semántica OpenAI/Gemini y es compatibilidad híbrida;
- `CallSession V49` y provider selector/composition quedan marcados para rediseño/retirada;
- `GeminiLiveSessionRuntime` queda identificado como Gemini nativo;
- sideband Gemini actual queda identificado como capacidad Gemini con contrato heredado;
- `OpenAIRealtimeCommandAdapter` queda identificado como OpenAI nativo;
- `ToolGateway`, reservas y Supabase confirman una frontera de negocio/persistencia compartible;
- `ResponseCoordinator` queda `UNRESOLVED` en lugar de asumir neutralidad.

**No se modificó runtime.**

**Siguiente acción exacta:** auditar `CallSession`/turn-concurrency y el núcleo del Gemini Media Edge; después construir el grafo de camino crítico de un turno para cuantificar qué saltos desaparecerían con el Gemini Worker independiente.
