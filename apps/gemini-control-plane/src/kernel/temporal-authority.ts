export const DEFAULT_TENANT_TIME_ZONE = "Europe/Madrid";

export type AuthoritativeDateTimeSnapshot = Readonly<{
  version: 1;
  source: "WORKER_CLOCK";
  timezone: string;
  captured_at_epoch_ms: number;
  now_iso: string;
  local_date: string;
  local_time: string;
  weekday: string;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function required(value: unknown, field: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function validEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Authoritative clock epoch is invalid");
  return value;
}

export function canonicalTenantTimeZone(value: unknown): string {
  const timezone = value == null ? DEFAULT_TENANT_TIME_ZONE : required(value, "Tenant business timezone", 128);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error("Tenant business timezone is invalid");
  }
  return timezone;
}

export function resolveTenantTimeZone(tenantConfigValue: unknown): string {
  if (tenantConfigValue == null) return DEFAULT_TENANT_TIME_ZONE;
  const config = record(tenantConfigValue);
  if (!config) throw new Error("Tenant config is invalid");
  const business = record(config.business);
  return canonicalTenantTimeZone(business?.timezone ?? business?.time_zone ?? config.timezone);
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
  const localEpoch = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const sourceEpoch = Math.floor(value.getTime() / 1_000) * 1_000;
  const offsetMinutes = Math.round((localEpoch - sourceEpoch) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const offsetMins = String(absolute % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHours}:${offsetMins}`;
}

export function buildAuthoritativeDateTimeSnapshot(
  timezone: string,
  nowEpochMs: number = Date.now(),
): AuthoritativeDateTimeSnapshot {
  const canonicalTimezone = canonicalTenantTimeZone(timezone);
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
