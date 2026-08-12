import { requireObject } from "./tool-gateway.js";

export type ReservationOperation = "CREATE" | "QUERY" | "CANCEL";

export type ReservationDraft = {
  partySize?: number;
  startsAt?: string;
  customerName?: string;
  customerPhone?: string;
  useCallerPhone?: boolean;
  durationMinutes?: number;
  notes?: string;
};

export type ReservationTurn = {
  operation: ReservationOperation;
  patch: ReservationDraft;
  confirm: boolean;
  selectionIndex?: number;
};

function optionalString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`Invalid reservation.${key}`);
  return value.trim();
}

function optionalInteger(record: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid reservation.${key}`);
  return value as number;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid reservation.${key}`);
  return value;
}

function optionalOperation(record: Record<string, unknown>): ReservationOperation {
  const value = record.operation;
  if (value === undefined || value === null) return "CREATE";
  if (value !== "CREATE" && value !== "QUERY" && value !== "CANCEL") throw new Error("Invalid reservation.operation");
  return value;
}

function normalizeE164(value: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new Error("Invalid reservation.customer_phone");
  return value;
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) throw new Error("Invalid reservation.starts_at");
  return new Date(parsed).toISOString();
}

export function parseReservationTurn(argumentsJson: string | undefined): ReservationTurn {
  if (!argumentsJson?.trim()) return { operation: "CREATE", patch: {}, confirm: false };
  const root = requireObject(JSON.parse(argumentsJson));
  if (root.data_requirement !== "RESERVATION") return { operation: "CREATE", patch: {}, confirm: false };
  if (root.reservation === undefined || root.reservation === null) return { operation: "CREATE", patch: {}, confirm: false };

  const reservation = requireObject(root.reservation);
  const allowed = new Set(["operation", "party_size", "starts_at", "customer_name", "customer_phone", "use_caller_phone", "duration_minutes", "notes", "confirm", "selection_index"]);
  for (const key of Object.keys(reservation)) if (!allowed.has(key)) throw new Error(`Unexpected reservation field: ${key}`);

  const startsAtRaw = optionalString(reservation, "starts_at", 64);
  const phoneRaw = optionalString(reservation, "customer_phone", 32);
  const confirm = optionalBoolean(reservation, "confirm") ?? false;

  return {
    operation: optionalOperation(reservation),
    patch: {
      partySize: optionalInteger(reservation, "party_size", 1, 100),
      startsAt: startsAtRaw ? normalizeIso(startsAtRaw) : undefined,
      customerName: optionalString(reservation, "customer_name", 160),
      customerPhone: phoneRaw ? normalizeE164(phoneRaw) : undefined,
      useCallerPhone: optionalBoolean(reservation, "use_caller_phone"),
      durationMinutes: optionalInteger(reservation, "duration_minutes", 15, 480),
      notes: optionalString(reservation, "notes", 1000),
    },
    confirm,
    selectionIndex: optionalInteger(reservation, "selection_index", 1, 20),
  };
}

export function mergeReservationDraft(current: ReservationDraft, patch: ReservationDraft, callerPhone?: string | null): ReservationDraft {
  const next: ReservationDraft = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  if (patch.useCallerPhone === true && callerPhone && /^\+[1-9]\d{7,14}$/.test(callerPhone)) {
    next.customerPhone = callerPhone;
  }
  if (patch.customerPhone) next.useCallerPhone = patch.useCallerPhone === true && patch.customerPhone === callerPhone;
  return next;
}

export function missingReservationAvailability(draft: ReservationDraft): string[] {
  const missing: string[] = [];
  if (draft.partySize === undefined) missing.push("party_size");
  if (!draft.startsAt) missing.push("starts_at");
  return missing;
}

export function missingReservationContact(draft: ReservationDraft): string[] {
  const missing: string[] = [];
  if (!draft.customerName) missing.push("customer_name");
  if (!draft.customerPhone) missing.push("customer_phone");
  return missing;
}

export function availabilityKey(draft: ReservationDraft): string | null {
  if (draft.partySize === undefined || !draft.startsAt) return null;
  return JSON.stringify({ party_size: draft.partySize, starts_at: draft.startsAt, duration_minutes: draft.durationMinutes ?? 90 });
}

export function completeReservationFingerprint(draft: ReservationDraft): string | null {
  if (missingReservationAvailability(draft).length || missingReservationContact(draft).length) return null;
  return JSON.stringify({
    party_size: draft.partySize,
    starts_at: draft.startsAt,
    customer_name: draft.customerName,
    customer_phone: draft.customerPhone,
    duration_minutes: draft.durationMinutes ?? 90,
    notes: draft.notes ?? null,
  });
}

export function nearbyStartTimes(startsAt: string, offsetsMinutes: number[] = [-30, 30, -60, 60]): string[] {
  const parsed = Date.parse(startsAt);
  if (!Number.isFinite(parsed)) throw new Error("Invalid starts_at");
  return offsetsMinutes.map((minutes) => new Date(parsed + minutes * 60_000).toISOString());
}
