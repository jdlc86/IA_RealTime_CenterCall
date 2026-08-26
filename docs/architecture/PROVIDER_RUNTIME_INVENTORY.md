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

`index-v6-runtime-core.ts` es una capa de composición histórica. `index-v5.ts` contiene flujo OpenAI real:

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
- response identities Gemini;
- `activityStart` / `activityEnd`;
- tool continuation automática/provider-owned;
- correlación de tool calls;
- adaptación de eventos Gemini.

**Clasificación:** `GEMINI_NATIVE`.

**Acción:** `MOVE` al producto Gemini. Revisar en Fase 2 si debe vivir en Gemini Worker o parcialmente en Media Edge.

## 4.2 Media Edge/control sideband dentro del Worker

Archivos demostrados incluyen admission, bootstrap, credentials, semantic decision, session contract, sideband connector/runtime, start authorization y Telnyx start authority.

`gemini-media-edge-sideband-runtime.ts` demuestra que el Control Plane actual:

- traduce tools al sideband;
- gobierna playback bind/drain/clear;
- envía `GOVERNED_SPEECH`;
- decide `CALLER_TURN_DECISION`;
- arma/libera semantic gate;
- controla input detection;
- mantiene identidad de caller/playback;
- contiene bypass determinista post-tool;
- reconstruye `GeminiLiveSessionRuntime` tras provider reset.

**Clasificación:** capacidad funcional `GEMINI_NATIVE`, pero el **contrato sideband actual es `LEGACY_COMPAT_REDESSIGN`** porque fue creado para conectar Gemini con el Control Plane híbrido.

**Acción:** preservar garantías/tests, rediseñar frontera Gemini Worker↔Media Edge.

## 4.3 Admission/provisioning Gemini

La composición actual valida provider affinity, traffic admission, `GEMINI_MEDIA_BRIDGE`, WSS, tenant/call binding y credenciales.

- invariantes de seguridad/admission: `GEMINI_NATIVE` valioso;
- selección multi-provider común: `LEGACY_COMPAT_REDESSIGN`.

**Acción:** `REWRITE` la composición en Gemini Worker preservando fail-closed y binding.

## 4.4 Caller input/barge-in/media Gemini en Control Plane

El árbol contiene además owners/adapters de barge-in, VAD, deferred transcription, Telnyx bridge, media contract, playback owner, streaming port y Google Speech adapter.

**Clasificación preliminar:** `GEMINI_NATIVE`. La ubicación final Worker vs Media Edge queda `UNRESOLVED` hasta diseñar el camino óptimo Gemini.

---

# 5. Abstracciones multi-provider que deben reevaluarse

## 5.1 `realtime-provider-runtime.ts`

Contiene:

- adapters OpenAI y runtime externo;
- `switch(provider)`;
- `this.provider === "GEMINI"`;
- `GEMINI_DETERMINISTIC_RESPONSE`;
- governed speech común;
- default-response replacement/defer;
- selección/admission/capabilities comunes;
- fallback de parsing a OpenAI wire.

**Clasificación:** `LEGACY_COMPAT_REDESSIGN`.

**Acción:** no compartir esta implementación entre productos. Extraer sólo invariantes realmente neutrales si la evidencia futura lo justifica.

## 5.2 `realtime-provider-call-session-composition.ts`

Hace `switch(selection.provider)`, conecta sideband Gemini y modifica `host.socket`; para OpenAI sólo bindea provider.

**Clasificación:** `LEGACY_COMPAT_REDESSIGN`.

**Acción:** `DELETE_LATER`/`REWRITE` después de separar productos.

## 5.3 `call-session-v49-provider-selection.ts`

Existe para seleccionar `OPENAI`/`GEMINI` dentro de la misma `CallSession`, con tenant/KV override, affinity, admission y sideband status.

**Clasificación:** `LEGACY_COMPAT_REDESSIGN`.

**Acción:** retirar del producto OpenAI tras separación. No copiar al Gemini Worker.

## 5.4 `realtime-provider-selector.ts`

Implementa `KV_OVERRIDE > TENANT_CONFIG > OPENAI default` dentro de una plataforma única.

**Clasificación:** `LEGACY_COMPAT_REDESSIGN` para runtime. Puede quedar algún concepto en provisioning futuro, pero no debe gobernar cada llamada dentro de los productos separados.

---

# 6. CallSession, response ownership y concurrencia

## 6.1 `CallSession V54`

La capa superior:

- consolida fragmentos de caller;
- gobierna confirmación explícita de cierre;
- mantiene contexto efectivo de turno;
- usa `realtime-provider-runtime` para hablar/crear continuación;
- delega al resto de la cadena V53→…

