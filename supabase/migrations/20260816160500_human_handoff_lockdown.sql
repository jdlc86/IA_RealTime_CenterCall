revoke all privileges on table public.human_handoff_events from anon, authenticated;
grant select, insert, update, delete on table public.human_handoff_events to service_role;
