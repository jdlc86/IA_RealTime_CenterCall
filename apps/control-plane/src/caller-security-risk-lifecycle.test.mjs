import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260829200938_caller_security_risk_lifecycle.sql", import.meta.url),
  "utf8",
);

test("SEC-P1-02 decays risk once per complete day without weakening blocks or strikes", () => {
  assert.match(migration, /risk_score_updated_at/);
  assert.match(migration, /elapsed_days := floor\([\s\S]*\/ 86400\)/);
  assert.match(migration, /decay_by := least\(state\.risk_score, elapsed_days\)/);
  assert.match(migration, /if state\.permanent_block or state\.risk_score = 0/);
  const helper = migration.slice(
    migration.indexOf("create or replace function private.apply_caller_security_risk_decay_v1"),
    migration.indexOf("create or replace function public.record_caller_security_signal_v2"),
  );
  assert.doesNotMatch(helper, /security_strikes\s*=/);
  assert.doesNotMatch(helper, /rate_limit_blocks\s*=/);
  assert.doesNotMatch(helper, /blocked_until\s*=/);
});

test("SEC-P1-02 applies decay inside existing RPCs without a new Worker network call", () => {
  assert.equal((migration.match(/state := private\.apply_caller_security_risk_decay_v1\(/g) ?? []).length, 2);
  assert.match(migration, /record_caller_security_signal_v2[\s\S]*state := private\.apply_caller_security_risk_decay_v1/);
  assert.match(migration, /evaluate_inbound_call_security_v2[\s\S]*state := private\.apply_caller_security_risk_decay_v1/);
});

test("SEC-P1-02 keeps automatic RPCs service-role-only and reset postgres-admin-only", () => {
  assert.match(migration, /revoke all on function public\.record_caller_security_signal_v2[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.record_caller_security_signal_v2[\s\S]*to service_role/);
  assert.match(migration, /grant execute on function public\.evaluate_inbound_call_security_v2[\s\S]*to service_role/);
  assert.match(migration, /revoke all on function public\.admin_reset_caller_security_state_v1\([\s\S]*\) from public, anon, authenticated, service_role/);
  assert.doesNotMatch(migration, /grant execute on function public\.admin_reset_caller_security_state_v1/);
});

test("SEC-P1-02 requires idempotency, bounded reason and a hashed admin actor", () => {
  assert.match(migration, /valid_admin_actor_hash_required/);
  assert.match(migration, /valid_admin_reset_reason_required/);
  assert.match(migration, /FALSE_POSITIVE_CONFIRMED/);
  assert.match(migration, /AUTHORIZED_TEST_CLEANUP/);
  assert.match(migration, /DUPLICATE_ADMIN_RESET/);
  assert.match(migration, /ADMIN_SECURITY_STATE_RESET/);
  assert.match(migration, /raw_transcript_stored/);
});
