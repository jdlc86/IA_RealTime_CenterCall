export type ReservationDraft = {
  party_size?: number;
  starts_at?: string;
  customer_name?: string;
  customer_phone?: string;
  use_caller_phone?: boolean;
  duration_minutes?: number;
  notes?: string;
  confirm?: boolean;
  separate_tables_acceptable?: boolean;
  tables_must_be_close?: boolean;
};

export type ReservationStage =
  | "IDLE"
  | "COLLECTING"
  | "AVAILABILITY_CONFIRMED"
  | "NEEDS_CONTACT"
  | "READY_TO_CONFIRM"
  | "BOOKED"
  | "CONFLICT";

export type ReservationSessionSnapshot = Readonly<{
  draft: ReservationDraft;
  stage: ReservationStage;
  commitEpoch: number;
  availabilityFingerprint: string | null;
  availabilityResult: Record<string, unknown> | null;
  offeredSlotFingerprint: string | null;
}>;

const ALLOWED_DRAFT_KEYS = [
  "party_size",
  "starts_at",
  "customer_name",
  "customer_phone",
  "use_caller_phone",
  "duration_minutes",
  "notes",
  "confirm",
  "separate_tables_acceptable",
  "tables_must_be_close",
] as const satisfies readonly (keyof ReservationDraft)[];

/**
 * Single owner for the in-call reservation draft and its commit lifecycle.
 *
 * This runtime intentionally contains no provider, CallSession-version, or backend
 * imports. CallSession adapters feed it facts; other authorities consume only its
 * public snapshot/epoch contract. No layer may inspect another layer's private
 * reservation fields.
 */
export class ReservationSessionRuntime {
  private draft: ReservationDraft = {};
  private stage: ReservationStage = "IDLE";
  private availabilityFingerprint: string | null = null;
  private availabilityResult: Record<string, unknown> | null = null;
  private offeredSlotFingerprint: string | null = null;
  private commitEpoch = 0;

  snapshot(): ReservationSessionSnapshot {
    return Object.freeze({
      draft: { ...this.draft },
      stage: this.stage,
      commitEpoch: this.commitEpoch,
      availabilityFingerprint: this.availabilityFingerprint,
      availabilityResult: this.availabilityResult ? { ...this.availabilityResult } : null,
      offeredSlotFingerprint: this.offeredSlotFingerprint,
    });
  }

  mergeDraft(args: Record<string, unknown>, trustedCallerPhone: string | null): ReservationDraft {
    for (const key of ALLOWED_DRAFT_KEYS) {
      if (args[key] !== undefined) (this.draft as Record<string, unknown>)[key] = args[key];
    }
    if (this.draft.use_caller_phone === true && !this.draft.customer_phone && trustedCallerPhone) {
      this.draft.customer_phone = trustedCallerPhone;
    }
    if (Object.keys(this.draft).length > 0 && this.stage === "IDLE") this.stage = "COLLECTING";
    return { ...this.draft };
  }

  fingerprintFor(draft: ReservationDraft): string | null {
    if (!Number.isInteger(draft.party_size) || !draft.starts_at) return null;
    return JSON.stringify({
      party_size: draft.party_size,
      starts_at: draft.starts_at,
      duration_minutes: draft.duration_minutes ?? 90,
      separate_tables_acceptable: draft.separate_tables_acceptable ?? null,
      tables_must_be_close: draft.tables_must_be_close ?? null,
    });
  }

  slotFingerprintFor(draft: ReservationDraft): string | null {
    if (!Number.isInteger(draft.party_size) || !draft.starts_at) return null;
    return JSON.stringify({
      party_size: draft.party_size,
      starts_at: draft.starts_at,
      duration_minutes: draft.duration_minutes ?? 90,
    });
  }

  canonicalizeOutstandingConfirmation(args: Record<string, unknown>): Record<string, unknown> {
    const candidates = this.availabilityResult?.requested_candidates;
    const confirmsOnlyOutstandingProposal = args.confirm === true
      && args.separate_tables_acceptable === undefined
      && this.draft.separate_tables_acceptable === undefined
      && this.draft.tables_must_be_close !== true
      && Array.isArray(candidates)
      && candidates.length > 1;
    return confirmsOnlyOutstandingProposal
      ? { ...args, separate_tables_acceptable: true }
      : args;
  }

  wasSlotOffered(draft: ReservationDraft): boolean {
    const fingerprint = this.slotFingerprintFor(draft);
    return fingerprint !== null && fingerprint === this.offeredSlotFingerprint;
  }

  cachedAvailability(fingerprint: string): Record<string, unknown> | null {
    if (this.availabilityFingerprint !== fingerprint || !this.availabilityResult) return null;
    return { ...this.availabilityResult };
  }

  recordAvailability(fingerprint: string, result: Record<string, unknown>): void {
    this.availabilityFingerprint = fingerprint;
    this.availabilityResult = { ...result };
    const candidates = result.requested_candidates;
    if (result.requested_available === true || (Array.isArray(candidates) && candidates.length > 0)) {
      const slotFingerprint = this.slotFingerprintFor(this.draft);
      if (slotFingerprint) this.offeredSlotFingerprint = slotFingerprint;
    }
    this.stage = result.requested_available === true ? "AVAILABILITY_CONFIRMED" : "COLLECTING";
  }

  markNeedsContact(): void {
    this.stage = "NEEDS_CONTACT";
  }

  markReadyToConfirm(): void {
    this.stage = "READY_TO_CONFIRM";
  }

  invalidateAvailabilityForConflict(): void {
    this.availabilityFingerprint = null;
    this.availabilityResult = null;
    this.offeredSlotFingerprint = null;
    this.draft.confirm = false;
    this.stage = "CONFLICT";
  }

  markBooked(): void {
    this.draft = {};
    this.availabilityFingerprint = null;
    this.availabilityResult = null;
    this.offeredSlotFingerprint = null;
    this.stage = "BOOKED";
    this.commitEpoch += 1;
  }

  committedAfter(epoch: number): boolean {
    return this.commitEpoch > epoch;
  }
}

const runtimes = new WeakMap<object, ReservationSessionRuntime>();

export function reservationSessionRuntimeFor(session: object): ReservationSessionRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new ReservationSessionRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
