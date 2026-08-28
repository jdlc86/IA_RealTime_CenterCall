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

export function createFastSecurityControlClient(options = {}) {
  const baseUrl = canonicalBaseUrl(options.baseUrl);
  const controlToken = required(options.controlToken, "Fast security control token");
  const sourceFetch = typeof options.fetcher === "function" ? options.fetcher : fetch;
  const fetcher = (...args) => sourceFetch(...args);

  return Object.freeze({
    async recordSemanticIncident(input) {
      try {
        const response = await fetcher(new URL("/internal/security-signal", baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${controlToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(input),
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
