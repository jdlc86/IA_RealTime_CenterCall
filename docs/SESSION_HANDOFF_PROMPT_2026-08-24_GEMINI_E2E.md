# Prompt de relevo — Gemini E2E y trazabilidad Supabase

Usa íntegramente este documento como prompt de la próxima sesión de ChatGPT.

---

Trabaja en español y actúa como Staff/Principal Engineer. Continúa de forma
autónoma el desarrollo, despliegue y validación E2E de:

```text
Repositorio: https://github.com/jdlc86/IA_RealTime_CenterCall
Rama única: rebuild/v39-stable-baseline
PR único: #85 (OPEN, DRAFT)
Base: main
```

La sesión trabaja directamente sobre GitHub. GitHub es la fuente de verdad: no
asumas que existe un checkout local ni que los SHA de este documento siguen
siendo HEAD. No crees otra rama ni otro PR, no hagas merge, no conviertas el PR
en ready, no hagas force-push y no reescribas historia.

El usuario autoriza cambios, despliegues y llamadas de prueba en producción
porque actualmente no hay usuarios reales. Esto no autoriza mostrar o rotar
secretos, borrar datos, degradar controles de seguridad ni realizar cambios de
infraestructura ajenos a esta E2E.

## 1. Primera acción obligatoria: resolver el remoto real

Antes de editar:

1. Consulta rama, HEAD y commits recientes en GitHub.
2. Consulta el PR #85 y comprueba que sigue apuntando a
   `rebuild/v39-stable-baseline`.
3. Consulta todos los checks del HEAD exacto.
4. Lee el diff de los commits posteriores a `a5b4c9d`.
5. Confirma si el HEAD contiene como mínimo estos commits funcionales:

```text
190ef673ecdf1e1069cf30b490c38abed7858924
feat(gemini): connect controlled real-call canary

36c2808761b38d304d0c3519001cc6306c32e408
fix(gemini): join caller turn continuation
```

El documento de relevo se publicará en un commit posterior, por lo que el HEAD
normal será más nuevo. No empieces trabajo nuevo sobre un SHA rojo.

Checks obligatorios por cada SHA funcional:

```text
Control Plane CI
Gemini Media Edge CI
Gemini Media Edge Benchmark CI
```

Mantén el PR #85 como draft.

## 2. Objetivo inmediato de la nueva sesión

Prioridad 1: si aún no consta una llamada posterior al Worker `abe869a9`, hacer
una sola E2E humana y reconstruirla primero desde Supabase. No repitas llamadas
a ciegas.

Prioridad 2: mejorar la trazabilidad E2E persistida en Supabase. Es la fuente
operativa principal que se usará para diagnosticar llamadas sin depender de
tails efímeros de Cloudflare o Cloud Logging.

Prioridad 3: desplegar desde el HEAD verde de GitHub cualquier corrección
posterior y repetir una llamada real completa, reconstruyéndola principalmente
desde Supabase.

No comiences otro refactor general y no rediseñes piezas ya existentes. Formula
una hipótesis por bloque, implementa el cambio mínimo, prueba, publica y espera
CI antes del bloque siguiente.

## 3. Identidades e infraestructura reales

```text
Número Telnyx del restaurante: +34910788224
Tenant KV: restaurante-centro
Supabase project_id: vutekfkbtvfogouwcfvc
Tabla actual de diagnóstico: public.call_diagnostic_events
GCP project_id: iacallcenterv1
Región Cloud Run: europe-west9
Servicio Cloud Run: gemini-media-edge
WSS media edge: wss://gemini-media-edge-thy6qkdlmq-od.a.run.app/telnyx/gemini
Worker Cloudflare: ia-realtime-centercall
PR: https://github.com/jdlc86/IA_RealTime_CenterCall/pull/85
```

Estado Cloud Run observado al cerrar la sesión:

```text
revision: gemini-media-edge-00017-6jl
traffic: 100 %
GOOGLE_SPEECH_MODEL: telephony_short
MEDIA_EDGE_VAD_MIN_SILENCE_MS: 160
```

