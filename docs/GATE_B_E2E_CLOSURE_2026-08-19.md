# Gate B — E2E closure — 2026-08-19

Repository: `jdlc86/IA_RealTime_CenterCall`
Branch: `rebuild/v39-stable-baseline`

## Decision

Gate B (`V40/V44 provider-neutral`) is **CLOSED E2E**.

This closure is based on complementary real calls. No single call is treated as evidence for behavior it did not exercise.

## Evidence A — split utterance / newest-fragment ordering

Call:

```text
rtc_u7_EEaYtmcwIAHmU9Dv216Zy
```

Observed sequence:

```text
MENU
→ BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
→ BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
→ BARGE_IN_CONFIRMED_DEFERRED_TO_NEWER_SPEECH_V40_REBUILD
→ BARGE_IN_CONFIRMED_V40_REBUILD
   deferred_to_newer_speech=true
   semantic_item_id=<newest item>
→ BARGE_IN_DEFERRED_LATEST_FRAGMENT_PROMOTED_V40_REBUILD
→ restaurant_business_info topics=[HOURS]
```

The classifier source item did not authorize a stale response. The newer split fragment became the semantic item and produced the correct HOURS tool decision.

Also observed:

```text
RESPONSE_OWNERSHIP_CONFLICT_V40_REBUILD = 0
warn/error/critical = 0
```

The call completed through V41/lifecycle and HangupController with Telnyx HTTP 200 and `HANGUP_COMPLETED`.

## Evidence B — IGNORE_CONFIRMED after irreversible provider clear

Call:

```text
rtc_u7_EEbdOkLdXM7No9tcGR8R7
```

Observed provider-clear branch:

```text
BARGE_IN_PLAYBACK_WINDOW_OPENED_V40_REBUILD
→ RAW_VAD_ROUTED_TO_V40_ONLY_V44
→ BARGE_IN_PROVIDER_CLEAR_BEFORE_DECISION_V40_REBUILD
→ BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
→ BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
→ BARGE_IN_PROVIDER_CLEAR_LIVENESS_RECOVERY_V40_REBUILD
   source=classified_ignore
   timer_used=false
   recovery_route=RECOVER_LIVENESS
   tools_disabled=true
   isolated_response=true
   synthetic_continuation=false
   business_action_executed=false
→ BARGE_IN_IGNORED_V40_REBUILD
   semantic_pipeline_entered=false
   resume_after_active_done=false
```

This validates the case that had remained open after the provider cleared playback before the semantic decision. IGNORE no longer produces dead air and does not restore liveness by replaying/synthesizing the interrupted business response.

The same call later exercised a legitimate interruption:

```text
BARGE_IN_CONFIRMED_V40_REBUILD
→ CONFIRMED_BARGE_IN_SEMANTIC_TURN_STARTED_V29
```

A subsequent model attempt to reinterpret that authoritative caller-directed turn as background was rejected by:

```text
BACKGROUND_INPUT_RECLASSIFICATION_BLOCKED_V29
```

No ownership conflict was observed and the call had:

```text
266 diagnostic events
warn/error/critical = 0
```

## Closing path

The final call also validated the contextual close and transport lifecycle:

```text
MORE_HELP_QUESTION_OPENED_V41
→ CONTEXTUAL_CLOSE_RESOLVED_V41
→ V41_CLOSE_COMMITTED_TO_LIFECYCLE
→ LIFECYCLE_END_CALL_REQUESTED_V18
→ terminal playback
→ LIFECYCLE_TERMINAL_DRAIN_ARMED_V18 (750 ms)
→ LIFECYCLE_HANGUP_DISPATCHED_V18
→ HANGUP_STARTED (TELNYX_SOURCE_LEG)
→ HANGUP_REQUEST_ACCEPTED (HTTP 200)
→ HANGUP_COMPLETED
```

The sideband close code 1006 occurred only after hangup had started and was observed by V46 in `session_state=closing`; it is not treated as a Gate B regression.

## Gate B invariants validated

```text
raw VAD is acoustic evidence, not semantic authority
protected speech remains protected
INTERRUPT does not wait for response.done
newest split fragment owns semantic promotion
IGNORE requires positive background certification
IGNORE does not enter the semantic pipeline
IGNORE does not create resume_assistant
provider-clear + IGNORE has an isolated liveness recovery
liveness recovery executes no business action and has tools disabled
single response ownership preserved
V41 contextual close reaches lifecycle
terminal drain remains 750 ms
Telnyx source-leg hangup completes
```

## Scope note

`TURN_CONCURRENCY_LATE_TRANSCRIPT_BYPASSED_V36` appeared in the final call for a later item while normal playback was active. It did not correspond to the newest substantive split fragment used to validate Gate B, did not cause an ownership conflict, and did not prevent the later caller-directed barge-in from being promoted. Therefore it is not evidence for modifying v36 in this gate.

## Result

```text
Gate B IMPLEMENTED   = ✅
Gate B CI GREEN      = ✅
Gate B DEPLOYED      = ✅ evidenced by runtime events from the new code paths
Gate B E2E VALIDATED = ✅
Gate B CLOSED        = ✅
```

Gate C (`ProviderCapabilities`) is now unblocked. This closure does **not** enable Gemini and does not authorize media-plane changes.
