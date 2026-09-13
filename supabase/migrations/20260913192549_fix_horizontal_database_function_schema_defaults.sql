-- SEC-P1-05 follow-up: Supabase grants function execution at schema scope.
-- Remove those direct defaults so every future public function must opt in
-- to one declared execution profile.

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;
