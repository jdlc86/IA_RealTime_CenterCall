import { requireObject } from "./tool-gateway.js";

export type MarketingConsentAction = "GRANT" | "DECLINE" | "REVOKE";

export type MarketingConsentFlowArgs = {
  action: MarketingConsentAction;
  targetPhone?: string;
};

export type MarketingConsentDecision =
  | {
      allowed: true;
      stage: "CONSENT_READY";
      action: MarketingConsentAction;
      phone: string;
      verificationMethod: "CALLER_ID_MATCH";
    }
  | {
      allowed: false;
      stage: "CALLER_NUMBER_UNAVAILABLE" | "OTHER_PHONE_REQUIRES_ALTERNATIVE";
      action: MarketingConsentAction;
      callerPhone: string | null;
      requestedPhone: string | null;
    };

export function normalizeE164(value: string): string {
  const phone = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Invalid phone number");
  return phone;
}

export function validateMarketingConsentFlowArgs(value: unknown): MarketingConsentFlowArgs {
  const record = requireObject(value);
  const allowed = new Set(["action", "target_phone"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Unexpected marketing consent field: ${key}`);

  const action = record.action;
  if (action !== "GRANT" && action !== "DECLINE" && action !== "REVOKE") throw new Error("Invalid marketing consent action");

  const target = record.target_phone;
  if (target !== undefined && target !== null && typeof target !== "string") throw new Error("Invalid target_phone");

  return {
    action,
    targetPhone: typeof target === "string" ? normalizeE164(target) : undefined,
  };
}

export function decideCallerMatchConsent(args: MarketingConsentFlowArgs, callerPhone: string | null | undefined): MarketingConsentDecision {
  const normalizedCaller = callerPhone ? normalizeE164(callerPhone) : null;
  const requested = args.targetPhone ? normalizeE164(args.targetPhone) : null;

  if (!normalizedCaller) {
    return {
      allowed: false,
      stage: "CALLER_NUMBER_UNAVAILABLE",
      action: args.action,
      callerPhone: null,
      requestedPhone: requested,
    };
  }

  if (requested && requested !== normalizedCaller) {
    return {
      allowed: false,
      stage: "OTHER_PHONE_REQUIRES_ALTERNATIVE",
      action: args.action,
      callerPhone: normalizedCaller,
      requestedPhone: requested,
    };
  }

  return {
    allowed: true,
    stage: "CONSENT_READY",
    action: args.action,
    phone: normalizedCaller,
    verificationMethod: "CALLER_ID_MATCH",
  };
}
