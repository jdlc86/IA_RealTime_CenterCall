create or replace function public.preserve_human_handoff_failure_outcome()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status in ('NO_ANSWER', 'BUSY', 'FAILED') and new.status = 'TERMINATED' then
    new.status := old.status;
    new.failure_reason := old.failure_reason;
    new.transfer_ended_at := coalesce(old.transfer_ended_at, new.transfer_ended_at);
    new.callback_required := old.callback_required;
    new.callback_status := old.callback_status;
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_human_handoff_failure_outcome_trg on public.human_handoff_events;
create trigger preserve_human_handoff_failure_outcome_trg
before update on public.human_handoff_events
for each row execute function public.preserve_human_handoff_failure_outcome();