**Clasificación:** `LEGACY_COMPAT_REDESSIGN` como composición física. Las capacidades (split-turn consolidation, closing authority, redacción, lifecycle) se evalúan individualmente.

**Regla:** no copiar la herencia V2→V54 al Gemini Worker. Rescatar owners/invariantes demostrados y componer un runtime nuevo.

## 6.2 `response-coordinator.ts` / `realtime-response-owner.ts`

Invariantes potencialmente valiosas:

- una respuesta activa;
- identidad `responseId`;
- interrupción vs ignore;
- playback separado de generación;
- terminal absorbente;
- resolución por identidad, no timers.

La implementación está expresada alrededor de `response.create`/`response.cancel` y fue adaptada después a Gemini.

**Clasificación:** `UNRESOLVED`.

**Acción:** conservar tests/invariantes; no asumir implementación compartida.

## 6.3 `turn-concurrency-coordinator.ts`

Garantías útiles:

- un turno semántico activo;
- drop/bypass de overlap por identidad;
- watchdog fail-closed;
- no reabrir input mientras una operación pueda seguir en vuelo.

Acoplamientos actuales:

- llama `realtimeCommandPortFor(session).suspendInputDetection/restoreInputDetection/clearInput`;
- depende de lifecycle/turn ownership de la plataforma híbrida;
- tiene watchdog fijo de 30 s.

**Clasificación:** `UNRESOLVED`.

**Acción:** conservar la propiedad de exclusión como requisito. Diseñar implementaciones OpenAI/Gemini según lifecycle real de cada producto; evaluar si el watchdog común sigue teniendo sentido.

## 6.4 `turn-ownership-runtime.ts`

Owner mínimo de `semanticOwnerItemId`, sin SDK/wire/provider.

**Clasificación:** candidato `SHARED_DOMAIN`/shared conversational invariant, pero no se extrae todavía porque pertenece al plano de conversación, no al dominio empresarial.

**Acción:** `INVESTIGATE`; reutilizar sólo si ambos productos necesitan exactamente el mismo contrato.

---

# 7. OpenAI específico ya identificado

`openai-realtime-command-adapter.ts` traduce explícitamente a:

- `response.create` / `response.cancel`;
- `conversation.item.create/delete`;
- `function_call_output`;
- `session.update`;
- input/output buffer clear;
- server VAD OpenAI.

**Clasificación:** `OPENAI_NATIVE`.

**Acción:** `KEEP` en producto OpenAI y revisar en Fase 4 capas redundantes alrededor de él. No usar esta semántica como interfaz obligatoria de Gemini.

---

# 8. Dominio y persistencia compartibles

## 8.1 `tool-gateway.ts`

Conoce tenant, tool, allowlist, validación y ejecución; no SDK/wire realtime.

**Clasificación:** `SHARED_DOMAIN`.

**Acción:** `EXTRACT` como paquete compartido cuando comience separación física.

## 8.2 `restaurant-reservation-port.ts`

La capacidad de reservas es neutral, pero hoy instancia `SupabaseAdapter` leyendo `host.env`.

- contratos/operaciones: `SHARED_DOMAIN`;
- composición desde Worker host/env: `LEGACY_COMPAT_REDESSIGN`.

**Acción:** separar interfaz/runtime de negocio de creación del adapter.

## 8.3 `supabase-adapter.ts`

No depende de OpenAI/Gemini y encapsula REST/RPC de Supabase para estado empresarial/diagnóstico.

**Clasificación:** shared data adapter, actualmente monolítico.

**Acción:** conservar como base común; modularizar por dominio más adelante si reduce acoplamiento.

---

# 9. Gemini Media Edge externo: auditoría del núcleo

## 9.1 El Edge actual no es un relay mínimo

`runtime-core.mjs` mezcla:

- WebSocket Telnyx;
- WebSocket Gemini Live;
- credential/bootstrap;
- reorder de chunks;
- PCM/resampling 24→16 kHz;
- VAD/caller input;
- playback/mark/clear;
- semantic gate;
- governed TTS;
- deterministic post-tool continuation;
- reconnect/rotation de sesión Gemini;
- sideband control;
- diagnóstico.

**Clasificación:** conjunto `GEMINI_NATIVE`, pero con responsabilidades que deben redistribuirse.

**Acción Fase 2:** decidir qué necesita proximidad al audio (Media Edge) y qué debe ser orchestration del Gemini Worker.

## 9.2 STT actual

`caller-input.mjs` acumula un candidato de audio tras VAD y llama Google Speech v2 de forma autoritativa. `google-speech.mjs` hace un `recognize` REST completo con PCM16/16 kHz.

