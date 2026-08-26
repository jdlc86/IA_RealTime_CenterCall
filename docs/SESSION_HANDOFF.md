# Prompt de relevo — IA_RealTime_CenterCall

> Última revisión: 2026-08-26  
> Decisión vigente: [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> Plan vivo: [`OPENAI_GEMINI_SEPARATION_WORKPLAN.md`](./architecture/OPENAI_GEMINI_SEPARATION_WORKPLAN.md)

## INICIO DEL PROMPT

Continúa autónomamente el trabajo sobre `jdlc86/IA_RealTime_CenterCall` como Staff/Principal Engineer de sistemas realtime de voz.

### Reglas Git/GitHub

```text
repo   jdlc86/IA_RealTime_CenterCall
rama   rebuild/v39-stable-baseline
PR     #85
base   main
```

- usar una sola rama y un solo PR;
- PR #85 debe permanecer OPEN y DRAFT;
- no crear ramas/PR nuevos;
- no merge;
- no ready-for-review;
- no force-push ni reescritura de historia;
- antes de escribir verifica HEAD remoto y si otra sesión publicó cambios;
- no descartes cambios locales del usuario si existe checkout accesible.

### Fuente de verdad arquitectónica

Lee en este orden:

1. `docs/architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`
2. `docs/architecture/OPENAI_GEMINI_SEPARATION_WORKPLAN.md`
3. `docs/architecture/PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md`
4. `docs/architecture/GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`
5. `docs/architecture/GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md`
6. `docs/architecture/GEMINI_CONTROL_CONTRACT_V1.md`
7. `docs/PROJECT_STATUS.md`
8. `docs/architecture/DESIGN_RULES.md`, interpretadas a través de ADR-003 cuando exista conflicto.

### Paradigma aprobado

La arquitectura híbrida universal OpenAI/Gemini ya no es objetivo.

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

Supabase es compartido en esta fase. Compartir DB/dominio no implica compartir runtime conversacional.

Un cliente Gemini debe poder operar sin SDK, runtime, secretos ni fallback OpenAI. Un cliente OpenAI debe poder operar después sin runtime/secretos Gemini.

### Estado de fases

#### Fase 0

COMPLETADA — ADR/decisión/documentación.

#### Fase 1

COMPLETADA — inventario arquitectónico. No se modificó runtime.

Hallazgos centrales:

- Worker actual es OpenAI-first pero contiene contaminación Gemini sustancial;
- `realtime-provider-runtime`, selección multi-provider y sideband son `LEGACY_COMPAT_REDESSIGN`;
- Gemini Media Edge actual mezcla media + provider + STT + semantic preselection + governed TTS + provider rotation;
- ToolGateway, reservas, Supabase, seguridad y diagnóstico contienen piezas realmente compartibles;
- Google STT batch, semantic preselection aislada, doble voz y provider rotation post-tool añaden complejidad/latencia al camino híbrido.

#### Fase 2

ACTIVA.

Ya existe:

- `GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`;
- `GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md`;
- `GEMINI_CONTROL_CONTRACT_V1.md`;
- `apps/gemini-control-plane/package.json`;
- `apps/gemini-control-plane/tsconfig.json`;
- `apps/gemini-control-plane/src/control-contract/v1.ts`;
- `apps/gemini-control-plane/src/control-contract/v1.test.ts`;
- `.github/workflows/gemini-control-plane-ci.yml`.

El nuevo app todavía **NO tiene tráfico, webhook, Durable Object productivo ni deploy**.

El primer CI independiente Gemini Control Plane pasó typecheck + tests del contrato.

### Decisiones Fase 2 ya cerradas

1. Gemini Worker separado físicamente.
2. `GeminiCallSession` nuevo por composición; no copiar V2→V54.
3. Gemini Live socket permanece en Media Edge.
4. DO actúa como autoridad de control/business y servidor WSS hibernatable.
5. estado crítico del DO debe persistir/reconstruirse tras hibernación.
6. tool flow normal: tool call real → DO/ToolGateway → FunctionResponse mismo ID → continuación en la misma sesión Live.
7. no provider rotation después de tool en camino nuevo.
8. no isolated semantic preselection por defecto.
9. audio entra a Live inmediatamente; STT/security gate corre en paralelo inicialmente.
10. output quarantine bloquea audio/effects antes de autorización, pero **no borra contexto Gemini**.
11. session resumption sirve para recuperación de conexión; **no es rollback de seguridad**.
12. rechazo de seguridad terminal cierra la sesión contaminada. Rechazo no terminal requeriría sesión Live limpia desde trusted state.
13. una sola identidad vocal Gemini Live es requisito.
14. Google TTS no es fallback silencioso permitido.
15. control speech Gemini 3.1 debe probar realtime text (`sendRealtimeInput({text})`); no asumir `sendClientContent` después del primer turno.
16. Worker↔Edge usa `gemini-control.v1`, sequence, message IDs, command IDs, ACK/NACK y replay explícito.
17. una falla de comando no produce sticky poison global.
18. backend/business idempotency es distinta de transport idempotency.

### Contrato v1 ya implementado/testeado

`apps/gemini-control-plane/src/control-contract/v1.ts` implementa:

- protocolo/envelope v1;
- payload validation;
- límites bounded;
- binding por `call_session_id`;
- `APPLY / DUPLICATE / OUT_OF_ORDER`;
- ACK/NACK builders.

No introducir todavía OpenAI SDK, Telnyx, Supabase ni Gemini SDK en este núcleo puro.

### Primera misión actual

Cerrar los probes que aún bloquean Fase 2 antes de habilitar tráfico.

#### D2 — control speech Gemini-native

Objetivo: demostrar greeting/presence/recovery/handoff/terminal usando **la misma voz Live**.

- usar semántica Gemini 3.1 vigente;
- baseline a probar: realtime text `sendRealtimeInput({text})`;
- demostrar que no se registra como caller evidence;
- cualquier tool call durante control turn se rechaza fail-closed;
- siguiente caller turn debe funcionar naturalmente;
- no exponer `GEMINI_API_KEY` al workflow: ejecutar probe en superficie donde el secreto ya esté aislado (actualmente Cloud Run Media Edge tiene acceso al secreto mediante configuración GCP).

#### D4 — DO↔Edge WSS

Después de D2 o en paralelo si se mantiene aislado:

- crear `GeminiCallSession` DO de prueba/no productivo;
- Hibernation API;
- storage mínimo de sequence/idempotency/lifecycle;
- constructor recreation test;
- ACK/NACK/replay/SYNC;
- no sticky poison;
- medir p50/p95.

No conectar número productivo ni retirar el camino híbrido todavía.

### Reglas de seguridad/privacidad

- audio nunca cruza el control WSS;
- raw transcript/tool args pueden cruzar efímeramente cuando se necesitan para seguridad/ToolGateway, pero no se persisten/loguean raw;
- no persistir API keys, stream tokens, bootstrap credentials, resumption handles ni prompts completos;
- tools nunca ejecutan por el mero hecho de que Gemini las solicite;
- ToolGateway/tenant capability/schema/business invariant/confirmación siguen siendo autoridades.

### Qué NO hacer

- no arreglar G3/G4 del runtime híbrido por sí mismo;
- no seguir refinando semantic preselection híbrida;
- no copiar sideband actual;
- no copiar CallSession V2→V54;
- no desplegar todavía `gemini-control-plane` a producción;
- no limpiar OpenAI antes de que Gemini independiente esté probado;
- no introducir failover/coexistencia/N-Supabase ahora.

### Validación

Distinguir siempre:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

Tras cada commit verifica PR #85 y checks del SHA exacto. No declares CI verde sin comprobarlo.

### Cierre de sesión

Antes de terminar:

1. actualizar `OPENAI_GEMINI_SEPARATION_WORKPLAN.md`;
2. actualizar este handoff si cambia la siguiente misión;
3. registrar SHA exacto y CI;
4. dejar siguiente acción exacta;
5. mantener PR #85 OPEN/DRAFT.

## FIN DEL PROMPT
