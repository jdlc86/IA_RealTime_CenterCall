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
  s public.caller_security_state%rowtype;
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
  if p_caller_key is null or btrim(p_caller_key) = '' then raise exception 'caller_key_required'; end if;

  insert into public.caller_security_state (tenant_id, caller_key, last_seen_at)
  values (p_tenant_id, p_caller_key, now())
  on conflict (tenant_id, caller_key) do update
    set last_seen_at = excluded.last_seen_at,
        updated_at = now();

  select cs.* into s
  from public.caller_security_state as cs
  where cs.tenant_id = p_tenant_id and cs.caller_key = p_caller_key
  for update;

  insert into public.caller_security_events (
    event_key, tenant_id, caller_key, event_type, severity
  ) values (
    p_event_key, p_tenant_id, p_caller_key, 'CALL_ATTEMPT', 'INFO'
  )
  on conflict (tenant_id, caller_key, event_key) where event_key is not null do nothing
  returning id into inserted_id;

  select count(*)::integer into c1
  from public.caller_security_events as e
  where e.tenant_id = p_tenant_id
    and e.caller_key = p_caller_key
    and e.event_type = 'CALL_ATTEMPT'
    and e.created_at >= now() - interval '1 minute';
  select count(*)::integer into c5
  from public.caller_security_events as e
  where e.tenant_id = p_tenant_id
    and e.caller_key = p_caller_key
    and e.event_type = 'CALL_ATTEMPT'
    and e.created_at >= now() - interval '5 minutes';
  select count(*)::integer into c60
  from public.caller_security_events as e
  where e.tenant_id = p_tenant_id
    and e.caller_key = p_caller_key
    and e.event_type = 'CALL_ATTEMPT'
    and e.created_at >= now() - interval '1 hour';

  if s.permanent_block then
    return query select 'BLOCK'::text, s.blocked_until, true, c1, c5, c60,
      s.risk_score, s.security_strikes, s.rate_limit_blocks, 'PERMANENT_BLOCK'::text;
    return;
  end if;
  if s.blocked_until is not null and s.blocked_until > now() then
    return query select 'BLOCK'::text, s.blocked_until, false, c1, c5, c60,
      s.risk_score, s.security_strikes, s.rate_limit_blocks, 'ACTIVE_TEMP_BLOCK'::text;
    return;
  end if;

  if inserted_id is null then
    return query select 'ALLOW'::text, null::timestamptz, false, c1, c5, c60,
      s.risk_score, s.security_strikes, s.rate_limit_blocks, 'DUPLICATE_EVENT'::text;
    return;
  end if;

  abusive := c1 >= 5 or c5 >= 8 or c60 >= 20;
  if abusive then
    block_reason := case when c1 >= 5 then 'CALL_RATE_1M' when c5 >= 8 then 'CALL_RATE_5M' else 'CALL_RATE_1H' end;
    new_block_until := case
      when s.rate_limit_blocks = 0 then now() + interval '1 hour'
      when s.rate_limit_blocks = 1 then now() + interval '24 hours'
      else now() + interval '7 days'
    end;
    update public.caller_security_state as cs
    set rate_limit_blocks = cs.rate_limit_blocks + 1,
        risk_score = least(100, cs.risk_score + 3),
        blocked_until = new_block_until,
        last_reason = block_reason,
        updated_at = now()
    where cs.tenant_id = p_tenant_id and cs.caller_key = p_caller_key
    returning cs.* into s;

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
      s.risk_score, s.security_strikes, s.rate_limit_blocks, block_reason;
    return;
  end if;

  return query select 'ALLOW'::text, null::timestamptz, false, c1, c5, c60,
    s.risk_score, s.security_strikes, s.rate_limit_blocks, 'OK'::text;
end;
$$;

revoke all on function public.evaluate_inbound_call_security_v2(text, text, text)
  from public, anon, authenticated;
grant execute on function public.evaluate_inbound_call_security_v2(text, text, text)
  to service_role;

comment on function public.evaluate_inbound_call_security_v2(text, text, text)
  is 'Evaluates each signed inbound Telnyx event exactly once per tenant and caller HMAC.';