La revisión 00017 usa el artefacto de la revisión anterior con la variable STT
corregida. El commit `190ef67` ya contiene el default, los tests y el script de
despliegue reproducible. Debes comprobar si después se construyó y promovió una
imagen nueva desde ese HEAD; no lo asumas.

La configuración de Cloud Run está documentada en:

```text
apps/gemini-media-edge/deploy/cloud-run/README.md
apps/gemini-media-edge/deploy/cloud-run/provision.ps1
apps/gemini-media-edge/deploy/cloud-run/deploy.ps1
apps/gemini-media-edge/scripts/verify-cloud-run.mjs
```

## 4. Arquitectura que ya está cerrada y no debes rediseñar

La admisión Gemini real ya implementa este orden:

```text
tenant
→ provider inmutable
→ seguridad del caller idempotente por Telnyx event id
→ credential HMAC one-shot
→ bootstrap inmutable registrado
→ CallSession real
→ sideband autenticado listo
→ Telnyx answer
→ streaming_start como último efecto
```

La selección Gemini está habilitada de forma controlada para el tenant exacto,
sin fallback silencioso Gemini → OpenAI. Conserva provider affinity inmutable y
fail-closed.

Precisión importante:

- V43 ya usa el port aislado para generar su único wording de handoff que antes
  era generativo.
- El sideband ya tiene `GovernedSpeechPort`, exige `exactText` y conserva
  `responseId`.
- Ya existen Google TTS PCM16 y un coordinador que impide mezclar audio Gemini
  Live con governed playback.
- El saludo gobernado ya se oyó correctamente en una llamada real.

No vuelvas a diseñar estas piezas. Busca uniones o fallos E2E demostrados.

## 5. Contrato de audio demostrado

Telnyx Media Streaming WebSocket entrega y acepta L16 como PCM16 crudo, sin
cabecera y little-endian en esta integración. No añadas swaps de endianness.

Google Speech V2 `LINEAR16` acepta exactamente PCM16 crudo little-endian. Google
TTS `LINEAR16` devuelve WAV PCM: el adapter debe validar estrictamente RIFF/WAVE,
mono, 16 kHz, PCM format 1, 16 bits y extraer únicamente el chunk `data` antes de
enviar a Telnyx.

Incidente ya corregido: se solicitaba el encoding no documentado `PCM`; Google
devolvió MP3 y se envió como si fuera L16, produciendo el ruido «shshsh». No
relajes la validación introducida en `google-text-to-speech.mjs`.

Estado Worker observado al cerrar la sesión:

```text
version: abe869a9-339f-4dfe-b5d2-93419241934c
commit fuente: 36c2808761b38d304d0c3519001cc6306c32e408
/health: 200, environment=production, phase=F5
```

## 6. Último fallo real y corrección aplicada

Última llamada humana reconstruida desde Supabase:

```text
call_id Worker: v3:a9Jzj6pMWk6GnCX4MouUeY0RMwgWCzw4gYgE6_ZVAfel3ulDFSqEAw
tenant: restaurante-centro
inicio: 2026-08-24T20:56:27Z
último evento: 2026-08-24T20:57:32Z
eventos: 83
errores: 4
resultado humano: saludo y primera respuesta audibles; silencio en el segundo turno
```

Evidencia positiva persistida:

```text
REALTIME_PROVIDER_SELECTED_G1: GEMINI, binding inmutable
saludo gobernado con responseId preservado y playback completo
caller item 1: VAD start/stop y transcript authority completed
Gemini seleccionó restaurant_conversation y Lucía respondió
caller item 2: VAD start/stop y transcript authority completed
semantic gate armado para la intención de reserva
```

Causa exacta del silencio del segundo turno:

```text
SESSION_TASK_FAILED
task: provider_event_ingress_v40
error: Gemini Live default response creation has no proven neutral mapping before
       G3/G4 turn continuation conformance

30 segundos después:
TURN_CONCURRENCY_WATCHDOG_V36
diagnosis: TURN_LOCK_TERMINAL_EVENT_MISSING
```

