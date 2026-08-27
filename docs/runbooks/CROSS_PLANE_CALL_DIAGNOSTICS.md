# Cross-plane call diagnostics runbook

> **Estado:** vigente  
> **Última revisión:** 2026-08-27

`public.call_diagnostic_events` es la fuente operacional persistida para reconstruir eventos técnicos de una llamada. **OpenAI y Gemini no necesariamente producen los mismos stages ni el mismo lifecycle**, por lo que este runbook separa consultas neutrales de filtros específicos.

No debe contener audio, base64 media, secretos, tokens, API keys, prompts completos ni transcripts crudos por defecto.

La persistencia de diagnóstico no debe gobernar la llamada: una caída del sink/auditoría no puede introducir latencia en audio ni autorizar/cambiar un efecto telefónico.

## 1. Empieza por identificar la llamada, no por buscar un stage esperado

```sql
select
  call_id,
  max(tenant_id) as tenant_id,
  min(occurred_at) as started_at,
  max(occurred_at) as last_event_at,
  count(*) as event_count,
  count(*) filter (where severity = 'error') as error_count,
  array_agg(distinct plane order by plane) as planes
from public.call_diagnostic_events
where occurred_at > now() - interval '24 hours'
group by call_id
order by last_event_at desc
limit 25;
```

No asumas que la llamada más reciente tiene un lifecycle completo sólo porque exista una fila. Verifica timestamps y planes.

## 2. Timeline completa

```sql
select
  occurred_at,
  persisted_at,
  sequence,
  plane,
  component,
  stage,
  event,
  severity,
  error_code,
  response_id,
  item_id,
  stream_id,
  elapsed_ms,
  duration_ms,
  audio_duration_ms,
  chunk_count,
  sample_count,
  recovery,
  details
from public.call_diagnostic_events
where call_id = :'call_id'
order by occurred_at, persisted_at, sequence nulls last, id;
```

La timeline completa es preferible a buscar primero un string concreto, porque los nombres de stage cambian entre productos/runtimes.

## 3. Primer error por llamada

```sql
select distinct on (call_id)
  call_id,
  occurred_at,
  plane,
  component,
  stage,
  error_code,
  details
from public.call_diagnostic_events
where severity = 'error'
order by call_id, occurred_at, persisted_at;
```

Un error de observabilidad/deploy/preflight no debe clasificarse automáticamente como error del audio hot path. Usa `plane`, `component` y causalidad.

## 4. Gemini Fast — stages útiles

En llamadas Fast reales se han observado families/stages como:

```text
FAST_TELNYX_CONNECTED
FAST_TELNYX_START_AUTHORIZED
FAST_SESSION_STARTED
FAST_MEDIA_AUTHORIZED
FAST_FIRST_CALLER_MEDIA
GEMINI_SETUP_SENT
GEMINI_SETUP_COMPLETE
FAST_FIRST_GEMINI_AUDIO_TO_TELNYX
GEMINI_TURN_COMPLETE
HUMAN_HANDOFF_AUTHORIZATION_BLOCKED
HUMAN_HANDOFF_ACCEPTED
HUMAN_HANDOFF_TRANSFER_START_RESULT
FAST_SESSION_CLOSED
```

Consulta orientativa:

```sql
select
  occurred_at,
  sequence,
  plane,
  component,
  stage,
  severity,
  elapsed_ms,
  duration_ms,
  details
from public.call_diagnostic_events
where call_id = :'call_id'
  and (
    stage like 'FAST_%'
    or stage like 'GEMINI_%'
    or stage like 'HUMAN_HANDOFF_%'
  )
order by occurred_at, sequence nulls last;
```

No convertir esta lista en un contrato exhaustivo: es un filtro de investigación, no una máquina de estados documental.

## 5. No reutilizar queries del runtime híbrido para afirmar fallos Fast

Queries antiguas buscaban por defecto:

```text
STT_%
TRANSCRIPT_AUTHORITY_COMPLETED
CALLER_TRANSCRIPT_COMPLETED
SIDEBAND_CLOSED
semantic preselection
quarantine
```

Esos mecanismos pueden seguir existiendo en código/rutas históricas, pero ADR-004 los eliminó como gates obligatorios del Fast Path normal.

Por tanto, una llamada Fast sin `STT_*` externo **no está incompleta por definición**.

