-- Cross-plane, server-only call trace contract. Backward compatible with the
-- existing CallSession writer while enabling Worker and Media Edge correlation.
alter table public.call_diagnostic_events
  add column if not exists event_id text,
  add column if not exists occurred_at timestamptz,
  add column if not exists persisted_at timestamptz not null default now(),
  add column if not exists call_control_id text,
  add column if not exists plane text,
  add column if not exists error_code text,
  add column if not exists sequence bigint,
  add column if not exists causal_parent_event_id text,
  add column if not exists response_id text,
  add column if not exists item_id text,
  add column if not exists stream_id text,
  add column if not exists duration_ms integer,
  add column if not exists audio_duration_ms integer,
  add column if not exists chunk_count integer,
  add column if not exists sample_count integer;

update public.call_diagnostic_events
set
  occurred_at = coalesce(occurred_at, created_at),
  persisted_at = coalesce(persisted_at, created_at),
  call_control_id = coalesce(call_control_id, call_id),
  plane = coalesce(
    plane,
    case
      when lower(component) = 'callsession' then 'call_session'
      when lower(component) like '%media%' then 'media_edge'
      else 'worker'
    end
  ),
  event_id = coalesce(event_id, 'legacy:' || id::text)
where event_id is null
   or occurred_at is null
   or call_control_id is null
   or plane is null;

create or replace function public.fill_call_diagnostic_cross_plane_defaults()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.occurred_at is null then
    new.occurred_at := coalesce(new.created_at, now());
  end if;
  if new.persisted_at is null then
    new.persisted_at := now();
  end if;
  if new.call_control_id is null or btrim(new.call_control_id) = '' then
    new.call_control_id := new.call_id;
  end if;
  if new.plane is null or btrim(new.plane) = '' then
    new.plane := case
      when lower(new.component) = 'callsession' then 'call_session'
      when lower(new.component) like '%media%' then 'media_edge'
      else 'worker'
    end;
  end if;
  if new.event_id is null or btrim(new.event_id) = '' then
    new.event_id := 'legacy:' || new.id::text;
  end if;
  return new;
end;
$$;

revoke all on function public.fill_call_diagnostic_cross_plane_defaults() from public, anon, authenticated;

drop trigger if exists call_diagnostic_cross_plane_defaults on public.call_diagnostic_events;
create trigger call_diagnostic_cross_plane_defaults
before insert on public.call_diagnostic_events
for each row execute function public.fill_call_diagnostic_cross_plane_defaults();

alter table public.call_diagnostic_events
  alter column event_id set not null,
  alter column occurred_at set not null,
  alter column call_control_id set not null,
  alter column plane set not null;

create unique index if not exists call_diagnostic_events_event_id_uidx
  on public.call_diagnostic_events (event_id);
create index if not exists call_diagnostic_events_call_occurred_idx
  on public.call_diagnostic_events (call_id, occurred_at);
create index if not exists call_diagnostic_events_control_occurred_idx
  on public.call_diagnostic_events (call_control_id, occurred_at);
create index if not exists call_diagnostic_events_tenant_occurred_idx
  on public.call_diagnostic_events (tenant_id, occurred_at desc);

alter table public.call_diagnostic_events enable row level security;
revoke all privileges on table public.call_diagnostic_events from public, anon, authenticated;
revoke all privileges on table public.call_diagnostic_events from service_role;
grant select, insert on table public.call_diagnostic_events to service_role;

comment on column public.call_diagnostic_events.event_id is
  'Idempotent technical-event identity. Never contains transcript, audio, PII, credential or secret material.';
comment on column public.call_diagnostic_events.occurred_at is
  'Source-plane occurrence time; persisted_at records database arrival time.';
comment on column public.call_diagnostic_events.call_control_id is
  'Explicit Telnyx call-control correlation identity.';
comment on column public.call_diagnostic_events.plane is
  'Technical source plane: worker, call_session, media_edge or provider.';
comment on column public.call_diagnostic_events.error_code is
  'Stable bounded technical error category; raw provider error text is forbidden.';
