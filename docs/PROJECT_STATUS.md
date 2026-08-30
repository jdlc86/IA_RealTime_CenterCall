# IA_RealTime_CenterCall — estado operativo

> Snapshot: 2026-08-30
> Para continuar: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)
> Decisiones vigentes: [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md) y [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)
> Seguridad viva: [`IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx`](../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx)

Los datos remotos deben verificarse al comenzar cualquier sesión. `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO`, `CANARY` y `VALIDADO E2E` son estados distintos.

## Baseline verificado

```text
repo      jdlc86/IA_RealTime_CenterCall
rama      rebuild/v39-stable-baseline
PR        #85 — OPEN / DRAFT / MERGEABLE
SHA canary 021d134625758cc9228284fecc4f49599a419182
fecha     2026-08-29 (verificación GitHub)
```

Los CI de Control Plane, Gemini Control Plane, Gemini Media Edge, Gemini Fast Worker y Benchmark del SHA están verdes. `Gemini Fast Canary Deploy` run `33252047260` y `Gemini Media Edge Canary Deploy` run `33252047272` terminaron correctamente.

## Estado por preocupación

| Área | Implementado | CI | Producción | E2E |
|---|---:|---:|---:|---:|
| OpenAI independiente | baseline existente | verde | sin cambios | no repetido en esta sesión |
| Gemini Fast Worker | sí | verde | canary aislado | PASS A–G |
| Gemini Media Edge | sí | verde | revisión canary | PASS A–G |
| Seguridad semántica durable Gemini-native | sí | verde | canary aislado | preflight PASS; llamada no repetida |
| Caller-security en admission Gemini | `62d8f25` | CI verde | canary aislado | sonda sintética PASS; llamada pendiente |
| Autoridad de tool ligada al turno runtime | `76eba31` | CI verde | canary aislado | E2E pendiente |
| Corte de dependencia con Worker histórico | sí | verde | canary aislado | wiring/HMAC PASS |

## Arquitectura vigente

OpenAI y Gemini son productos realtime independientes:

```text
OPENAI PRODUCT                      GEMINI PRODUCT
OpenAI Worker                       Gemini Fast Worker
OpenAI runtime/lifecycle            Gemini runtime/lifecycle
OpenAI tool flow                    Gemini tool flow
OpenAI Realtime                     Gemini Media Edge → Gemini Live
          └──────── contratos neutrales + Supabase compartido ────────┘
```

- El stack OpenAI queda como legado independiente pendiente de retirada; ya no forma parte del modelo de negocio objetivo de Gemini.
- Gemini tiene Worker y Media Edge propios; su canary no utiliza runtime, SDK, socket, voz ni lifecycle OpenAI.
- No hay failover OpenAI↔Gemini a mitad de llamada.
- Supabase, dominio empresarial y caller security se comparten sólo detrás de contratos neutrales.
- El código Gemini posee su propio endpoint autenticado, adaptador Supabase, cola y DLQ de caller security. El Media Edge deriva esa URL del Fast Worker Gemini; los workflows Fast ya no instalan, escriben secretos ni hacen preflight contra el Worker histórico. El corte está desplegado en el canary del SHA `d7435fd81915c470f74bce81eb87d8ae7bda1c1f`.
- El endpoint histórico se conserva temporalmente sólo para no alterar el producto legado; no es una dependencia del runtime ni del despliegue Gemini.

El kernel distingue dos clases de capacidad:

- **Transversales:** seguridad, admission/identidad, flujo y lifecycle de voz, autorización de tools, transferencia humana, hora autoritativa, diagnóstico/redacción y comunicación externa. En KV, WhatsApp se divide en `message.whatsapp.transactional` y `message.whatsapp.realtime_support`; ambas capacidades son opt-in por tenant.
- **Verticales:** reservas, disponibilidad, horarios, mesas y demás reglas propias del negocio configurado para el tenant.

Toda tool cruza un contrato declarativo mínimo: nombre/schema cerrado, `authority`, `effect`, `capability`, `evidence`, handler permitido y contexto tenant/call. Las mutaciones añaden idempotencia, confirmación e invariantes de dominio. Gemini propone; el kernel autoriza; el dominio valida; el backend ejecuta.

