# Cross-plane call diagnostics runbook

`public.call_diagnostic_events` is the server-only operational source for reconstructing a call across the Worker, `CallSession`, Media Edge and provider adapters. It must never contain audio, base64 media, raw transcripts, caller/business PII, prompts, provider response bodies, credentials, tokens or secrets.

The Worker remains the only durable Supabase writer. Media Edge keeps a bounded short-lived in-memory journal and exposes it only through the existing authenticated Control Plane → Media Edge internal bearer boundary. After a signed Telnyx `call.hangup` is accepted by the existing webhook handler, the Worker reads that journal and inserts the events idempotently by `event_id`. Failure to read or persist telemetry is best-effort and must not change call state.

RLS remains enabled. `public`, `anon` and `authenticated` have no table privileges; `service_role` has only `select, insert`. The existing hourly cron deletes rows older than seven days using `created_at`.

## Latest calls

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

## Full timeline for one call

```sql
select
  occurred_at,
  persisted_at,
  sequence,
  plane,
  component,
  stage,
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
  details
from public.call_diagnostic_events
where call_id = :'call_id'
order by occurred_at, persisted_at, sequence nulls last, id;
```

## First error per call

```sql
select distinct on (call_id)
  call_id, occurred_at, plane, component, stage, error_code, details
from public.call_diagnostic_events
where severity = 'error'
order by call_id, occurred_at, persisted_at;
```

## Admission, greeting, VAD, STT, Gemini and playback evidence

```sql
select
  call_id,
  stage,
  plane,
  occurred_at,
  duration_ms,
  audio_duration_ms,
  error_code,
  response_id,
  item_id,
  details
from public.call_diagnostic_events
where call_id = :'call_id'
  and (
    stage like '%ADMISSION%'
    or stage like '%GREETING%'
    or stage like 'VAD_%'
    or stage like 'STT_%'
    or stage like 'GEMINI_%'
    or stage like '%PLAYBACK%'
  )
order by occurred_at, sequence nulls last;
```

## Calls closed without transcript authority

```sql
select call_id, max(occurred_at) as closed_at
from public.call_diagnostic_events
group by call_id
having bool_or(stage in ('MEDIA_SESSION_CLOSING', 'TELNYX_HANGUP_OBSERVED', 'SIDEBAND_CLOSED'))
   and not bool_or(stage in ('TRANSCRIPT_AUTHORITY_COMPLETED', 'CALLER_TRANSCRIPT_COMPLETED'))
order by closed_at desc;
```

## Correlation invariant — expected zero

```sql
select count(*) as uncorrelated_events
from public.call_diagnostic_events
where event_id is null
   or call_id is null
   or call_control_id is null
   or plane is null
   or occurred_at is null;
```

## Forbidden-content smoke check — expected zero

Do not flag technical booleans merely because their key contains words such as `transcript`, `reservation` or `phone`. Check exact forbidden content-bearing keys and PII/media-shaped string values instead.

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
    'email', 'email_address', 'address',
    'provider_body', 'prompt', 'instruction'
  ])
   or value ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
   or (
     key ~ '(phone|caller|customer|destination|contact)'
     and regexp_replace(value, '[^0-9+]', '', 'g') ~ '^\+?[0-9]{9,15}$'
   )
   or (
     length(value) >= 128
     and value ~ '^[A-Za-z0-9+/=]+$'
   );
```

For failures, diagnose from this table first. `STT_FAILED` carries only a stable `error_code`, optional HTTP status and bounded timing/audio metrics; provider error bodies and transcript text are intentionally absent.
