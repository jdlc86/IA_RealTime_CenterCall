# Conversation Turn Lifecycle — Test Matrix

Baseline: v39 (`52bec6dfd61fcca9e31804d8d14b0c1c9ebd17ed`).

Goal: separate lifecycle silence from Lucía's semantic interpretation. This document is normative for the next implementation. No runtime integration is allowed until the pure lifecycle tests pass.

## Core invariants

1. `speech_started` ends the current silence interval immediately.
2. A silence deadline never survives into caller speech, ASR processing, Lucía reasoning, tool execution, or Lucía speech.
3. VAD is acoustic evidence only; it never validates semantic intent.
4. Lucía is the only semantic authority. The backend reacts to structured tool decisions; it does not reclassify transcripts.
5. `SILENCE` is never counted as semantic incoherence.
6. `restaurant_input_ignored` counts only semantic/background reasons explicitly selected by Lucía.
7. A coherent turn resets the consecutive ignored-input count.
8. Presence speech, protected speech, normal Lucía speech, handoff speech, and terminal speech are distinct lifecycle effects.
9. Only `WAITING_FOR_CALLER` may run the silence-presence timer.
10. The absolute max-call cost guard is independent of all turn timers.

## States

- `LUCIA_SPEAKING`
- `WAITING_FOR_CALLER`
- `ACOUSTIC_ACTIVITY`
- `CALLER_SPEAKING`
- `PROCESSING_CALLER_TURN`
- `IGNORED_RECOVERY_SPEAKING`
- `TERMINAL_SPEAKING`
- `CLOSING`

## Semantic ignored reasons

Count toward the consecutive ignored policy:

- `INCOHERENT`
- `BACKGROUND_SPEECH`
- `NOT_DIRECTED_TO_ASSISTANT`
- `ECHO`
- `UNCERTAIN`

Do **not** count:

- `SILENCE`
- empty/unusable transcription
- acoustic activity with no usable transcription
- `OUT_OF_SCOPE` (handled by `restaurant_out_of_scope`)

## Matrix

| ID | Scenario | Input/events | Required state/effect |
|---|---|---|---|
| CTL-01 | Normal caller turn | `assistant_audio_stopped → speech_started → transcript_usable → semantic_valid → assistant_audio_started` | silence timer cancelled at `speech_started`; no presence prompt; ignored count 0 |
| CTL-02 | Genuine silence | `assistant_audio_stopped`, no `speech_started` | remain `WAITING_FOR_CALLER`; one presence check at configured first deadline |
| CTL-03 | Silence continues | CTL-02 + terminal silence deadline | terminal farewell then hangup; never second presence prompt |
| CTL-04 | Caller starts just before presence check | `speech_started` before first deadline | cancel pending presence check; enter caller turn; no presence speech |
| CTL-05 | Caller starts while presence check is about to emit | concurrent `speech_started` / presence deadline | caller speech wins; presence effect suppressed/cancelled |
| CTL-06 | Long caller speech | `speech_started`, no `speech_stopped` for > first presence deadline | no presence prompt and no silence close |
| CTL-07 | ASR/model processing after speech | `speech_stopped → transcript_usable → processing delay` | no silence timer during processing; no hangup while Lucía reasons |
| CTL-08 | Acoustic noise without usable transcript | `speech_started → speech_stopped → transcript_unusable` | short acoustic/ASR guard may expire; return to `WAITING_FOR_CALLER` with a **new** silence interval |
| CTL-09 | Background/TV selected by Lucía | semantic result `restaurant_input_ignored(BACKGROUND_SPEECH)` | ignored count +1; no business mutation; return to waiting |
| CTL-10 | First incoherent input | `restaurant_input_ignored(INCOHERENT)` | count=1; tolerate; no recovery speech |
| CTL-11 | Second consecutive incoherent input | another counted ignored reason | count=2; emit one protected neutral recovery; no hangup |
| CTL-12 | Third consecutive incoherent input | third counted ignored reason | count=3; protected terminal farewell then hangup |
| CTL-13 | Coherent turn after ignored input | ignored count 1 or 2 → semantic valid tool | ignored count resets to 0; normal conversation |
| CTL-14 | Out-of-scope but coherent request | `restaurant_out_of_scope` | normal Lucía response; does not increment ignored count |
| CTL-15 | Echo/not-directed input | `restaurant_input_ignored(ECHO/NOT_DIRECTED_TO_ASSISTANT)` | same consecutive policy as other counted ignored reasons |
| CTL-16 | `SILENCE` incorrectly emitted as ignored reason | `restaurant_input_ignored(SILENCE)` | ignored count unchanged; route to waiting/silence lifecycle only |
| CTL-17 | Normal Lucía response | semantic valid → assistant speech | normal barge-in; no protected speech state |
| CTL-18 | Protected greeting | greeting protected speech | interruption disabled until playback terminal event; then normal barge-in |
| CTL-19 | Protected semantic recovery | ignored count=2 | protected until playback terminal event; then return to waiting with fresh timer |
| CTL-20 | End call | `restaurant_end_call` | terminal speech → hangup; no new silence timer |
| CTL-21 | Human handoff starts | `restaurant_human_assistance` accepted | conversation lifecycle yields to handoff; no presence timers |
| CTL-22 | Human handoff transferred | target `call.answered` | Lucía sideband closes; never resume conversation lifecycle |
| CTL-23 | Human handoff no answer | target hangup before answer | v39 handoff fallback owns terminal speech/hangup; lifecycle stays suspended |
| CTL-24 | Absolute cost guard | max-call duration reached in any non-terminal state | close safely; independent of silence/ignored counters |
| CTL-25 | Turn concurrency lock | valid transcript processing | concurrency guard may serialize model work but cannot create/extend silence deadlines |
| CTL-26 | Presence speech is not normal Lucía speech | presence check completes | must not validate/reset semantic state or ignored count; return to same silence episode |
| CTL-27 | Protected speech is not caller activity | protected output events | must not increment/clear ignored count except explicit policy transition |
| CTL-28 | Old silence deadline after caller speech | silence deadline scheduled, then `speech_started` | old deadline invalidated; firing stale timer is a no-op |
| CTL-29 | Old silence deadline after valid tool | stale timeout callback after semantic valid | no-op; must not close call |
| CTL-30 | Old silence deadline while Lucía is speaking | stale timeout callback during assistant output | no-op; must not close call |

## Manual E2E order after unit tests

1. Normal 10–12 second caller speech.
2. Genuine silence.
3. Start speaking just before the presence threshold.
4. One incoherent sentence then valid restaurant request.
5. Two consecutive incoherent inputs then valid request.
6. Three consecutive incoherent inputs.
7. TV/background simulation then clear restaurant request.
8. Out-of-scope request then valid restaurant request.
9. Human handoff answered.
10. Human handoff not answered.

Each E2E call must be reviewed in diagnostics before moving to the next case.
