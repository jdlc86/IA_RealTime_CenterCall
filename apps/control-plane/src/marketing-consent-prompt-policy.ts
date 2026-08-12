import type { MarketingConsentStatus } from "./marketing-consent-store.js";

export type MarketingPromptDecision =
  | { ask: true; reason: "NO_HISTORY" }
  | { ask: false; reason: "EXISTING_DECISION"; status: MarketingConsentStatus };

export function decideMarketingPrompt(status: MarketingConsentStatus | null): MarketingPromptDecision {
  if (status === null) return { ask: true, reason: "NO_HISTORY" };
  return { ask: false, reason: "EXISTING_DECISION", status };
}
