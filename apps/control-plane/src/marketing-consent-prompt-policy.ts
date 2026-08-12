import type { MarketingConsentStatus } from "./marketing-consent-store.js";

export const MARKETING_OFFER_COOLDOWN_DAYS = 90;

export type MarketingPromptDecision =
  | { ask: true; reason: "NO_HISTORY" | "COOLDOWN_EXPIRED" }
  | { ask: false; reason: "EXISTING_DECISION"; status: MarketingConsentStatus }
  | { ask: false; reason: "OFFER_COOLDOWN"; lastOfferedAt: string };

export function decideMarketingPrompt(
  status: MarketingConsentStatus | null,
  lastOfferedAt: string | null = null,
  nowMs: number = Date.now(),
): MarketingPromptDecision {
  if (status !== null) return { ask: false, reason: "EXISTING_DECISION", status };
  if (lastOfferedAt === null) return { ask: true, reason: "NO_HISTORY" };

  const offeredMs = Date.parse(lastOfferedAt);
  if (!Number.isFinite(offeredMs)) throw new Error("Invalid marketing offer timestamp");
  const cooldownMs = MARKETING_OFFER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  if (nowMs - offeredMs < cooldownMs) return { ask: false, reason: "OFFER_COOLDOWN", lastOfferedAt };
  return { ask: true, reason: "COOLDOWN_EXPIRED" };
}