## 6. Transferencia humana requiere dos fuentes

La timeline general está en:

```text
public.call_diagnostic_events
```

El lifecycle/auditoría durable de handoff está en:

```text
public.human_handoff_events
```

Consultar ambos por la misma llamada.

Ejemplo:

```sql
select
  id,
  tenant_id,
  call_id,
  status,
  requested_at,
  transfer_started_at,
  answered_at,
  transfer_ended_at,
  call_terminated_at,
  target_call_control_id,
  callback_required,
  callback_status,
  failure_reason
from public.human_handoff_events
where call_id = :'call_id'
order by requested_at desc;
```

Evitar exponer `caller_phone` o `destination_phone` en una revisión ordinaria salvo que sean estrictamente necesarios; en documentación/resúmenes, enmascararlos.

## 7. Separar los hitos de handoff

No inferir un hito a partir de otro:

```text
HUMAN_HANDOFF_ACCEPTED
    demuestra autorización/aceptación del lifecycle

HUMAN_HANDOFF_TRANSFER_START_RESULT
    demuestra resultado del comando de inicio

target_call_control_id
    demuestra que existe/evidenció un leg remoto

call.bridged / TRANSFERRED
    demuestra bridge exitoso

NO_ANSWER / BUSY / FAILED
    demuestra resultado terminal de intento

call.speak.ended
    demuestra lifecycle de speak, NO audibilidad al caller

callback_required=true, callback_status=PENDING
    demuestra necesidad registrada, NO callback ejecutado
```

## 8. Ringback y audio terminal

`call_diagnostic_events` puede demostrar signaling/control, pero la ausencia o presencia de ringback/TTS audible es una cuestión acústica.

Para un incidente “se quedó muda” separar:

1. ¿Gemini dejó de producir audio porque el handoff entró en terminal?;
2. ¿Telnyx inició el target leg?;
3. ¿había early media?;
4. ¿la aplicación generó ringback local?;
5. ¿se solicitó failure TTS?;
6. ¿Telnyx aceptó/completó el speak?;
7. ¿el caller lo oyó realmente?

Actualmente el Fast handoff no genera ringback local determinista; no diagnosticar silencio de dialing como VAD/Gemini sin más evidencia.

## 9. Correlación — smoke check

```sql
select count(*) as uncorrelated_events
from public.call_diagnostic_events
where event_id is null
   or call_id is null
   or plane is null
   or occurred_at is null;
```

`call_control_id` puede tener semántica distinta según el evento/plane; no añadirlo a un `expected zero` universal sin verificar el schema productor actual.

## 10. Forbidden-content smoke check

No flags técnicos por contener palabras como `transcript` o `phone` en una clave. Busca contenido real sensible.

```sql
with detail_values as (
  select e.id, lower(d.key) as key, d.value
  from public.call_diagnostic_events e
  cross join lateral jsonb_each_text(e.details) as d(key, value)
)
select count(distinct id) as suspicious_rows
from detail_values
where key = any (array[
    'raw_transcript', 'transcript_text', 'transcript_value',
    'audio_payload', 'audio_base64', 'base64_audio',
    'authorization', 'api_key', 'secret', 'credential', 'credential_url', 'token',
    'phone_number', 'customer_phone', 'caller_phone',
    'email', 'email_address',
    'provider_body', 'prompt', 'instruction'
  ])
   or value ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
   or (
     key ~ '(phone|caller|customer|destination|contact)'
     and regexp_replace(value, '[^0-9+]', '', 'g') ~ '^\+?[0-9]{9,15}$'
   );
```

Revisar manualmente cualquier resultado; no borrar evidencia automáticamente a partir de este smoke test.

## 11. Método recomendado de investigación

```text
1. localizar call_id exacto por ventana temporal
2. timeline completa de call_diagnostic_events
3. identificar runtime/producto por stages/planes
4. localizar primer desvío respecto al lifecycle esperado de ESE runtime
5. si hay handoff, unir human_handoff_events
6. distinguir signaling/control de experiencia acústica
7. contrastar configuración remota sólo si afecta al incidente
8. cambiar el owner mínimo responsable
9. añadir regresión del fallo real
```

No empezar por modificar VAD/audio si la primera divergencia aparece en autorización, routing, transfer, deploy o telemetry.