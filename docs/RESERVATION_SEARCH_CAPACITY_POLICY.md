# Reservation search and table-capacity policy

## Automatic allocation rule

Automatic reservation is allowed only when the total capacity assigned is at least the requested party size and leaves at most one unused seat in total.

Examples:

- 5 guests -> tables 4 + 2 (capacity 6): allowed, 1 unused seat.
- 6 guests -> tables 4 + 2 (capacity 6): allowed, exact.
- 6 guests -> tables 4 + 4 (capacity 8): not allowed automatically, 2 unused seats.
- 1 guest -> only a table of 4 available: not allowed automatically, 3 unused seats; human assistance is required.

The SQL function `check_restaurant_table_plan` is authoritative. It emits `SINGLE_EXACT`, `SINGLE_TOLERATED`, `MULTI_EXACT`, or `MULTI_TOLERATED`.

If no time-specific plan exists, `check_restaurant_capacity_fit` distinguishes between:

- a structurally supported party with no availability at that time -> offer `restaurant_reservation_search`;
- a party that cannot fit the <=1 unused-seat rule with the restaurant's active table topology -> `HUMAN_ASSISTANCE_REQUIRED`.

No capacity-policy failure may cancel an existing reservation or be described as a cancellation.

## Reservation search tool

`restaurant_reservation_search` is read-only. It accepts a party size plus optional preferred/range/time-of-day criteria and queries `search_restaurant_table_slots`.

The tool returns ranked real availability only. Lucia presents a short list and must route the chosen option back through `restaurant_reservation_create`; search itself never books.

Default search behavior:

- duration: 90 minutes;
- slot step: 30 minutes;
- result limit: 5;
- when `to` is omitted: search up to seven days after the starting timestamp;
- timezone for local time-of-day filters: `Europe/Madrid`.

## Human escalation

When automatic seating is impossible under the capacity policy, or the guest requires separated tables to be close, Lucia must not reject or cancel anything. She explains that the configuration requires a person and routes the intent to `restaurant_human_assistance`. When a real transfer transport is implemented, the same tool contract can continue the flow with a human agent.
