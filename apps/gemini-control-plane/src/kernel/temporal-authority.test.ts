import { describe, expect, it } from "vitest";
import {
  buildAuthoritativeDateTimeSnapshot,
  canonicalTenantTimeZone,
  resolveTenantTimeZone,
} from "./temporal-authority";

describe("horizontal temporal authority", () => {
  it.each([
    { businessType: "RESTAURANT", business: { timezone: "America/Bogota" } },
    { businessType: "CLINIC", business: { timezone: "America/Bogota" } },
    { businessType: "RETAIL", timezone: "America/Bogota" },
  ])("uses the tenant timezone without branching on $businessType", (config) => {
    expect(resolveTenantTimeZone(config)).toBe("America/Bogota");
  });

  it("normalizes the same instant to the tenant calendar across a date boundary", () => {
    const epoch = Date.parse("2026-12-31T23:30:00.000Z");
    expect(buildAuthoritativeDateTimeSnapshot("Europe/Madrid", epoch)).toMatchObject({
      source: "WORKER_CLOCK",
      local_date: "2027-01-01",
      local_time: "00:30:00",
      now_iso: "2027-01-01T00:30:00+01:00",
    });
    expect(buildAuthoritativeDateTimeSnapshot("America/Bogota", epoch)).toMatchObject({
      source: "WORKER_CLOCK",
      local_date: "2026-12-31",
      local_time: "18:30:00",
      now_iso: "2026-12-31T18:30:00-05:00",
    });
  });

  it("fails closed for invalid tenant timezones", () => {
    expect(() => canonicalTenantTimeZone("Mars/Olympus_Mons")).toThrow(/timezone is invalid/);
  });
});
