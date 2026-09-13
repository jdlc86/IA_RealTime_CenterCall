-- Short-lived, server-only technical observability. The Worker writes with a
-- secret server credential; browser roles must never reach these traces.
alter table public.call_diagnostic_events enable row level security;

revoke all privileges on table public.call_diagnostic_events from public, anon, authenticated;
revoke all privileges on table public.call_diagnostic_events from service_role;
grant select, insert on table public.call_diagnostic_events to service_role;

comment on table public.call_diagnostic_events is
  'Server-only redacted technical call traces. Automatic retention: 7 days.';

-- Historical tool payloads predate recursive redaction and may contain caller
-- data inside JSON strings. Preserve the structural timeline, but remove those
-- unsafe payload fields before enabling richer traces.
update public.call_diagnostic_events
set details = details - 'arguments' - 'output'
where details ?| array['arguments', 'output'];

delete from public.call_diagnostic_events
where created_at < now() - interval '7 days';

create extension if not exists pg_cron;

select cron.schedule(
  'purge-redacted-call-diagnostics-7d',
  '17 * * * *',
  $$delete from public.call_diagnostic_events where created_at < now() - interval '7 days'$$
);
