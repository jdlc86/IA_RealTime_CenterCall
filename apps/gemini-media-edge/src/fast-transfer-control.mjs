function required(value, field, max = 8_192) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function canonicalBaseUrl(value) {
  const raw = required(value, "Fast transfer control URL", 2_048);
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) {
    throw new Error("Fast transfer control URL must use HTTPS");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function responseJson(response) {
  try { return record(await response.json()); }
  catch { return null; }
}

export function createFastTransferControlClient(options = {}) {
  const baseUrl = canonicalBaseUrl(options.baseUrl);
  const controlToken = required(options.controlToken, "Fast transfer control token");
  const sourceFetch = typeof options.fetcher === "function" ? options.fetcher : fetch;
  // Keep native fetch as a bare-call dependency. Receiver-sensitive runtimes can
  // reject fetch when invoked as an object method (the same protection used by
  // the proven OpenAI/Telnyx handoff adapter).
  const fetcher = (...args) => sourceFetch(...args);

  async function post(pathname, body, fallbackStatus) {
    try {
      const response = await fetcher(new URL(pathname, baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${controlToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = await responseJson(response);
      if (payload) return Object.freeze({ ...payload, httpStatus: response.status });
      return Object.freeze({ ok: false, status: fallbackStatus, httpStatus: response.status });
    } catch {
      // Authorization failures must not tear down an otherwise healthy call.
      // Transfer-start failures are already terminal by policy, but still return
      // a structured result so the runtime can close deterministically.
      return Object.freeze({ ok: false, status: fallbackStatus });
    }
  }

  return Object.freeze({
    authorizeTransfer(input) {
      return post("/internal/call-transfer/authorize", input, "HUMAN_HANDOFF_NOT_AVAILABLE");
    },
    startTransfer(input) {
      return post("/internal/call-transfer/start", input, "TRANSFER_CONTROL_UNAVAILABLE");
    },
  });
}
