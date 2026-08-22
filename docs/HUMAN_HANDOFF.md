# Human handoff

Human handoff is a transversal CallSession capability. The conversational model decides when a human is required; deterministic backend code owns authorization, tenant configuration, traceability, telephony and terminal lifecycle.

## Invariants

- A destination phone number is read only from tenant KV and is never exposed to the model.
- Tenants without `humanHandoff.enabled=true` keep the historical behavior unchanged.
- Traceability in `human_handoff_events` is created before the caller is told that a transfer will happen.
- Once a configured handoff is accepted, the conversation reaches a point of no return: Lucía does not resume normal dialogue.
- The transfer announcement is atomic/protected speech with turn detection disabled.
- On `call.bridged`, the human owns the call and the AI sideband is closed.
- On no-answer, busy, transport failure or transfer timeout, the event is marked for callback, Lucía speaks exactly one protected terminal message, and the call is hung up.
- Caller input during the terminal handoff lifecycle is ignored and cannot open a new semantic turn.

## Tenant KV

Add this top-level property to the existing tenant document. The phone must be an actual E.164 number before enabling the feature.

```json
{
  "humanHandoff": {
    "enabled": true,
    "destination": {
      "type": "PHONE",
      "phone": "+34XXXXXXXXX",
      "label": "Recepción"
    },
    "transfer": {
      "mode": "BLIND",
      "answerTimeoutSeconds": 25
    },
    "failurePolicy": {
      "action": "TERMINATE_AND_CALLBACK",
      "message": "Ahora mismo no ha sido posible comunicarte con una persona del equipo. Hemos registrado tu solicitud para que puedan devolverte la llamada. Gracias."
    },
    "successMessage": "De acuerdo, te paso con una persona del equipo para que continúe contigo. Un momento, por favor."
  }
}
```

`+34XXXXXXXXX` is documentation-only and intentionally fails runtime E.164 validation. Replace it with the real business transfer number before setting `enabled` to `true`.

## Traceability

Each accepted handoff creates a `public.human_handoff_events` row containing tenant, Realtime call, caller phone, reason, destination, lifecycle timestamps, transfer result and callback state. Failed/unanswered handoffs retain the real caller phone for the explicit operational purpose of returning the call.

Callback states are `PENDING`, `CONTACTED`, `RESOLVED`, `UNREACHABLE`, or `CANCELLED`.
