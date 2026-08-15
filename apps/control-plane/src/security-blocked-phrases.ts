export const BUILTIN_CRITICAL_BLOCKED_PHRASES = [
  "system prompt",
  "prompt del sistema",
  "prompt sistema",
  "ignora tus instrucciones",
  "olvida tus instrucciones",
] as const;

export type BlockedPhraseMatch = {
  matched: boolean;
  phrase?: string;
  source?: "BUILTIN" | "TENANT_KV";
};

export function normalizeSecurityPhrase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ_\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(normalizedTranscript: string, normalizedPhrase: string): boolean {
  if (!normalizedPhrase) return false;
  return ` ${normalizedTranscript} `.includes(` ${normalizedPhrase} `);
}

export function parseTenantBlockedPhrases(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("security.blockedPhrases must be an array");
  if (raw.length > 100) throw new Error("security.blockedPhrases supports at most 100 phrases");

  const phrases = raw.map((item, index) => {
    if (typeof item !== "string") throw new Error(`security.blockedPhrases[${index}] must be a string`);
    const normalized = normalizeSecurityPhrase(item);
    if (!normalized) throw new Error(`security.blockedPhrases[${index}] must not be empty`);
    if (normalized.length > 120) throw new Error(`security.blockedPhrases[${index}] is too long`);
    return normalized;
  });
  return [...new Set(phrases)];
}

export function matchBlockedSecurityPhrase(transcript: string, tenantPhrases: readonly string[] = []): BlockedPhraseMatch {
  const normalizedTranscript = normalizeSecurityPhrase(transcript);
  if (!normalizedTranscript) return { matched: false };

  for (const phrase of BUILTIN_CRITICAL_BLOCKED_PHRASES) {
    const normalizedPhrase = normalizeSecurityPhrase(phrase);
    if (containsPhrase(normalizedTranscript, normalizedPhrase)) return { matched: true, phrase: normalizedPhrase, source: "BUILTIN" };
  }

  for (const phrase of tenantPhrases) {
    const normalizedPhrase = normalizeSecurityPhrase(phrase);
    if (containsPhrase(normalizedTranscript, normalizedPhrase)) return { matched: true, phrase: normalizedPhrase, source: "TENANT_KV" };
  }

  return { matched: false };
}
