import { requireObject } from "./tool-gateway.js";

export type ReservationFlowArgs = {
  partySize?: number;
  startsAt?: string;
  customerName?: string;
  customerPhone?: string;
  useCallerPhone?: boolean;
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

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid ${key}`);
  return value;
}

function normalizeE164(value: string): string {
  const phone = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Invalid customer_phone");
  return phone;
}

export function validateReservationFlowArgs(value: unknown): ReservationFlowArgs {
  const record = requireObject(value);
  const allowed = new Set(["party_size", "starts_at", "customer_name", "customer_phone", "use_caller_phone", "duration_minutes", "notes", "confirm"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Unexpected reservation field: ${key}`);

  const customerPhoneRaw = optionalString(record, "customer_phone", 32);
  const customerPhone = customerPhoneRaw ? normalizeE164(customerPhoneRaw) : undefined;

  return {
    partySize: optionalInteger(record, "party_size", 1, 100),
    startsAt: optionalString(record, "starts_at", 64),
    customerName: optionalString(record, "customer_name", 160),
    customerPhone,
    useCallerPhone: optionalBoolean(record, "use_caller_phone"),
    durationMinutes: optionalInteger(record, "duration_minutes", 15, 480),
    notes: optionalString(record, "notes", 1000),
    confirm: optionalBoolean(record, "confirm"),
  };
}

export function resolveReservationContactPhone(args: ReservationFlowArgs, callerPhone: string | null | undefined): string | undefined {
  const normalizedCaller = callerPhone ? normalizeE164(callerPhone) : undefined;
  if (args.customerPhone && args.useCallerPhone === true && normalizedCaller && args.customerPhone !== normalizedCaller) {
    throw new Error("Conflicting reservation phone selection");
  }
  if (args.customerPhone) return args.customerPhone;
  if (args.useCallerPhone === true) return normalizedCaller;
  return undefined;
}

export function withResolvedReservationContact(args: ReservationFlowArgs, callerPhone: string | null | undefined): ReservationFlowArgs {
  const phone = resolveReservationContactPhone(args, callerPhone);
  return { ...args, customerPhone: phone };
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
