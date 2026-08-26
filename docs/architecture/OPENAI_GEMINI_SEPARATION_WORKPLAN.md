# Plan de trabajo — separación OpenAI / Gemini

> **Estado:** ACTIVO  
> **Fecha de inicio:** 2026-08-26  
> **ADR autoridad:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Rama única:** `rebuild/v39-stable-baseline`  
> **PR único:** `#85`

## Objetivo

Transformar la integración híbrida actual en **dos productos realtime independientes y eficientes**:

- OpenAI Worker/runtime optimizado para OpenAI Realtime;
- Gemini Worker/runtime optimizado para Gemini Live;
- Gemini Media Edge específico de Gemini;
- Supabase y contratos de dominio realmente neutrales compartidos en esta fase;
- sin obligación de coexistencia simultánea para un mismo cliente;
- sin failover OpenAI↔Gemini dentro de una llamada.

El código existente es evidencia histórica y funcional, **no especificación arquitectónica**.

## Arquitectura objetivo

```text
                         SUPABASE COMPARTIDO
                         negocio + persistencia
                               ▲       ▲
                               │       │
                  contratos shared realmente neutrales
                         ▲             ▲
                         │             │
              ┌──────────┘             └──────────┐
              │                                   │
     OPENAI PRODUCT                      GEMINI PRODUCT
     --------------                      --------------
     OpenAI Worker                       Gemini Worker
     OpenAI runtime                      GeminiCallSession DO
     OpenAI lifecycle                    Gemini lifecycle propio
     OpenAI tool flow                    ToolGateway/domain shared
     OpenAI audio/voz                         │
              │                               ▼
       OpenAI Realtime                  Gemini Media Edge
                                              │
                                         Gemini Live
```

## Reglas de refactorización

1. Usar exclusivamente `rebuild/v39-stable-baseline` y PR #85.
2. PR #85 permanece OPEN y DRAFT; no merge, ready, force-push ni historia reescrita.
3. No seguir arreglando el camino híbrido salvo bloqueo de la separación o código que vaya a sobrevivir.
4. No copiar automáticamente `CallSession`, `ResponseCoordinator`, `realtime-provider-runtime` ni sideband actuales al nuevo Gemini Worker.
5. OpenAI actual tampoco se considera automáticamente óptimo; se limpiará después de estabilizar Gemini independiente.
6. Compartir dominio/persistencia, no orchestration conversacional por obligación.
7. Supabase permanece único en esta fase.
8. No introducir N bases, coexistencia o failover ahora.
9. One state owner per concern.
10. No usar timers/sleeps para ocultar ordering; usar identidad, ACK, estados y evidencia.
11. No exponer secretos para facilitar probes. Los probes deben ejecutarse donde el secreto ya está correctamente aislado.
12. Cada sesión actualiza este plan/relevo antes de cerrar.

---

# Fases y progreso

## Fase 0 — Decisión y documentación

**Estado:** COMPLETADA.

- [x] ADR-003 creado.
- [x] Dos productos realtime independientes aprobados.
- [x] Dos Workers separados fijados como dirección.
- [x] Gemini Media Edge conservado como servicio Gemini.
- [x] Supabase compartido en esta fase.
- [x] Futura N-Supabase reconocida como evolución posterior.
- [x] Limpieza posterior de OpenAI incluida.
- [x] `PROJECT_STATUS.md` / `SESSION_HANDOFF.md` orientados al nuevo paradigma.

---

## Fase 1 — Inventario arquitectónico

**Estado:** COMPLETADA.

**Entregables:**

- [`PROVIDER_RUNTIME_INVENTORY.md`](./PROVIDER_RUNTIME_INVENTORY.md)
- [`PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md`](./PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md)

**Cierre demostrado:**

- [x] Worker actual identificado como OpenAI-first con contaminación Gemini.
- [x] superficie Gemini dentro de `apps/control-plane` clasificada.
- [x] Gemini Media Edge auditado.
- [x] camino crítico actual reconstruido.
- [x] STT Google batch, semantic preselection aislada, doble voz, provider rotation post-tool y sideband sticky identificados.
- [x] ToolGateway / reservas / Supabase / seguridad / diagnóstico clasificados.
- [x] OpenAI-native vs Gemini-native vs legacy compatibility separados conceptualmente.
- [x] no se modificó runtime en Fase 1.