**Efecto en camino crítico:** después de terminar de hablar existe una llamada externa STT antes de que el turno pueda continuar.

**Clasificación:** `GEMINI_NATIVE` en arquitectura actual; necesidad futura `UNRESOLVED`.

**Acción:** benchmark/justificar frente a alternativas Gemini-native o streaming. No retirar sin conservar transcript authority/calidad.

## 9.3 Semantic preselection actual

`semantic-preselection.mjs` realiza una clasificación aislada para escoger una tool. Fuera de continuaciones deterministas, `isolated-decision.mjs` hace otra llamada REST a Gemini `generateContent` con un modelo separado.

**Efecto en camino crítico:** tras STT puede existir **una segunda inferencia externa** antes de entregar el turno a Gemini Live.

`semantic-tool-gate.mjs` compara luego esa selección con el tool call real de Gemini Live y falla cerrado ante conflicto/output prematuro.

**Clasificación:** garantías de autorización `GEMINI_NATIVE`; arquitectura de doble decisión `LEGACY_COMPAT_REDESSIGN`/`UNRESOLVED`.

**Acción:** preservar “una tool autorizada por turno” y fail-closed; reevaluar si hacen falta dos modelos/decisiones para conseguirlo.

## 9.4 Governed speech y dos voces

`server.mjs` crea `createGoogleTextToSpeechSynthesizer`, mientras las respuestas normales llegan como audio de Gemini Live.

**Estado:** causa arquitectónica de la identidad vocal doble CONFIRMADA POR CÓDIGO.

**Clasificación:** governed speech como capacidad actual `GEMINI_NATIVE`; estrategia de dos sintetizadores `LEGACY_COMPAT_REDESSIGN`.

**Acción:** producto Gemini final debe tener **una identidad vocal coherente por sesión**. La autoridad sobre qué texto puede decirse se separará del motor que lo renderiza.

## 9.5 Continuación post-tool actual

Para ciertas respuestas deterministas `runtime-core.mjs`:

1. resetea playback/resampler/semantic gate;
2. construye bootstrap con contexto de continuación;
3. cierra/reemplaza el socket Gemini;
4. abre una nueva sesión y reenvía `setup`;
5. emite `PROVIDER_SESSION_RESET` al Control Plane.

**Clasificación:** `LEGACY_COMPAT_REDESSIGN`.

**Acción:** no copiar al nuevo Gemini Worker sin demostrar que la rotación es realmente necesaria bajo una arquitectura Gemini-native.

---

# 10. Camino crítico actual de un turno Gemini

A partir de los contratos inspeccionados, el camino actual es conceptualmente:

```text
Caller/PSTN
  ↓
Telnyx Media Streaming
  ↓
Gemini Media Edge
  ├─ reorder / VAD
  ├─ buffer de candidato
  └─ Google Speech v2 REST            [salto externo 1]
       ↓ transcript
  ├─ isolated semantic preselection
  └─ Gemini generateContent REST      [salto externo 2, salvo continuación fijada]
       ↓ tool esperada
  ↓ sideband WSS
Cloudflare Control Plane / CallSession
  ├─ ownership / lifecycle / semantic gate authority
  ├─ tool execution
  └─ dominio / Supabase               [salto DB si aplica]
       ↓ tool result / decisión
  ↓ sideband WSS
Gemini Media Edge
  ├─ Gemini Live tool result/continuation
  │    o provider rotation si determinista
  ├─ Gemini Live audio                [voz Gemini]
  │    o Google TTS governed speech   [voz Google]
  └─ playback/mark/clear
       ↓
Telnyx → Caller
```

Este grafo explica por qué la arquitectura actual funciona pero tiene múltiples puntos de latencia, ownership y carrera.

### Objetivo de Fase 2

No optimizar por intuición. Para cada salto se decidirá:

- `ESSENTIAL`: requerido por telefonía/proveedor/seguridad/negocio;
- `KEEP_FOR_INVARIANT`: coste aceptado por una garantía demostrada;
- `REMOVE_OR_COLLAPSE`: existe por compatibilidad híbrida;
- `BENCHMARK`: falta evidencia de coste/beneficio.

---

# 11. Hallazgos cerrados

## H1 — No existe Gemini Worker independiente
**CONFIRMADO.** Debe diseñarse, no renombrarse el Worker actual.

## H2 — El Worker actual es OpenAI-first
**CONFIRMADO.** Debe convertirse en producto OpenAI limpio después de extraer Gemini.

