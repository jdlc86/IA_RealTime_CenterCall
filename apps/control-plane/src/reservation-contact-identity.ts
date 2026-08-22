import { normalizePhoneToE164 } from "./phone-normalization.js";

export type ReservationContactIdentityInput = {
  trustedCallerPhone: string;
  suppliedPhone?: unknown;
  useCallerPhone?: unknown;
};

export type ReservationContactIdentityDecision = {
  phone: string;
  source: "TRUSTED_CALLER" | "EXPLICIT_OTHER_CONTACT";
};

export type ReservationCreateContactCanonicalization = Readonly<{
  arguments: Record<string, unknown>;
  changed: boolean;
  source?: ReservationContactIdentityDecision["source"];
}>;

function trustedCallerE164(raw: string): string {
  return normalizePhoneToE164(raw);
}

function explicitInternationalPhone(raw: string): string {
  // Deliberately no default country: an alternate contact must carry its own
  // country code so identity remains globally unambiguous.
  return normalizePhoneToE164(raw);
}

export function resolveReservationContactIdentity(
  input: ReservationContactIdentityInput,
): ReservationContactIdentityDecision {
  const caller = trustedCallerE164(input.trustedCallerPhone);
  const supplied = typeof input.suppliedPhone === "string" ? input.suppliedPhone.trim() : "";

  // The operator-provided caller identity is the default and remains
  // authoritative unless the model explicitly marks that the user requested a
  // different contact. Omission is never permission to replace identity.
  if (input.useCallerPhone !== false) {
    return { phone: caller, source: "TRUSTED_CALLER" };
  }

  if (!supplied) throw new Error("Explicit alternate contact phone is required");
  return { phone: explicitInternationalPhone(supplied), source: "EXPLICIT_OTHER_CONTACT" };
}

/**
 * Provider-neutral reservation-create argument canonicalization.
 *
 * This function deliberately operates on already parsed semantic tool arguments.
 * Malformed provider payloads remain owned by the malformed-tool/argument
 * validation boundaries and are never reconstructed here as provider wire.
 */
export function canonicalizeReservationCreateContactArguments(
  args: Record<string, unknown>,
  trustedCallerPhone: string | null | undefined,
): ReservationCreateContactCanonicalization {
  const trusted = typeof trustedCallerPhone === "string" ? trustedCallerPhone.trim() : "";
  if (!trusted) return { arguments: args, changed: false };

  const decision = resolveReservationContactIdentity({
    trustedCallerPhone: trusted,
    suppliedPhone: args.customer_phone,
    useCallerPhone: args.use_caller_phone,
  });
  const changed = args.customer_phone !== decision.phone ||
    (decision.source === "TRUSTED_CALLER" && args.use_caller_phone !== true);

  if (!changed) return { arguments: args, changed: false, source: decision.source };

  const canonical: Record<string, unknown> = { ...args, customer_phone: decision.phone };
  if (decision.source === "TRUSTED_CALLER") canonical.use_caller_phone = true;
  return { arguments: canonical, changed: true, source: decision.source };
}
