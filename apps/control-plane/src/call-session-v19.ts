import { CallSession as CallSessionV18 } from "./call-session-v18";
import type { ToolGateway, ToolResult } from "./tool-gateway";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV18 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV18.prototype as any;

const CREATE_RESERVATION = "restaurant_reservation_create";
const CHECK_AVAILABILITY = "check_reservation_availability";
const MANAGE_RESERVATION = "manage_reservation";

type ReservationDraft = {
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

function parseObject(argumentsJson: string | undefined): Record<string, unknown> {
  if (!argumentsJson?.trim()) return {};
  const parsed = JSON.parse(argumentsJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}

function publicToolOutput(result: ToolResult): Record<string, unknown> {
  if (!result.ok) return { ok: false, status: "ERROR", error: result.error, message: result.message };
  const payload = result.result && typeof result.result === "object" && !Array.isArray(result.result)
    ? result.result as Record<string, unknown>
    : { value: result.result };
  return { ok: true, ...payload };
}

export class CallSession extends BaseConstructor {
  private reservationDraftV19: ReservationDraft = {};
  private reservationAvailabilityFingerprintV19: string | null = null;
  private reservationAvailabilityResultV19: Record<string, unknown> | null = null;

  private mergeReservationDraftV19(args: Record<string, unknown>): ReservationDraft {
    const allowed = [
      "party_size", "starts_at", "customer_name", "customer_phone", "use_caller_phone",
      "duration_minutes", "notes", "confirm", "separate_tables_acceptable", "tables_must_be_close",
    ] as const;
    for (const key of allowed) {
      if (args[key] !== undefined) (this.reservationDraftV19 as Record<string, unknown>)[key] = args[key];
    }
    if (this.reservationDraftV19.use_caller_phone === true && !this.reservationDraftV19.customer_phone) {
      const caller = (this as any).callerPhone;
      if (typeof caller === "string" && caller.trim()) this.reservationDraftV19.customer_phone = caller.trim();
    }
    return { ...this.reservationDraftV19 };
  }

  private reservationAvailabilityFingerprint(draft: ReservationDraft): string | null {
    if (!Number.isInteger(draft.party_size) || !draft.starts_at) return null;
    return JSON.stringify({
      party_size: draft.party_size,
      starts_at: draft.starts_at,
      duration_minutes: draft.duration_minutes ?? 90,
      separate_tables_acceptable: draft.separate_tables_acceptable ?? null,
      tables_must_be_close: draft.tables_must_be_close ?? null,
    });
  }

  private sendFunctionOutputV19(callId: string | undefined, output: Record<string, unknown>): void {
    const port = realtimeCommandPortFor(this as any);
    port.submitToolResult({ callId, toolName: CREATE_RESERVATION, output });
    port.createDefaultResponse();
  }

  private async executeDirectCreateV19(callId: string | undefined, args: Record<string, unknown>): Promise<void> {
    const draft = this.mergeReservationDraftV19(args);
    const tenantId = (this as any).tenantId as string | null | undefined;
    if (!tenantId) {
      this.sendFunctionOutputV19(callId, { ok: false, status: "ERROR", error: "TENANT_REQUIRED" });
      return;
    }

    // Keep v16 multi-table preference state synchronized, but do not route execution
    // through conversation_intent / CoreIntent / legacy reservation collection.
    (this as any).captureStructuredTurnV16?.(JSON.stringify({
      intent: "CREATE_RESERVATION",
      reservation: draft,
    }));

    const missingAvailability: string[] = [];
    if (!Number.isInteger(draft.party_size)) missingAvailability.push("party_size");
    if (!draft.starts_at) missingAvailability.push("starts_at");
    if (missingAvailability.length) {
      this.sendFunctionOutputV19(callId, {
        ok: true,
        status: "MISSING_INFORMATION",
        missing: missingAvailability,
        draft,
      });
      return;
    }

    const gateway = (this as any).createToolGateway?.() as ToolGateway | undefined;
    if (!gateway) {
      this.sendFunctionOutputV19(callId, { ok: false, status: "ERROR", error: "TOOL_GATEWAY_UNAVAILABLE" });
      return;
    }

    const fingerprint = this.reservationAvailabilityFingerprint(draft)!;
    if (this.reservationAvailabilityFingerprintV19 !== fingerprint || !this.reservationAvailabilityResultV19) {
      const started = Date.now();
      (this as any).diagnostics?.checkpoint?.("DIRECT_RESERVATION_AVAILABILITY_STARTED", {
        party_size: draft.party_size,
        starts_at: draft.starts_at,
      });
      const availability = await gateway.execute({
        name: CHECK_AVAILABILITY,
        arguments: {
          party_size: draft.party_size,
          starts_at: draft.starts_at,
          duration_minutes: draft.duration_minutes ?? 90,
        },
        context: { tenantId, callId: (this as any).callId ?? undefined },
      });
      (this as any).diagnostics?.checkpoint?.("DIRECT_RESERVATION_AVAILABILITY_COMPLETED", {
        elapsed_ms: Date.now() - started,
        ok: availability.ok,
      });
      if (!availability.ok) {
        this.sendFunctionOutputV19(callId, publicToolOutput(availability));
        return;
      }
      this.reservationAvailabilityFingerprintV19 = fingerprint;
      this.reservationAvailabilityResultV19 = availability.result as Record<string, unknown>;
    }

    const availabilityResult = this.reservationAvailabilityResultV19 ?? {};
    if (availabilityResult.requested_available !== true) {
      this.sendFunctionOutputV19(callId, {
        ok: true,
        status: "UNAVAILABLE",
        ...availabilityResult,
      });
      return;
    }

    const missingContact: string[] = [];
    if (!draft.customer_name) missingContact.push("customer_name");
    if (!draft.customer_phone) missingContact.push("customer_phone");
    if (missingContact.length) {
      this.sendFunctionOutputV19(callId, {
        ok: true,
        status: "AVAILABLE_NEEDS_CONTACT",
        missing: missingContact,
        availability: availabilityResult,
        draft,
      });
      return;
    }

    if (draft.confirm !== true) {
      this.sendFunctionOutputV19(callId, {
        ok: true,
        status: "READY_TO_CONFIRM",
        availability: availabilityResult,
        reservation: {
          party_size: draft.party_size,
          starts_at: draft.starts_at,
          customer_name: draft.customer_name,
          duration_minutes: draft.duration_minutes ?? 90,
          separate_tables_acceptable: draft.separate_tables_acceptable ?? false,
        },
      });
      return;
    }

    const started = Date.now();
    (this as any).diagnostics?.checkpoint?.("DIRECT_RESERVATION_BOOKING_STARTED", {
      party_size: draft.party_size,
      starts_at: draft.starts_at,
    });
    const booking = await gateway.execute({
      name: MANAGE_RESERVATION,
      arguments: {
        party_size: draft.party_size,
        starts_at: draft.starts_at,
        customer_name: draft.customer_name,
        customer_phone: draft.customer_phone,
        duration_minutes: draft.duration_minutes ?? 90,
        notes: draft.notes,
        confirm: true,
      },
      context: { tenantId, callId: (this as any).callId ?? undefined },
    });
    (this as any).diagnostics?.checkpoint?.("DIRECT_RESERVATION_BOOKING_COMPLETED", {
      elapsed_ms: Date.now() - started,
      ok: booking.ok,
      stage: booking.ok && booking.result && typeof booking.result === "object"
        ? (booking.result as Record<string, unknown>).stage
        : null,
    });

    if (booking.ok && booking.result && typeof booking.result === "object" && (booking.result as Record<string, unknown>).stage === "BOOKED") {
      this.reservationDraftV19 = {};
      this.reservationAvailabilityFingerprintV19 = null;
      this.reservationAvailabilityResultV19 = null;
    }
    this.sendFunctionOutputV19(callId, publicToolOutput(booking));
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = adaptRealtimeProviderEvents(data).find(
      (candidate) => candidate.type === "SEMANTIC_TOOL_SELECTED" && candidate.name === CREATE_RESERVATION,
    );

    if (event?.type === "SEMANTIC_TOOL_SELECTED" && event.name === CREATE_RESERVATION) {
      let args: Record<string, unknown>;
      try {
        args = parseObject(event.arguments);
      } catch (error) {
        this.sendFunctionOutputV19(event.callId, {
          ok: false,
          status: "ERROR",
          error: "INVALID_ARGUMENTS",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      (this as any).diagnostics?.checkpoint?.("LUCIA_AGENT_TOOL_SELECTED", {
        tool: CREATE_RESERVATION,
        compatibility_executor: "direct_reservation_controller_v19",
      });
      try {
        await this.executeDirectCreateV19(event.callId, args);
      } catch (error) {
        (this as any).diagnostics?.fail?.("DIRECT_RESERVATION_FAILED", "DIRECT_RESERVATION_EXECUTION_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.sendFunctionOutputV19(event.callId, {
          ok: false,
          status: "ERROR",
          error: "EXECUTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
