type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type TenantKv = Readonly<{
  get(key: string): Promise<string | null>;
  put?(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}>;

export type FastWhatsAppTemplateEnv = Readonly<{
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: string;
  META_WHATSAPP_ACCESS_TOKEN: string;
  TENANT_ROUTING_KV: TenantKv;
}>;

type Dependencies = Readonly<{
  fetcher?: FetchLike;
  now?: () => number;
}>;

type WhatsAppConfig = Readonly<{
  phoneNumberId: string;
  wabaId: string;
  languageCode: string;
  allowedTemplates: ReadonlySet<string>;
}>;

type TemplateParameter = Readonly<{ type: "text"; text: string }>;

const GRAPH_API_VERSION = "v25.0";
const RECEIPT_TTL_SECONDS = 7 * 24 * 60 * 60;

class WhatsAppPolicyError extends Error {
  constructor(
    message: string,
    readonly status: "CAPABILITY_DISABLED" | "CONFIG_INVALID",
    readonly httpStatus: 403 | 503,
  ) {
    super(message);
  }
}

class PayloadTooLargeError extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function required(value: unknown, field: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function parseJson(raw: string | null, field: string): unknown | null {
  if (raw == null) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { throw new Error(`${field} is invalid JSON`); }
}

function canonicalId(value: unknown, field: string): string {
  const normalized = required(value, field, 64);
  if (!/^\d{5,32}$/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function canonicalLanguage(value: unknown): string {
  const normalized = required(value, "WhatsApp language", 16);
  if (!/^[a-z]{2,3}_[A-Z]{2}$/.test(normalized)) throw new Error("WhatsApp language is invalid");
  return normalized;
}

function canonicalTemplateName(value: unknown): string {
  const normalized = required(value, "WhatsApp template name", 512);
  if (!/^[a-z0-9_]+$/.test(normalized)) throw new Error("WhatsApp template name is invalid");
  return normalized;
}

function canonicalRecipient(value: unknown): string {
  const normalized = required(value, "WhatsApp recipient", 16);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("WhatsApp recipient must be E.164");
  return normalized;
}

function canonicalAllowedTemplates(value: unknown): ReadonlySet<string> {
  const source = typeof value === "string" ? (() => {
    try { return JSON.parse(value) as unknown; }
    catch { return [value]; }
  })() : value;
  if (!Array.isArray(source) || source.length < 1 || source.length > 32) {
    throw new Error("WhatsApp allowed templates are invalid");
  }
  return new Set(source.map((entry) => canonicalTemplateName(entry)));
}

function canonicalParameters(value: unknown): readonly TemplateParameter[] {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 10) throw new Error("WhatsApp template parameters are invalid");
  return Object.freeze(value.map((entry, index) => {
    const parameter = typeof entry === "string" ? { type: "text", text: entry } : record(entry);
    if (!parameter || parameter.type !== "text") throw new Error(`WhatsApp parameter ${index} is invalid`);
    return Object.freeze({
      type: "text" as const,
      text: required(parameter.text, `WhatsApp parameter ${index} text`, 1_024),
    });
  }));
}

async function readBoundedText(message: Request | Response, maxBytes: number): Promise<string> {
  const declared = message.headers.get("content-length");
  if (declared && Number.isFinite(Number(declared)) && Number(declared) > maxBytes) {
    throw new PayloadTooLargeError("Payload is too large");
  }
  if (!message.body) return "";
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError("Payload is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function secureEqual(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function controlAuthorized(request: Request, expected: string): Promise<boolean> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  return Boolean(match && await secureEqual(match[1], expected));
}

function transactionalEnabled(value: unknown, tenantId: string): boolean {
  const source = record(value);
  if (!source) return false;
  const declaredTenant = source.tenant_id ?? source.tenantId;
  if (declaredTenant != null && required(declaredTenant, "Tenant capability tenant id", 256) !== tenantId) {
    throw new Error("Tenant capability tenant mismatch");
  }
  if (source["message.whatsapp.transactional"] === true) return true;
  return record(source.whatsapp)?.transactional === true;
}

function nestedWhatsAppConfig(value: unknown, tenantId: string): Record<string, unknown> | null {
  const tenant = record(value);
  if (!tenant) return null;
  const declaredTenant = tenant.tenant_id ?? tenant.tenantId;
  if (declaredTenant != null && required(declaredTenant, "Tenant config tenant id", 256) !== tenantId) {
    throw new Error("Tenant config tenant mismatch");
  }
  if (tenant.status != null && tenant.status !== "active") throw new Error("Tenant config is not active");
  return record(record(tenant.communications)?.whatsapp) ?? record(tenant.whatsapp);
}

async function resolveWhatsAppConfig(kv: TenantKv, tenantId: string): Promise<WhatsAppConfig> {
  const [tenantRaw, capabilitiesRaw] = await Promise.all([
    kv.get(`tenant_config:${tenantId}`),
    kv.get(`tenant_capabilities:${tenantId}`),
  ]);
  const tenantValue = parseJson(tenantRaw, "Tenant config");
  const capabilities = parseJson(capabilitiesRaw, "Tenant capabilities");
  if (!transactionalEnabled(capabilities, tenantId)) {
    throw new WhatsAppPolicyError("WhatsApp transactional capability is disabled", "CAPABILITY_DISABLED", 403);
  }
  try {
    const nested = nestedWhatsAppConfig(tenantValue, tenantId);
    const phoneNumberId = canonicalId(nested?.phone_number_id ?? nested?.phoneNumberId, "WhatsApp phone number id");
    const wabaId = canonicalId(nested?.waba_id ?? nested?.wabaId, "WhatsApp business account id");
    const languageCode = canonicalLanguage(nested?.default_language ?? nested?.defaultLanguage);
    const allowedTemplates = canonicalAllowedTemplates(nested?.allowed_templates ?? nested?.allowedTemplates);
    return Object.freeze({ phoneNumberId, wabaId, languageCode, allowedTemplates });
  } catch (error) {
    if (error instanceof WhatsAppPolicyError) throw error;
    throw new WhatsAppPolicyError(
      error instanceof Error ? error.message : "WhatsApp configuration is invalid",
      "CONFIG_INVALID",
      503,
    );
  }
}

async function receiptKey(tenantId: string, idempotencyKey: string): Promise<string> {
  const material = new TextEncoder().encode(`${tenantId}\u0000${idempotencyKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  const suffix = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `whatsapp_canary_receipt:${tenantId}:${suffix}`;
}

function templatePayload(
  recipientE164: string,
  templateName: string,
  languageCode: string,
  parameters: readonly TemplateParameter[],
): Record<string, unknown> {
  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: languageCode },
  };
  if (parameters.length) {
    template.components = [{ type: "body", parameters }];
  }
  return {
    messaging_product: "whatsapp",
    to: recipientE164.slice(1),
    type: "template",
    template,
  };
}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
  try { return record(JSON.parse(await readBoundedText(response, 32_768))); }
  catch { return null; }
}

export async function sendFastWhatsAppTemplate(
  input: Readonly<{
    accessToken: string;
    phoneNumberId: string;
    recipientE164: string;
    templateName: string;
    languageCode: string;
    parameters: readonly TemplateParameter[];
  }>,
  fetcher: FetchLike = fetch,
): Promise<Readonly<{ messageId: string }>> {
  const response = await fetcher(`https://graph.facebook.com/${GRAPH_API_VERSION}/${input.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(templatePayload(
      input.recipientE164,
      input.templateName,
      input.languageCode,
      input.parameters,
    )),
  });
  const body = await responseJson(response);
  if (!response.ok) {
    const metaError = record(body?.error);
    const code = typeof metaError?.code === "number" ? metaError.code : null;
    throw new Error(`Meta WhatsApp request failed (${response.status}${code == null ? "" : `/${code}`})`);
  }
  const messages = body?.messages;
  const first = Array.isArray(messages) ? record(messages[0]) : null;
  const messageId = required(first?.id, "Meta WhatsApp message id", 512);
  return Object.freeze({ messageId });
}

export async function routeFastWhatsAppTemplateCanary(
  request: Request,
  env: FastWhatsAppTemplateEnv,
  dependencies: Dependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return Response.json({ ok: false, status: "METHOD_NOT_ALLOWED" }, { status: 405 });
  let controlToken: string;
  try { controlToken = required(env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN, "GEMINI_MEDIA_CONTROL_PLANE_TOKEN", 8_192); }
  catch { return Response.json({ ok: false, status: "WHATSAPP_UNAVAILABLE" }, { status: 503 }); }
  if (!await controlAuthorized(request, controlToken)) {
    return Response.json({ ok: false, status: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!env.TENANT_ROUTING_KV?.get || !env.TENANT_ROUTING_KV.put) {
    return Response.json({ ok: false, status: "WHATSAPP_UNAVAILABLE" }, { status: 503 });
  }

  let rawBody: string;
  try { rawBody = await readBoundedText(request, 32_768); }
  catch (error) {
    if (!(error instanceof PayloadTooLargeError)) {
      return Response.json({ ok: false, status: "INVALID_REQUEST" }, { status: 400 });
    }
    return Response.json({ ok: false, status: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  }
  let input: Readonly<{
    tenantId: string;
    recipientE164: string;
    templateName: string;
    parameters: readonly TemplateParameter[];
    idempotencyKey: string;
  }>;
  try {
    const body = record(JSON.parse(rawBody));
    if (!body) throw new Error("Request body is invalid");
    input = Object.freeze({
      tenantId: required(body.tenantId ?? body.tenant_id, "tenantId", 256),
      recipientE164: canonicalRecipient(body.recipientPhoneE164 ?? body.recipient_phone_e164),
      templateName: canonicalTemplateName(body.templateName ?? body.template_name),
      parameters: canonicalParameters(body.parameters),
      idempotencyKey: required(body.idempotencyKey ?? body.idempotency_key, "idempotencyKey", 256),
    });
  } catch {
    return Response.json({ ok: false, status: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const config = await resolveWhatsAppConfig(env.TENANT_ROUTING_KV, input.tenantId);
    if (!config.allowedTemplates.has(input.templateName)) {
      return Response.json({ ok: false, status: "TEMPLATE_NOT_ALLOWED" }, { status: 403 });
    }
    const key = await receiptKey(input.tenantId, input.idempotencyKey);
    const existing = parseJson(await env.TENANT_ROUTING_KV.get(key), "WhatsApp canary receipt");
    if (existing) {
      const receipt = record(existing);
      return Response.json({
        ok: true,
        status: "ALREADY_ACCEPTED",
        message_id: required(receipt?.message_id, "Stored WhatsApp message id", 512),
      });
    }
    const accessToken = required(env.META_WHATSAPP_ACCESS_TOKEN, "META_WHATSAPP_ACCESS_TOKEN", 8_192);
    const result = await sendFastWhatsAppTemplate({
      accessToken,
      phoneNumberId: config.phoneNumberId,
      recipientE164: input.recipientE164,
      templateName: input.templateName,
      languageCode: config.languageCode,
      parameters: input.parameters,
    }, dependencies.fetcher);
    await env.TENANT_ROUTING_KV.put(key, JSON.stringify({
      message_id: result.messageId,
      accepted_at_epoch_ms: (dependencies.now ?? Date.now)(),
      template_name: input.templateName,
    }), { expirationTtl: RECEIPT_TTL_SECONDS });
    return Response.json({ ok: true, status: "ACCEPTED_BY_META", message_id: result.messageId }, { status: 202 });
  } catch (error) {
    if (error instanceof WhatsAppPolicyError) {
      return Response.json({ ok: false, status: error.status }, { status: error.httpStatus });
    }
    console.error(JSON.stringify({
      level: "error",
      event: "whatsapp_template_canary_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({ ok: false, status: "WHATSAPP_SEND_FAILED" }, { status: 502 });
  }
}
