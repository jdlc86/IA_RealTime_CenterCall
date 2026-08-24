import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritativeTemporalContextPortFor,
  installAuthoritativeTemporalContextPort,
  removeAuthoritativeTemporalContextPort,
} from "../.test-dist/authoritative-temporal-context-runtime.js";

function host() {
  const events = [];
  return {
    events,
    send(event) { events.push(event); },
  };
}

test("OpenAI fallback keeps authoritative time refresh on the existing realtime policy path", () => {
  const h = host();
  authoritativeTemporalContextPortFor(h).refresh({
    baseInstructions: "BASE_POLICY",
    now: new Date("2026-08-24T01:30:00.000Z"),
  });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].type, "session.update");
  assert.match(h.events[0].session?.instructions ?? "", /BASE_POLICY/);
  assert.match(h.events[0].session?.instructions ?? "", /AUTHORITATIVE_NOW_V48/);
  assert.match(h.events[0].session?.instructions ?? "", /Europe\/Madrid/);
});

test("external authoritative temporal context overrides refresh for exactly one session", () => {
  const h = host();
  const effects = [];
  const external = { refresh(request) { effects.push(request); } };
  const fallback = authoritativeTemporalContextPortFor(h);

  installAuthoritativeTemporalContextPort(h, external);
  const selected = authoritativeTemporalContextPortFor(h);
  assert.equal(selected, external);
  selected.refresh({ baseInstructions: "BASE", now: new Date("2026-08-24T01:30:00.000Z") });
  assert.equal(effects.length, 1);
  assert.equal(h.events.length, 0);

  removeAuthoritativeTemporalContextPort(h, external);
  assert.equal(authoritativeTemporalContextPortFor(h), fallback);
});

test("external authoritative temporal context ownership is fail-closed", () => {
  const h = host();
  const first = { refresh() {} };
  const second = { refresh() {} };

  installAuthoritativeTemporalContextPort(h, first);
  assert.doesNotThrow(() => installAuthoritativeTemporalContextPort(h, first));
  assert.throws(() => installAuthoritativeTemporalContextPort(h, second), /already installed/);
  assert.throws(() => removeAuthoritativeTemporalContextPort(h, second), /ownership mismatch/);
  assert.equal(authoritativeTemporalContextPortFor(h), first);
  removeAuthoritativeTemporalContextPort(h, first);
});