---

## Fase 2 — Diseño y contratos del Gemini independiente

**Estado:** ACTIVA — D2 y D4 demostrados; D1/D3/D5 pendientes.

### 2A — Diseño de producto

- [x] Topología Gemini Worker + `GeminiCallSession` DO + Gemini Media Edge + Gemini Live definida.
- [x] ownership Worker/DO/Edge definido.
- [x] Gemini Live conserva su propia semántica; no imita OpenAI.
- [x] tool flow same-session mediante FunctionResponse definido.
- [x] provider rotation post-tool eliminado del diseño nuevo.
- [x] semantic preselection aislada eliminada como requisito por defecto.
- [x] audio entra a Live en tiempo real; STT/security pasa a gate paralelo inicialmente.
- [x] single-voice Gemini Live definido como requisito arquitectónico.
- [x] VAD/manual activity baseline definido en Media Edge.
- [x] session resumption/GoAway definido como recuperación de conexión, no como lifecycle de negocio.
- [x] shared packages por dependency injection definidos.
- [x] secretos Gemini separados de OpenAI en diseño.
- [x] CI/E2E Gemini independientes definidos conceptualmente.

**Documento:** [`GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`](./GEMINI_INDEPENDENT_RUNTIME_DESIGN.md)

### 2B — Revisión contra APIs actuales

- [x] diseño contrastado con Gemini Live vigente y Cloudflare DO/WebSockets.
- [x] DO WebSocket Hibernation aceptado como servidor de control.
- [x] estado crítico del DO obligado a sobrevivir hibernación/reconstrucción.
- [x] session resumption declarado explícitamente **no rollback de seguridad**.
- [x] output quarantine redefinido: bloquea efectos/audio, no borra contexto Gemini.
- [x] rejected-turn trust recovery definido como requisito.
- [x] control speech actualizado a semántica Gemini 3.1 vigente (`sendRealtimeInput({text})`).
- [x] ACK/NACK explícito añadido para efectos Worker↔Edge.
- [x] tool/business idempotency separada de transport idempotency.

**Documento:** [`GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md`](./GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md)

### 2C — Control Contract v1

- [x] protocolo `gemini-control.v1` definido.
- [x] envelope, identities y sequence definidos.
- [x] ACK/NACK definidos.
- [x] Edge→Worker events definidos.
- [x] Worker→Edge commands definidos.
- [x] replay/reconnect/SYNC definidos.
- [x] límites bounded iniciales definidos.
- [x] estado mínimo persistente del DO definido.
- [x] invariantes de lifecycle/identity definidos.
- [x] política sensitive payload transient definida.

**Documento:** [`GEMINI_CONTROL_CONTRACT_V1.md`](./GEMINI_CONTROL_CONTRACT_V1.md)

### 2D — Implementación contract-first sin tráfico

- [x] creado `apps/gemini-control-plane/` como paquete independiente.
- [x] no tiene OpenAI SDK ni runtime dependency.
- [x] creado `src/control-contract/v1.ts`.
- [x] parser/validator de envelope implementado.
- [x] validación de payloads v1 implementada.
- [x] decisión `APPLY / DUPLICATE / OUT_OF_ORDER` implementada.
- [x] builders ACK/NACK implementados.
- [x] tests de versión/binding/sequence/duplicate/ACK/NACK/payload limits añadidos.
- [x] workflow `Gemini Control Plane CI` independiente creado.
- [x] `GeminiCallSession` experimental creado como Durable Object sin tráfico productivo.
- [x] SQLite del DO persiste sequence/idempotency.
- [x] WebSocket Hibernation API usada en el probe.
- [x] test Cloudflare runtime verifica reconnect + duplicate + out-of-order.
- [ ] añadir lockfile y cambiar CI a `npm ci` cuando se fijen dependencias del skeleton.

