alter table public.caller_security_events
  add column if not exists event_key text;

create unique index if not exists caller_security_events_idempotency_idx
  on public.caller_security_events (tenant_id, caller_key, event_key)
  where event_key is not null;

create or replace function public.record_caller_security_signal_v2(
  p_event_key text,
  p_tenant_id text,
  p_caller_key text,
  p_event_type text,
  p_severity text,
  p_risk_delta integer,
  p_metadata jsonb default '{}'::jsonb,
  p_high_confidence boolean default false
)
returns table(
  action text,
  blocked_until timestamptz,
  permanent_block boolean,
  risk_score integer,
  security_strikes integer,
  reason text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  s public.caller_security_state%rowtype;
  inserted_id bigint;
  strikes_24h integer;
  should_permanent boolean := false;
  new_block_until timestamptz;
begin
  if p_event_key is null or btrim(p_event_key) = '' or length(p_event_key) > 200 then
    raise exception 'valid_event_key_required';
  end if;
  if p_tenant_id is null or btrim(p_tenant_id) = '' then raise exception 'tenant_id_required'; end if;
  if p_caller_key is null or btrim(p_caller_key) = '' then raise exception 'caller_key_required'; end if;
  if p_event_type is null or btrim(p_event_type) = '' or length(p_event_type) > 160 then
    raise exception 'valid_event_type_required';
  end if;
  if coalesce(p_severity, '') not in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') then
    raise exception 'valid_severity_required';
  end if;
  if p_risk_delta is null or p_risk_delta < 0 or p_risk_delta > 100 then
    raise exception 'valid_risk_delta_required';
  end if;

  insert into public.caller_security_state (tenant_id, caller_key, last_seen_at)
  values (p_tenant_id, p_caller_key, now())
  on conflict (tenant_id, caller_key) do nothing;

  select cs.* into s
  from public.caller_security_state as cs
  where cs.tenant_id = p_tenant_id and cs.caller_key = p_caller_key
  for update;

  insert into public.caller_security_events (
    event_key, tenant_id, caller_key, event_type, severity, risk_delta, metadata
  ) values (
    p_event_key, p_tenant_id, p_caller_key, p_event_type, p_severity,
    p_risk_delta, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (tenant_id, caller_key, event_key) where event_key is not null do nothing
  returning id into inserted_id;

  if inserted_id is null then
    return query select
      case when s.permanent_block or (s.blocked_until is not null and s.blocked_until > now())
        then 'BLOCK_FUTURE_CALLS' else 'ALLOW_FUTURE_CALLS' end,
      s.blocked_until,
      s.permanent_block,
      s.risk_score,
      s.security_strikes,
      coalesce(s.last_reason, p_event_type);
    return;
  end if;

  update public.caller_security_state as cs
  set risk_score = least(100, cs.risk_score + p_risk_delta),
      security_strikes = cs.security_strikes + case when p_high_confidence then 1 else 0 end,
      last_reason = p_event_type,
      last_seen_at = now(),
      updated_at = now()
  where cs.tenant_id = p_tenant_id and cs.caller_key = p_caller_key
  returning cs.* into s;

  select count(*)::integer into strikes_24h
  from public.caller_security_events as e
  where e.tenant_id = p_tenant_id
    and e.caller_key = p_caller_key
    and e.severity in ('HIGH', 'CRITICAL')
    and e.created_at >= now() - interval '24 hours';

  if p_high_confidence and strikes_24h >= 2 then
    new_block_until := case
      when s.security_strikes <= 2 then now() + interval '1 hour'
      when s.security_strikes <= 4 then now() + interval '24 hours'
      else now() + interval '7 days'
    end;
    update public.caller_security_state as cs
    set blocked_until = greatest(coalesce(cs.blocked_until, 'epoch'::timestamptz), new_block_until),
        updated_at = now()
    where cs.tenant_id = p_tenant_id and cs.caller_key = p_caller_key
    returning cs.* into s;
  end if;

  should_permanent := s.security_strikes >= 8
    and s.rate_limit_blocks >= 3
    and s.risk_score >= 25;
  if should_permanent then
    update public.caller_security_state as cs
    set permanent_block = true,
        blocked_until = null,
        last_reason = 'PERSISTENT_HOSTILE_BEHAVIOR',
        updated_at = now()
    where cs.tenant_id = p_tenant_id and cs.caller_key = p_caller_key
    returning cs.* into s;
  end if;

  return query select
    case when s.permanent_block or (s.blocked_until is not null and s.blocked_until > now())
      then 'BLOCK_FUTURE_CALLS' else 'ALLOW_FUTURE_CALLS' end,
    s.blocked_until,
    s.permanent_block,
    s.risk_score,
    s.security_strikes,
    case when s.permanent_block then 'PERSISTENT_HOSTILE_BEHAVIOR' else p_event_type end;
end;
$$;

revoke all on function public.record_caller_security_signal_v2(text, text, text, text, text, integer, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.record_caller_security_signal_v2(text, text, text, text, text, integer, jsonb, boolean)
  to service_role;

comment on function public.record_caller_security_signal_v2(text, text, text, text, text, integer, jsonb, boolean)
  is 'Records a caller security signal exactly once per tenant, caller HMAC and event key.';
