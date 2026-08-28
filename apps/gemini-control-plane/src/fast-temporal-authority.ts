import type { FastGeminiToolDeclaration } from "./admission/fast-media";

export const DEFAULT_FAST_TIME_ZONE = "Europe/Madrid";

export type FastAuthoritativeDateTimeSnapshot = Readonly<{
  version: 1;
  source: "WORKER_CLOCK";
  timezone: string;
  captured_at_epoch_ms: number;
  now_iso: string;
  local_date: string;
  local_time: string;
  weekday: string;
}>;

type TenantKv = Readonly<{
  get(key: string): Promise<string | null>;
}>;

export type FastTemporalAuthorityEnv = Readonly<{
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: string;
  TENANT_ROUTING_KV: TenantKv;
}>;

type FastTemporalAuthorityDependencies = Readonly<{
  now?: () => number;
}>;

export const FAST_AUTHORITATIVE_DATETIME_TOOL: FastGeminiToolDeclaration = Object.freeze({
  name: "get_authoritative_datetime",
  description: "Obtiene del kernel la fecha y hora actuales autoritativas para el tenant. Usa esta herramienta antes de afirmar la fecha/hora actual o cuando una interpretación temporal relativa dependa del momento actual. La semántica del lenguaje pertenece a Gemini, pero el reloj, la zona horaria y el calendario pertenecen al kernel. Nunca inventes ni derives por tu cuenta la fecha u hora actuales cuando esta herramienta sea necesaria.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
});

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function required(value: unknown, field: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function parseJson(raw: string | null, field: string): unknown | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { throw new Error(`${field} is invalid JSON`); }
}

function validEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Authoritative clock epoch is invalid");
  return value;
}

export function canonicalFastTimeZone(value: unknown): string {
  const timezone = value == null ? DEFAULT_FAST_TIME_ZONE : required(value, "Tenant business timezone", 128);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error("Tenant business timezone is invalid");
  }
  return timezone;
}

export function resolveFastTenantTimeZone(tenantConfigValue: unknown): string {
  if (tenantConfigValue == null) return DEFAULT_FAST_TIME_ZONE;
  const config = record(tenantConfigValue);
  if (!config) throw new Error("Tenant config is invalid");
  const business = record(config.business);
  return canonicalFastTimeZone(business?.timezone ?? business?.time_zone ?? config.timezone);
}

function localParts(value: Date, timezone: string): Readonly<Record<string, string>> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const result: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") result[part.type] = part.value;
  return Object.freeze(result);
}

function offsetIso(value: Date, timezone: string): string {
  const parts = localParts(value, timezone);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute, second);
  const sourceEpoch = Math.floor(value.getTime() / 1_000) * 1_000;
  const offsetMinutes = Math.round((localEpoch - sourceEpoch) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const offsetMins = String(absolute % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHours}:${offsetMins}`;
}

export function buildFastAuthoritativeDateTimeSnapshot(
  timezone: string,
  nowEpochMs: number = Date.now(),
): FastAuthoritativeDateTimeSnapshot {
  const canonicalTimezone = canonicalFastTimeZone(timezone);
  const epoch = validEpoch(nowEpochMs);
  const now = new Date(epoch);
  if (!Number.isFinite(now.getTime())) throw new Error("Authoritative clock is invalid");
  const parts = localParts(now, canonicalTimezone);
  const weekday = new Intl.DateTimeFormat("es-ES", {
    timeZone: canonicalTimezone,
    weekday: "long",
  }).format(now);
  return Object.freeze({
    version: 1 as const,
    source: "WORKER_CLOCK" as const,
    timezone: canonicalTimezone,
    captured_at_epoch_ms: epoch,
    now_iso: offsetIso(now, canonicalTimezone),
    local_date: `${parts.year}-${parts.month}-${parts.day}`,
    local_time: `${parts.hour}:${parts.minute}:${parts.second}`,
    weekday,
  });
}

export function fastTemporalAuthorityInstruction(snapshot: FastAuthoritativeDateTimeSnapshot): string {
  return [
    "Autoridad temporal del kernel:",
    `- Snapshot inicial firmado por el Worker: ${JSON.stringify(snapshot)}`,
    "- El Worker es la autoridad final del reloj, zona horaria y calendario; no uses conocimiento del modelo para decidir cuál es la fecha u hora actual.",
    "- Gemini conserva la interpretación semántica libre del lenguaje temporal; no reduzcas expresiones naturales a listas de palabras o frases rígidas.",
    "- Usa get_authoritative_datetime antes de afirmar la fecha/hora actual o cuando una referencia temporal dependa de un 'ahora' que pueda haber cambiado desde el inicio de la llamada.",
    "- El resultado más reciente de get_authoritative_datetime sustituye este snapshot inicial para el turno correlacionado.",
    "- Si la autoridad temporal no está disponible, no inventes la fecha/hora ni materialices una referencia relativa dependiente del momento actual; explica brevemente que no puedes verificar el reloj en ese momento.",
  ].join("\n");
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

export async function routeFastAuthoritativeDateTime(
  request: Request,
  env: FastTemporalAuthorityEnv,
  dependencies: FastTemporalAuthorityDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return Response.json({ ok: false, status: "METHOD_NOT_ALLOWED" }, { status: 405 });
  if (!await controlAuthorized(request, required(env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN, "GEMINI_MEDIA_CONTROL_PLANE_TOKEN", 8_192))) {
    return Response.json({ ok: false, status: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!env.TENANT_ROUTING_KV || typeof env.TENANT_ROUTING_KV.get !== "function") {
    return Response.json({ ok: false, status: "TEMPORAL_AUTHORITY_UNAVAILABLE" }, { status: 503 });
  }

  let body: Record<string, unknown> | null = null;
  try { body = record(await request.json()); } catch {}
  if (!body) return Response.json({ ok: false, status: "INVALID_REQUEST" }, { status: 400 });

  try {
    const tenantId = required(body.tenantId ?? body.tenant_id, "tenantId", 256);
    const callControlId = body.callControlId ?? body.call_control_id;
    if (callControlId != null) required(callControlId, "callControlId", 512);
    const configValue = parseJson(await env.TENANT_ROUTING_KV.get(`tenant_config:${tenantId}`), "Tenant config");
    const config = configValue == null ? null : record(configValue);
    if (configValue != null && !config) throw new Error("Tenant config is invalid");
    const declaredTenant = config?.tenant_id ?? config?.tenantId;
    if (declaredTenant != null && required(declaredTenant, "Tenant config tenant id", 256) !== tenantId) {
      throw new Error("Tenant config tenant mismatch");
    }
    if (config?.status != null && config.status !== "active") throw new Error("Tenant config is not active");
    const timezone = resolveFastTenantTimeZone(configValue);
    const now = dependencies.now ?? Date.now;
    const authoritativeTemporalContext = buildFastAuthoritativeDateTimeSnapshot(timezone, now());
    return Response.json({
      ok: true,
      status: "AUTHORITATIVE_DATETIME",
      time_authoritative: true,
      authoritative_temporal_context: authoritativeTemporalContext,
      instruction: "Este resultado procede del reloj autoritativo del Worker y sustituye cualquier snapshot temporal anterior para el turno actual. Usa su timezone, fecha y hora; no derives otra fecha/hora actual por tu cuenta.",
    });
  } catch {
    return Response.json({
      ok: false,
      status: "TEMPORAL_AUTHORITY_UNAVAILABLE",
      time_authoritative: false,
      instruction: "No afirmes una fecha u hora actual ni materialices una referencia temporal dependiente de ahora porque el kernel no pudo certificar el reloj.",
    }, { status: 503 });
  }
}