### 2E — Probes obligatorios antes de declarar diseño cerrado

#### D1 — Transcript authority

**Estado:** PENDIENTE / SIGUIENTE ACCIÓN.

- [ ] comparar Google STT batch actual vs Gemini input transcription vs alternativa streaming si aporta valor.
- [ ] medir EOS→transcript p50/p95, calidad telefonía/español, split-turn, coste y ordering/finality.
- [ ] decidir baseline de Fase 3 sin retirar Google STT por hipótesis.

#### D2 — Control speech Gemini-native

**Estado:** PROBADO.

- [x] dos control turns se envían mediante realtime text en UNA sesión Live.
- [x] voz prebuilt única configurada (`Kore` por defecto).
- [x] ambos turnos exigen audio nativo y `turnComplete`.
- [x] tool call inesperado falla cerrado.
- [x] turno sin audio falla cerrado.
- [x] secreto permanece dentro de Cloud Run; no se expone a GitHub Actions.
- [x] startup del Media Edge se bloquea si el probe real falla.
- [x] canary real desplegado sólo después de que el probe pasara.

**Evidencia:**

- capability/startup SHA `880e09b0203be5a009f7cb5b6491aa263e042ed6`;
- `Gemini Media Edge Canary Deploy` run #43 / id `32959778772`: SUCCESS;
- final revision `gemini-media-edge-00073-qfk` sirviendo 100%;
- image `sha256:c8ca1bf77b342755bfdfc0ec5be81d5813ff4ba34c13cdf33b76c5473181ee07`;
- 148 Media Edge tests, 0 fallos;
- deployed E2E/readiness: SUCCESS.

**Límite de la evidencia:** demuestra capacidad para la arquitectura nueva; las llamadas productivas siguen usando el camino híbrido actual y todavía no deben declararse single-voice.

#### D3 — Authorization/output quarantine

**Estado:** PENDIENTE.

- [ ] medir `activityEnd → TURN_AUTHORIZED` p50/p95.
- [ ] medir bytes PCM quarantined y output/tool temprano.
- [ ] fijar límite y policy fail-closed por evidencia.

#### D4 — DO↔Edge WSS

**Estado:** PROBADO para persistencia/secuencia/reconnect; latencia p50/p95 queda para benchmark posterior.

- [x] `GeminiCallSession` DO experimental creado.
- [x] Hibernation API usada para control WebSocket.
- [x] sequence/idempotency persistidos en SQLite, no sólo memoria.
- [x] seq=1 → ACK `APPLIED`.
- [x] reconexión + mismo seq/message → ACK `DUPLICATE_ALREADY_APPLIED`.
- [x] gap seq=3 esperando 2 → NACK `OUT_OF_ORDER_SEQUENCE` retryable.
- [x] no se introduce sticky poison global.
- [ ] medir latencia p50/p95 cuando exista Edge↔DO integration probe real.

**Evidencia:** HEAD `be98a465ed1eb1ff22f6c6b2374c9f1406c7a563`; `Gemini Control Plane CI` run id `32959979617`: SUCCESS.

#### D5 — Rejected-turn trust recovery

**Estado:** PENDIENTE.

- [ ] rechazo terminal: sin output/tool effect y cierre limpio.
- [ ] si se habilita rechazo no terminal: nueva sesión limpia desde trusted state.
- [ ] demostrar que contenido rechazado no reaparece en contexto reconstruido.

### Criterio de salida Fase 2

Fase 2 podrá marcarse COMPLETADA cuando:

- [x] arquitectura/owners estén definidos;
- [x] contrato v1 esté definido e implementado/testeado inicialmente;
- [x] no exista dependencia conceptual OpenAI en el nuevo Gemini Worker;
- [x] D2 tenga mecanismo exacto probado contra Gemini Live real;
- [x] D4 valide el modelo DO control WSS/sequence/reconnect;
- [x] límites/ACK/replay v1 básicos estén ratificados por tests;
- [x] primera construcción de `GeminiCallSession` esté definida e iniciada sin tráfico;
- [ ] D1 tenga baseline decidido;
- [ ] D3 tenga límites/policy de quarantine definidos;
- [ ] D5 tenga política de trust recovery demostrable.

