-- SEC-P1-05: horizontal database-function boundary.
-- Existing functions retain their current behavior and are adopted separately.
-- New postgres-owned functions start with no client EXECUTE privilege.

alter default privileges for role postgres
  revoke execute on functions from public;

alter default privileges for role postgres
  revoke execute on functions from anon, authenticated;
