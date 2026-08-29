# IA_RealTime_CenterCall — estado operativo

> Snapshot: 2026-08-29
> Para continuar: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)
> Decisiones vigentes: [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md) y [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)
> Seguridad viva: [`IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx`](../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx)

Los datos remotos deben verificarse al comenzar cualquier sesión. `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO`, `CANARY` y `VALIDADO E2E` son estados distintos.

## Baseline verificado

```text
repo      jdlc86/IA_RealTime_CenterCall
rama      rebuild/v39-stable-baseline
PR        #85 — OPEN / DRAFT / MERGEABLE
SHA canary d7435fd81915c470f74bce81eb87d8ae7bda1c1f
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

SEC-P0-06 está implementado y verificado **localmente**, todavía sin commit/CI/deploy. El endpoint Gemini `/internal/diagnostics-ingest` reconstruye cada evento desde un schema cerrado y aplica una allowlist común de detalles escalares justo antes del sink Supabase. Campos desconocidos —incluidos transcript, prompt, token, teléfono y payloads anidados— se descartan; un valor inválido en una clave permitida falla cerrado antes de persistir. La reproducción previa demostró que esos campos arbitrarios llegaban a `call_diagnostic_events`; tras el cambio sólo persisten metadatos técnicos bounded. No se importa el redactor OpenAI ni se modifica el runtime de audio.

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

El `risk_score` actual es acumulativo y no tiene decay automático: Gemini semántico suma 1; una detección determinista de alta confianza suma 5 y un strike; un bloqueo por frecuencia suma 3. Los duplicados idempotentes y llamadas normales no suman.

Umbrales de frecuencia: 5 llamadas/minuto, 8/5 minutos o 20/hora. Los bloqueos escalan 1 hora, 24 horas y 7 días. El bloqueo permanente requiere simultáneamente `security_strikes>=8`, `rate_limit_blocks>=3` y `risk_score>=25`.

## Despliegue canary vigente

```text
workflow          Gemini Fast Canary Deploy
run_id            33261676273
source SHA        a95a9311b4f9c68d1ad1894c1273b6ccf181a462
Cloud Run         gemini-media-edge-00205-mub
Fast Worker       318b36d8-a900-4fe9-99ba-64863891883f
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

1. decidir si SEC-P0-04/05 requieren una nueva llamada E2E específica; ambos ya están publicados e incluidos en el canary `a95a9311...`;
2. publicar SEC-P0-06 y completar sus estados separados de CI/canary; al ser un control sideband de persistencia, no requiere otra llamada adversarial para demostrar la redacción;
3. decidir si la política necesita decay/reset administrado de `risk_score`;
4. validar la persistencia/idempotencia Gemini-native con una prueba sintética o controlada antes de otra llamada adversarial real.
