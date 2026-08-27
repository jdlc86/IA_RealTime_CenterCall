function required(value, field, max = 64_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /\u0000/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function safeEpoch(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function e164(value, field, nullable = false) {
  if (nullable && value === null) return null;
  const normalized = required(value, field, 16);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error(`${field} must be E.164`);
  return normalized;
}

function canonicalSecurityContext(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fast Gemini security context is invalid");
  if (value.securityVersion !== 1) throw new Error("Fast Gemini security context version is invalid");
  if (value.provider !== "TELNYX") throw new Error("Fast Gemini security context provider is invalid");
  const tenantId = required(value.tenantId, "Fast Gemini security tenantId", 256);
  const callControlId = required(value.callControlId, "Fast Gemini security callControlId", 512);
  const notAfterEpochMs = safeEpoch(value.notAfterEpochMs, "Fast Gemini security notAfterEpochMs");
  if (tenantId !== expected.tenantId || callControlId !== expected.callControlId || notAfterEpochMs !== expected.notAfterEpochMs) {
    throw new Error("Fast Gemini security context identity mismatch");
  }
  const createdAtEpochMs = safeEpoch(value.createdAtEpochMs, "Fast Gemini security createdAtEpochMs");
  if (createdAtEpochMs >= notAfterEpochMs) throw new Error("Fast Gemini security context lifetime is invalid");
  return Object.freeze({
    securityVersion: 1,
    sessionId: required(value.sessionId, "Fast Gemini security sessionId", 256),
    tenantId,
    routeId: required(value.routeId, "Fast Gemini security routeId", 256),
    callControlId,
    callerPhoneE164: e164(value.callerPhoneE164, "Fast Gemini security callerPhoneE164", true),
    calledPhoneE164: e164(value.calledPhoneE164, "Fast Gemini security calledPhoneE164"),
    provider: "TELNYX",
    createdAtEpochMs,
    notAfterEpochMs,
  });
}

function canonicalTools(value) {
  if (!Array.isArray(value)) throw new Error("Fast Gemini bootstrap tools must be an array");
  return Object.freeze(value.map((tool, index) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error(`Fast Gemini bootstrap tool ${index} is invalid`);
    const name = required(tool.name, `Fast Gemini bootstrap tool ${index} name`, 128);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Fast Gemini bootstrap tool ${index} name is invalid`);
    const description = required(tool.description, `Fast Gemini bootstrap tool ${index} description`, 4_000);
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new Error(`Fast Gemini bootstrap tool ${index} parameters are invalid`);
    }
    return Object.freeze({ name, description, parameters: structuredClone(tool.parameters) });
  }));
}

export function canonicalFastBootstrap(value, nowEpochMs = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fast Gemini bootstrap is invalid");
  const now = safeEpoch(nowEpochMs, "Fast Gemini bootstrap nowEpochMs");
  const notAfterEpochMs = safeEpoch(value.notAfterEpochMs, "Fast Gemini bootstrap notAfterEpochMs");
  if (now >= notAfterEpochMs) throw new Error("Fast Gemini bootstrap expired");
  const tenantId = required(value.tenantId, "Fast Gemini bootstrap tenantId", 256);
  const callControlId = required(value.callControlId, "Fast Gemini bootstrap callControlId", 512);
  const voiceName = value.voiceName == null ? "Kore" : required(value.voiceName, "Fast Gemini bootstrap voiceName", 128);
  const languageCode = value.languageCode == null ? "es-ES" : required(value.languageCode, "Fast Gemini bootstrap languageCode", 32);
  return Object.freeze({
    version: "gemini-fast-bootstrap.v1",
    provider: "GEMINI",
    credentialId: required(value.credentialId, "Fast Gemini bootstrap credentialId", 256),
    tenantId,
    callControlId,
    notAfterEpochMs,
    securityContext: canonicalSecurityContext(value.securityContext, { tenantId, callControlId, notAfterEpochMs }),
    systemInstruction: required(value.systemInstruction, "Fast Gemini bootstrap systemInstruction", 64_000),
    tools: canonicalTools(value.tools ?? []),
    voiceName,
    languageCode,
  });
}

export class InMemoryFastBootstrapRegistry {
  constructor() { this.entries = new Map(); }

  register(value, nowEpochMs = Date.now()) {
    const bootstrap = canonicalFastBootstrap(value, nowEpochMs);
    this.prune(nowEpochMs);
    const existing = this.entries.get(bootstrap.credentialId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(bootstrap)) {
        throw new Error("Fast Gemini bootstrap credential already has different content");
      }
      return existing;
    }
    this.entries.set(bootstrap.credentialId, bootstrap);
    return bootstrap;
  }

  consumeForClaims(claims, nowEpochMs = Date.now()) {
    const now = safeEpoch(nowEpochMs, "Fast Gemini bootstrap consume nowEpochMs");
    this.prune(now);
    const credentialId = required(claims?.credentialId, "Fast Gemini credentialId", 256);
    const bootstrap = this.entries.get(credentialId);
    if (!bootstrap) throw new Error("Fast Gemini bootstrap is not registered");
    const security = bootstrap.securityContext;
    if (
      bootstrap.tenantId !== claims.tenantId ||
      bootstrap.callControlId !== claims.callControlId ||
      bootstrap.notAfterEpochMs !== claims.notAfterEpochMs ||
      security.sessionId !== claims.sessionId ||
      security.routeId !== claims.routeId ||
      security.callerPhoneE164 !== claims.callerPhoneE164 ||
      security.calledPhoneE164 !== claims.calledPhoneE164 ||
      security.securityVersion !== claims.securityVersion
    ) {
      throw new Error("Fast Gemini bootstrap identity mismatch");
    }
    this.entries.delete(credentialId);
    return bootstrap;
  }

  prune(nowEpochMs = Date.now()) {
    const now = safeEpoch(nowEpochMs, "Fast Gemini bootstrap prune nowEpochMs");
    for (const [id, bootstrap] of this.entries) if (now >= bootstrap.notAfterEpochMs) this.entries.delete(id);
  }

  size() { return this.entries.size; }
}
