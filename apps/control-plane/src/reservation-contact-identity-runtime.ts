import { canonicalizeReservationCreateContactArguments } from "./reservation-contact-identity.js";
import { realtimeCommandPortFor } from "./realtime-provider-runtime.js";

export type ReservationContactIdentityRequest = Readonly<{
  callId?: string;
  trustedCallerPhone: string | null;
  arguments: Record<string, unknown>;
}>;

export type ReservationContactIdentityResult =
  | Readonly<{ allowed: true; arguments: Record<string, unknown> }>
  | Readonly<{ allowed: false }>;

/**
 * Version-neutral authority for reservation contact identity.
 *
 * The trusted transport caller identity is applied to already parsed semantic
 * arguments before ReservationSessionRuntime merges its draft. Rejection emits
 * only through the provider-neutral command port; no provider event is parsed or
 * reconstructed here.
 */
export class ReservationContactIdentityRuntime {
  canonicalizeCreate(session: object, request: ReservationContactIdentityRequest): ReservationContactIdentityResult {
    if (!request.trustedCallerPhone?.trim()) return { allowed: true, arguments: request.arguments };

    try {
      const canonical = canonicalizeReservationCreateContactArguments(
        request.arguments,
        request.trustedCallerPhone,
      );
      if (canonical.changed) {
        (session as any).diagnostics?.checkpoint?.("RESERVATION_CONTACT_IDENTITY_CANONICALIZED_V52", {
          source: canonical.source,
          trusted_caller_authoritative: canonical.source === "TRUSTED_CALLER",
          globally_unambiguous_e164: true,
          authority_owner: "reservation_contact_identity_runtime",
        });
      }
      return { allowed: true, arguments: canonical.arguments };
    } catch (error) {
      (session as any).diagnostics?.fail?.(
        "RESERVATION_CONTACT_IDENTITY_REJECTED_V52",
        "RESERVATION_CONTACT_IDENTITY_INVALID",
        {
          error: error instanceof Error ? error.message : String(error),
          fail_closed: true,
          authority_owner: "reservation_contact_identity_runtime",
        },
      );
      const port = realtimeCommandPortFor(session as any);
      port.submitToolResult({
        callId: request.callId,
        toolName: "restaurant_reservation_create",
        output: {
          ok: false,
          status: "CONTACT_PHONE_REQUIRES_COUNTRY_CODE",
          reservation_created: false,
        },
      });
      port.speak({
        exactText: "Para usar un teléfono distinto al número desde el que llamas, necesito el número completo con su prefijo internacional.",
        instructions: "Di exactamente la frase indicada. No llames herramientas en esta respuesta. Espera un nuevo turno del cliente.",
        purpose: "reservation_contact_identity_recovery_v52",
        metadata: {
          reservation_contact_identity: "explicit_country_required",
          authority: "reservation_contact_identity_runtime",
        },
        isolated: true,
        tools: "DISABLED",
      });
      return { allowed: false };
    }
  }
}

const runtimes = new WeakMap<object, ReservationContactIdentityRuntime>();

export function reservationContactIdentityRuntimeFor(session: object): ReservationContactIdentityRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new ReservationContactIdentityRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
