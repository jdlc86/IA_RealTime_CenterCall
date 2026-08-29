# Prompt de relevo — IA_RealTime_CenterCall

> Última revisión: 2026-08-29
> Decisiones: [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md) y [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

## INICIO DEL PROMPT

Continúa el trabajo en `jdlc86/IA_RealTime_CenterCall` como Staff/Principal Engineer de voz realtime y seguridad.

### Arranque obligatorio

```text
repo   jdlc86/IA_RealTime_CenterCall
rama   rebuild/v39-stable-baseline
PR     PR #85, mantener OPEN/DRAFT
SHA canary de seguridad
       021d134625758cc9228284fecc4f49599a419182
```

Antes de escribir, verifica de nuevo HEAD remoto, PR, CI, deploy efectivo y estado local. No sobrescribas cambios ajenos. No hagas merge, ready-for-review, force-push, rebase destructivo ni otra rama/PR. No hagas commit, push, deploy, llamadas, IAM o configuración sin autorización explícita.

Lee en este orden:

1. `docs/README.md`
2. `docs/PROJECT_STATUS.md`
3. `docs/SYSTEM_OVERVIEW.md`
4. `docs/architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`
5. `docs/architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`
6. `docs/architecture/DESIGN_RULES.md`
7. `Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx` si la misión afecta seguridad
8. el runbook o contrato funcional exacto del problema.

Los planes de fase, diseños D1/D3/D5 y handoffs fechados fueron retirados del árbol vigente. Git los conserva como historial, pero no sustituyen estas fuentes canónicas.

### 2. Arquitectura obligatoria

Hay dos productos, no un runtime híbrido:

```text
OpenAI Worker → OpenAI runtime/lifecycle → OpenAI Realtime

Gemini Fast Worker → Gemini runtime/lifecycle → Gemini Media Edge → Gemini Live

Ambos → contratos neutrales de dominio/seguridad → Supabase compartido
```

Gemini ya dispone de Worker y Media Edge propios. No puede depender de SDK, secretos, sockets, voz, lifecycle, persistencia sideband ni coordinadores OpenAI. El stack OpenAI queda como legado independiente pendiente de retirada y no forma parte del modelo de negocio objetivo.

La extracción de caller security y SEC-P0-06 están desplegados en el canary del SHA `021d134625758cc9228284fecc4f49599a419182`: Gemini Fast Worker posee endpoint, adaptador Supabase, cola y DLQ; Media Edge usa el origen Gemini y los workflows Fast no tocan el Worker histórico. La ruta confirma primero Queue y usa Supabase directo como fallback; nunca responde éxito por `waitUntil`. `caller-security-hmac-secret` y `caller-security-hmac-sha256` están provisionados en Secret Manager con los bytes históricos y su huella independiente; CI verificó la coincidencia.

Capacidades transversales: seguridad, admission/identidad, voz/lifecycle, tool authorization, human handoff, tiempo, diagnóstico y comunicaciones. WhatsApp tiene dos capabilities KV independientes: `message.whatsapp.transactional` y `message.whatsapp.realtime_support`. Las verticales —por ejemplo reservas— pertenecen al tenant/dominio y consumen las capacidades transversales sin duplicarlas.

### 3. Reglas arquitectónicas que no puedes violar

1. Prohibido añadir latencia evitable. Ningún salto síncrono, inferencia, RPC, persistencia, sleep, buffer o transformación entra en el camino crítico sin baseline, presupuesto y p50/p95/p99.
2. No añadir trabajo por chunk de audio salvo ADR+benchmark imprescindible.
3. Seguridad/diagnóstico sideband o asíncronos cuando la invariante lo permita.
4. One state owner per concern; ordering por identidad/sequence/ACK, nunca por timers.
5. El modelo interpreta/proporciona una categoría; kernel, ToolGateway, backend y DB autorizan efectos.
6. Cero tools o audio no autorizados; cualquier quarantine exigida por una ruta concreta debe ser bounded y fail-closed, pero no se añade al Fast Path por defecto.
7. No persistir transcript crudo, audio, prompts, secretos ni payload hostil.
8. Idempotencia de transporte separada de idempotencia empresarial.
9. Rejected context no terminal exige fresh Gemini session; session resumption no limpia confianza.
10. No failover OpenAI↔Gemini a mitad de llamada.
11. `IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E`. El estado CANARY se declara aparte.
12. Toda tool requiere nombre/schema cerrado, `authority`, `effect`, `capability`, `evidence`, handler permitido y tenant/call context; una mutación añade idempotencia, confirmación e invariantes verticales.

### 4. Corrección y extracción de seguridad desplegadas

El fallo persistente era drift del token de control: Cloud Run y Fast Worker tenían el mismo token, pero la frontera de persistencia del Control Plane no. Se corrigió en:

- `9eef2567ae445a7d0a74392e52fb4b9bcb05010f`
- `154fdcfd31af22fde7c270b04074cf6cc3898aee`

El baseline sincronizaba el token con tres puntos. El corte desplegado elimina la frontera histórica: sincroniza el token sólo con Cloud Run y Gemini Fast Worker, añade la clave HMAC estable de caller security y ejecuta el preflight contra el Fast Worker Gemini.

IAM desplegado: `github-cloud-run-deployer@iacallcenterv1.iam.gserviceaccount.com` tiene `roles/secretmanager.secretAccessor` sobre los secretos necesarios del baseline y, a nivel de recurso, sobre `caller-security-hmac-secret` y `caller-security-hmac-sha256`. Los valores no se documentan ni se exponen.

### 5. CI, deploy y E2E verificados

```text
SHA                021d134625758cc9228284fecc4f49599a419182
Fast Canary run    33264338263, SUCCESS
Cloud Run revision gemini-media-edge-00206-pid
Fast Worker ver.   a62e7fac-598d-4944-8ccb-78971284c326
production traffic sin cambios
```

Llamada A–G:

`v3:uHjdAfDtH2KmuPKzJ2cKyGY_nbIQankHLScOdnq2oN4TNewNo5xxpg`

Resultado técnico PASS: conversación, pregunta educativa, dos prompt exfiltration, role escalation, tool manipulation, hora autoritativa y transferencia humana contestada. Cuatro eventos persistidos con `risk_delta=1`, `raw_transcript_stored=false`, latencias 40–135 ms y ningún `TOOL_EXECUTION_FAILED`. Transferencia `TRANSFERRED`, `failure_reason=null`, cierre `HUMAN_HANDOFF_TERMINAL`.

Estado final del llamante:

```text
risk_score=21
security_strikes=3
rate_limit_blocks=0
blocked_until=null
permanent_block=false
```

El score desplegado todavía no decae automáticamente. SEC-P1-02 está implementado sólo localmente: un punto por cada 24 horas completas sin evidencia nueva, reset Postgres-admin-only e historial before/after. La migración pasó un dry-run transaccional con `ROLLBACK`, pero no está aplicada. No repitas ataques desde el número real.

### 6. Primera misión

Primero realiza sólo inspección y confirma que el SHA/CI/deploy/documentos continúan vigentes. Trata el baseline de seguridad como PASS y no vuelvas a corregirlo sin una regresión demostrada.

Si se continúa esta misión de seguridad, el orden es:

1. tratar `021d134625758cc9228284fecc4f49599a419182` y el run `33264338263` como baseline desplegado de P06, sin exponer valores de secretos;
2. revisar la migración local `20260829200938_caller_security_risk_lifecycle.sql` y su test de contrato antes de commit/push;
3. no aplicar la migración ni desplegar SEC-P1-02 sin autorización explícita; después de aplicarla, ejecutar advisors y pruebas sintéticas, nunca ataques reales;
4. dejar para otra misión la cobertura de caller-security en admission Gemini y la eliminación física del código OpenAI legado.

Cualquier propuesta debe indicar amenaza, invariante, archivo/frontera, impacto de latencia, plan de prueba y rollback. No hagas otra llamada.

### 7. Validación mínima antes de cerrar

Desde `apps/control-plane`:

```bash
npm run docs:check
npm test
npm run check
```

Para una misión limitada a documentación, `npm run docs:check` y `git diff --check` son obligatorios; las suites completas se ejecutan si cambia código o si el riesgo de la misión lo requiere.

## FIN DEL PROMPT
