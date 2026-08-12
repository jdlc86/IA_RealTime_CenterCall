import {
  validateMarketingConsentFlowArgs,
  type MarketingConsentFlowArgs,
} from "./marketing-consent-flow.js";
import { requireObject } from "./tool-gateway.js";

export type MarketingConsentClassifierTurn = {
  explicit: true;
  flow: MarketingConsentFlowArgs;
};

export function parseMarketingConsentClassifierTurn(argumentsJson: string | undefined): MarketingConsentClassifierTurn {
  if (!argumentsJson?.trim()) throw new Error("Missing marketing consent classifier arguments");

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new Error("Invalid marketing consent classifier JSON");
  }

  const root = requireObject(parsed);
  if (root.data_requirement !== "MARKETING_CONSENT") {
    throw new Error("Classifier data_requirement is not MARKETING_CONSENT");
  }

  const marketing = requireObject(root.marketing_consent);
  const allowed = new Set(["action", "explicit", "target_phone"]);
  for (const key of Object.keys(marketing)) {
    if (!allowed.has(key)) throw new Error(`Unexpected marketing consent classifier field: ${key}`);
  }

  if (marketing.explicit !== true) {
    throw new Error("Explicit marketing consent is required");
  }

  const flow = validateMarketingConsentFlowArgs({
    action: marketing.action,
    ...(marketing.target_phone === undefined ? {} : { target_phone: marketing.target_phone }),
  });

  return { explicit: true, flow };
}
