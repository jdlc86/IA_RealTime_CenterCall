import { CallSession as CallSessionV18 } from "./call-session-v18";
import type { ToolGateway, ToolResult } from "./tool-gateway";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import {
  isReservationAvailabilityConflict,
  reservationAvailabilityChangedOutput,
} from "./reservation-concurrency-policy.js";
import { reservationContactIdentityRuntimeFor } from "./reservation-contact-identity-runtime.js";
import { reservationDatetimeRuntimeFor } from "./reservation-datetime-runtime.js";
import {
  reservationSessionRuntimeFor,
  type ReservationDraft,
} from "./reservation-session-runtime.js";
import { reservationMultitableRuntimeFor } from "./reservation-multitable-runtime.js";

const BaseConstructor = CallSessionV18 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV18.prototype as any;

const CREATE_RESERVATION = "restaurant_reservation_create";
const CHECK_AVAILABILITY = "check_reservation_availability";
const MANAGE_RESERVATION = "manage_reservation";

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

function trustedCallerPhone(session: any): string | null {
  return typeof session.callerPhone === "string" && session.callerPhone.trim() ? session.callerPhone.trim() : null;
}

export class CallSession extends BaseConstructor {
  protected sendReservationOutput(callId: string | undefined, output: Record<string, unknown>): void {
    const port = realtimeCommandPortFor(this as any);
    port.submitToolResult({ callId, toolName: CREATE_RESERVATION, output });
    port.createDefaultResponse();
  }

  private async executeDirectCreateV19(callId: string | undefined, args: Record<string, unknown>): Promise<void> {
    const session = this as any;
    const runtime = reservationSessionRuntimeFor(this);
    const callerPhone = trustedCallerPhone(session);
    const canonicalArguments = runtime.canonicalizeOutstandingConfirmation(args);
    const contactIdentity = reservationContactIdentityRuntimeFor(this).canonicalizeCreate(this, {
      callId,
      trustedCallerPhone: callerPhone,
      arguments: canonicalArguments,
    });
    if (!contactIdentity.allowed) return;
    const datetime = reservationDatetimeRuntimeFor(this).canonicalizeCreate(this, {
      callId,
      arguments: contactIdentity.arguments,
    });
    if (!datetime.allowed) return;
    const draft = runtime.mergeDraft(datetime.arguments, callerPhone);
    const tenantId = session.tenantId as string | null | undefined;
    if (!tenantId) {
      this.sendReservationOutput(callId, { ok: false, status: "ERROR", error: "TENANT_REQUIRED" });
      return;
    }

    reservationMultitableRuntimeFor(this).capturePreferences({
      separateTablesAcceptable: draft.separate_tables_acceptable,
      tablesMustBeClose: draft.tables_must_be_close,
    });

    const missingAvailability: string[] = [];
    if (!Number.isInteger(draft.party_size)) missingAvailability.push("party_size");
    if (!draft.starts_at) missingAvailability.push("starts_at");
    if (missingAvailability.length) {
      this.sendReservationOutput(callId, {
        ok: true,
        status: "MISSING_INFORMATION",
        missing: missingAvailability,
        draft,
      });
      return;
    }

    const gateway = session.createToolGateway?.() as ToolGateway | undefined;
    if (!gateway) {
      this.sendReservationOutput(callId, { ok: false, status: "ERROR", error: "TOOL_GATEWAY_UNAVAILABLE" });
      return;
    }

    const fingerprint = runtime.fingerprintFor(draft)!;
    let availabilityResult = runtime.cachedAvailability(fingerprint);
    if (!availabilityResult) {
      const previouslyOffered = runtime.wasSlotOffered(draft);
      const started = Date.now();
      session.diagnostics?.checkpoint?.("DIRECT_RESERVATION_AVAILABILITY_STARTED", {
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
        context: { tenantId, callId: session.callId ?? undefined },
      });
      session.diagnostics?.checkpoint?.("DIRECT_RESERVATION_AVAILABILITY_COMPLETED", {
        elapsed_ms: Date.now() - started,
        ok: availability.ok,
      });
      if (!availability.ok) {
        this.sendReservationOutput(callId, publicToolOutput(availability));
        return;
      }
      availabilityResult = availability.result as Record<string, unknown>;
      runtime.recordAvailability(fingerprint, availabilityResult);
      if (availabilityResult.requested_available !== true && previouslyOffered) {
        runtime.invalidateAvailabilityForConflict();
        session.diagnostics?.checkpoint?.("DIRECT_RESERVATION_AVAILABILITY_CHANGED_BEFORE_COMMIT", {
          party_size: draft.party_size,
          starts_at: draft.starts_at,
          reservation_created: false,
          confirmation_rearmed: true,
        });
        this.sendReservationOutput(callId, reservationAvailabilityChangedOutput({
          party_size: draft.party_size,
          starts_at: draft.starts_at,
          customer_name: draft.customer_name,
          duration_minutes: draft.duration_minutes ?? 90,
        }));
        return;
      }
    }

    if (availabilityResult.requested_available !== true) {
      this.sendReservationOutput(callId, {
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
      runtime.markNeedsContact();
      this.sendReservationOutput(callId, {
        ok: true,
        status: "AVAILABLE_NEEDS_CONTACT",
        missing: missingContact,
        availability: availabilityResult,
        draft,
      });
      return;
    }

    if (draft.confirm !== true) {
      runtime.markReadyToConfirm();
      this.sendReservationOutput(callId, {
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
    session.diagnostics?.checkpoint?.("DIRECT_RESERVATION_BOOKING_STARTED", {
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
      context: { tenantId, callId: session.callId ?? undefined },
    });
    session.diagnostics?.checkpoint?.("DIRECT_RESERVATION_BOOKING_COMPLETED", {
      elapsed_ms: Date.now() - started,
      ok: booking.ok,
      stage: booking.ok && booking.result && typeof booking.result === "object"
        ? (booking.result as Record<string, unknown>).stage
        : null,
    });

    if (isReservationAvailabilityConflict(booking)) {
      runtime.invalidateAvailabilityForConflict();
      session.diagnostics?.checkpoint?.("DIRECT_RESERVATION_AVAILABILITY_CHANGED_AT_COMMIT", {
        party_size: draft.party_size,
        starts_at: draft.starts_at,
        reservation_created: false,
        confirmation_rearmed: true,
      });
      this.sendReservationOutput(callId, reservationAvailabilityChangedOutput({
        party_size: draft.party_size,
        starts_at: draft.starts_at,
        customer_name: draft.customer_name,
        duration_minutes: draft.duration_minutes ?? 90,
      }));
      return;
    }

    if (booking.ok && booking.result && typeof booking.result === "object" && (booking.result as Record<string, unknown>).stage === "BOOKED") {
      runtime.markBooked();
    }
    this.sendReservationOutput(callId, publicToolOutput(booking));
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
        this.sendReservationOutput(event.callId, {
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
        reservation_state_owner: "reservation_session_runtime",
        reservation_contact_identity_owner: "reservation_contact_identity_runtime",
        reservation_datetime_owner: "reservation_datetime_runtime",
      });
      try {
        await this.executeDirectCreateV19(event.callId, args);
      } catch (error) {
        (this as any).diagnostics?.fail?.("DIRECT_RESERVATION_FAILED", "DIRECT_RESERVATION_EXECUTION_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.sendReservationOutput(event.callId, {
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
