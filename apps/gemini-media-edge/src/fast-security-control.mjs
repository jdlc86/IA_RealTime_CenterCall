function required(value, field, max = 8_192) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function canonicalBaseUrl(value) {
  const raw = required(value, "Fast security control URL", 2_048);
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) {
    throw new Error("Fast security control URL must use HTTPS");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createFastSecurityControlClient(options = {}) {
  const baseUrl = canonicalBaseUrl(options.baseUrl);
  const controlToken = required(options.controlToken, "Fast security control token");
  const timeoutMs = options.timeoutMs ?? 1_500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new Error("Fast security control timeout is invalid");
  }
  const sourceFetch = typeof options.fetcher === "function" ? options.fetcher : fetch;
  const fetcher = (...args) => sourceFetch(...args);

  return Object.freeze({
    async recordSemanticIncident(input) {
      try {
        const tenantId = required(input?.tenantId, "semantic security tenantId", 256);
        const callControlId = required(input?.callControlId, "semantic security callControlId", 512);
        const callerPhoneE164 = required(input?.callerPhoneE164, "semantic security callerPhoneE164", 16);
        const toolCallId = required(input?.toolCallId, "semantic security toolCallId", 256);
        const category = required(input?.category, "semantic security category", 64);
        const eventDigest = await sha256Hex(`gemini-fast-semantic-security-v1|${tenantId}|${callControlId}|${toolCallId}|${category}`);
        const response = await fetcher(new URL("/internal/fast-semantic-security-signal", baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${controlToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            tenantId,
            callerPhoneE164,
            category,
            eventKey: `gemini-fast-semsec-v1:${eventDigest}`,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        let payload = null;
        try {
          const parsed = await response.json();
          payload = record(parsed);
        } catch {}
        if (payload) return Object.freeze({ ...payload, httpStatus: response.status });
        return Object.freeze({ ok: false, status: "SECURITY_SIGNAL_UNAVAILABLE", httpStatus: response.status });
      } catch {
        // Reputation persistence is outside the continuous audio path. A failure
        // must not tear down an otherwise healthy voice session.
        return Object.freeze({ ok: false, status: "SECURITY_SIGNAL_UNAVAILABLE" });
      }
    },
  });
}