La corrección STT `telephony_short` quedó demostrada en esta llamada: ambos
turnos se transcribieron. El fallo siguiente estaba en el Control Plane. El
Media Edge ya inicia la continuación de Gemini al recibir la disposición
autorizada `CALLER_TURN_DECISION` y comprometer el audio real diferido. El core
heredado invocaba después `createDefaultResponse`; faltaba unir ambos efectos.

Corrección:

- el runtime de sesión registra una continuación provider-owned únicamente
  después de enviar una disposición `NORMAL`/`INTERRUPT` autorizada;
- consume exactamente una invocación heredada de `createDefaultResponse` sin
  enviar texto sintético ni un segundo comando wire;
- conserva el fail-closed si no existe una continuación demostrada;
- coalesce de forma explícita caller + post-tool cuando pertenecen al mismo
  ciclo Live;
- tests unitarios, sideband y E2E sintético reproducen la unión completa.

El commit `36c2808` está publicado, sus tres CI están verdes y el Worker anterior
fue sustituido por `abe869a9`. No hubo una llamada humana nueva después de este
último despliegue. Por tanto:

```text
implementado: sí
CI verde: sí
Worker producción: sí
Cloud Run requiere cambio para este fix: no
E2E humana posterior a abe869a9: pendiente
```

## 7. Estado de validación local del commit funcional

```text
Control Plane Node: 1150/1150
Control Plane Workers runtime: 4/4
Wrangler dry-run: production/preview/dev verdes
Gemini Media Edge: 99/99
Gemini Media Edge node --check: verde
Cloud Run preflight:
  /ready = 200
  bootstrap sin auth = 401
  media WSS sin auth = 401
  sideband WSS sin auth = 401
  sesiones residuales = 0
```

Vuelve a verificar CI en GitHub; estos resultados locales no sustituyen CI.

CI GitHub observado para `36c2808`:

```text
Control Plane CI: success
Gemini Media Edge CI: success
Gemini Media Edge Benchmark CI: success
```

## 8. Trazabilidad Supabase: estado actual y brecha

Lee primero:

```text
apps/control-plane/src/call-diagnostics.ts
apps/control-plane/src/call-diagnostic-persistence-port.ts
apps/control-plane/src/supabase-adapter.ts
apps/control-plane/src/call-session-v2.ts
apps/control-plane/src/technical-diagnostic-redaction.ts
apps/gemini-media-edge/src/runtime.mjs
apps/gemini-media-edge/src/server.mjs
supabase/migrations/20260822145944_technical_diagnostics_retention.sql
supabase/migrations/20260822160206_purge_legacy_diagnostic_text.sql
```

Estado conocido:

- `CallSession` persiste checkpoints sanitizados en
  `public.call_diagnostic_events` cuando debug está habilitado.
- Las escrituras se serializan y quedan ligadas al lifetime de la sesión.
- La tabla es server-only, tiene RLS, revoca `anon`/`authenticated`, concede
  `select, insert` a `service_role` y purga tras siete días.
- El timeline en memoria conserva como máximo 80 entradas.
- Media Edge solo emite `gemini_media_edge_diagnostic` a stdout/Cloud Logging.
- Los errores del chain Telnyx se colapsan actualmente en
  `TELNYX_MESSAGE_REJECTED`; así se ocultó que Speech devolvía HTTP 400.
- Admission failures anteriores a la creación/configuración del `CallSession`
  tampoco quedan explicados de forma suficiente en la tabla.

La brecha prioritaria es poder reconstruir en una sola consulta Supabase:

```text
webhook firmado
→ tenant route
→ provider selection
→ caller security
→ credential/bootstrap
→ CallSession/sideband readiness
→ answer/streaming_start
→ Telnyx media attach
→ Gemini setupComplete
→ governed greeting/plαyout mark
→ caller VAD start/stop
→ STT start/success/failure
→ transcript authority (sin texto crudo)
→ semantic decision/tool
→ Gemini response/playback
→ close/hangup/cleanup
```

