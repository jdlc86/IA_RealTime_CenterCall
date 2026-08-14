export const USER_TURN_WATCHDOG_V18 = {
  firstPresenceCheckMs: 8_000,
  secondPresenceCheckMs: 16_000,
  maxUnansweredWaitMs: 26_000,
  maxCallDurationMs: 15 * 60_000,
  vadResetsInactivity: false,
} as const;
