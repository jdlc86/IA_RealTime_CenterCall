import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port.js";
import { requireRealtimeProviderCapabilities } from "./realtime-provider-capabilities.js";
import type { RealtimeProviderName } from "./realtime-provider-types.js";
import { withAuthoritativeNowContext } from "./temporal-grounding.js";
import { resolveAuthoritativeRelativeDate } from "./authoritative-relative-date.js";

export type AuthoritativeTemporalContextRefresh = Readonly<{
  baseInstructions: string;
  now?: Date;
  callerTurn?: Readonly<{ itemId: string; transcript: string }>;
}>;

export type AuthoritativeReservationDateDecision =
  | Readonly<{ action: "NO_CALLER_CONTEXT" }>
  | Readonly<{ action: "NO_RELATIVE_DATE_EVIDENCE"; itemId: string }>
  | Readonly<{ action: "ALLOW"; itemId: string; authoritativeLocalDate: string }>
  | Readonly<{ action: "BLOCK_MISMATCH"; itemId: string; authoritativeLocalDate: string; requestedLocalDate: string }>
  | Readonly<{ action: "BLOCK_AMBIGUOUS"; itemId: string; authoritativeLocalDates: readonly string[] }>;

/**
 * Provider-neutral capability for keeping conversational and business semantics
 * grounded in backend-owned time.
 *
 * Callers request the semantic effect only. They do not know whether a provider
 * achieves it with a session mutation, a dedicated context primitive, or
 * product-owned validation at the business-effect boundary.
 */
export interface AuthoritativeTemporalContextPort {
  refresh(request: AuthoritativeTemporalContextRefresh): void;
  decideReservationDate(requestedLocalDate: string): AuthoritativeReservationDateDecision;
}

type AuthoritativeCallerTurnContext = Readonly<{ itemId: string; transcript: string; now: Date }>;

class AuthoritativeCallerTurnClock {
  private latest: AuthoritativeCallerTurnContext | null = null;

  refresh(request: AuthoritativeTemporalContextRefresh): void {
    if (!request.callerTurn) return;
    const itemId = request.callerTurn.itemId.trim();
    const transcript = request.callerTurn.transcript.replace(/\s+/g, " ").trim();
    if (!itemId || !transcript) throw new Error("Authoritative temporal caller turn is invalid");
    const now = new Date((request.now ?? new Date()).getTime());
    if (!Number.isFinite(now.getTime())) throw new Error("Authoritative temporal current time is invalid");
    this.latest = Object.freeze({ itemId, transcript, now });
  }

  decideReservationDate(requestedLocalDate: string): AuthoritativeReservationDateDecision {
    const requested = requestedLocalDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) throw new Error("Requested reservation local date is invalid");
    if (!this.latest) return { action: "NO_CALLER_CONTEXT" };
    const resolved = resolveAuthoritativeRelativeDate(this.latest.transcript, this.latest.now);
    if (resolved.kind === "NO_RELATIVE_DATE_EVIDENCE") {
      return Object.freeze({ action: "NO_RELATIVE_DATE_EVIDENCE", itemId: this.latest.itemId });
    }
    if (resolved.kind === "AMBIGUOUS") {
      return Object.freeze({
        action: "BLOCK_AMBIGUOUS",
        itemId: this.latest.itemId,
        authoritativeLocalDates: resolved.localDates,
      });
    }
    if (resolved.localDate === requested) {
      return Object.freeze({ action: "ALLOW", itemId: this.latest.itemId, authoritativeLocalDate: resolved.localDate });
    }
    return Object.freeze({
      action: "BLOCK_MISMATCH",
      itemId: this.latest.itemId,
      authoritativeLocalDate: resolved.localDate,
      requestedLocalDate: requested,
    });
  }
}

class RealtimeBackedAuthoritativeTemporalContextPort implements AuthoritativeTemporalContextPort {
  private readonly callerClock = new AuthoritativeCallerTurnClock();

  constructor(
    private readonly provider: RealtimeProviderName,
    private readonly realtime: RealtimeProviderCommandPort,
  ) {}

  refresh(request: AuthoritativeTemporalContextRefresh): void {
    requireRealtimeProviderCapabilities(this.provider, ["authoritativeTemporalContext"]);
    this.realtime.updateSessionPolicy({
      instructions: withAuthoritativeNowContext(request.baseInstructions, request.now ?? new Date()),
    });
    this.callerClock.refresh(request);
  }

  decideReservationDate(requestedLocalDate: string): AuthoritativeReservationDateDecision {
    return this.callerClock.decideReservationDate(requestedLocalDate);
  }
}

class ProductOwnedAuthoritativeTemporalContextPort implements AuthoritativeTemporalContextPort {
  private readonly callerClock = new AuthoritativeCallerTurnClock();
  private closed = false;

  refresh(request: AuthoritativeTemporalContextRefresh): void {
    if (this.closed) throw new Error("Product-owned authoritative temporal context is closed");
    this.callerClock.refresh(request);
  }

  decideReservationDate(requestedLocalDate: string): AuthoritativeReservationDateDecision {
    if (this.closed) throw new Error("Product-owned authoritative temporal context is closed");
    return this.callerClock.decideReservationDate(requestedLocalDate);
  }

  close(): void {
    this.closed = true;
  }
}

export type ProductOwnedAuthoritativeTemporalContextCapability = Readonly<{
  port: AuthoritativeTemporalContextPort;
  close(): void;
}>;

/** Dynamic backend-owned clock with no provider conversation or wire effect. */
export function createProductOwnedAuthoritativeTemporalContextCapability(): ProductOwnedAuthoritativeTemporalContextCapability {
  const owner = new ProductOwnedAuthoritativeTemporalContextPort();
  return Object.freeze({ port: owner, close: () => owner.close() });
}

export function createRealtimeBackedAuthoritativeTemporalContextPort(
  provider: RealtimeProviderName,
  realtime: RealtimeProviderCommandPort,
): AuthoritativeTemporalContextPort {
  return new RealtimeBackedAuthoritativeTemporalContextPort(provider, realtime);
}
