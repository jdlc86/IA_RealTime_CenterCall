function required(value, field, max = 8_192) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function canonicalBaseUrl(value) {
  const raw = required(value, "Fast temporal control URL", 2_048);
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) {
    throw new Error("Fast temporal control URL must use HTTPS");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function positiveEpoch(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} is invalid`);
  return value;
}

function canonicalTemporalContext(value) {
  const context = record(value);
  if (!context || context.version !== 1 || context.source !== "WORKER_CLOCK") {
    throw new Error("Authoritative temporal context is invalid");
  }
  const timezone = required(context.timezone, "Authoritative temporal timezone", 128);
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0)); }
  catch { throw new Error("Authoritative temporal timezone is invalid"); }
  const nowIso = required(context.now_iso, "Authoritative temporal now_iso", 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(nowIso) || !Number.isFinite(Date.parse(nowIso))) {
    throw new Error("Authoritative temporal now_iso is invalid");
  }
  const localDate = required(context.local_date, "Authoritative temporal local_date", 32);
  const localTime = required(context.local_time, "Authoritative temporal local_time", 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^\d{2}:\d{2}:\d{2}$/.test(localTime)) {
    throw new Error("Authoritative temporal local date/time is invalid");
  }
  return Object.freeze({
    version: 1,
    source: "WORKER_CLOCK",
    timezone,
    captured_at_epoch_ms: positiveEpoch(context.captured_at_epoch_ms, "Authoritative temporal captured_at_epoch_ms"),
    now_iso: nowIso,
    local_date: localDate,
    local_time: localTime,
    weekday: required(context.weekday, "Authoritative temporal weekday", 64),
  });
}

async function responseJson(response) {
  try { return record(await response.json()); }
  catch { return null; }
}

function unavailable() {
  return Object.freeze({
    ok: false,
    status: "TEMPORAL_AUTHORITY_UNAVAILABLE",
    time_authoritative: false,
    instruction: "No afirmes una fecha u hora actual ni materialices una referencia temporal dependiente de ahora porque el kernel no pudo certificar el reloj. Pide reintentar o explica brevemente la indisponibilidad sin inventar datos temporales.",
  });
}

export function createFastTemporalControlClient(options = {}) {
  const baseUrl = canonicalBaseUrl(options.baseUrl);
  const controlToken = required(options.controlToken, "Fast temporal control token");
  const sourceFetch = typeof options.fetcher === "function" ? options.fetcher : fetch;
  const fetcher = (...args) => sourceFetch(...args);

  async function getAuthoritativeDateTime(input = {}) {
    let tenantId;
    let callControlId;
    try {
      tenantId = required(input.tenantId, "Fast temporal tenant id", 256);
      callControlId = required(input.callControlId, "Fast temporal call control id", 512);
    } catch {
      return unavailable();
    }

    try {
      const response = await fetcher(new URL("/internal/authoritative-datetime", baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${controlToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ tenantId, callControlId }),
      });
      const payload = await responseJson(response);
      if (
        response.status !== 200
        || !payload
        || payload.ok !== true
        || payload.status !== "AUTHORITATIVE_DATETIME"
        || payload.time_authoritative !== true
      ) return unavailable();
      const context = canonicalTemporalContext(payload.authoritative_temporal_context);
      return Object.freeze({
        ok: true,
        status: "AUTHORITATIVE_DATETIME",
        time_authoritative: true,
        authoritative_temporal_context: context,
        instruction: required(payload.instruction, "Authoritative temporal instruction", 1_000),
      });
    } catch {
      return unavailable();
    }
  }

  return Object.freeze({ getAuthoritativeDateTime });
}