SEC-P0-04 está publicado en `codex/fix-fast-security-persistence` mediante el commit `1d514b5617a9f10691359ba6eb2493a478324baf` e incluido en el canary posterior de SEC-P0-05; no se repitió E2E telefónico: una decisión `ALLOW` genera un recibo opaco ligado a la function call exacta y al contexto autenticado `tenantId/callControlId`. El executor genérico y el sink especial `transfer_call` exigen ese recibo antes de cualquier handler; una autorización ausente, fabricada o reutilizada en otra llamada produce cero efectos. El handler recibe la instantánea de argumentos autorizada, no un payload mutable posterior.

SEC-P0-05 está publicado en `a95a9311b4f9c68d1ad1894c1273b6ccf181a462` y desplegado en el canary mediante `Gemini Fast Canary Deploy` run `33261676273`. El bootstrap autenticado evoluciona a `gemini-fast-bootstrap.v2` y toda declaración de tool lleva una `capability` explícita. Media Edge exige que esa concesión coincida exactamente con la policy local antes de construir la sesión; capability ausente o distinta falla cerrada. El registro de bootstrap continúa ligando credencial, tenant y llamada, y el Worker rechaza un registro de capabilities perteneciente a otro tenant antes de provisionar el Media Edge. La reproducción previa produjo `effects=1` con una capability declarada ajena; después del cambio produce `effects=0`.

SEC-P0-06 está publicado en `021d134625758cc9228284fecc4f49599a419182` y desplegado mediante `Gemini Fast Canary Deploy` run `33264338263`. El endpoint Gemini `/internal/diagnostics-ingest` reconstruye cada evento desde un schema cerrado y aplica una allowlist común de detalles escalares justo antes del sink Supabase. Campos desconocidos —incluidos transcript, prompt, token, teléfono y payloads anidados— se descartan; un valor inválido en una clave permitida falla cerrado antes de persistir. La sonda post-deploy `p06-synthetic-1788032648-ee74fd87` confirmó `201/PERSISTED` para el evento válido, `400/INVALID_DIAGNOSTICS` para el inválido, tres campos seguros exactos y cero marcas prohibidas o filas inválidas. No se importa el redactor OpenAI ni se modifica el runtime de audio.

SEC-P1-02 está publicado en `db210c54b939eee49a2a0159cfa1d528c62b839c`; `Control Plane CI` run `33277134222` finalizó `SUCCESS` y la migración productiva `caller_security_risk_lifecycle` quedó registrada en Supabase como versión `20260829215407`. Añade decay perezoso de un punto por cada 24 horas completas sin nueva evidencia de riesgo dentro de las RPC existentes, sin viajes de red adicionales. No reduce automáticamente strikes, historial de rate limit ni bloqueos temporales/permanentes. El reset es idempotente, auditable, exige motivo cerrado y actor con hash SHA-256, y queda revocado incluso para `service_role`: sólo un administrador Postgres puede ejecutarlo. La prueba productiva sintética confirmó decay `5→2`, conservación de strikes/rate-limit/bloqueo temporal, reset idempotente y ACL; terminó con `ROLLBACK` y cero filas residuales. No hubo redeploy del runtime de voz porque este bloque sólo modifica PostgreSQL.

Caller-security en admission Gemini está publicado en `62d8f25acd1ccf84dc2e37b5e462593d6a295bdd` mediante la PR borrador `#95`. `Gemini Control Plane CI` run `33300524069`, `Gemini Media Edge CI` run `33300524062`, `Control Plane CI` run `33300524075` y `Gemini Fast Worker Deploy` run `33300524089` terminaron en `SUCCESS`. `Gemini Fast Canary Deploy` run `33300576501` desplegó la revisión sin tráfico `gemini-media-edge-00207-reg`, imagen inmutable `sha256:a737f308eb8e1d061eb8a5b13677f518eac16c36510c08f45197f30c7b00a024`, y apuntó el Worker al tag `fast-62d8f25acd1c` sin cambiar tráfico productivo.

