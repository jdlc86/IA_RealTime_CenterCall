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
3. `docs/architecture/PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md`
4. `docs/architecture/GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`
5. `docs/architecture/GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md`
6. `docs/architecture/GEMINI_CONTROL_CONTRACT_V1.md`
7. `docs/PROJECT_STATUS.md`
8. `docs/architecture/DESIGN_RULES.md`, interpretadas mediante ADR-003 si existe conflicto.

### 2. Paradigma aprobado

La arquitectura híbrida OpenAI/Gemini ya no es el objetivo. Se construyen dos productos independientes:

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

Supabase se comparte en esta fase. Compartir DB/dominio no significa compartir orchestration conversacional. Gemini debe poder operar sin SDK/runtime/secretos/fallback OpenAI; OpenAI se limpiará después para operar sin runtime/secretos Gemini.

### 3. Reglas arquitectónicas que no puedes violar

1. Dos Workers/runtimes independientes.
2. No copiar `CallSession V2→V54`, `realtime-provider-runtime` ni sideband híbrido al nuevo Gemini.
3. El código actual es evidencia histórica, no especificación óptima.
4. Compartir sólo dominio/persistencia/seguridad/diagnóstico realmente neutrales.
5. One state owner per concern.
6. No timers/sleeps para ocultar ordering; usar identidad, sequence, ACK/NACK y estado persistente.
7. Gemini Live socket permanece en Media Edge; el DO es autoridad de control/business.
8. Tool effects requieren ToolGateway/capability/schema/business invariant/confirmación cuando aplique.
9. Session resumption es continuidad de conexión, no rollback de seguridad.
10. Output quarantine puede bloquear efectos/audio, pero no elimina contexto ya enviado a Gemini.
11. Un turno rechazado que contaminó contexto requiere trust recovery explícito; no continuar como si nada.
12. Una sola identidad vocal Gemini Live es requisito; no volver silenciosamente a Google TTS.
13. No exponer secretos para probes; ejecutar probes donde el secreto ya esté aislado.
14. Supabase único por ahora; no introducir coexistencia/failover/N-Supabase sin ADR posterior.

### 4. Estado real alcanzado

Fase 0 y Fase 1 están COMPLETADAS. Fase 2 está ACTIVA.

Ya existe el nuevo paquete independiente `apps/gemini-control-plane/` y NO recibe tráfico productivo.

Implementado y validado:

- `gemini-control.v1`: envelope, binding, sequence, payload validation, `APPLY/DUPLICATE/OUT_OF_ORDER`, ACK/NACK;
- CI independiente `Gemini Control Plane CI`;
- `GeminiCallSession` experimental como Durable Object con WebSocket Hibernation + SQLite para sequence/idempotency;
- probe D2 de control speech Gemini-native;
- startup gate del Media Edge que impide readiness si D2 real falla.

#### D2 — PROBADO CON GEMINI LIVE REAL

Commit de capability gate: `880e09b0203be5a009f7cb5b6491aa263e042ed6`.

El probe abre UNA sesión Gemini Live, configura una voz prebuilt (`Kore` por defecto), envía dos control turns por realtime text, y exige audio nativo + `turnComplete` en ambos. Falla cerrado ante tool call inesperado o turno sin audio.

Canary real:

- workflow `Gemini Media Edge Canary Deploy` run #43, id `32959778772`: SUCCESS;
- final Cloud Run revision: `gemini-media-edge-00073-qfk`;
- 100% traffic;
- image digest `sha256:c8ca1bf77b342755bfdfc0ec5be81d5813ff4ba34c13cdf33b76c5473181ee07`;
- 148 Media Edge tests, 0 fail;
- deployed E2E/readiness: SUCCESS.

Interpretación correcta: **la capacidad de una sola voz/control speech está demostrada**, pero el camino productivo de llamadas sigue siendo el runtime híbrido actual. No declarar todavía resuelto el cambio de voz en llamadas reales.

#### D4 — PROBADO EN RUNTIME CLOUDFLARE

HEAD probado: `be98a465ed1eb1ff22f6c6b2374c9f1406c7a563`.

`GeminiCallSession` experimental persiste en SQLite:

- inbound/outbound sequence;
- applied message IDs.

Test real con `@cloudflare/vitest-plugin`:

1. seq=1 → ACK `APPLIED`;
2. cerrar/reconectar mismo DO;
3. repetir seq=1/message ID → ACK `DUPLICATE_ALREADY_APPLIED`;
4. enviar seq=3 cuando espera seq=2 → NACK `OUT_OF_ORDER_SEQUENCE`.

`Gemini Control Plane CI` run id `32959979617`: SUCCESS.

### 5. Estado de CI conocido

Para HEAD `be98a465ed1eb1ff22f6c6b2374c9f1406c7a563`:

- Gemini Control Plane CI: SUCCESS;
- Gemini Media Edge CI: SUCCESS;
- Gemini Media Edge Benchmark CI: SUCCESS;
- Control Plane CI: FAILURE **sólo por contrato documental obsoleto del propio handoff**; este documento restaura los encabezados/comandos exigidos y debe revalidarse en el siguiente SHA.

No interpretes ese fallo documental como regresión runtime OpenAI.

### 6. Primera misión

La siguiente decisión de Fase 2 es **D1 — transcript authority**.

Comparar por evidencia:

1. Google Speech batch actual;
2. Gemini Live `inputAudioTranscription`;
3. alternativa streaming sólo si aporta una ventaja clara.

Medir/razonar:

- end-of-speech → transcript ready p50/p95;
- calidad en español/telefonía;
- finality/ordering;
- split utterances;
- coste;
- utilidad real para caller security/tool authorization.

No retires Google STT aún. El objetivo es decidir el baseline de Fase 3.

Después cerrar D3/D5:

- output quarantine bounded;
- policy de trust recovery para turnos rechazados;
- demostrar que contenido rechazado no reaparece en contexto reconstruido.

No conectar aún número productivo al nuevo Gemini Worker.

### 7. Validación y comandos obligatorios

Para documentación/Control Plane:

```bash
npm run docs:check
npm test
npm run check
```

Ejecutarlos desde `apps/control-plane` cuando corresponda.

Para `apps/gemini-control-plane`, ejecutar su `npm run check`/CI independiente. Para Media Edge, mantener `npm run check`, `npm test` y canary sólo cuando el cambio lo requiera.

Distinguir siempre:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

### 8. Qué NO hacer ahora

- no arreglar G3/G4 híbrido por sí mismo;
- no refinar semantic preselection híbrida;
- no copiar sideband actual;
- no limpiar OpenAI antes de probar Gemini independiente;
- no declarar una sola voz en llamadas productivas sólo porque D2 esté demostrado;
- no pedir una llamada manual hasta que el nuevo camino Gemini esté realmente desplegado, sirviendo y validado.

### 9. Cierre de sesión

Antes de terminar:

1. actualizar `OPENAI_GEMINI_SEPARATION_WORKPLAN.md`;
2. actualizar este handoff si cambia la siguiente misión;
3. registrar SHA/CI/deploy exactos;
4. dejar siguiente acción exacta;
5. mantener PR #85 OPEN/DRAFT.

## FIN DEL PROMPT
