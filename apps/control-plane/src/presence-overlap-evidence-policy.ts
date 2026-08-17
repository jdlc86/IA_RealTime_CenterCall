export function hasUsablePresenceTranscript(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(normalized);
}
