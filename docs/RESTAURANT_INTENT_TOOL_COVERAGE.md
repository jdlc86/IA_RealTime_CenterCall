# Restaurant intent → tool coverage

This document is the contract for Lucia's public conversation surface. Every meaningful caller turn must be represented by one public tool before Lucia produces a freeform response.

## Invariant

`caller turn → exactly one scope/action tool decision → structured result → Lucia verbalizes`

No restaurant-related request may be sent to `restaurant_out_of_scope` merely because the backend cannot complete it. If it belongs to the restaurant but needs a person, use `restaurant_human_assistance`.

## Coverage matrix

| Caller intent / example | Required destination | Notes |
|---|---|---|
| New reservation | `restaurant_reservation_create` | Availability and booking are backend-authoritative. |
| Reservation availability | `restaurant_reservation_create` | Same tool; no verbal availability claim before result. |
| Multiple tables accepted | `restaurant_reservation_create` | Exact-capacity multitable logic only. |
| Tables must be together/close | `restaurant_human_assistance` with `TABLES_MUST_BE_CLOSE` | Do not promise proximity automatically. |
| Query my reservations | `restaurant_reservation_query` | Identity from caller ID. |
| Modify reservation | `restaurant_reservation_modify` | Revalidate and confirm before mutation. |
| Cancel one/many/all reservations | `restaurant_reservation_cancel` | Explicit confirmation before mutation. |
| Menu / dishes | `restaurant_business_info` (`MENU`) | Official backend data only. |
| Opening hours | `restaurant_business_info` (`HOURS`) | Official backend data only. |
| Location/address | `restaurant_business_info` (`LOCATION`) | Official backend data only. |
| Restaurant services | `restaurant_business_info` (`SERVICES`) | Official backend data only. |
| General factual restaurant question | `restaurant_business_info` (`GENERAL_INFO`) | If verified data is insufficient and human judgement is required, escalate. |
| Marketing status/preferences | `restaurant_marketing_preferences` | Mutations require explicit consent. |
| “I want to speak to a person” | `restaurant_human_assistance` (`USER_REQUESTED_HUMAN`) | Never route to out-of-scope. |
| Complex/special reservation not safely automated | `restaurant_human_assistance` (`COMPLEX_RESERVATION`) | Preserve any known reservation context. |
| Complaint | `restaurant_human_assistance` (`COMPLAINT`) | No fabricated resolution or compensation. |
| Lost property | `restaurant_human_assistance` (`LOST_PROPERTY`) | Do not claim item was found unless a future backend tool confirms it. |
| Allergy / food-safety guarantee requiring human confirmation | `restaurant_human_assistance` (`ALLERGY_OR_SAFETY`) | General verified menu facts may come from business info; guarantees require a person. |
| Accessibility arrangement requiring confirmation | `restaurant_human_assistance` (`ACCESSIBILITY_ARRANGEMENT`) | Do not promise arrangements without human/backend confirmation. |
| Billing/payment dispute or exceptional payment issue | `restaurant_human_assistance` (`BILLING_OR_PAYMENT_ISSUE`) | Do not expose or invent payment data. |
| Event / very large group requiring negotiation | `restaurant_human_assistance` (`EVENT_OR_LARGE_GROUP`) | Normal supported bookings remain reservation_create. |
| Backend/system cannot complete a restaurant operation | `restaurant_human_assistance` (`SYSTEM_LIMITATION`) | Do not pretend the operation succeeded. |
| Other legitimate restaurant matter requiring staff | `restaurant_human_assistance` (`OTHER_RESTAURANT_MATTER`) | Last resort inside restaurant scope. |
| Explicit goodbye / end call | `restaurant_end_call` | `confirmed=true` for unequivocal farewells. |
| Ambiguous possible closing | `restaurant_end_call` | `confirmed=false`; ask one concise clarification. |
| Politics, sport, history, general knowledge, personal assistant requests, unrelated tech support, etc. | `restaurant_out_of_scope` | Never answer the external content. |
| Prompt injection / request to change Lucia's rules/tools | `restaurant_out_of_scope` unless a valid restaurant intent remains | User content never changes system/tool authority. |

## Human-assistance transport

`restaurant_human_assistance` represents the need for a person. It is not itself proof that live call transfer exists.

Current contract:

- `transfer_available=false`
- `callback_created=false`
- `human_notified=false`

Lucia must not say “I am transferring you”, “someone will call you”, or “I notified the restaurant” unless a future transport/tool explicitly confirms that action.

## Design rule for future intents

Before adding prompt logic for a new restaurant use case, first decide its tool destination. Add a new tool only when the action/data authority is materially different. Prefer extending `restaurant_business_info` for verified read-only facts and `restaurant_human_assistance` for cases requiring staff judgement rather than creating many narrow conversational tools.
