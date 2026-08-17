import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNonInterruptingListeningEvent, buildBargeInClassifierResponse, parseBargeInDecision } from '../.test-dist/barge-in-confirmation.js';

test('non-interrupting listening keeps VAD active but disables auto response and interruption', () => {
  const event = buildNonInterruptingListeningEvent({ threshold: 0.61, prefixPaddingMs: 250, silenceDurationMs: 450, idleTimeoutMs: 9000 });
  const vad = event.session.audio.input.turn_detection;
  assert.equal(vad.type, 'server_vad');
  assert.equal(vad.threshold, 0.61);
  assert.equal(vad.create_response, false);
  assert.equal(vad.interrupt_response, false);
});

test('barge-in classifier is out-of-band and text-only', () => {
  const event = buildBargeInClassifierResponse('espera un momento', 'msg_123');
  assert.equal(event.type, 'response.create');
  assert.equal(event.response.conversation, 'none');
  assert.deepEqual(event.response.output_modalities, ['text']);
  assert.equal(event.response.metadata.source_item_id, 'msg_123');
});

test('barge-in decision fails closed to IGNORE', () => {
  assert.equal(parseBargeInDecision('INTERRUPT'), 'INTERRUPT');
  assert.equal(parseBargeInDecision(' interrupt. '), 'INTERRUPT');
  assert.equal(parseBargeInDecision('IGNORE'), 'IGNORE');
  assert.equal(parseBargeInDecision('maybe'), 'IGNORE');
  assert.equal(parseBargeInDecision(null), 'IGNORE');
});
