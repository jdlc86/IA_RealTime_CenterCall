# Prompt de relevo — IA_RealTime_CenterCall

> Última revisión: 2026-08-26  
> Decisión vigente: [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> Plan vivo: [`OPENAI_GEMINI_SEPARATION_WORKPLAN.md`](./architecture/OPENAI_GEMINI_SEPARATION_WORKPLAN.md)

## INICIO DEL PROMPT

Continúa autónomamente el trabajo sobre `jdlc86/IA_RealTime_CenterCall` como Staff/Principal Engineer de sistemas realtime de voz.

### 1. Fuente de verdad y arranque obligatorio

```text
repo   jdlc86/IA_RealTime_CenterCall
rama   rebuild/v39-stable-baseline
PR     #85
base   main
```

Usa exclusivamente esa rama y PR. PR #85 debe permanecer OPEN y DRAFT. No crees ramas/PR, no merge, no ready-for-review, no force-push y no reescribas historia. Antes de escribir verifica HEAD remoto/PR/CI y si otra sesión publicó cambios.

Lee en este orden:

1. `docs/architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`
2. `docs/architecture/OPENAI_GEMINI_SEPARATION_WORKPLAN.md`
3. `docs/architecture/GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`
4. `docs/architecture/GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md`
5. `docs/architecture/GEMINI_CONTROL_CONTRACT_V1.md`
6. `docs/architecture/GEMINI_TRANSCRIPT_AUTHORITY_D1.md`
7. `docs/architecture/GEMINI_AUTHORIZATION_TRUST_D3_D5.md`
8. `docs/PROJECT_STATUS.md`
9. `docs/architecture/DESIGN_RULES.md`, interpretadas mediante ADR-003 si existe conflicto.

### 2. Paradigma aprobado

La arquitectura híbrida OpenAI/Gemini ya no es objetivo. Se construyen dos productos independientes:

```text
OPENAI PRODUCT                      GEMINI PRODUCT
OpenAI Worker                       Gemini Worker
OpenAI runtime                      GeminiCallSession DO
OpenAI lifecycle                    Gemini lifecycle propio
OpenAI tool flow                    shared ToolGateway/domain
OpenAI audio/voz                           │
       │                                   ▼
OpenAI Realtime                     Gemini Media Edge
                                            │
                                       Gemini Live
```

Supabase se comparte en esta fase. Gemini debe poder operar sin SDK/runtime/secretos/fallback OpenAI. OpenAI se limpiará después.

### 3. Reglas arquitectónicas que no puedes violar

1. Dos Workers/runtimes independientes.
2. No copiar `CallSession V2→V54`, `realtime-provider-runtime` ni sideband híbrido.
3. El código histórico no es especificación óptima.
4. Compartir sólo dominio/persistencia/seguridad/diagnóstico realmente neutrales.
5. One state owner per concern.
6. No timers/sleeps para ocultar ordering; usar identidad, sequence, ACK/NACK y estado persistente.
7. Gemini Live socket permanece en Media Edge; DO es autoridad control/business.
8. Tools requieren ToolGateway/capability/schema/business invariant/confirmación cuando aplique.
9. Session resumption es continuidad, nunca rollback de seguridad.
10. Output quarantine bloquea efectos/audio, pero no borra contexto ya enviado a Gemini.
11. Rejected context no terminal exige fresh provider session; resumption está prohibido.
12. Una sola identidad vocal Gemini Live; no volver silenciosamente a Google TTS.
13. Google STT v2 es transcript authority baseline inicial; Gemini input transcription es auxiliar hasta evidencia posterior.
14. No exponer secretos para probes.
15. Supabase único por ahora; no coexistencia/failover/N-Supabase sin ADR posterior.

### 4. Estado real alcanzado

Fases 0, 1 y **2 están COMPLETADAS**. **Fase 3 está ACTIVA.**

El nuevo paquete `apps/gemini-control-plane/` existe pero **NO recibe tráfico productivo**.

Implementado/validado:

- `gemini-control.v1`: envelope, payload validation, sequence, ACK/NACK, replay/SYNC contract;
- `GeminiCallSession` experimental DO + WebSocket Hibernation + SQLite sequence/idempotency;
- `TurnAuthorizationQuarantine` bounded en Media Edge, todavía aislada del runtime de llamadas;
- `planRejectedTurnRecovery` en Gemini Control Plane;
- CI independiente Gemini Control Plane;
- D2 real single-voice/control-speech capability;
- D1 transcript authority baseline;
- D3/D5 policies/test owners.

#### D1

Google Speech v2 permanece autoridad textual inicial. Datos reales últimos 7 días: 37 completados, p50 445 ms, p95 598.4 ms, avg 457.7 ms, min 324, max 648; 1 fallo y 3 empty. Gemini `inputAudioTranscription` no es autoridad porque la API la envía independientemente y sin ordering garantizado.

#### D2

Capability gate SHA `880e09b0203be5a009f7cb5b6491aa263e042ed6`.

Canary `Gemini Media Edge Canary Deploy` run #43 / id `32959778772`: SUCCESS. Final revision `gemini-media-edge-00073-qfk`, 100% traffic, image `sha256:c8ca1bf77b342755bfdfc0ec5be81d5813ff4ba34c13cdf33b76c5473181ee07`.

Prueba dos control turns en UNA sesión Live, voz `Kore` baseline, audio nativo + `turnComplete` en ambos. Esto demuestra capability, NO que las llamadas híbridas actuales ya usen una sola voz.

#### D3

`TurnAuthorizationQuarantine`:

- 128 KiB máximo ≈2.73 s PCM16/24 kHz;
- audio/tools retenidos antes de auth;
- authorize libera en orden;
- reject descarta;
- overflow fail closed → clean restart;
- no timers.

#### D4

DO probe: seq=1 ACK/APPLIED; reconnect+duplicate ACK/DUPLICATE; gap NACK/OUT_OF_ORDER. Estado crítico en SQLite.

#### D5

Terminal reject → terminate. Non-terminal rejected input que entró a Gemini → `CLEAN_RESTART_PROVIDER`, `allowSessionResumption=false`, fresh connection y `PROVIDER_RECONNECTED(mode=CLEAN_RESTART)` antes de LISTENING.

### 5. CI conocido

SHA de cierre Fase 2: `884209db652bd8e4d5fc8d61f5bc4583566e6e90`.

Todos SUCCESS:

- Control Plane CI run `32960868003`;
- Gemini Control Plane CI run `32960867952`;
- Gemini Media Edge CI run `32960868029`;
- Gemini Media Edge Benchmark CI run `32960867963`.

Gemini Control Plane CI ejecutó 16 tests reales: 12 contrato, 3 trust recovery, 1 DO/reconnect. La cobertura `src/**/*.test.ts` fue restaurada después de detectar que el primer config Vitest la había excluido accidentalmente.

### 6. Primera misión

**Fase 3A — consolidar `GeminiCallSession` y el contrato antes de cualquier tráfico.**

Primero:

1. definir direcciones estrictas `EDGE_TO_WORKER` y `WORKER_TO_EDGE` en `gemini-control.v1`;
2. hacer que el endpoint WSS del DO rechace mensajes Worker-only enviados por Edge;
3. crear lifecycle state owner pequeño (`CALL_BOOTSTRAP`, `LISTENING`, `CALLER_ACTIVE`, `TURN_GATING`, `TOOL_PENDING`, `ASSISTANT_ACTIVE`, `CLOSING`, `TERMINAL`);
4. persistir lifecycle/turn/provider epoch mínimo en SQLite;
5. validar state + identity antes de ACK `APPLIED`;
6. conservar sequence/idempotency/reconnect existentes;
7. añadir tests de invalid direction/state sin conectar Telnyx ni Media Edge real todavía.

Después avanzar a admission Telnyx Gemini no productivo.

### 7. Validación y comandos obligatorios

Para documentación/Control Plane:

```bash
npm run docs:check
npm test
npm run check
```

Para `apps/gemini-control-plane`, ejecutar `npm run check`/CI independiente. Para Media Edge, `npm run check` + `npm test`; canary sólo cuando el cambio lo requiera.

Distinguir siempre:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

### 8. Qué NO hacer ahora

- no conectar número productivo al nuevo Worker;
- no pedir llamada manual todavía;
- no retirar camino híbrido;
- no limpiar OpenAI todavía;
- no volver a semantic preselection híbrida;
- no declarar single-voice productivo sólo por D2;
- no introducir OpenAI SDK/secretos en `gemini-control-plane`.

### 9. Cierre de sesión

Antes de terminar:

1. actualizar `OPENAI_GEMINI_SEPARATION_WORKPLAN.md`;
2. actualizar este handoff si cambia misión;
3. registrar SHA/CI/deploy exactos;
4. dejar siguiente acción exacta;
5. mantener PR #85 OPEN/DRAFT.

## FIN DEL PROMPT
