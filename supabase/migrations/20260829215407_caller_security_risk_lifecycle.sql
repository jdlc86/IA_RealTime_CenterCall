-- SEC-P1-02: caller risk lifecycle and audited administrative remediation.
--
-- Risk decays lazily inside the RPCs that already serialize caller-security
-- state. This adds no Worker-to-database round trip and never touches audio.
-- Strikes, rate-limit history, temporary blocks and permanent blocks do not
-- decay automatically.

alter table public.caller_security_state
  add column if not exists risk_score_updated_at timestamptz;

update public.caller_security_state as state
set risk_score_updated_at = coalesce(
  (
    select max(event.created_at)
    from public.caller_security_events as event
    where event.tenant_id = state.tenant_id
      and event.caller_key = state.caller_key
      and event.risk_delta > 0
  ),
  state.updated_at,
  state.created_at,
  now()
)
where state.risk_score_updated_at is null;

alter table public.caller_security_state
  alter column risk_score_updated_at set default now(),
  alter column risk_score_updated_at set not null;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create or replace function private.apply_caller_security_risk_decay_v1(
  p_tenant_id text,
  p_caller_key text,
  p_now timestamptz default statement_timestamp()
)
returns public.caller_security_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  state public.caller_security_state%rowtype;
  elapsed_days integer;
  decay_by integer;
  next_baseline timestamptz;
begin
  select current_state.* into state
  from public.caller_security_state as current_state
  where current_state.tenant_id = p_tenant_id
    and current_state.caller_key = p_caller_key
  for update;

  if not found then raise exception 'caller_security_state_not_found'; end if;
  if p_now is null then raise exception 'decay_time_required'; end if;

  -- Permanent decisions require explicit human remediation. Automatic decay
  -- cannot weaken them, strikes, rate-limit history or active block windows.
  if state.permanent_block or state.risk_score = 0 or p_now <= state.risk_score_updated_at then
    return state;
  end if;

  elapsed_days := floor(extract(epoch from (p_now - state.risk_score_updated_at)) / 86400)::integer;
  if elapsed_days < 1 then return state; end if;

  decay_by := least(state.risk_score, elapsed_days);
  next_baseline := case
    when decay_by = state.risk_score then p_now
    else state.risk_score_updated_at + (elapsed_days * interval '1 day')
  end;

  update public.caller_security_state as current_state
  set risk_score = current_state.risk_score - decay_by,
      risk_score_updated_at = next_baseline,
      updated_at = p_now
  where current_state.tenant_id = p_tenant_id
    and current_state.caller_key = p_caller_key
  returning current_state.* into state;

  insert into public.caller_security_events (
    event_key,
    tenant_id,
    caller_key,
    event_type,
    severity,
    risk_delta,
    metadata
  ) values (
    format(
      'risk-decay-v1:%s:%s',
      extract(epoch from (next_baseline - (elapsed_days * interval '1 day')))::bigint,
      extract(epoch from next_baseline)::bigint
    ),
    p_tenant_id,
    p_caller_key,
    'RISK_SCORE_DECAY',
    'INFO',
    0,
    jsonb_build_object(
      'policy', 'ONE_POINT_PER_24H',
      'decayed_by', decay_by,
      'risk_score_after', state.risk_score,
      'raw_transcript_stored', false
    )
  )
  on conflict (tenant_id, caller_key, event_key) where event_key is not null do nothing;

  return state;
end;
$$;

revoke all on function private.apply_caller_security_risk_decay_v1(text, text, timestamptz)
  from public, anon, authenticated, service_role;

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
set search_path = ''
as $$
declare
  state public.caller_security_state%rowtype;
  inserted_id bigint;
  strikes_24h integer;
  should_permanent boolean := false;
  new_block_until timestamptz;
