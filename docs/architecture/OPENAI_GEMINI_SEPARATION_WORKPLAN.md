# Plan de trabajo — separación OpenAI / Gemini

> **Estado:** ACTIVO  
> **Fecha de inicio:** 2026-08-26  
> **ADR autoridad:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Rama única:** `rebuild/v39-stable-baseline`  
> **PR único:** `#85`

## Objetivo

Dos productos realtime independientes y eficientes:

- OpenAI Worker/runtime optimizado para OpenAI Realtime;
- Gemini Worker/runtime optimizado para Gemini Live;
- Gemini Media Edge específico de Gemini;
- Supabase y contratos de dominio realmente neutrales compartidos en esta fase;
- sin coexistencia/failover obligatorios para un mismo cliente.

El código existente es evidencia histórica, **no especificación arquitectónica**.

## Arquitectura objetivo

```text
                         SUPABASE COMPARTIDO
                         negocio + persistencia
                               ▲       ▲
                               │       │
                    contratos shared neutrales
                         ▲             ▲
                         │             │
              ┌──────────┘             └──────────┐
              │                                   │
     OPENAI PRODUCT                      GEMINI PRODUCT
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

## Reglas permanentes

1. Usar exclusivamente `rebuild/v39-stable-baseline` y PR #85.
2. PR #85 permanece OPEN/DRAFT; no merge, ready, force-push ni reescritura.
3. No seguir parcheando el camino híbrido salvo bloqueo de separación/código superviviente.
4. No copiar `CallSession V2→V54`, `realtime-provider-runtime` ni sideband híbrido al nuevo Gemini.
5. Compartir dominio/persistencia/seguridad/diagnóstico cuando sean realmente neutrales; no orchestration por obligación.
6. One state owner per concern.
7. No timers para ocultar ordering; usar identidad/sequence/ACK/estado.
8. No exponer secretos para probes.
9. Supabase único ahora; N-Supabase/coexistencia/failover quedan fuera de alcance actual.

---

# Fases y progreso

## Fase 0 — Decisión y documentación

**Estado:** COMPLETADA.

- [x] ADR-003.
- [x] dos productos/dos Workers.
- [x] Supabase compartido en esta fase.
- [x] futura limpieza OpenAI y futura N-Supabase reconocidas.

## Fase 1 — Inventario arquitectónico

**Estado:** COMPLETADA.

Entregables:

- [`PROVIDER_RUNTIME_INVENTORY.md`](./PROVIDER_RUNTIME_INVENTORY.md)
- [`PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md`](./PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md)

- [x] Worker OpenAI-first y contaminación Gemini identificados.
- [x] Gemini Media Edge auditado.
- [x] camino crítico y capas legacy clasificadas.
- [x] shared domain/persistencia/seguridad/diagnóstico identificados.
- [x] no se modificó runtime durante inventario.

## Fase 2 — Diseño y contratos del Gemini independiente

**Estado:** COMPLETADA.

Documentos:

- [`GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`](./GEMINI_INDEPENDENT_RUNTIME_DESIGN.md)
- [`GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md`](./GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md)
- [`GEMINI_CONTROL_CONTRACT_V1.md`](./GEMINI_CONTROL_CONTRACT_V1.md)
- [`GEMINI_TRANSCRIPT_AUTHORITY_D1.md`](./GEMINI_TRANSCRIPT_AUTHORITY_D1.md)
- [`GEMINI_AUTHORIZATION_TRUST_D3_D5.md`](./GEMINI_AUTHORIZATION_TRUST_D3_D5.md)

### Diseño/contrato

- [x] Gemini Worker + `GeminiCallSession` DO + Media Edge + Gemini Live.
- [x] ownership Worker/DO/Edge explícito.
- [x] tool flow same-session con FunctionResponse.
- [x] provider rotation post-tool eliminado del diseño nuevo.
- [x] semantic preselection aislada eliminada por defecto.
- [x] VAD/manual activity baseline en Edge.
- [x] session resumption = continuidad, no rollback/trust recovery.
- [x] single-voice Gemini Live como requisito.
- [x] `gemini-control.v1` con identity/sequence/ACK/NACK/replay/SYNC.
- [x] transport idempotency separada de business idempotency.

### D1 — Transcript authority

**Estado:** BASELINE DECIDIDO.

- [x] Google Speech v2 permanece autoridad inicial para seguridad/tool gating.
- [x] Gemini `inputAudioTranscription` queda auxiliar/no autoritativa: la API la entrega independientemente y sin ordering garantizado.
- [x] audio entra a Gemini Live en paralelo; STT no bloquea ingestión del provider.
- [x] Supabase real, últimos 7 días: 37 completados, p50 445 ms, p95 598.4 ms, avg 457.7 ms, min 324, max 648; 1 fallo y 3 empty.
- [x] A/B de calidad/WER diferido a dark probe efímero de Fase 3, sin almacenar audio/raw transcript adicional.

### D2 — Control speech / single voice

**Estado:** PROBADO CONTRA GEMINI LIVE REAL.

- [x] dos control turns en UNA sesión Live vía realtime text.
- [x] voz prebuilt única (`Kore` baseline).
- [x] audio nativo + `turnComplete` obligatorio en ambos.
- [x] unexpected tool / no-audio fail closed.
- [x] API key permanece aislada dentro de Cloud Run.

Evidencia:

- SHA capability gate `880e09b0203be5a009f7cb5b6491aa263e042ed6`;
- Canary Deploy run #43 / `32959778772`: SUCCESS;
- revision `gemini-media-edge-00073-qfk`, 100% traffic;
- image `sha256:c8ca1bf77b342755bfdfc0ec5be81d5813ff4ba34c13cdf33b76c5473181ee07`;
- 148 Media Edge tests, 0 fallos; deployed E2E/readiness SUCCESS.

Límite: demuestra capacidad para el runtime nuevo; el camino híbrido productivo todavía no es single-voice.

### D3 — Authorization/output quarantine

**Estado:** BASELINE DEFINIDO + OWNER/TESTS PUROS.

- [x] `TurnAuthorizationQuarantine` creado en Media Edge, aún no conectado a llamadas.
- [x] no timers; identity-driven.
- [x] audio y tool calls quedan retenidos antes de `TURN_AUTHORIZED`.
- [x] límite inicial `128 KiB` ≈ 2.73 s de PCM16/24 kHz (~4.5× p95 STT observado).
- [x] overflow → fail closed / `CLEAN_RESTART_REQUIRED`.
- [x] rechazo descarta audio/tools; no release parcial.
- [x] Media Edge CI valida tests/build Docker.
- [ ] high-water p50/p95/p99 del camino integrado se mide en Fase 3 antes de tráfico real.

### D4 — Durable Object/control WSS

**Estado:** PROBADO EN CLOUDFLARE TEST RUNTIME.

- [x] `GeminiCallSession` experimental.
- [x] Hibernation API.
- [x] sequence/idempotency persistidos en SQLite.
- [x] seq=1 → ACK `APPLIED`.
- [x] reconnect + duplicate → ACK `DUPLICATE_ALREADY_APPLIED`.
- [x] gap → NACK `OUT_OF_ORDER_SEQUENCE` retryable.
- [x] sin sticky poison global.

Evidencia inicial: `be98a465...`, Gemini Control Plane CI `32959979617` SUCCESS. Cobertura posterior restaurada y CI ejecuta contrato + trust recovery + DO.

### D5 — Rejected-turn trust recovery

**Estado:** BASELINE DEFINIDO + TESTS PUROS.

- [x] terminal rejection → terminate, nunca resumption.
- [x] non-terminal rejection cuyo input entró a Gemini → fresh provider session.
- [x] `allowSessionResumption=false` en trust recovery.
- [x] trusted bootstrap no incluye rejected transcript/output/tool call/resumption handle contaminado.
- [x] `PROVIDER_RECONNECTED(mode=CLEAN_RESTART)` requerido antes de volver a LISTENING.
- [ ] E2E con marcador efímero se ejecuta en Fase 3 antes de tráfico real.

### Cierre Fase 2

- [x] arquitectura/owners definidos.
- [x] contrato v1 definido e implementado/testeado inicialmente.
- [x] no dependencia conceptual OpenAI en nuevo Gemini Worker.
- [x] D1 baseline decidido.
- [x] D2 probado real.
- [x] D3 límite/policy definidos.
- [x] D4 control DO/reconnect demostrado.
- [x] D5 trust recovery definido/testeado.
- [x] CI del SHA `884209db652bd8e4d5fc8d61f5bc4583566e6e90`: Control Plane, Gemini Control Plane, Gemini Media Edge y Benchmark SUCCESS.

**Criterio de salida Fase 2: CUMPLIDO.**

---

## Fase 3 — Construcción y migración Gemini

**Estado:** ACTIVA.

No habilitar número/tráfico productivo hasta superar los gates E2E/canary definidos abajo.

### 3A — Consolidar `GeminiCallSession` y contrato

- [ ] separar explícitamente direcciones `EDGE_TO_WORKER` / `WORKER_TO_EDGE`; un Edge no puede enviar comandos de Worker.
- [ ] lifecycle state owner pequeño, sin herencia V2→V54.
- [ ] persistir lifecycle/turn/provider epoch necesarios en DO.
- [ ] validar eventos por estado + identidad antes de ACK `APPLIED`.
- [ ] SYNC/replay real tras reconnect.
- [ ] conservar ACK/NACK/idempotency SQLite.

### 3B — Admission Telnyx Gemini sin número productivo

- [ ] webhook/admission propio Gemini.
- [ ] caller security pre-call shared.
- [ ] credencial efímera call↔Edge.
- [ ] answer/streaming_start Gemini-native.
- [ ] sin OpenAI SDK/secret/config.

### 3C — Edge↔DO no productivo

- [ ] conectar `gemini-control.v1` detrás de endpoint/flag no productivo.
- [ ] medir RTT p50/p95/p99.
- [ ] medir reconnect/SYNC/replay.
- [ ] medir quarantine high-water.

### 3D — Tools/business

- [ ] Gemini tool call → DO → ToolGateway → shared domain/Supabase.
- [ ] FunctionResponse mismo ID en misma sesión Live.
- [ ] progressive reservation + outside-hours + BOOKED.
- [ ] cero tool effect antes de auth.

### 3E — Trust/audio

- [ ] integrar quarantine.
- [ ] integrar Google STT authority en paralelo.
- [ ] integrar clean restart para rejected context.
- [ ] integrar single-voice control turns.
- [ ] dark transcript benchmark opcional/efímero.

### 3F — E2E/canary antes de tráfico

- [ ] greeting single voice.
- [ ] conversación simple.
- [ ] reserva multi-turno.
- [ ] outside-hours → alternativa → continuación.
- [ ] booking real confirmado backend.
- [ ] tool rejection.
- [ ] barge-in.
- [ ] split utterance.
- [ ] GoAway/resumption normal.
- [ ] rejected-turn clean restart sin contexto contaminado.
- [ ] control WSS reconnect.
- [ ] hangup/handoff.
- [ ] diagnóstico cross-plane sin audio/PII/secrets.
- [ ] ausencia de OpenAI runtime/secretos.

**Criterio de salida:** Gemini autónomo, probado y desplegable sin OpenAI. Sólo después retirar el camino Gemini híbrido.

---

## Fase 4 — Limpieza/optimización OpenAI

**Estado:** BLOQUEADA hasta Gemini independiente probado.

- [ ] retirar Gemini sideband/bootstrap/bindings/branches.
- [ ] retirar secretos/config Gemini.
- [ ] reevaluar capas legacy de compatibilidad.
- [ ] simplificar según OpenAI Realtime real.
- [ ] conservar hardening general.
- [ ] E2E OpenAI sin runtime Gemini.

## Fase 5 — Separación operacional

- [x] CI básico Gemini Control Plane independiente.
- [ ] CI/deploy Gemini completos.
- [ ] CI/deploy OpenAI independientes tras limpieza.
- [ ] secretos/bindings segregados.
- [ ] health/readiness/runbooks separados.
- [ ] diagnóstico identifica producto/runtime/deployment.

## Fase 6 — Futuro fuera de alcance

- [ ] coexistencia simultánea sólo si aparece requisito.
- [ ] failover/provider selection por ADR posterior.
- [ ] N Supabase con mismos contratos.
- [ ] provisioning/comercialización automatizados.

---

# Registro de trabajo

## 2026-08-26 — Fase 0/1

- cambio de paradigma aprobado;
- inventario cerrado sin modificar runtime.

## 2026-08-26 — Fase 2 cerrada

- diseño/contrato v1 creados;
- `apps/gemini-control-plane` creado sin tráfico;
- D1 Google STT authority baseline decidido con datos reales;
- D2 single-voice/control-speech capability probada en Gemini Live real;
- D3 quarantine bounded implementada/testeada en aislamiento;
- D4 Durable Object sequence/reconnect probado;
- D5 clean trust recovery definido/testeado;
- cobertura de Vitest corregida: contrato + lifecycle + DO vuelven a ejecutarse;
- SHA `884209db652bd8e4d5fc8d61f5bc4583566e6e90`: cuatro pipelines principales SUCCESS.

**Siguiente acción exacta:** Fase 3A — hacer que `GeminiCallSession` valide dirección y lifecycle de eventos antes de aplicarlos/ACK, manteniendo el nuevo camino completamente sin tráfico productivo.
