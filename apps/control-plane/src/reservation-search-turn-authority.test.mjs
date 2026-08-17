import test from "node:test";
import assert from "node:assert/strict";
import {
  decideReservationSearch,
  initialReservationSearchAuthorityState,
  noteReservationSearchCallerTurn,
} from "../.test-dist/reservation-search-turn-authority.js";

test("only one reservation search is allowed per caller turn", () => {
  let state = initialReservationSearchAuthorityState();
  state = noteReservationSearchCallerTurn(state, "item-1");

  const first = decideReservationSearch(state);
  assert.equal(first.kind, "ALLOW");
  state = first.state;

  const second = decideReservationSearch(state);
  assert.equal(second.kind, "BLOCK_AND_RECOVER");
  assert.equal(second.reason, "SEARCH_ALREADY_EXECUTED_THIS_TURN");
  state = second.state;

  const third = decideReservationSearch(state);
  assert.equal(third.kind, "BLOCK_SILENT");
  assert.equal(third.reason, "SEARCH_ALREADY_EXECUTED_THIS_TURN");
});

test("a new caller turn opens exactly one new search opportunity", () => {
  let state = noteReservationSearchCallerTurn(initialReservationSearchAuthorityState(), "item-1");
  state = decideReservationSearch(state).state;
  state = decideReservationSearch(state).state;

  state = noteReservationSearchCallerTurn(state, "item-2");
  const nextTurn = decideReservationSearch(state);
  assert.equal(nextTurn.kind, "ALLOW");

  const duplicate = decideReservationSearch(nextTurn.state);
  assert.equal(duplicate.kind, "BLOCK_AND_RECOVER");
});

test("changing search arguments without a new caller turn does not grant authority", () => {
  let state = noteReservationSearchCallerTurn(initialReservationSearchAuthorityState(), "item-1");
  const first = decideReservationSearch(state);
  assert.equal(first.kind, "ALLOW");

  // The authority policy intentionally has no argument-dependent reset.
  // Different time ranges, limits or party sizes are still a second search
  // until the caller supplies a new turn.
  const changedArguments = decideReservationSearch(first.state);
  assert.equal(changedArguments.kind, "BLOCK_AND_RECOVER");
});

test("autonomous search without caller evidence fails closed and cannot loop", () => {
  const initial = initialReservationSearchAuthorityState();
  const first = decideReservationSearch(initial);
  assert.equal(first.kind, "BLOCK_AND_RECOVER");
  assert.equal(first.reason, "NO_CALLER_TURN");

  const repeated = decideReservationSearch(first.state);
  assert.equal(repeated.kind, "BLOCK_SILENT");
  assert.equal(repeated.reason, "NO_CALLER_TURN");
});
