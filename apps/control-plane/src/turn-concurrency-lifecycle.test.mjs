import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnConcurrencyLifecycle, isUsableCompletedTranscript } from '../.test-dist/turn-concurrency-lifecycle.js';

test('acquires only one active turn at a time', () => {
  const lifecycle = new TurnConcurrencyLifecycle();
  assert.equal(lifecycle.acquire(100), true);
  assert.equal(lifecycle.acquire(200), false);
  assert.equal(lifecycle.isActive(), true);
  assert.equal(lifecycle.ageMs(350), 250);
});

test('release allows the next turn', () => {
  const lifecycle = new TurnConcurrencyLifecycle();
  lifecycle.acquire(100);
  assert.equal(lifecycle.release(), true);
  assert.equal(lifecycle.release(), false);
  assert.equal(lifecycle.isActive(), false);
  assert.equal(lifecycle.ageMs(500), null);
  assert.equal(lifecycle.acquire(600), true);
});

test('completed transcript must contain semantic text before acquiring concurrency', () => {
  assert.equal(isUsableCompletedTranscript(undefined), false);
  assert.equal(isUsableCompletedTranscript(null), false);
  assert.equal(isUsableCompletedTranscript(''), false);
  assert.equal(isUsableCompletedTranscript('   '), false);
  assert.equal(isUsableCompletedTranscript('Hola'), true);
  assert.equal(isUsableCompletedTranscript('  Quiero reservar  '), true);
});
