export type DiagnosticLevel = "info" | "error";

export type DiagnosticEntry = {
  at_ms: number;
  stage: string;
  level: DiagnosticLevel;
  elapsed_ms: number;
  details?: Record<string, unknown>;
};

export type DiagnosticSnapshot = {
  enabled: boolean;
  call_id: string | null;
  tenant_id: string | null;
  current_stage: string;
  last_success: string | null;
  last_error: string | null;
  diagnosis: string | null;
  recovery: string | null;
  elapsed_ms: number;
  timeline: DiagnosticEntry[];
};

export type DiagnosticSink = (entry: DiagnosticEntry, snapshot: DiagnosticSnapshot) => void | Promise<void>;
export type DiagnosticTaskOwner = (promise: Promise<void>) => void;

const MAX_TIMELINE_ENTRIES = 80;

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("authorization") ||
      lower.includes("api_key") ||
      lower.includes("apikey") ||
      lower.includes("phone") ||
      lower.includes("transcript") ||
      lower.includes("prompt") ||
      lower.includes("audio")
    ) {
      continue;
    }
    if (typeof value === "string") sanitized[key] = value.slice(0, 300);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) sanitized[key] = value;
    else if (Array.isArray(value)) sanitized[key] = { count: value.length };
    else if (typeof value === "object") sanitized[key] = "[object]";
  }
  return sanitized;
}

export function isDebugEnabled(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase() === "true";
}

export class CallDiagnostics {
  private enabled: boolean;
  private readonly startedAt = Date.now();
  private callId: string | null = null;
  private tenantId: string | null = null;
  private currentStage = "INIT";
  private lastSuccess: string | null = null;
  private lastError: string | null = null;
  private diagnosis: string | null = null;
  private recovery: string | null = null;
  private timeline: DiagnosticEntry[] = [];
  private sink: DiagnosticSink | null = null;
  private sinkTaskOwner: DiagnosticTaskOwner | null = null;
  private sinkTail: Promise<void> = Promise.resolve();

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  configure(
    enabled: boolean,
    callId?: string | null,
    tenantId?: string | null,
    sink?: DiagnosticSink | null,
    sinkTaskOwner?: DiagnosticTaskOwner | null,
  ): void {
    this.enabled = enabled;
    if (callId) this.callId = callId;
    if (tenantId) this.tenantId = tenantId;
    if (sink !== undefined) this.sink = sink;
    if (sinkTaskOwner !== undefined) this.sinkTaskOwner = sinkTaskOwner;
    this.checkpoint("DEBUG_CONFIGURED", { enabled });
  }

  checkpoint(stage: string, details?: Record<string, unknown>): void {
    this.currentStage = stage;
    this.lastSuccess = stage;
    if (!this.enabled) return;
    this.push("info", stage, details);
  }

  fail(stage: string, diagnosis: string, details?: Record<string, unknown>): void {
    this.currentStage = stage;
    this.lastError = stage;
    this.diagnosis = diagnosis;
    if (!this.enabled) return;
    this.push("error", stage, { diagnosis, ...details });
  }

  recovered(stage: string, recovery: string, details?: Record<string, unknown>): void {
    this.currentStage = stage;
    this.lastSuccess = stage;
    this.recovery = recovery;
    if (!this.enabled) return;
    this.push("info", stage, { recovery, ...details });
  }

  snapshot(): DiagnosticSnapshot {
    return {
      enabled: this.enabled,
      call_id: this.callId,
      tenant_id: this.tenantId,
      current_stage: this.currentStage,
      last_success: this.lastSuccess,
      last_error: this.lastError,
      diagnosis: this.diagnosis,
      recovery: this.recovery,
      elapsed_ms: Date.now() - this.startedAt,
      timeline: this.enabled ? [...this.timeline] : [],
    };
  }

  private push(level: DiagnosticLevel, stage: string, details?: Record<string, unknown>): void {
    const entry: DiagnosticEntry = {
      at_ms: Date.now(),
      stage,
      level,
      elapsed_ms: Date.now() - this.startedAt,
      details: sanitizeDetails(details),
    };
    this.timeline.push(entry);
    if (this.timeline.length > MAX_TIMELINE_ENTRIES) {
      this.timeline.splice(0, this.timeline.length - MAX_TIMELINE_ENTRIES);
    }

    const snapshot = this.snapshot();
    const logEntry = {
      level,
      event: "call_diagnostic",
      component: "CallDiagnostics",
      call_id: this.callId,
      tenant_id: this.tenantId,
      current_stage: this.currentStage,
      last_success: this.lastSuccess,
      last_error: this.lastError,
      diagnosis: this.diagnosis,
      recovery: this.recovery,
      elapsed_ms: entry.elapsed_ms,
      details: entry.details,
    };
    const serialized = JSON.stringify(logEntry);
    if (level === "error") console.error(serialized);
    else console.log(serialized);

    if (this.sink) {
      const sink = this.sink;
      this.sinkTail = this.sinkTail
        .then(() => sink(entry, snapshot))
        .catch((error) => {
          console.error(JSON.stringify({
            level: "error",
            event: "call_diagnostic_sink_failed",
            component: "CallDiagnostics",
            call_id: this.callId,
            tenant_id: this.tenantId,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
          }));
        });
      this.sinkTaskOwner?.(this.sinkTail);
    }
  }
}
