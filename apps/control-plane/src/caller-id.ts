export type SipHeader = { name: string; value: string };

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase();
}

export function extractE164FromSipIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/\+[1-9]\d{7,14}/);
  return match?.[0] ?? null;
}

export function extractTrustedCallerPhone(headers: SipHeader[] | undefined): string | null {
  if (!headers?.length) return null;
  const priorities = ["p-asserted-identity", "remote-party-id", "from"];
  for (const headerName of priorities) {
    const value = headers.find((header) => normalizeHeaderName(header.name) === headerName)?.value;
    const phone = extractE164FromSipIdentity(value);
    if (phone) return phone;
  }
  return null;
}