## H3 — La contaminación Gemini dentro del Worker es sustancial
**CONFIRMADO.** Incluye session/runtime, admission/sideband, barge-in, media, VAD/STT, semantic decision y Telnyx bridge.

## H4 — Parte del “provider-neutral core” es compatibilidad híbrida
**CONFIRMADO.** Runtime, composition, selector y CallSession V49 contienen ramas/provider selection explícitas.

## H5 — Existe dominio realmente compartible
**CONFIRMADO.** `ToolGateway` es neutral; reservas/Supabase son compartibles tras limpiar composición.

## H6 — Response/turn ownership no debe declararse shared todavía
**CONFIRMADO.** Invariantes valiosas, implementación condicionada por lifecycle actual.

## H7 — El Media Edge está sobrecargado de orchestration
**CONFIRMADO.** No es sólo transporte/audio.

## H8 — STT + preselection añaden al menos dos decisiones/servicios previos a Gemini Live
**CONFIRMADO POR CÓDIGO.** Su necesidad se evaluará por evidencia, no se heredará automáticamente.

## H9 — La doble voz está codificada arquitectónicamente
**CONFIRMADO.** Gemini Live + Google TTS.

## H10 — La continuación determinista usa provider rotation
**CONFIRMADO.** Candidato fuerte a rediseño.

---

# 12. Estado de Fase 1

## 1A — Topología y entrypoints

- [x] apps/servicios principales enumerados.
- [x] Worker productivo actual y bindings principales identificados.
- [x] Gemini Media Edge identificado como servicio separado.
- [x] pipelines CI/deploy principales identificados.

## 1B — Worker / Control Plane

- [x] entrypoint/configuración OpenAI-first identificados.
- [x] superficie Gemini localizada.
- [x] provider selection/composition híbridos clasificados.
- [x] adapter OpenAI representativo clasificado.
- [x] CallSession superior y relación con runtime híbrido auditadas a nivel suficiente para no reutilizar la herencia.
- [x] turn concurrency/turn ownership inspeccionados y clasificados provisionalmente.
- [ ] seguridad/diagnóstico/Telnyx neutral vs específico auditados.
- [x] `ToolGateway` clasificado.
- [x] reservas/Supabase clasificados.

## 1C — Gemini Media Edge

- [x] superficie principal identificada.
- [x] `runtime-core.mjs` auditado en camino crítico.
- [x] semantic preselection/tool gate auditados.
- [x] Google STT y governed TTS auditados.
- [ ] playback/reconnect restantes y servidor/registry revisados para ownership final.

## 1D — Clasificación/dependencias

- [x] dependencias cruzadas principales Worker↔Gemini demostradas.
- [x] abstracciones híbridas principales marcadas `LEGACY_COMPAT_REDESSIGN`.
- [x] ejemplos sólidos de `OPENAI_NATIVE`, `GEMINI_NATIVE` y `SHARED_DOMAIN` demostrados.
- [x] grafo conceptual del camino crítico actual construido.
- [ ] clasificar cada salto como esencial/garantía/eliminable/benchmark.
- [ ] cerrar piezas `UNRESOLVED` suficientes para comenzar Fase 2.

---

# 13. Registro de trabajo

## 2026-08-26 — Bloque 1: topología

Apps, entrypoints, configuración Worker, Media Edge, workflows y contaminación Gemini en `index-v6.ts`. Sin cambios runtime.

## 2026-08-26 — Bloque 2: frontera de runtime

- `realtime-provider-runtime` demostrado híbrido;
- CallSession V49/selector/composition marcados para rediseño/retirada;
- Gemini Live runtime identificado como Gemini nativo;
- sideband actual identificado como contrato heredado;
- adapter OpenAI identificado como OpenAI nativo;
- ToolGateway/reservas/Supabase confirman frontera compartible;
- ResponseCoordinator queda `UNRESOLVED`.

## 2026-08-26 — Bloque 3: camino crítico Gemini

- auditado TurnConcurrency/TurnOwnership;
- auditada composición superior CallSession V54;
- auditado núcleo del Media Edge;
- confirmado STT Google batch antes de Live;
- confirmada preselección mediante inferencia Gemini aislada adicional;
- confirmado Google TTS para governed speech y Gemini Live para audio normal;
- confirmada rotación de sesión Gemini en continuación determinista;
- construido grafo del camino crítico actual.

**No se modificó runtime.**

**Siguiente acción exacta:** clasificar los saltos del camino crítico (`ESSENTIAL` / `KEEP_FOR_INVARIANT` / `REMOVE_OR_COLLAPSE` / `BENCHMARK`), revisar seguridad/diagnóstico/Telnyx compartible y cerrar Fase 1 antes de diseñar el Gemini Worker.
