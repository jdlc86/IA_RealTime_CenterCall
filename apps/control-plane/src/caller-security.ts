export type CallerSecurityEnv = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
};

export type CallerSecuritySignal = {
  eventKey: string;
  tenantId: string;
  eventType: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskDelta: number;
  highConfidence: boolean;
  metadata?: Record<string, unknown>;
};

export type QueuedCallerSecuritySignal = CallerSecuritySignal & {
  callerKey: string;
};

export type InboundSecurityDecision = {
  decision: "ALLOW" | "BLOCK";
  blocked_until: string | null;
  permanent_block: boolean;
  calls_1m: number;
  calls_5m: number;
  calls_1h: number;
  risk_score: number;
  security_strikes: number;
  rate_limit_blocks: number;
  reason: string;
};

export type SecuritySignalDecision = {
  action: "ALLOW_FUTURE_CALLS" | "BLOCK_FUTURE_CALLS";
  blocked_until: string | null;
  permanent_block: boolean;
  risk_score: number;
  security_strikes: number;
  reason: string;
};

export type TranscriptSecurityFinding = {
  level: "NONE" | "LOW" | "HIGH";
  eventType?: string;
  riskDelta: number;
  terminateCurrentCall: boolean;
  matchedRule?: string;
};

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}

function normalizeForSecurity(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s_\-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const HIGH_CONFIDENCE_RULES: Array<{ id: string; re: RegExp; event: string }> = [
  { id: "IGNORE_INSTRUCTIONS_ES", re: /\b(?:ignora|omite|desobedece|saltate)\b.{0,45}\b(?:tus|las|mis)?\s*(?:instrucciones|reglas|directrices)\b/i, event: "PROMPT_INJECTION_HIGH" },
  { id: "FORGET_INSTRUCTIONS_ES", re: /\b(?:olvida|descarta|borra)\b.{0,45}\b(?:tus|las)?\s*(?:instrucciones|reglas|directrices)\b/i, event: "PROMPT_INJECTION_HIGH" },
  { id: "IGNORE_INSTRUCTIONS_EN", re: /\b(?:ignore|forget|disregard|override)\b.{0,45}\b(?:previous|prior|system|developer)?\s*(?:instructions|rules|prompt)\b/i, event: "PROMPT_INJECTION_HIGH" },
  { id: "SYSTEM_PROMPT_EXFIL", re: /\b(?:muestra|muestrame|revela|revelame|dime|ensename|imprime|lee)\b.{0,50}\b(?:system prompt|prompt del sistema|instrucciones internas|mensaje del sistema)\b/i, event: "PROMPT_EXFILTRATION_HIGH" },
  { id: "SYSTEM_PROMPT_EXFIL_EN", re: /\b(?:show|reveal|print|repeat|tell me)\b.{0,50}\b(?:system prompt|hidden instructions|developer message|internal instructions)\b/i, event: "PROMPT_EXFILTRATION_HIGH" },
  { id: "ROLE_ESCALATION", re: /\b(?:actua|comportate|haz de cuenta)\b.{0,35}\b(?:administrador|admin|developer|desarrollador|sistema|root)\b/i, event: "ROLE_ESCALATION_HIGH" },
  { id: "TOOL_MANIPULATION", re: /\b(?:ejecuta|llama|invoca|usa)\b.{0,35}\b(?:tool|function|funcion|function_call|tool_choice|json)\b/i, event: "TOOL_MANIPULATION_HIGH" },
];

const LOW_SIGNAL_TERMS = [
  /\bsystem prompt\b/i,
  /\bprompt injection\b/i,
  /\btool_choice\b/i,
  /\bfunction_call\b/i,
  /\binstrucciones internas\b/i,
  /\bdeveloper message\b/i,
];

export function inspectCallerTranscript(transcript: string): TranscriptSecurityFinding {
  const normalized = normalizeForSecurity(transcript).slice(0, 2000);
  if (!normalized) return { level: "NONE", riskDelta: 0, terminateCurrentCall: false };

  for (const rule of HIGH_CONFIDENCE_RULES) {
    if (rule.re.test(normalized)) {
      return {
        level: "HIGH",
        eventType: rule.event,
        riskDelta: 5,
        terminateCurrentCall: true,
        matchedRule: rule.id,
      };
    }
  }

  if (LOW_SIGNAL_TERMS.some((re) => re.test(normalized))) {
    return {
      level: "LOW",
      eventType: "CYBERSECURITY_SUSPICIOUS_LANGUAGE",
      riskDelta: 1,
      terminateCurrentCall: false,
      matchedRule: "LOW_SIGNAL_TERM",
    };
  }

  return { level: "NONE", riskDelta: 0, terminateCurrentCall: false };
}

export class CallerSecurityService {
  constructor(private readonly env: CallerSecurityEnv) {}

  private async rpc<T>(name: string, body: Record<string, unknown>): Promise<T[]> {
    const baseUrl = requireString(this.env.SUPABASE_URL, "SUPABASE_URL").replace(/\/+$/, "");
    const key = requireString(this.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
    const response = await fetch(`${baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${name} failed with HTTP ${response.status}: ${raw.slice(0, 300)}`);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${name} returned invalid payload`);
    return parsed as T[];
  }

  async callerKey(tenantId: string, callerPhone: string): Promise<string> {
    const secret = requireString(this.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${tenantId}|${callerPhone}`));
    return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async evaluateInbound(tenantId: string, callerPhone: string): Promise<InboundSecurityDecision> {
    const callerKey = await this.callerKey(tenantId, callerPhone);
    const rows = await this.rpc<InboundSecurityDecision>("evaluate_inbound_call_security", {
      p_tenant_id: tenantId,
      p_caller_key: callerKey,
    });
    if (!rows[0]) throw new Error("evaluate_inbound_call_security returned empty payload");
    return rows[0];
  }

  async recordSignal(params: {
    eventKey: string;
    tenantId: string;
    callerPhone: string;
    eventType: string;
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    riskDelta: number;
    highConfidence: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<SecuritySignalDecision> {
    const callerKey = await this.callerKey(params.tenantId, params.callerPhone);
    return this.recordSignalByCallerKey({ ...params, callerKey });
  }

  async recordSignalByCallerKey(params: QueuedCallerSecuritySignal): Promise<SecuritySignalDecision> {
    const rows = await this.rpc<SecuritySignalDecision>("record_caller_security_signal_v2", {
      p_event_key: requireString(params.eventKey, "eventKey"),
      p_tenant_id: params.tenantId,
      p_caller_key: requireString(params.callerKey, "callerKey"),
      p_event_type: params.eventType,
      p_severity: params.severity,
      p_risk_delta: params.riskDelta,
      p_metadata: params.metadata ?? {},
      p_high_confidence: params.highConfidence,
    });
    if (!rows[0]) throw new Error("record_caller_security_signal_v2 returned empty payload");
    return rows[0];
  }
}
