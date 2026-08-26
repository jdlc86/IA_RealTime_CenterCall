const VERSION = "gemini-edge-control-bootstrap.v1";

function required(value, field, maxLength = 256) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function positiveSafeInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function controlUrl(value) {
  const raw = required(value, "Gemini edge control URL", 2048);
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("Gemini edge control URL is invalid"); }
  if (url.protocol !== "wss:") throw new Error("Gemini edge control URL must use wss://");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/internal/control") {
    throw new Error("Gemini edge control URL contains forbidden identity or path data");
  }
  return url.toString();
}

export function canonicalEdgeControlBootstrap(value, nowEpochMs = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gemini edge control bootstrap is invalid");
  }
  if (value.version !== VERSION || value.provider !== "GEMINI") {
    throw new Error("Gemini edge control bootstrap version/provider is invalid");
  }
  const now = positiveSafeInteger(nowEpochMs, "Gemini edge control bootstrap nowEpochMs");
  const notAfterEpochMs = positiveSafeInteger(value.notAfterEpochMs, "Gemini edge control bootstrap notAfterEpochMs");
  if (notAfterEpochMs <= now) throw new Error("Gemini edge control bootstrap is expired");

  return Object.freeze({
    version: VERSION,
    provider: "GEMINI",
    tenantId: required(value.tenantId, "Gemini edge control bootstrap tenantId"),
    callControlId: required(value.callControlId, "Gemini edge control bootstrap callControlId"),
    callSessionId: required(value.callSessionId, "Gemini edge control bootstrap callSessionId"),
    edgeSessionId: required(value.edgeSessionId, "Gemini edge control bootstrap edgeSessionId"),
    credentialId: required(value.credentialId, "Gemini edge control bootstrap credentialId"),
    controlUrl: controlUrl(value.controlUrl),
    controlCapability: required(value.controlCapability, "Gemini edge control capability", 8192),
    notAfterEpochMs,
  });
}

export function controlWebSocketConnectionV1(value, nowEpochMs = Date.now()) {
  const bootstrap = canonicalEdgeControlBootstrap(value, nowEpochMs);
  return Object.freeze({
    url: bootstrap.controlUrl,
    options: Object.freeze({
      headers: Object.freeze({ Authorization: `Bearer ${bootstrap.controlCapability}` }),
    }),
  });
}

export function edgeControlBootstrapAudit(value, nowEpochMs = Date.now()) {
  const bootstrap = canonicalEdgeControlBootstrap(value, nowEpochMs);
  return Object.freeze({
    version: bootstrap.version,
    provider: bootstrap.provider,
    tenantId: bootstrap.tenantId,
    callControlId: bootstrap.callControlId,
    callSessionId: bootstrap.callSessionId,
    edgeSessionId: bootstrap.edgeSessionId,
    credentialId: bootstrap.credentialId,
    controlUrl: bootstrap.controlUrl,
    notAfterEpochMs: bootstrap.notAfterEpochMs,
    controlCapabilityPresent: true,
  });
}