El Worker Fast consulta una vez `evaluate_inbound_call_security_v2` con `eventId`, `tenantId` y el HMAC histórico del caller después de autenticar/resolver la llamada y antes de emitir cualquier identity, credencial o efecto Telnyx/Media Edge. `BLOCK`, caller ausente, secreto ausente, error/timeout Supabase o payload inválido fallan cerrados. El límite de 2 s afecta únicamente al establecimiento pre-call; codec, WebSocket, audio, barge-in y post-tool no cambian. Los dos workflows de despliegue y el sync manual exigen nombres exactos para `CALLER_SECURITY_HMAC_SECRET` y `SUPABASE_SERVICE_ROLE_KEY`, sin leer ni registrar sus valores.

La sonda Supabase ejecutada como `service_role` con identidad exclusivamente sintética comprobó `ALLOW/OK`, reintento `ALLOW/DUPLICATE_EVENT` sin incrementar el contador y `BLOCK/CALL_RATE_1M` en el quinto evento. Terminó con `ROLLBACK`, `assertion_failures=0`, `residual_state_rows=0` y `residual_event_rows=0`. Los preflights del workflow verificaron además health, token semántico y bootstrap/HMAC Worker→Media Edge. La llamada real controlada continúa pendiente y no debe mezclar ataques repetidos.

La corrección de autoridad por turno está implementada en `76eba318f17e65b9353d0883a3a37f69ae3ffb38`. El incidente real `v3:PmWI3aKneTW47lPrNOOZ3vvzxgnsB78832-hA1jTqdboPLkPTZqlbA` fue bloqueado antes de Fast Worker por `TOOL_AUTHORITY_EVIDENCE_MISMATCH`: el contrato anterior exigía que Gemini repitiera literalmente parte del transcript. Esa cadena controlada por el modelo fue retirada como credencial. Ahora cada propuesta caller-governed recibe un recibo opaco local, ligado a kernel/tenant/llamada y de un solo uso; ausencia, turno cerrado, fabricación, cruce y replay fallan antes del efecto. Varias tools legítimas del mismo frame reciben recibos distintos. La suite Media Edge pasa `243/243`, `docs:check` pasa y los cuatro workflows del SHA `5d6a3c9f39a61090ac951bb1b54552f6be174d63` terminaron en `SUCCESS`. `Gemini Fast Canary Deploy` run `33302316492` desplegó `gemini-media-edge-00208-riz`, imagen `sha256:60205aeaaa9c308f8a4b2aaa28670f9568def818b5f3362c96e596beaf4625a0`, con tráfico productivo intacto, Worker sincronizado y preflights completos. Sólo falta E2E real. No se añadió inferencia, RPC, persistencia, espera ni trabajo por chunk de audio.

## Regla de latencia

Está prohibido añadir latencia evitable al turno o al audio. Un cambio no puede introducir inferencias, RPC, persistencia, sleeps, buffers o transformaciones síncronas en el camino crítico sin:

1. baseline previo;
2. presupuesto explícito;
3. medición p50/p95/p99;
4. prueba de que no degrada voz, barge-in ni continuación post-tool.

No se añade trabajo por cada chunk de audio salvo necesidad demostrada por ADR+benchmark. Seguridad, auditoría y diagnóstico se ejecutan sideband/asíncronos cuando la invariante lo permite.

## Estado de seguridad Gemini

La causa del fallo persistente anterior quedó corregida en el baseline desplegado. La extracción Gemini-native posterior quedó desplegada en canary mediante el run `33252047260` y sincroniza:

- `gemini-media-edge-control-plane-token` únicamente con Cloud Run y Gemini Fast Worker;
- `gemini-media-edge-credential-hmac-secret` entre Cloud Run y Gemini Fast Worker;
- `CALLER_SECURITY_HMAC_SECRET` con el Fast Worker desde `caller-security-hmac-secret`; CI compara su SHA-256 con `caller-security-hmac-sha256`, capturado previamente de la clave histórica, para impedir un fork silencioso de identidad;
- preflight autenticado a `/internal/fast-semantic-security-signal`, que exige `400 INVALID_SECURITY_SIGNAL` para `{}` sin persistir un evento;
- probe HMAC del upgrade WSS.

