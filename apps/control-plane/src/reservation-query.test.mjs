import assert from "node:assert/strict";
import { test } from "node:test";
import { publicReservationQueryResults } from "../.test-dist/reservation-query.js";

test("reservation query exposes only safe public fields and preserves ordering", () => {
  const rows = [
    {
      id: "internal-1",
      reservation_code: "R-100101",
      starts_at: "2026-08-13T15:00:00.000Z",
      ends_at: "2026-08-13T16:30:00.000Z",
      party_size: 2,
      customer_name: "Juan",
      customer_phone: "+34600111222",
      status: "BOOKED",
    },
    {
      id: "internal-2",
      reservation_code: "R-100102",
      starts_at: "2026-08-13T18:00:00.000Z",
      ends_at: "2026-08-13T19:30:00.000Z",
      party_size: 4,
      customer_name: "Juan",
      customer_phone: "+34600111222",
      status: "BOOKED",
    },
  ];

  const result = publicReservationQueryResults(rows);
  assert.deepEqual(result, [
    { option: 1, reservation_code: "R-100101", starts_at: rows[0].starts_at, ends_at: rows[0].ends_at, party_size: 2, customer_name: "Juan", status: "BOOKED" },
    { option: 2, reservation_code: "R-100102", starts_at: rows[1].starts_at, ends_at: rows[1].ends_at, party_size: 4, customer_name: "Juan", status: "BOOKED" },
  ]);
  assert.equal("id" in result[0], false);
  assert.equal("customer_phone" in result[0], false);
  assert.match(result[0].reservation_code, /^R-\d{6,10}$/);
});
