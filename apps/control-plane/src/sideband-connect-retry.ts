export const SIDEBAND_CONNECT_RETRY_DELAYS_MS = [300, 800] as const;

export function isRetryableSidebandConnectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Realtime sideband upgrade failed:\s*HTTP\s+404\b/i.test(message);
}