No habilitar tráfico productivo del nuevo camino antes de este criterio.

---

## Fase 3 — Construcción y migración Gemini

**Estado:** BLOQUEADA por D1/D3/D5 de Fase 2.

Orden previsto:

1. consolidar `GeminiCallSession` + storage/control contract.
2. admission Telnyx Gemini sin número productivo.
3. Edge↔DO contract v1 detrás de camino no productivo.
4. tool call → ToolGateway → FunctionResponse same-session.
5. output quarantine + caller security gate.
6. rejected-turn trust recovery.
7. single-voice control turns en el nuevo runtime.
8. D1 transcript authority final/baseline.
9. E2E sintético completo.
10. canary Gemini manual sólo tras SHA/CI/deploy/E2E verificados.
11. retirar camino Gemini híbrido sólo después del canary exitoso.

**Criterio de salida:** producto Gemini autónomo sin runtime/credenciales OpenAI.

---

## Fase 4 — Limpieza y optimización OpenAI

**Estado:** BLOQUEADA hasta Gemini independiente probado.

- [ ] retirar Gemini sideband/bootstrap/bindings/branches del Worker OpenAI.
- [ ] retirar secretos/configuración Gemini.
- [ ] reevaluar coordinadores/owners creados por compatibilidad histórica.
- [ ] simplificar OpenAI según OpenAI Realtime real.
- [ ] conservar hardening general útil.
- [ ] E2E OpenAI completo sin runtime Gemini.

---

## Fase 5 — Separación operacional

- [ ] CI/deploy OpenAI independientes.
- [x] CI Gemini Control Plane independiente para contrato/DO probe.
- [ ] CI/deploy Gemini completos e independientes.
- [ ] secretos/bindings segregados.
- [ ] health/readiness/runbooks separados.
- [ ] diagnóstico Supabase identifica producto/runtime/deployment.

---

## Fase 6 — Evolución futura (fuera de alcance actual)

- [ ] coexistencia simultánea por cliente sólo si aparece requisito.
- [ ] failover/provider selection sólo mediante ADR posterior.
- [ ] N proyectos/bases Supabase con los mismos contratos.
- [ ] provisioning/comercialización automatizados.

---

# Registro de trabajo

## 2026-08-26 — Cambio de paradigma

- dos productos / dos Workers aprobados;
- Supabase compartido;
- runtime híbrido deja de ser objetivo.

## 2026-08-26 — Fase 1 cerrada

- inventario y camino crítico documentados;
- no se modificó runtime.

## 2026-08-26 — Fase 2: diseño, contrato y probes D2/D4

- diseño/revisión/contrato v1 documentados;
- creado `apps/gemini-control-plane` sin tráfico;
- implementado contrato puro v1 y CI independiente;
- D2 single-voice/control-speech capability demostrada contra Gemini Live real en Cloud Run canary;
- D4 Durable Object sequence/reconnect/idempotency demostrado en Cloudflare Vitest runtime;
- Control Plane CI de `be98a465...` falló exclusivamente porque `SESSION_HANDOFF.md` había perdido encabezados/comandos literales exigidos por `docs:check`; el relevo fue corregido en el commit documental siguiente.

**Siguiente acción exacta:** ejecutar D1 — comparar transcript authority (Google STT batch vs Gemini Live input transcription y sólo si procede una opción streaming), decidir baseline de Fase 3; después cerrar D3/D5 antes de habilitar tráfico real del nuevo Gemini Worker.

## Relevo entre sesiones

1. verificar HEAD remoto, PR #85 y CI real;
2. leer ADR-003 y este plan;
3. leer diseño + revisión + contrato v1;
4. inspeccionar `apps/gemini-control-plane` y probes Media Edge;
5. continuar desde D1;
6. actualizar este documento y `docs/SESSION_HANDOFF.md` antes de cerrar.
