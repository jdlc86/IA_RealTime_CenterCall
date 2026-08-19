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

  if (input.useCallerPhone === true) {
    return { phone: caller, source: "TRUSTED_CALLER" };
  }

  if (input.useCallerPhone === false) {
    if (!supplied) throw new Error("Explicit alternate contact phone is required");
    return { phone: explicitInternationalPhone(supplied), source: "EXPLICIT_OTHER_CONTACT" };
  }

  if (!supplied) {
    return { phone: caller, source: "TRUSTED_CALLER" };
  }

  // Backward-compatible but safe default: a national-format number emitted by
  // the model cannot replace the operator identity. Only an explicitly
  // international number can represent a different contact when the legacy
  // boolean is omitted.
  if (!supplied.startsWith("+") && !supplied.startsWith("00")) {
    return { phone: caller, source: "TRUSTED_CALLER" };
  }

  return { phone: explicitInternationalPhone(supplied), source: "EXPLICIT_OTHER_CONTACT" };
}

export function rewriteReservationCreateContactEvent(
  data: unknown,
  trustedCallerPhone: string,
): { data: unknown; changed: boolean; source?: ReservationContactIdentityDecision["source"] } {
  let text: string | null = null;
  if (typeof data === "string") text = data;
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (!text) return { data, changed: false };

  let event: Record<string, unknown>;
  try { event = JSON.parse(text) as Record<string, unknown>; } catch { return { data, changed: false }; }
  if (event.type !== "response.function_call_arguments.done" || event.name !== "restaurant_reservation_create") {
    return { data, changed: false };
  }

  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(typeof event.arguments === "string" ? event.arguments : "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { data, changed: false };
    args = parsed as Record<string, unknown>;
  } catch {
    // V51/V25 own malformed JSON recovery. Do not interfere with that contract.
    return { data, changed: false };
  }

  const decision = resolveReservationContactIdentity({
    trustedCallerPhone,
    suppliedPhone: args.customer_phone,
    useCallerPhone: args.use_caller_phone,
  });
  const changed = args.customer_phone !== decision.phone;
  args.customer_phone = decision.phone;
  if (decision.source === "TRUSTED_CALLER") args.use_caller_phone = true;
  event.arguments = JSON.stringify(args);
  return { data: JSON.stringify(event), changed, source: decision.source };
}
