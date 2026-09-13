-- SEC-P1-04 follow-up: preserve escalation history and bound scheduled runs.
-- The first migration was already applied before review feedback arrived, so
-- this forward-only migration brings production and fresh replays to the same
-- corrected end state without editing remote migration history.

create or replace function private.run_security_retention_v1(
  p_now timestamptz default statement_timestamp(),
  p_batch_size integer default 1000,
  p_max_rows integer default 10000
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  run_started_at timestamptz := clock_timestamp();
  run_id bigint;
  affected integer;
  pass_deleted integer;
  remaining integer;
  diagnostics_deleted integer := 0;
  call_attempts_deleted integer := 0;
  ordinary_security_events_deleted integer := 0;
  high_security_events_deleted integer := 0;
  administrative_events_deleted integer := 0;
  inactive_caller_states_deleted integer := 0;
  completed_handoffs_deleted integer := 0;
  retention_audit_rows_deleted integer := 0;
  permanent_blocks_due_review integer := 0;
  callbacks_due_review integer := 0;
  callbacks_overdue_review integer := 0;
  total_deleted integer := 0;
begin
  if p_now is null then raise exception 'retention_time_required'; end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 1000 then
    raise exception 'retention_batch_size_out_of_range';
  end if;
  if p_max_rows is null or p_max_rows < 1 or p_max_rows > 10000 then
    raise exception 'retention_max_rows_out_of_range';
  end if;

  -- A second scheduler or manual run exits without waiting for the active run.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('private.run_security_retention_v1')
  ) then
    return null;
  end if;

  perform pg_catalog.set_config('lock_timeout', '250ms', true);
  perform pg_catalog.set_config('statement_timeout', '30s', true);

  loop
    pass_deleted := 0;

    remaining := p_max_rows - total_deleted;
    exit when remaining <= 0;
    with candidates as (
      select event.id
      from public.call_diagnostic_events as event
      where event.created_at < p_now - interval '7 days'
      order by event.created_at, event.id
      limit least(p_batch_size, remaining)
      for update skip locked
    )
    delete from public.call_diagnostic_events as event
    using candidates
    where event.id = candidates.id;
    get diagnostics affected = row_count;
    diagnostics_deleted := diagnostics_deleted + affected;
    total_deleted := total_deleted + affected;
    pass_deleted := pass_deleted + affected;

    remaining := p_max_rows - total_deleted;
    exit when remaining <= 0;
    with candidates as (
      select event.id
      from public.caller_security_events as event
      where event.event_type = 'CALL_ATTEMPT'
        and event.created_at < p_now - interval '7 days'
      order by event.created_at, event.id
      limit least(p_batch_size, remaining)
      for update skip locked
    )
    delete from public.caller_security_events as event
    using candidates
    where event.id = candidates.id;
    get diagnostics affected = row_count;
    call_attempts_deleted := call_attempts_deleted + affected;
    total_deleted := total_deleted + affected;
    pass_deleted := pass_deleted + affected;

    remaining := p_max_rows - total_deleted;
    exit when remaining <= 0;
    with candidates as (
      select event.id
      from public.caller_security_events as event
      where event.event_type <> 'ADMIN_SECURITY_STATE_RESET'
        and event.event_type <> 'CALL_ATTEMPT'
        and event.severity not in ('HIGH', 'CRITICAL')
        and event.created_at < p_now - interval '30 days'
      order by event.created_at, event.id
      limit least(p_batch_size, remaining)
      for update skip locked
    )
    delete from public.caller_security_events as event
    using candidates
    where event.id = candidates.id;
    get diagnostics affected = row_count;
    ordinary_security_events_deleted := ordinary_security_events_deleted + affected;
    total_deleted := total_deleted + affected;
    pass_deleted := pass_deleted + affected;

    remaining := p_max_rows - total_deleted;
    exit when remaining <= 0;
    with candidates as (
      select event.id
      from public.caller_security_events as event
      where event.event_type <> 'ADMIN_SECURITY_STATE_RESET'
        and event.severity in ('HIGH', 'CRITICAL')
        and event.created_at < p_now - interval '90 days'
      order by event.created_at, event.id
      limit least(p_batch_size, remaining)
      for update skip locked
    )
    delete from public.caller_security_events as event
    using candidates
    where event.id = candidates.id;
    get diagnostics affected = row_count;
    high_security_events_deleted := high_security_events_deleted + affected;
    total_deleted := total_deleted + affected;
    pass_deleted := pass_deleted + affected;

    remaining := p_max_rows - total_deleted;
    exit when remaining <= 0;
    with candidates as (
      select event.id
      from public.caller_security_events as event
      where event.event_type = 'ADMIN_SECURITY_STATE_RESET'
        and event.created_at < p_now - interval '365 days'
      order by event.created_at, event.id
      limit least(p_batch_size, remaining)
      for update skip locked
    )
    delete from public.caller_security_events as event
    using candidates
    where event.id = candidates.id;
    get diagnostics affected = row_count;
    administrative_events_deleted := administrative_events_deleted + affected;
    total_deleted := total_deleted + affected;
    pass_deleted := pass_deleted + affected;

    remaining := p_max_rows - total_deleted;
    exit when remaining <= 0;
    with candidates as (
      select state.tenant_id, state.caller_key
      from public.caller_security_state as state
      where state.permanent_block = false
        and state.risk_score = 0
        and state.security_strikes = 0
        and state.rate_limit_blocks = 0
        and coalesce(state.last_seen_at, state.updated_at, state.created_at)
          < p_now - interval '90 days'
        and state.updated_at < p_now - interval '90 days'
        and (
          state.blocked_until is null
          or state.blocked_until < p_now - interval '90 days'
        )
      order by coalesce(state.last_seen_at, state.updated_at, state.created_at),
        state.tenant_id, state.caller_key
      limit least(p_batch_size, remaining)
      for update skip locked
    )
    delete from public.caller_security_state as state
    using candidates
    where state.tenant_id = candidates.tenant_id
      and state.caller_key = candidates.caller_key;
    get diagnostics affected = row_count;
    inactive_caller_states_deleted := inactive_caller_states_deleted + affected;
    total_deleted := total_deleted + affected;
    pass_deleted := pass_deleted + affected;

    remaining := p_max_rows - total_deleted;
    exit when remaining <= 0;
    with candidates as (
      select handoff.id
      from public.human_handoff_events as handoff
      where handoff.status in (
          'TRANSFERRED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CALLBACK_REQUIRED', 'TERMINATED'
        )
        and (
          handoff.callback_required = false
          or handoff.callback_status in ('RESOLVED', 'UNREACHABLE', 'CANCELLED')
        )
        and handoff.updated_at < p_now - interval '30 days'
      order by handoff.updated_at, handoff.id
      limit least(p_batch_size, remaining)
      for update skip locked
    )
    delete from public.human_handoff_events as handoff
    using candidates
    where handoff.id = candidates.id;
    get diagnostics affected = row_count;
    completed_handoffs_deleted := completed_handoffs_deleted + affected;
    total_deleted := total_deleted + affected;
    pass_deleted := pass_deleted + affected;

    remaining := p_max_rows - total_deleted;
    exit when remaining <= 0;
    with candidates as (
      select retention_run.id
      from private.security_retention_runs as retention_run
      where retention_run.completed_at < p_now - interval '365 days'
      order by retention_run.completed_at, retention_run.id
      limit least(p_batch_size, remaining)
      for update skip locked
    )
    delete from private.security_retention_runs as retention_run
    using candidates
    where retention_run.id = candidates.id;
    get diagnostics affected = row_count;
    retention_audit_rows_deleted := retention_audit_rows_deleted + affected;
    total_deleted := total_deleted + affected;
    pass_deleted := pass_deleted + affected;

    exit when pass_deleted = 0 or total_deleted >= p_max_rows;
  end loop;

  select count(*)::integer into permanent_blocks_due_review
  from public.caller_security_state as state
  where state.permanent_block = true
    and state.updated_at < p_now - interval '365 days';

  select count(*)::integer into callbacks_due_review
  from public.human_handoff_events as handoff
  where handoff.callback_required = true
    and coalesce(handoff.callback_status, 'PENDING') = 'PENDING'
    and handoff.updated_at < p_now - interval '30 days';

  select count(*)::integer into callbacks_overdue_review
  from public.human_handoff_events as handoff
  where handoff.callback_required = true
    and coalesce(handoff.callback_status, 'PENDING') = 'PENDING'
    and handoff.updated_at < p_now - interval '90 days';

  insert into private.security_retention_runs (
    started_at,
    completed_at,
    diagnostics_deleted,
    call_attempts_deleted,
    ordinary_security_events_deleted,
    high_security_events_deleted,
    administrative_events_deleted,
    inactive_caller_states_deleted,
    completed_handoffs_deleted,
    retention_audit_rows_deleted,
    permanent_blocks_due_review,
    callbacks_due_review,
    callbacks_overdue_review,
    total_deleted,
    batch_size,
    max_rows
  ) values (
    run_started_at,
    clock_timestamp(),
    diagnostics_deleted,
    call_attempts_deleted,
    ordinary_security_events_deleted,
    high_security_events_deleted,
    administrative_events_deleted,
    inactive_caller_states_deleted,
    completed_handoffs_deleted,
    retention_audit_rows_deleted,
    permanent_blocks_due_review,
    callbacks_due_review,
    callbacks_overdue_review,
    total_deleted,
    p_batch_size,
    p_max_rows
  )
  returning id into run_id;

  return run_id;
end;
$$;

revoke all on function private.run_security_retention_v1(timestamptz, integer, integer)
  from public, anon, authenticated, service_role;

comment on function private.run_security_retention_v1(timestamptz, integer, integer) is
  'Daily bounded SEC-P1-04 purge. Deletes at most 10000 rows in batches of at most 1000 and records aggregate evidence only.';

-- Replace the earlier unbounded hourly diagnostic purge with the consolidated
-- daily maintenance authority. Jobs are modified only through pg_cron APIs.
do $$
declare
  existing_job record;
begin
  for existing_job in
    select job.jobid
    from cron.job as job
    where job.jobname in (
      'purge-redacted-call-diagnostics-7d',
      'purge-gemini-security-retention-v1'
    )
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'purge-gemini-security-retention-v1',
  '17 3 * * *',
  $$
    set statement_timeout = '30s';
    set lock_timeout = '250ms';
    select private.run_security_retention_v1();
  $$
);
