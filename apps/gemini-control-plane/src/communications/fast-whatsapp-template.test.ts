import { describe, expect, it, vi } from "vitest";
import {
  routeFastWhatsAppTemplateCanary,
  sendFastWhatsAppTemplate,
  type FastWhatsAppTemplateEnv,
} from "./fast-whatsapp-template";

const CONTROL_TOKEN = "0123456789abcdef0123456789abcdef";
const TENANT_ID = "tenant-clinic";

function request(body: Record<string, unknown>, token = CONTROL_TOKEN): Request {
  return new Request("https://worker.example/internal/communications/whatsapp/template-canary", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    recipientPhoneE164: "+34600000000",
    templateName: "jaspers_market_order_confirmation_v1",
    parameters: ["Jane Doe", "APT-123", "Sep 28, 2026"],
    idempotencyKey: "appointment:APT-123:confirmation:v1",
    ...overrides,
  };
}

function environment(overrides: Partial<FastWhatsAppTemplateEnv> = {}) {
  const values = new Map<string, string>([
    [`tenant_config:${TENANT_ID}`, JSON.stringify({ tenant_id: TENANT_ID, status: "active" })],
    [`tenant_capabilities:${TENANT_ID}`, JSON.stringify({ tenant_id: TENANT_ID, whatsapp: { transactional: true } })],
    ["whatsapp.phone_number_id", "1267454589790392"],
    ["whatsapp.waba_id", "1423142006344998"],
    ["whatsapp.default_language", "en_US"],
    ["whatsapp.allowed_templates", JSON.stringify([
      "jaspers_market_plain_text_v1",
      "jaspers_market_order_confirmation_v1",
    ])],
  ]);
  const put = vi.fn(async (key: string, value: string) => { values.set(key, value); });
  return {
    env: {
      GEMINI_MEDIA_CONTROL_PLANE_TOKEN: CONTROL_TOKEN,
      META_WHATSAPP_ACCESS_TOKEN: "meta-test-token",
      TENANT_ROUTING_KV: {
        async get(key: string) { return values.get(key) ?? null; },
        put,
      },
      ...overrides,
    } satisfies FastWhatsAppTemplateEnv,
    put,
  };
}

describe("sendFastWhatsAppTemplate", () => {
  it("omits components for a fixed template", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload).toEqual({
        messaging_product: "whatsapp",
        to: "34600000000",
        type: "template",
        template: { name: "jaspers_market_plain_text_v1", language: { code: "en_US" } },
      });
      return Response.json({ messages: [{ id: "wamid.fixed" }] });
    });
    await expect(sendFastWhatsAppTemplate({
      accessToken: "secret",
      phoneNumberId: "1267454589790392",
      recipientE164: "+34600000000",
      templateName: "jaspers_market_plain_text_v1",
      languageCode: "en_US",
      parameters: [],
    }, fetcher)).resolves.toEqual({ messageId: "wamid.fixed" });
  });
});

describe("routeFastWhatsAppTemplateCanary", () => {
  it("rejects unauthenticated requests without reading configuration", async () => {
    const get = vi.fn(async () => null);
    const response = await routeFastWhatsAppTemplateCanary(request(validBody(), "wrong"), {
      GEMINI_MEDIA_CONTROL_PLANE_TOKEN: CONTROL_TOKEN,
      META_WHATSAPP_ACCESS_TOKEN: "meta-test-token",
      TENANT_ROUTING_KV: { get, async put() {} },
    });
    expect(response.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed when the tenant capability is disabled", async () => {
    const { env } = environment({
      TENANT_ROUTING_KV: {
        async get(key: string) {
          if (key === `tenant_config:${TENANT_ID}`) return JSON.stringify({ tenant_id: TENANT_ID, status: "active" });
          if (key === `tenant_capabilities:${TENANT_ID}`) return JSON.stringify({ tenant_id: TENANT_ID, whatsapp: { transactional: false } });
          return null;
        },
        async put() {},
      },
    });
    const fetcher = vi.fn();
    const response = await routeFastWhatsAppTemplateCanary(request(validBody()), env, { fetcher });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ status: "CAPABILITY_DISABLED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a template outside the tenant allowlist", async () => {
    const { env } = environment();
    const fetcher = vi.fn();
    const response = await routeFastWhatsAppTemplateCanary(
      request(validBody({ templateName: "unregistered_template" })),
      env,
      { fetcher },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ status: "TEMPLATE_NOT_ALLOWED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid recipients before configuration or Meta", async () => {
    const { env } = environment();
    const fetcher = vi.fn();
    const response = await routeFastWhatsAppTemplateCanary(
      request(validBody({ recipientPhoneE164: "34600000000" })),
      env,
      { fetcher },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ status: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before parsing or Meta", async () => {
    const { env } = environment();
    const fetcher = vi.fn();
    const response = await routeFastWhatsAppTemplateCanary(new Request(
      "https://worker.example/internal/communications/whatsapp/template-canary",
      {
        method: "POST",
        headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
        body: "x".repeat(32_769),
      },
    ), env, { fetcher });
    expect(response.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends an allowlisted parameterized template without logging message content", async () => {
    const { env, put } = environment();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://graph.facebook.com/v25.0/1267454589790392/messages");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer meta-test-token");
      expect(JSON.parse(String(init?.body))).toEqual({
        messaging_product: "whatsapp",
        to: "34600000000",
        type: "template",
        template: {
          name: "jaspers_market_order_confirmation_v1",
          language: { code: "en_US" },
          components: [{
            type: "body",
            parameters: [
              { type: "text", text: "Jane Doe" },
              { type: "text", text: "APT-123" },
              { type: "text", text: "Sep 28, 2026" },
            ],
          }],
        },
      });
      return Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.accepted" }] });
    });
    const response = await routeFastWhatsAppTemplateCanary(request(validBody()), env, { fetcher, now: () => 1_800_000_000_000 });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, status: "ACCEPTED_BY_META", message_id: "wamid.accepted" });
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).toMatch(/^whatsapp_canary_receipt:tenant-clinic:[a-f0-9]{64}$/);
    expect(put.mock.calls[0]?.[1]).not.toContain("Jane Doe");
    expect(put.mock.calls[0]?.[1]).not.toContain("34600000000");
  });

  it("does not send again after an accepted idempotency receipt", async () => {
    const { env } = environment();
    const fetcher = vi.fn(async () => Response.json({ messages: [{ id: "wamid.once" }] }));
    const first = await routeFastWhatsAppTemplateCanary(request(validBody()), env, { fetcher });
    const second = await routeFastWhatsAppTemplateCanary(request(validBody()), env, { fetcher });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ ok: true, status: "ALREADY_ACCEPTED", message_id: "wamid.once" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
