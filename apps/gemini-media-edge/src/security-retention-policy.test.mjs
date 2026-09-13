import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const migrationDirectory = resolve(import.meta.dirname, "../../../supabase/migrations");
const migrationNames = readdirSync(migrationDirectory).filter((name) =>
  name.endsWith("_security_retention_and_deletion.sql"),
);
const safetyMigrationNames = readdirSync(migrationDirectory).filter((name) =>
  name.endsWith("_fix_security_retention_safety.sql"),
);

assert.equal(migrationNames.length, 1, "exactly one SEC-P1-04 migration must exist");
assert.equal(
  safetyMigrationNames.length,
  1,
  "exactly one forward SEC-P1-04 safety migration must exist",
);
const sql = readFileSync(resolve(migrationDirectory, migrationNames[0]), "utf8");
const safetySql = readFileSync(
  resolve(migrationDirectory, safetyMigrationNames[0]),
  "utf8",
);

test("SEC-P1-04 keeps maintenance outside public runtime authority", () => {
  assert.match(sql, /create or replace function private\.run_security_retention_v1/i);
  assert.match(sql, /security invoker/i);
  assert.match(
    sql,
    /revoke all on function private\.run_security_retention_v1[\s\S]*from public, anon, authenticated, service_role/i,
  );
  assert.doesNotMatch(sql, /security definer/i);
  assert.doesNotMatch(sql, /grant\s+execute/i);
});

test("SEC-P1-04 enforces the approved retention windows", () => {
  for (const retentionWindow of [
    "interval '7 days'",
    "interval '30 days'",
    "interval '90 days'",
    "interval '365 days'",
  ]) {
    assert.ok(sql.includes(retentionWindow), `missing retention window ${retentionWindow}`);
  }

  assert.match(sql, /event\.event_type = 'CALL_ATTEMPT'[\s\S]*interval '7 days'/i);
  assert.match(sql, /event\.severity not in \('HIGH', 'CRITICAL'\)[\s\S]*interval '30 days'/i);
  assert.match(sql, /event\.severity in \('HIGH', 'CRITICAL'\)[\s\S]*interval '90 days'/i);
  assert.match(sql, /event\.event_type = 'ADMIN_SECURITY_STATE_RESET'[\s\S]*interval '365 days'/i);
});

test("SEC-P1-04 protects active security decisions and unresolved callbacks", () => {
  const callerStateDelete = sql.match(
    /with candidates as \(\s*select state\.tenant_id, state\.caller_key[\s\S]*?get diagnostics affected = row_count;/i,
  )?.[0];
  assert.ok(callerStateDelete, "bounded caller-state deletion is required");
  assert.match(
    callerStateDelete,
    /state\.permanent_block = false[\s\S]*state\.risk_score = 0[\s\S]*state\.security_strikes = 0[\s\S]*state\.rate_limit_blocks = 0[\s\S]*state\.blocked_until is null[\s\S]*interval '90 days'/i,
  );
  assert.doesNotMatch(callerStateDelete, /permanent_block = true/i);
  assert.match(
    sql,
    /'CALLBACK_REQUIRED'[\s\S]*handoff\.callback_required = false[\s\S]*'RESOLVED', 'UNREACHABLE', 'CANCELLED'/i,
  );
  assert.match(sql, /callbacks_due_review[\s\S]*interval '30 days'/i);
  assert.match(sql, /callbacks_overdue_review[\s\S]*interval '90 days'/i);
});

test("SEC-P1-04 bounds work and avoids concurrent cleanup", () => {
  assert.match(sql, /p_batch_size integer default 1000/i);
  assert.match(sql, /p_max_rows integer default 10000/i);
  assert.match(sql, /pg_try_advisory_xact_lock/i);
  assert.match(sql, /set_config\('lock_timeout', '250ms', true\)/i);
  assert.match(sql, /set_config\('statement_timeout', '30s', true\)/i);
  assert.ok((sql.match(/for update skip locked/gi) ?? []).length >= 8);
  assert.ok((sql.match(/create index concurrently/gi) ?? []).length >= 5);
});

test("SEC-P1-04 schedules one daily aggregate-only maintenance job", () => {
  assert.match(
    sql,
    /cron\.schedule\([\s\S]*'purge-gemini-security-retention-v1'[\s\S]*'17 3 \* \* \*'/i,
  );
  assert.match(
    sql,
    /set statement_timeout = '30s';[\s\S]*select private\.run_security_retention_v1\(\);/i,
  );
  assert.match(sql, /cron\.unschedule\(existing_job\.jobid\)/i);
  assert.doesNotMatch(sql, /(insert|update|delete)\s+(into\s+)?cron\.job/i);

  const auditTable = sql.match(
    /create table if not exists private\.security_retention_runs \(([\s\S]*?)\n\);/i,
  )?.[1];
  assert.ok(auditTable, "aggregate retention audit table is required");
  assert.doesNotMatch(auditTable, /caller_key|phone|call_id|tenant_id|metadata|details/i);
});

test("SEC-P1-04 forward migration repairs the already-deployed authority", () => {
  assert.match(
    safetySql,
    /state\.risk_score = 0[\s\S]*state\.security_strikes = 0[\s\S]*state\.rate_limit_blocks = 0/i,
  );
  assert.match(
    safetySql,
    /set statement_timeout = '30s';[\s\S]*set lock_timeout = '250ms';[\s\S]*select private\.run_security_retention_v1\(\);/i,
  );
  assert.match(safetySql, /cron\.unschedule\(existing_job\.jobid\)/i);
  assert.doesNotMatch(safetySql, /(insert|update|delete)\s+(into\s+)?cron\.job/i);
});
