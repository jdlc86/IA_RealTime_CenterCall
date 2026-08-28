import { describe, expect, it } from "vitest";
import {
  buildFastAuthoritativeDateTimeSnapshot,
  canonicalFastTimeZone,
  resolveFastTenantTimeZone,
  routeFastAuthoritativeDateTime,
} from "./fast-temporal-authority";

const TOKEN = "0123456789abcdef0123456789abcdef";

function request(body: unknown, token = TOKEN): Request {
  return new Request("https://worker.example/internal/authoritative-datetime", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Gemini Fast temporal authority", () => {
  it("materializes Madrid summer time with the correct DST offset", () => {
    const snapshot = buildFastAuthoritativeDateTimeSnapshot(
      "Europe/Madrid",
      Date.parse("2026-08-28T07:28:00.000Z"),
    );
    expect(snapshot).toEqual({
      version: 1,
      source: "WORKER_CLOCK",
      timezone: "Europe/Madrid",
      captured_at_epoch_ms: Date.parse("2026-08-28T07:28:00.000Z"),
      now_iso: "2026-08-28T09:28:00+02:00",
      local_date: "2026-08-28",
      local_time: "09:28:00",
      weekday: "viernes",
    });
  });

  it("materializes Madrid winter time with the correct standard-time offset", () => {
    const snapshot = buildFastAuthoritativeDateTimeSnapshot(
      "Europe/Madrid",
      Date.parse("2026-01-15T08:00:00.000Z"),
    );
    expect(snapshot.now_iso).toBe("2026-01-15T09:00:00+01:00");
    expect(snapshot.local_date).toBe("2026-01-15");
    expect(snapshot.local_time).toBe("09:00:00");
  });

  it("uses local calendar authority across the year boundary", () => {
    const snapshot = buildFastAuthoritativeDateTimeSnapshot(
      "Europe/Madrid",
      Date.parse("2026-12-31T23:30:00.000Z"),
    );
    expect(snapshot.now_iso).toBe("2027-01-01T00:30:00+01:00");
    expect(snapshot.local_date).toBe("2027-01-01");
    expect(snapshot.weekday).toBe("viernes");
  });

  it("supports tenant-owned IANA timezones without changing runtime code", () => {
    const snapshot = buildFastAuthoritativeDateTimeSnapshot(
      "America/Bogota",
      Date.parse("2026-08-28T14:28:00.000Z"),
    );
    expect(snapshot.now_iso).toBe("2026-08-28T09:28:00-05:00");
    expect(snapshot.timezone).toBe("America/Bogota");
    expect(resolveFastTenantTimeZone({ business: { timezone: "America/Bogota" } })).toBe("America/Bogota");
  });

  it("defaults to Madrid but fails closed for an invalid configured timezone", () => {
    expect(resolveFastTenantTimeZone(null)).toBe("Europe/Madrid");
    expect(canonicalFastTimeZone(undefined)).toBe("Europe/Madrid");
    expect(() => canonicalFastTimeZone("Mars/Olympus_Mons")).toThrow(/timezone is invalid/);
  });

  it("returns a fresh Worker-owned snapshot for an authenticated tenant", async () => {
    const env = {
      GEMINI_MEDIA_CONTROL_PLANE_TOKEN: TOKEN,
      TENANT_ROUTING_KV: {
        async get(key: string) {
          if (key === "tenant_config:tenant-bogota") {
            return JSON.stringify({
              tenant_id: "tenant-bogota",
              status: "active",
              business: { timezone: "America/Bogota" },
            });
          }
          return null;
        },
      },
    };
    const response = await routeFastAuthoritativeDateTime(
      request({ tenantId: "tenant-bogota", callControlId: "call-1" }),
      env,
      { now: () => Date.parse("2026-08-28T14:28:05.000Z") },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe("AUTHORITATIVE_DATETIME");
    expect(body.time_authoritative).toBe(true);
    expect(body.authoritative_temporal_context).toMatchObject({
      source: "WORKER_CLOCK",
      timezone: "America/Bogota",
      now_iso: "2026-08-28T09:28:05-05:00",
      local_date: "2026-08-28",
      local_time: "09:28:05",
    });
  });

  it("rejects unauthenticated refresh and fails closed on bad tenant temporal config", async () => {
    const env = {
      GEMINI_MEDIA_CONTROL_PLANE_TOKEN: TOKEN,
      TENANT_ROUTING_KV: {
        async get() {
          return JSON.stringify({ status: "active", business: { timezone: "Invalid/Zone" } });
        },
      },
    };
    const unauthorized = await routeFastAuthoritativeDateTime(
      request({ tenantId: "tenant-1" }, "wrong-token"),
      env,
    );
    expect(unauthorized.status).toBe(401);

    const unavailable = await routeFastAuthoritativeDateTime(
      request({ tenantId: "tenant-1" }),
      env,
      { now: () => Date.parse("2026-08-28T07:28:00.000Z") },
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      ok: false,
      status: "TEMPORAL_AUTHORITY_UNAVAILABLE",
      time_authoritative: false,
    });
  });
});
