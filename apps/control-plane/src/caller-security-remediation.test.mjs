import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("all in-call high confidence boundaries use durable signal delivery and lifecycle authority", () => {
  for (const file of ["./call-session-v17.ts", "./call-session-v33.ts", "./call-session-v34.ts"]) {
    const source = read(file);
    assert.match(source, /recordCallerSecuritySignalDurably\(this/);
    assert.match(source, /conversationLifecyclePortFor\(this\)\.confirmEndCall/);
  }
});

test("inbound security store failure rejects instead of transferring the call", () => {
  const source = read("./index-v4.ts");
  const catchBody = source.slice(source.indexOf('event: "caller_security_inbound_check_failed_closed"'));
  assert.match(catchBody, /rejectSecurityBlockedCall/);
  assert.match(catchBody, /action: "security_unavailable_reject"/);
  assert.ok(catchBody.indexOf("security_unavailable_reject") < catchBody.indexOf("transferToRealtime"));
  assert.doesNotMatch(source, /caller_security_inbound_check_failed_open|Fail open/);
});

test("queue consumer retries valid failed messages and discards malformed messages", () => {
  const source = read("./index-v6.ts");
  assert.match(source, /recordSignalByCallerKey\(message\.body\)/);
  assert.match(source, /message\.retry\(\)/);
  assert.match(source, /caller_security_signal_queue_invalid/);
  assert.match(source, /message\.ack\(\)/);
});

test("idempotent RPC mutates caller state only after a new event was inserted", () => {
  const migration = read("../../../supabase/migrations/20260822143000_idempotent_caller_security_signals.sql");
  assert.match(migration, /caller_security_events_idempotency_idx/);
  assert.match(migration, /on conflict \(tenant_id, caller_key, event_key\)[\s\S]*do nothing/);
  assert.match(migration, /if inserted_id is null then[\s\S]*return;/);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, public/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
});