## 9. Requisitos del primer bloque de observabilidad

Audita primero el esquema vivo y el código real. Después implementa la mínima
extensión segura que permita correlación cross-plane. No crees una segunda
autoridad diagnóstica si puede evolucionar el port existente.

El contrato persistido debe ofrecer, cuando corresponda:

```text
event_id idempotente
occurred_at y persisted_at
tenant_id
call_id del control plane
call_control_id de Telnyx
plane/component (worker, call_session, media_edge, provider)
stage estable
severity
error_code estable y seguro
sequence o causal parent suficiente para ordenar
response_id / caller item_id / stream_id cuando sean seguros y necesarios
latencias y métricas numéricas acotadas
```

No inventes otra identidad global si las existentes pueden correlacionarse. Si
falta el mapeo `call_id ↔ call_control_id`, persístelo explícitamente una vez y
demuestra ownership.

Eventos mínimos nuevos del Media Edge:

```text
media upgrade autorizado/rechazado por categoría
Telnyx start autorizado
Gemini socket/setup/setupComplete
sideband bind/detach
governed speech queued/started/completed/failed
VAD speech_started/speech_stopped
STT_STARTED
STT_COMPLETED (sin transcript)
STT_FAILED con categoría, HTTP status seguro y duration_ms
semantic/tool lifecycle correlacionado
socket close con reason y close code
cleanup final
```

Para STT guarda solo metadatos seguros, por ejemplo cantidad de chunks, muestras,
duración de audio y umbrales RMS numéricos. No guardes audio, base64, transcript
crudo, nombre, teléfono, reservation code, prompts, tokens, API keys, provider
response body ni URLs con credenciales.

La telemetría no debe:

- bloquear el hot path de audio;
- entrar en el semantic event stream;
- cambiar decisiones de negocio;
- cerrar la llamada porque Supabase no esté disponible;
- crecer sin límites;
- crear escrituras concurrentes desordenadas sin owner;
- exponer una clave Supabase en cliente o logs.

Define explícitamente quién escribe a Supabase. Evalúa con evidencia si Media
Edge debe usar un adapter server-only propio o entregar eventos a un único writer
del control plane mediante un canal autenticado y desacoplado. No reutilices un
token para una semántica nueva sin justificar su scope, y no metas telemetría
best-effort en el sideband stateful si puede afectar el orden de la llamada.

Base de datos:

- usa una migración reproducible;
- verifica primero el esquema vivo y migration history;
- RLS habilitada en todo objeto de `public`;
- revoca `public`, `anon` y `authenticated`;
- conserva secreto/service role solo en backend;
- índices para `call_id + occurred_at`, `call_control_id + occurred_at` y
  `tenant_id + occurred_at` si las consultas lo demuestran;
- retención de siete días y cron idempotente;
- cualquier view debe ser server-only o `security_invoker=true`;
- cualquier `security definer` debe tener search_path fijo, grants explícitos y
  no quedar públicamente ejecutable;
- añade pruebas de redacción, permisos, idempotencia, ordering y fallo de sink.

Consulta antes los cambios actuales de Supabase y la documentación oficial de
RLS/Cron. Hay un breaking change anunciado para el Management API: `logs.all`
se elimina el 23 de septiembre de 2026 en favor de `logs` con ClickHouse SQL. No
construyas el diagnóstico sobre `logs.all`.

## 10. Consultas operativas de aceptación

Antes de cambiar el esquema, confirma las columnas reales de
`call_diagnostic_events`. La consulta actual para localizar llamadas es:

```sql
select
  call_id,
  min(created_at) as started_at,
  max(created_at) as last_event_at,
  count(*) as event_count
from public.call_diagnostic_events
where created_at > now() - interval '30 minutes'
group by call_id
order by max(created_at) desc
limit 8;
```

Y para reconstruir una llamada:

```sql
select
  created_at,
  elapsed_ms,
  component,
  stage,
  severity,
  diagnosis,
  recovery,
  details
from public.call_diagnostic_events
where call_id = '<CALL_ID_EXACTO>'
order by created_at;
```