Secretos previos al deploy ya provisionados en Google Secret Manager: `caller-security-hmac-secret` conserva los bytes históricos y `caller-security-hmac-sha256` conserva su huella independiente. `github-cloud-run-deployer@iacallcenterv1.iam.gserviceaccount.com` tiene `roles/secretmanager.secretAccessor` a nivel de cada uno de esos dos secretos, además de los secretos del baseline. Sus valores no se documentan ni se exponen.

### E2E real A–G

```text
call_id   v3:uHjdAfDtH2KmuPKzJ2cKyGY_nbIQankHLScOdnq2oN4TNewNo5xxpg
resultado PASS técnico A–G
```

Se verificaron conversación, pregunta educativa legítima, prompt exfiltration, role escalation parafraseada, tool manipulation, hora autoritativa y transferencia humana contestada.

Persistencia demostrada:

- 2 × `GEMINI_SEMANTIC_PROMPT_EXFILTRATION`;
- 1 × `GEMINI_SEMANTIC_ROLE_ESCALATION`;
- 1 × `GEMINI_SEMANTIC_TOOL_MANIPULATION`;
- `severity=MEDIUM`, `risk_delta=1`, claves idempotentes distintas;
- `source=GEMINI_FAST_SEMANTIC_BOUNDARY`;
- `raw_transcript_stored=false`;
- latencias observadas: 135, 74, 89 y 40 ms;
- ningún `TOOL_EXECUTION_FAILED`.

Estado del llamante tras la prueba:

```text
risk_score         21
security_strikes   3
rate_limit_blocks  0
blocked_until      null
permanent_block    false
```

El `risk_score` desplegado aplica un punto de decay por cada 24 horas completas sin evidencia nueva, sin modificar strikes ni bloqueos. Gemini semántico suma 1; una detección determinista de alta confianza suma 5 y un strike; un bloqueo por frecuencia suma 3. Los duplicados idempotentes y llamadas normales no suman ni reinician el reloj de decay.

Umbrales de frecuencia: 5 llamadas/minuto, 8/5 minutos o 20/hora. Los bloqueos escalan 1 hora, 24 horas y 7 días. El bloqueo permanente requiere simultáneamente `security_strikes>=8`, `rate_limit_blocks>=3` y `risk_score>=25`.

## Despliegue canary vigente

```text
workflow          Gemini Fast Canary Deploy
run_id            33302316492
source SHA        5d6a3c9f39a61090ac951bb1b54552f6be174d63
Cloud Run         gemini-media-edge-00208-riz
Fast Worker       162705c6-5890-4aa6-89bf-c1a77c7e9733
canary traffic    0 %, accesible por tag/Fast Worker
production        sin cambios
```

La transferencia real quedó `TRANSFERRED`, destino `Reception`, contestada aproximadamente 2.23 s después de iniciar el transfer, `failure_reason=null` y cierre esperado `HUMAN_HANDOFF_TERMINAL`.

## Restricciones para la siguiente sesión

- No realizar otra llamada ni repetir ataques desde el número real sin petición expresa.
- No modificar OpenAI para corregir Gemini.
- No copiar la cadena histórica `CallSession V2→V54` al producto Gemini.
- No añadir latencia ni trabajo por chunk sin benchmark/ADR.
- No almacenar prompts, secretos, audio o transcript crudo en eventos de seguridad.
- El modelo propone intención; kernel, ToolGateway, backend y base de datos autorizan efectos.
- No cambiar IAM, secretos, tráfico, deploy o configuración sin autorización explícita.
- No hacer commit/push con cambios ajenos; verificar worktree antes de editar.
- Mantener PR #85 OPEN/DRAFT y distinguir siempre código, CI, deploy, canary y E2E.

## Siguiente validación

La seguridad probada debe conservarse sin más llamadas adversariales. Los asuntos abiertos son:

1. observar SEC-P1-02 con métricas y eventos técnicos, sin llamadas adversariales reales ni resets sobre identidades reales;
2. mantener los avisos preexistentes de advisors en backlog separado: SEC-P1-02 no añadió lints nuevos;
3. mantener SEC-P0-06 como PASS post-deploy;
4. tratar en una misión separada la cobertura de caller-security en admission Gemini y la retirada física del legado OpenAI.
