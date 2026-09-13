# Reservation contact default policy

> **Estado:** política vigente
> **Última revisión documental:** 2026-08-29

For telephone CREATE reservations, a trustworthy E.164 `caller_phone` propagated from the verified Telnyx webhook is the default `reservation_phone`.

- Do not ask the caller to repeat that number.
- An explicitly supplied alternate reservation contact may replace it.
- If no trustworthy caller number exists, collect a reservation contact normally.
- Reservation contact and marketing consent remain independent facts.
- Copying `caller_phone` into a reservation must never be interpreted as marketing consent or as proof for an alternate number.
