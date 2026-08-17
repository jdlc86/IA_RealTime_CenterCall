import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialConversationLifecycle,
  reduceConversationLifecycle,
} from '../../.test-dist/conversation-lifecycle-model.js';

function run(events) {
  let state = initialConversationLifecycle();
  const effects = [];
  for (const event of events) {
    const result = reduceConversationLifecycle(state, event);
    state = result.next;
    effects.push(result.effect);
  }
  return { state, effects };
}

test('semantic caller turn is processed and resets incoherence counter', () => {
  const result = run([
    { type: 'CALLER_TRANSCRIPT', disposition: 'INCOHERENT' },
    { type: 'CALLER_TRANSCRIPT', disposition: 'SEMANTIC_TURN' },
  ]);
  assert.equal(result.state.state, 'PROCESSING_CALLER_TURN');
  assert.equal(result.state.ignoredCount, 0);
  assert.equal(result.effects.at(-1), 'PROCESS_TURN');
});

test('background input while Lucia speaks never becomes a turn', () => {
  const result = run([
    { type: 'ASSISTANT_RESPONSE_STARTED' },
    { type: 'CALLER_TRANSCRIPT', disposition: 'BACKGROUND' },
  ]);
  assert.equal(result.state.state, 'LUCIA_SPEAKING');
  assert.equal(result.effects.at(-1), 'IGNORE_INPUT');
});

test('legitimate interruption becomes one semantic turn', () => {
  const result = run([
    { type: 'ASSISTANT_RESPONSE_STARTED' },
    { type: 'CALLER_SPEECH_STARTED' },
    { type: 'CALLER_TRANSCRIPT', disposition: 'SEMANTIC_TURN' },
  ]);
  assert.equal(result.state.state, 'PROCESSING_CALLER_TURN');
  assert.equal(result.effects.filter((e) => e === 'PROCESS_TURN').length, 1);
});

test('handoff requires explicit handoff disposition', () => {
  const ordinary = run([
    { type: 'CALLER_TRANSCRIPT', disposition: 'SEMANTIC_TURN' },
  ]);
  assert.notEqual(ordinary.effects.at(-1), 'START_HANDOFF');

  const explicit = run([
    { type: 'CALLER_TRANSCRIPT', disposition: 'EXPLICIT_HANDOFF' },
  ]);
  assert.equal(explicit.effects.at(-1), 'START_HANDOFF');
  assert.equal(explicit.state.state, 'CLOSING');
});

test('silence escalates deterministically to hangup', () => {
  const result = run([
    { type: 'PRESENCE_TIMEOUT' },
    { type: 'PRESENCE_TIMEOUT' },
    { type: 'SILENCE_CLOSE_TIMEOUT' },
  ]);
  assert.equal(result.state.presenceChecks, 2);
  assert.equal(result.effects.at(-1), 'START_HANGUP');
  assert.equal(result.state.state, 'CLOSING');
});

test('terminal call ignores all later events', () => {
  let state = initialConversationLifecycle();
  state = reduceConversationLifecycle(state, { type: 'SILENCE_CLOSE_TIMEOUT' }).next;
  state = reduceConversationLifecycle(state, { type: 'HANGUP_COMPLETED' }).next;
  const result = reduceConversationLifecycle(state, { type: 'PRESENCE_TIMEOUT' });
  assert.equal(result.next.state, 'CLOSED');
  assert.equal(result.next.terminal, true);
  assert.equal(result.effect, 'NONE');
});