begin
  if p_event_key is null or btrim(p_event_key) = '' or length(p_event_key) > 200 then
    raise exception 'valid_event_key_required';
  end if;
  if p_tenant_id is null or btrim(p_tenant_id) = '' then raise exception 'tenant_id_required'; end if;
  if p_caller_key is null or p_caller_key !~ '^[a-f0-9]{64}$' then raise exception 'valid_caller_key_required'; end if;
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

  state := private.apply_caller_security_risk_decay_v1(p_tenant_id, p_caller_key, statement_timestamp());

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
      case when state.permanent_block or (state.blocked_until is not null and state.blocked_until > now())
        then 'BLOCK_FUTURE_CALLS' else 'ALLOW_FUTURE_CALLS' end,
      state.blocked_until,
      state.permanent_block,
      state.risk_score,
      state.security_strikes,
      coalesce(state.last_reason, p_event_type);
    return;
  end if;

  update public.caller_security_state as current_state
  set risk_score = least(100, current_state.risk_score + p_risk_delta),
      risk_score_updated_at = case
        when p_risk_delta > 0 then statement_timestamp()
        else current_state.risk_score_updated_at
      end,
      security_strikes = current_state.security_strikes + case when p_high_confidence then 1 else 0 end,
      last_reason = p_event_type,
      last_seen_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where current_state.tenant_id = p_tenant_id
    and current_state.caller_key = p_caller_key
  returning current_state.* into state;

  select count(*)::integer into strikes_24h
  from public.caller_security_events as event
  where event.tenant_id = p_tenant_id
    and event.caller_key = p_caller_key
    and event.severity in ('HIGH', 'CRITICAL')
    and event.created_at >= statement_timestamp() - interval '24 hours';

  if p_high_confidence and strikes_24h >= 2 then
    new_block_until := case
      when state.security_strikes <= 2 then statement_timestamp() + interval '1 hour'
      when state.security_strikes <= 4 then statement_timestamp() + interval '24 hours'
      else statement_timestamp() + interval '7 days'
    end;
    update public.caller_security_state as current_state
    set blocked_until = greatest(coalesce(current_state.blocked_until, 'epoch'::timestamptz), new_block_until),
        updated_at = statement_timestamp()
    where current_state.tenant_id = p_tenant_id
      and current_state.caller_key = p_caller_key
    returning current_state.* into state;
  end if;

  should_permanent := state.security_strikes >= 8
    and state.rate_limit_blocks >= 3
    and state.risk_score >= 25;
  if should_permanent then
    update public.caller_security_state as current_state
    set permanent_block = true,
        blocked_until = null,
        last_reason = 'PERSISTENT_HOSTILE_BEHAVIOR',
        updated_at = statement_timestamp()
    where current_state.tenant_id = p_tenant_id
      and current_state.caller_key = p_caller_key
    returning current_state.* into state;
  end if;

  return query select
    case when state.permanent_block or (state.blocked_until is not null and state.blocked_until > now())
      then 'BLOCK_FUTURE_CALLS' else 'ALLOW_FUTURE_CALLS' end,
    state.blocked_until,
    state.permanent_block,
    state.risk_score,
    state.security_strikes,
    case when state.permanent_block then 'PERSISTENT_HOSTILE_BEHAVIOR' else p_event_type end;
end;
$$;

