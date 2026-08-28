const AUTHORITY_TYPES = new Set([
  "SYSTEM_AUTHORITY",
  "SEMANTIC_NECESSITY",
  "CALLER_REQUEST",
  "CALLER_CONFIRMATION",
  "EXPLICIT_CONFIRMATION",
  "CALLER_AUTHORITY",
]);

const EFFECT_TYPES = new Set([
  "READ_CONTEXT",
  "READ_BUSINESS_DATA",
  "MUTATE_BUSINESS_DATA",
  "DESTRUCTIVE_ACTION",
  "EXTERNAL_COMMUNICATION",
  "TERMINAL_CALL_ACTION",
  "FINANCIAL_ACTION",
]);

const READ_ONLY_EFFECT_TYPES = new Set(["READ_CONTEXT", "READ_BUSINESS_DATA"]);
const CALLER_AUTHORITY_DEFAULT_SOURCES = Object.freeze(["EXPLICIT_REQUEST", "CONFIRMED_OFFER"]);

function required(value, field, max = 512) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function code(value, field) {
  const normalized = required(value, field, 128);
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function capability(value) {
  const normalized = required(value, "Fast tool capability", 128);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) throw new Error("Fast tool capability is invalid");
  return normalized;
}

function canonicalEvidence(value) {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function canonicalAllowedSources(authority, value) {
  if (authority === "CALLER_AUTHORITY") {
    const source = value ?? CALLER_AUTHORITY_DEFAULT_SOURCES;
    if (!Array.isArray(source) || source.length < 1 || source.length > 8) {
      throw new Error("Fast tool caller authority sources are invalid");
    }
    return Object.freeze([...new Set(source.map((entry) => code(entry, "Fast tool caller authority source")))]);
  }
  if (value !== undefined) {
    if (!Array.isArray(value) || value.length !== 1 || code(value[0], "Fast tool authority source") !== authority) {
      throw new Error("Fast tool allowedSources does not match its authority");
    }
  }
  return Object.freeze([authority]);
}

function defaultEvidence(authority, effect) {
  if (authority === "SYSTEM_AUTHORITY") return "NONE";
  if (authority === "SEMANTIC_NECESSITY" && READ_ONLY_EFFECT_TYPES.has(effect)) return "NONE";
  return "CALLER_TRANSCRIPT";
}

export function defineFastToolPolicy(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Fast tool policy is invalid");
  const authority = code(input.authority, "Fast tool authority");
  const effect = code(input.effect, "Fast tool effect");
  if (!AUTHORITY_TYPES.has(authority)) throw new Error(`Fast tool authority ${authority} is unsupported`);
  if (!EFFECT_TYPES.has(effect)) throw new Error(`Fast tool effect ${effect} is unsupported`);
  const evidence = input.evidence ?? defaultEvidence(authority, effect);
  if (evidence !== "NONE" && evidence !== "CALLER_TRANSCRIPT") throw new Error("Fast tool evidence policy is invalid");
  if (evidence === "NONE" && authority !== "SYSTEM_AUTHORITY") {
    if (authority !== "SEMANTIC_NECESSITY" || !READ_ONLY_EFFECT_TYPES.has(effect)) {
      throw new Error("Only read-only semantic necessity may omit caller transcript evidence");
    }
  }
  return Object.freeze({
    authority,
    effect,
    capability: capability(input.capability),
    evidence,
    allowedSources: canonicalAllowedSources(authority, input.allowedSources),
  });
}

export const FAST_HORIZONTAL_TOOL_POLICIES = Object.freeze({
  get_authoritative_datetime: defineFastToolPolicy({
    authority: "SEMANTIC_NECESSITY",
    effect: "READ_CONTEXT",
    capability: "time.authoritative",
    evidence: "NONE",
  }),
  transfer_call: defineFastToolPolicy({
    authority: "CALLER_AUTHORITY",
    allowedSources: ["EXPLICIT_REQUEST", "CONFIRMED_OFFER"],
    effect: "TERMINAL_CALL_ACTION",
    capability: "call.transfer",
  }),
});

function canonicalPolicyMap(value, field = "Fast tool policies") {
  if (value == null) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} are invalid`);
  const result = {};
  for (const [name, rawPolicy] of Object.entries(value)) {
    const toolName = required(name, "Fast tool policy name", 128);
    if (!/^[A-Za-z0-9_-]+$/.test(toolName)) throw new Error(`Fast tool policy name ${toolName} is invalid`);
    result[toolName] = defineFastToolPolicy(rawPolicy);
  }
  return Object.freeze(result);
}

/**
 * Horizontal policies are security minima owned by the product. Extensions may
 * add business-specific tools but cannot replace an existing minimum policy.
 */
export function mergeFastToolPolicies(basePolicies = {}, extensionPolicies = {}) {
  const base = canonicalPolicyMap(basePolicies, "Fast base tool policies");
  const extension = canonicalPolicyMap(extensionPolicies, "Fast extension tool policies");
  const merged = { ...base };
  for (const [name, policy] of Object.entries(extension)) {
    if (Object.prototype.hasOwnProperty.call(merged, name)) {
      throw new Error(`Fast tool policy override is forbidden: ${name}`);
    }
    merged[name] = policy;
  }
  return Object.freeze(merged);
}

function authorityDescription(policy) {
  switch (policy.authority) {
    case "SEMANTIC_NECESSITY":
      return "Declara SEMANTIC_NECESSITY solo cuando esta herramienta sea necesaria por el significado completo de la petición actual del caller. No decidas por coincidencias léxicas ni palabras aisladas y no la uses de forma proactiva para enriquecer una respuesta.";
    case "CALLER_REQUEST":
      return "Declara CALLER_REQUEST solo cuando el caller haya pedido semánticamente esta acción en el turno actual.";
    case "CALLER_CONFIRMATION":
      return "Declara CALLER_CONFIRMATION solo cuando el caller haya confirmado semánticamente la acción en el turno actual.";
    case "EXPLICIT_CONFIRMATION":
      return "Declara EXPLICIT_CONFIRMATION solo cuando el caller haya confirmado explícitamente la acción concreta en el turno actual.";
    case "CALLER_AUTHORITY":
      return `Declara una de estas fuentes de autoridad semántica únicamente cuando corresponda al turno actual: ${policy.allowedSources.join(", ")}.`;
    case "SYSTEM_AUTHORITY":
      return "Declara SYSTEM_AUTHORITY únicamente para esta herramienta registrada como autoridad interna del sistema.";
    default:
      throw new Error("Fast tool authority description is unavailable");
  }
}

export function buildFastToolAuthorityContract(description, parameters, policyInput) {
  const policy = defineFastToolPolicy(policyInput);
  const schema = structuredClone(parameters);
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? structuredClone(schema.properties)
    : {};
  properties.authorization = Object.freeze({
    type: "string",
    enum: [...policy.allowedSources],
    description: authorityDescription(policy),
  });
  if (policy.evidence === "CALLER_TRANSCRIPT") {
    properties.caller_authority_evidence = Object.freeze({
      type: "string",
      description: "Cita literalmente la parte del turno actual del caller que fundamenta esta autorización. Conserva su lenguaje natural; no la reduzcas a keywords ni inventes evidencia.",
    });
  }
  schema.properties = properties;
  const requiredFields = Array.isArray(schema.required) ? schema.required.filter((entry) => typeof entry === "string") : [];
  schema.required = [...new Set([
    ...requiredFields,
    "authorization",
    ...(policy.evidence === "CALLER_TRANSCRIPT" ? ["caller_authority_evidence"] : []),
  ])];
  schema.additionalProperties = false;
  return Object.freeze({
    description: `${description}\nKernel tool-authority contract: ${authorityDescription(policy)} El kernel valida la política y decide ALLOW/DENY; una function call de Gemini es solo una propuesta y nunca constituye por sí sola autorización para ejecutar una herramienta con efectos.`,
    parametersJsonSchema: schema,
    policy,
  });
}

function declaredToolNames(value) {
  if (!Array.isArray(value)) throw new Error("Fast declared tools are invalid");
  const names = new Set();
  for (const tool of value) {
    const name = required(tool?.name, "Fast declared tool name", 128);
    if (names.has(name)) throw new Error(`Fast declared tool duplicated: ${name}`);
    names.add(name);
  }
  return names;
}

function denied(status, toolName, policy = null) {
  return Object.freeze({
    allowed: false,
    status,
    toolName,
    ...(policy ? {
      authority: policy.authority,
      effect: policy.effect,
      capability: policy.capability,
    } : {}),
  });
}

/**
 * Generic, call-scoped authorization boundary. The authenticated bootstrap owns
 * which tools are available to this tenant/call; the local policy registry owns
 * the minimum authority/effect contract and cannot be weakened by Gemini.
 * Natural-language interpretation remains with Gemini. Caller-governed effects
 * require grounded caller evidence; read-only semantic necessity does not depend
 * on provider transcription arrival order.
 */
export class FastToolAuthorizationKernel {
  constructor(options = {}) {
    this.policies = canonicalPolicyMap(options.policies, "Fast authorization kernel policies");
    this.declaredTools = declaredToolNames(options.declaredTools ?? []);
    for (const name of this.declaredTools) {
      if (!this.policies[name]) throw new Error(`Fast tool policy required for declared tool: ${name}`);
    }
    this.allowed = 0;
    this.blocked = 0;
  }

  authorize(call, context = {}) {
    const toolName = required(call?.name, "Fast authorization tool name", 128);
    if (!this.declaredTools.has(toolName)) {
      this.blocked += 1;
      return denied("TOOL_NOT_DECLARED_FOR_SESSION", toolName);
    }
    const policy = this.policies[toolName];
    if (!policy) {
      this.blocked += 1;
      return denied("TOOL_POLICY_REQUIRED", toolName);
    }

    required(context.tenantId, "Fast authorization tenant id", 256);
    required(context.callControlId, "Fast authorization call control id", 512);
    const args = call?.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
    const source = typeof args.authorization === "string" ? args.authorization.trim() : "";
    if (!policy.allowedSources.includes(source)) {
      this.blocked += 1;
      return denied("TOOL_AUTHORITY_REQUIRED", toolName, policy);
    }

    if (policy.evidence === "CALLER_TRANSCRIPT") {
      const transcript = canonicalEvidence(context.callerTranscript);
      const evidence = canonicalEvidence(args.caller_authority_evidence);
      if (!transcript || !evidence || !transcript.includes(evidence)) {
        this.blocked += 1;
        return denied("TOOL_AUTHORITY_EVIDENCE_MISMATCH", toolName, policy);
      }
    }

    this.allowed += 1;
    return Object.freeze({
      allowed: true,
      status: "TOOL_AUTHORIZED",
      toolName,
      authority: policy.authority,
      authoritySource: source,
      effect: policy.effect,
      capability: policy.capability,
    });
  }

  snapshot() {
    return Object.freeze({
      declaredTools: Object.freeze([...this.declaredTools].sort()),
      policyTools: Object.freeze(Object.keys(this.policies).sort()),
      allowed: this.allowed,
      blocked: this.blocked,
    });
  }
}