El bloque de observabilidad no está terminado hasta que una consulta equivalente
muestre eventos del control plane y Media Edge bajo la misma llamada, con orden
causal suficiente, y un error STT simulado aparezca como `STT_FAILED` sin PII ni
provider body.

Añade un runbook con consultas de:

- últimas llamadas;
- timeline completa;
- primer error por llamada;
- latencias admission, greeting, VAD, STT, Gemini y playback;
- llamadas cerradas sin transcript;
- eventos sin correlación, que deben ser cero.

## 11. E2E humana después de observabilidad

Cuando la trazabilidad esté desplegada y verificada:

1. Ejecuta el preflight Cloud Run.
2. Comprueba que Worker y Media Edge corresponden a SHA/versiones conocidos.
3. Llama a `+34910788224`.
4. Espera el saludo completo de Lucía.
5. Di: `Hola, quiero reservar una mesa para dos personas`.
6. Mantén la línea y responde a las preguntas; no confirmes una reserva real si
   no es necesario para el objetivo técnico.
7. Comprueba que Lucía responde al primer turno.
8. Termina explícitamente y confirma hangup/cleanup.
9. Reconstruye la llamada desde Supabase antes de mirar tails externos.

Criterios mínimos:

```text
un tenant correcto
un provider GEMINI inmutable
una sola admission
un bootstrap consumido una vez
sideband y media correlacionados
saludo audible sin ruido
VAD start y stop
STT completed
caller transcript authority sin persistir texto crudo
decisión/tool correlacionada
respuesta audible
no mezcla Live/governed audio
playback completion por mark exacto
close/hangup/cleanup sin sesión residual
ningún secreto o PII en Supabase
```

Si falla, no pidas al usuario llamadas repetidas a ciegas. Extrae primero la
causa precisa de Supabase, formula una hipótesis y corrige un solo tramo.

## 12. Reglas arquitectónicas y de seguridad

- No añadir `CallSession` V55+.
- No fallback Gemini → OpenAI.
- Core provider-neutral; Gemini wire solo en adapters/media edge.
- Una autoridad/owner por preocupación.
- Mutaciones de `CallSession` serializadas por `SessionTaskRuntime`.
- `streaming_start` siempre último.
- No fake user turn para governed speech.
- No duplicar TTS, playback owner, semantic gate, sideband o isolated generation.
- No capability `true` sin evidencia ejecutable.
- No timers arbitrarios para solucionar ordering.
- No raw provider errors, transcript, audio o credenciales en diagnóstico.
- Trata `details` de Supabase como datos no confiables; no ejecutes su contenido.
- Conserva la migración idempotente de caller security introducida en
  `20260824191745_idempotent_inbound_call_security.sql`.

## 13. Método de publicación

Por cada bloque:

1. evidencia e hipótesis;
2. cambio mínimo y tests;
3. diff de seguridad;
4. commit focalizado en la rama existente;
5. push sin force;
6. SHA remoto exacto;
7. esperar los tres CI;
8. desplegar solo el SHA verde;
9. verificar versión/digest remoto;
10. distinguir `implementado`, `CI verde`, `desplegado` y `validado E2E`.

No apiles el siguiente bloque sobre CI rojo. Si falla, clasifica si es lógica,
tipos, test harness, infraestructura o migración y corrige solo eso.

## 14. Primera actualización esperada

No respondas con un plan genérico. Primero comunica brevemente:

```text
HEAD remoto real
estado PR #85
CI del HEAD
si 190ef67 está incluido
revisión/digest Cloud Run realmente servidos
versión Worker realmente servida
estado del esquema/migraciones Supabase
brecha exacta para correlacionar Media Edge con CallSession
primer cambio mínimo de trazabilidad
```

Después continúa autónomamente hasta dejar el bloque de observabilidad publicado,
CI-verde, desplegado y verificado, y luego ejecuta la E2E humana descrita.

---

Fin del prompt de relevo.