revoke all on function public.record_caller_security_signal_v2(text, text, text, text, text, integer, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.record_caller_security_signal_v2(text, text, text, text, text, integer, jsonb, boolean)
  to service_role;

create or replace function public.evaluate_inbound_call_security_v2(
  p_event_key text,
  p_tenant_id text,
  p_caller_key text
)
returns table(
  decision text,
  blocked_until timestamptz,
  permanent_block boolean,
  calls_1m integer,
  calls_5m integer,
  calls_1h integer,
  risk_score integer,
  security_strikes integer,
  rate_limit_blocks integer,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  state public.caller_security_state%rowtype;
  inserted_id bigint;
  c1 integer;
  c5 integer;
  c60 integer;
  abusive boolean;
  new_block_until timestamptz;
  block_reason text;
begin
  if p_event_key is null or btrim(p_event_key) = '' or length(p_event_key) > 200 then
    raise exception 'valid_event_key_required';
  end if;
  if p_tenant_id is null or btrim(p_tenant_id) = '' then raise exception 'tenant_id_required'; end if;
  if p_caller_key is null or p_caller_key !~ '^[a-f0-9]{64}$' then raise exception 'valid_caller_key_required'; end if;

  insert into public.caller_security_state (tenant_id, caller_key, last_seen_at)
  values (p_tenant_id, p_caller_key, statement_timestamp())
  on conflict (tenant_id, caller_key) do update
    set last_seen_at = excluded.last_seen_at,
        updated_at = statement_timestamp();

  state := private.apply_caller_security_risk_decay_v1(p_tenant_id, p_caller_key, statement_timestamp());

  insert into public.caller_security_events (
    event_key, tenant_id, caller_key, event_type, severity
  ) values (
    p_event_key, p_tenant_id, p_caller_key, 'CALL_ATTEMPT', 'INFO'
  )
  on conflict (tenant_id, caller_key, event_key) where event_key is not null do nothing
  returning id into inserted_id;

  select count(*)::integer into c1
  from public.caller_security_events as event
  where event.tenant_id = p_tenant_id
    and event.caller_key = p_caller_key
    and event.event_type = 'CALL_ATTEMPT'
    and event.created_at >= statement_timestamp() - interval '1 minute';
  select count(*)::integer into c5
  from public.caller_security_events as event
  where event.tenant_id = p_tenant_id
    and event.caller_key = p_caller_key
    and event.event_type = 'CALL_ATTEMPT'
    and event.created_at >= statement_timestamp() - interval '5 minutes';
  select count(*)::integer into c60
  from public.caller_security_events as event
  where event.tenant_id = p_tenant_id
    and event.caller_key = p_caller_key
    and event.event_type = 'CALL_ATTEMPT'
    and event.created_at >= statement_timestamp() - interval '1 hour';

  if state.permanent_block then
    return query select 'BLOCK'::text, state.blocked_until, true, c1, c5, c60,
      state.risk_score, state.security_strikes, state.rate_limit_blocks, 'PERMANENT_BLOCK'::text;
    return;
  end if;
  if state.blocked_until is not null and state.blocked_until > statement_timestamp() then
    return query select 'BLOCK'::text, state.blocked_until, false, c1, c5, c60,
      state.risk_score, state.security_strikes, state.rate_limit_blocks, 'ACTIVE_TEMP_BLOCK'::text;
    return;
  end if;

  if inserted_id is null then
    return query select 'ALLOW'::text, null::timestamptz, false, c1, c5, c60,
      state.risk_score, state.security_strikes, state.rate_limit_blocks, 'DUPLICATE_EVENT'::text;
    return;
  end if;

  abusive := c1 >= 5 or c5 >= 8 or c60 >= 20;
  if abusive then
    block_reason := case when c1 >= 5 then 'CALL_RATE_1M' when c5 >= 8 then 'CALL_RATE_5M' else 'CALL_RATE_1H' end;
    new_block_until := case
      when state.rate_limit_blocks = 0 then statement_timestamp() + interval '1 hour'
      when state.rate_limit_blocks = 1 then statement_timestamp() + interval '24 hours'
      else statement_timestamp() + interval '7 days'
    end;
    update public.caller_security_state as current_state
    set rate_limit_blocks = current_state.rate_limit_blocks + 1,
        risk_score = least(100, current_state.risk_score + 3),
        risk_score_updated_at = statement_timestamp(),
        blocked_until = new_block_until,
        last_reason = block_reason,
        updated_at = statement_timestamp()
    where current_state.tenant_id = p_tenant_id
      and current_state.caller_key = p_caller_key
    returning current_state.* into state;

    insert into public.caller_security_events (
      event_key, tenant_id, caller_key, event_type, severity, risk_delta, metadata
    ) values (
      p_event_key || ':rate-limit-block', p_tenant_id, p_caller_key,
      'RATE_LIMIT_BLOCK', 'HIGH', 3,
      jsonb_build_object(
        'reason', block_reason,
        'calls_1m', c1,
        'calls_5m', c5,
        'calls_1h', c60,
        'blocked_until', new_block_until
      )
    )
    on conflict (tenant_id, caller_key, event_key) where event_key is not null do nothing;

    return query select 'BLOCK'::text, new_block_until, false, c1, c5, c60,
      state.risk_score, state.security_strikes, state.rate_limit_blocks, block_reason;
    return;
  end if;

  return query select 'ALLOW'::text, null::timestamptz, false, c1, c5, c60,
    state.risk_score, state.security_strikes, state.rate_limit_blocks, 'OK'::text;
end;
$$;

revoke all on function public.evaluate_inbound_call_security_v2(text, text, text)
  from public, anon, authenticated;
grant execute on function public.evaluate_inbound_call_security_v2(text, text, text)
  to service_role;

create or replace function public.admin_reset_caller_security_state_v1(
  p_event_key text,
  p_tenant_id text,
  p_caller_key text,
  p_reason text,
  p_admin_actor_hash text,
  p_reset_risk_score boolean default true,
  p_reset_security_strikes boolean default false,
  p_reset_rate_limit_blocks boolean default false,
  p_clear_temporary_block boolean default true,
  p_clear_permanent_block boolean default false
)
returns table(
  applied boolean,
  risk_score integer,
  security_strikes integer,
  rate_limit_blocks integer,
  blocked_until timestamptz,
  permanent_block boolean,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  state public.caller_security_state%rowtype;
  previous_state public.caller_security_state%rowtype;
  existing_event_id bigint;
begin
  if p_event_key is null or btrim(p_event_key) = '' or length(p_event_key) > 200 then
    raise exception 'valid_event_key_required';
  end if;
  if p_tenant_id is null or btrim(p_tenant_id) = '' then raise exception 'tenant_id_required'; end if;
  if p_caller_key is null or p_caller_key !~ '^[a-f0-9]{64}$' then raise exception 'valid_caller_key_required'; end if;
  if p_admin_actor_hash is null or p_admin_actor_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'valid_admin_actor_hash_required';
  end if;
  if p_reason not in (
    'FALSE_POSITIVE_CONFIRMED',
    'AUTHORIZED_TEST_CLEANUP',
    'INCIDENT_REMEDIATION',
    'DATA_CORRECTION'
  ) then raise exception 'valid_admin_reset_reason_required'; end if;
  if not coalesce(p_reset_risk_score, false)
    and not coalesce(p_reset_security_strikes, false)
    and not coalesce(p_reset_rate_limit_blocks, false)
    and not coalesce(p_clear_temporary_block, false)
    and not coalesce(p_clear_permanent_block, false)
  then raise exception 'admin_reset_requires_change'; end if;

  select current_state.* into state
  from public.caller_security_state as current_state
  where current_state.tenant_id = p_tenant_id
    and current_state.caller_key = p_caller_key
  for update;
  if not found then raise exception 'caller_security_state_not_found'; end if;

  select event.id into existing_event_id
  from public.caller_security_events as event
  where event.tenant_id = p_tenant_id
    and event.caller_key = p_caller_key
    and event.event_key = p_event_key;

  if existing_event_id is not null then
    return query select false, state.risk_score, state.security_strikes,
      state.rate_limit_blocks, state.blocked_until, state.permanent_block,
      'DUPLICATE_ADMIN_RESET'::text;
    return;
  end if;

  previous_state := state;
  update public.caller_security_state as current_state
  set risk_score = case when p_reset_risk_score then 0 else current_state.risk_score end,
      risk_score_updated_at = case when p_reset_risk_score then statement_timestamp() else current_state.risk_score_updated_at end,
      security_strikes = case when p_reset_security_strikes then 0 else current_state.security_strikes end,
      rate_limit_blocks = case when p_reset_rate_limit_blocks then 0 else current_state.rate_limit_blocks end,
      blocked_until = case when p_clear_temporary_block then null else current_state.blocked_until end,
      permanent_block = case when p_clear_permanent_block then false else current_state.permanent_block end,
      last_reason = p_reason,
      updated_at = statement_timestamp()
  where current_state.tenant_id = p_tenant_id
    and current_state.caller_key = p_caller_key
  returning current_state.* into state;

  insert into public.caller_security_events (
    event_key,
    tenant_id,
    caller_key,
    event_type,
    severity,
    risk_delta,
    metadata
  ) values (
    p_event_key,
    p_tenant_id,
    p_caller_key,
    'ADMIN_SECURITY_STATE_RESET',
    'INFO',
    0,
    jsonb_build_object(
      'reason', p_reason,
      'admin_actor_hash', p_admin_actor_hash,
      'risk_score_before', previous_state.risk_score,
      'risk_score_after', state.risk_score,
      'security_strikes_before', previous_state.security_strikes,
      'security_strikes_after', state.security_strikes,
      'rate_limit_blocks_before', previous_state.rate_limit_blocks,
      'rate_limit_blocks_after', state.rate_limit_blocks,
      'temporary_block_cleared', p_clear_temporary_block and previous_state.blocked_until is not null,
      'permanent_block_cleared', p_clear_permanent_block and previous_state.permanent_block,
      'raw_transcript_stored', false
    )
  );

  return query select true, state.risk_score, state.security_strikes,
    state.rate_limit_blocks, state.blocked_until, state.permanent_block,
    p_reason;
end;
$$;

revoke all on function public.admin_reset_caller_security_state_v1(
  text, text, text, text, text, boolean, boolean, boolean, boolean, boolean
) from public, anon, authenticated, service_role;

comment on column public.caller_security_state.risk_score_updated_at
  is 'Baseline for lazy risk decay; normal calls do not postpone decay.';
comment on function private.apply_caller_security_risk_decay_v1(text, text, timestamptz)
  is 'Lazily subtracts one risk point per full 24h without weakening strikes or blocks.';
comment on function public.admin_reset_caller_security_state_v1(
  text, text, text, text, text, boolean, boolean, boolean, boolean, boolean
) is 'Postgres-admin-only idempotent remediation with bounded reason, hashed actor and before/after audit.';
