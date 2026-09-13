-- Caller-security state is backend-only. Keep the service-role integration intact
-- while removing direct PostgREST access for public application roles.

alter table public.caller_security_state enable row level security;
alter table public.caller_security_events enable row level security;

revoke all privileges on table public.caller_security_state
  from public, anon, authenticated;
revoke all privileges on table public.caller_security_events
  from public, anon, authenticated;
revoke all privileges on sequence public.caller_security_events_id_seq
  from public, anon, authenticated;

grant all privileges on table public.caller_security_state to service_role;
grant all privileges on table public.caller_security_events to service_role;
grant all privileges on sequence public.caller_security_events_id_seq to service_role;

revoke all privileges on function public.evaluate_inbound_call_security(text, text)
  from public, anon, authenticated;
grant execute on function public.evaluate_inbound_call_security(text, text)
  to service_role;
alter function public.evaluate_inbound_call_security(text, text)
  set search_path = pg_catalog, public;

revoke all privileges on function public.record_caller_security_signal(text, text, text, text, integer, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.record_caller_security_signal(text, text, text, text, integer, jsonb, boolean)
  to service_role;
alter function public.record_caller_security_signal(text, text, text, text, integer, jsonb, boolean)
  set search_path = pg_catalog, public;
