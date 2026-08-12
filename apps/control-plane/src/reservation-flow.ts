import { requireObject } from "./tool-gateway.js";

export type ReservationFlowArgs = {
  partySize?: number;
  startsAt?: string;
  customerName?: string;
  customerPhone?: string;
  durationMinutes?: number;
  notes?: string;
  confirm?: boolean;
};

function optionalString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`Invalid ${key}`);
  return value.trim();
}

function optionalInteger(record: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${key}`);
  return value as number;
}

export function validateReservationFlowArgs(value: unknown): ReservationFlowArgs {
  const record = requireObject(value);
  const allowed = new Set(["party_size", "starts_at", "customer_name", "customer_phone", "duration_minutes", "notes", "confirm"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Unexpected reservation field: ${key}`);

  const confirm = record.confirm;
  if (confirm !== undefined && typeof confirm !== "boolean") throw new Error("Invalid confirm");

  return {
    partySize: optionalInteger(record, "party_size", 1, 100),
    startsAt: optionalString(record, "starts_at", 64),
    customerName: optionalString(record, "customer_name", 160),
    customerPhone: optionalString(record, "customer_phone", 32),
    durationMinutes: optionalInteger(record, "duration_minutes", 15, 480),
    notes: optionalString(record, "notes", 1000),
    confirm: confirm as boolean | undefined,
  };
}

export function missingAvailabilityFields(args: ReservationFlowArgs): string[] {
  const missing: string[] = [];
  if (args.partySize === undefined) missing.push("party_size");
  if (!args.startsAt) missing.push("starts_at");
  return missing;
}

export function missingContactFields(args: ReservationFlowArgs): string[] {
  const missing: string[] = [];
  if (!args.customerName) missing.push("customer_name");
  if (!args.customerPhone) missing.push("customer_phone");
  return missing;
}

export function reservationFingerprint(args: ReservationFlowArgs): string {
  if (missingAvailabilityFields(args).length || missingContactFields(args).length) throw new Error("Reservation fingerprint requires complete details");
  return JSON.stringify({
    party_size: args.partySize,
    starts_at: args.startsAt,
    customer_name: args.customerName,
    customer_phone: args.customerPhone,
    duration_minutes: args.durationMinutes ?? 90,
    notes: args.notes ?? null,
  });
}
