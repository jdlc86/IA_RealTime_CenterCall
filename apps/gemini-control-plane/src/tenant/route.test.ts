import { describe, expect, it, vi } from "vitest";
import { KvGeminiTenantRoutePort, normalizeCalledNumber, tenantPhoneRouteKey } from "./route";

describe("Gemini tenant route port", () => {
  it("uses the existing provider-neutral phone route key and normalizes numbers", async () => {
    const get = vi.fn(async () => JSON.stringify({ schemaVersion: 1, tenantId: "tenant-1", status: "active" }));
    const port = new KvGeminiTenantRoutePort({ get });
    await expect(port.resolveByCalledNumber("+34 910 000 010")).resolves.toEqual({
      tenantId: "tenant-1",
      calledNumber: "+34910000010",
      source: "called_number",
    });
    expect(get).toHaveBeenCalledWith("ia-rtcc:v1:route:phone:+34910000010", { cacheTtl: 30 });
    expect(tenantPhoneRouteKey("+34 910 000 010")).toBe("ia-rtcc:v1:route:phone:+34910000010");
    expect(normalizeCalledNumber("+34 (910) 000-010")).toBe("+34910000010");
  });

  it("returns null for missing, disabled or invalid input", async () => {
    const missing = new KvGeminiTenantRoutePort({ get: async () => null });
    await expect(missing.resolveByCalledNumber("+34910000010")).resolves.toBeNull();
    await expect(missing.resolveByCalledNumber("---")).resolves.toBeNull();

    const disabled = new KvGeminiTenantRoutePort({
      get: async () => JSON.stringify({ schemaVersion: 1, tenantId: "tenant-1", status: "disabled" }),
    });
    await expect(disabled.resolveByCalledNumber("+34910000010")).resolves.toBeNull();
  });

  it("fails closed on malformed shared route configuration", async () => {
    const malformed = new KvGeminiTenantRoutePort({ get: async () => "{" });
    await expect(malformed.resolveByCalledNumber("+34910000010")).rejects.toThrow(/Invalid JSON/i);

    const wrongSchema = new KvGeminiTenantRoutePort({
      get: async () => JSON.stringify({ schemaVersion: 2, tenantId: "tenant-1", status: "active" }),
    });
    await expect(wrongSchema.resolveByCalledNumber("+34910000010")).rejects.toThrow(/schemaVersion/i);
  });
});
