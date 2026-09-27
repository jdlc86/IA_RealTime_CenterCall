import type { FastGeminiToolDeclaration } from "./admission/fast-media";
import {
  DEFAULT_TENANT_TIME_ZONE,
  buildAuthoritativeDateTimeSnapshot,
  canonicalTenantTimeZone,
  resolveTenantTimeZone,
  type AuthoritativeDateTimeSnapshot,
} from "./kernel/temporal-authority";

export const DEFAULT_FAST_TIME_ZONE = DEFAULT_TENANT_TIME_ZONE;
export type FastAuthoritativeDateTimeSnapshot = AuthoritativeDateTimeSnapshot;
export const canonicalFastTimeZone = canonicalTenantTimeZone;
export const resolveFastTenantTimeZone = resolveTenantTimeZone;
export const buildFastAuthoritativeDateTimeSnapshot = buildAuthoritativeDateTimeSnapshot;

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
  capability: "time.authoritative",
  description: "Obtiene del kernel la fecha y hora actuales autoritativas para el tenant. Su dominio es exclusivamente el anclaje del reloj y calendario actuales. Las consultas meteorológicas, de clima, previsión del tiempo, duración u otros sentidos de 'tiempo' están fuera de alcance: no invoques esta herramienta si la petición no depende del momento calendario actual. Decide por el significado completo del turno, no por coincidencias de palabras. Usa esta herramienta antes de afirmar la fecha/hora actual o cuando una interpretación temporal relativa dependa del momento actual. La semántica del lenguaje pertenece a Gemini, pero el reloj, la zona horaria y el calendario pertenecen al kernel. Nunca inventes ni derives por tu cuenta la fecha u hora actuales cuando esta herramienta sea necesaria.",
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

export function fastTemporalAuthorityInstruction(snapshot: FastAuthoritativeDateTimeSnapshot): string {
  return [
    "Autoridad temporal del kernel:",
    `- Snapshot inicial emitido por el Worker mediante el bootstrap autenticado: ${JSON.stringify(snapshot)}`,
    "- El Worker es la autoridad final del reloj, zona horaria y calendario; no uses conocimiento del modelo para decidir cuál es la fecha u hora actual.",
    "- El dominio de get_authoritative_datetime es únicamente el reloj/calendario actual y referencias relativas que dependan de ese momento. Meteorología, clima, previsión del tiempo, duración u otros significados de 'tiempo' quedan fuera de ese dominio.",
    "- Decide la necesidad por el significado completo del turno; no actives la herramienta por una palabra aislada ni por coincidencia léxica.",
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
