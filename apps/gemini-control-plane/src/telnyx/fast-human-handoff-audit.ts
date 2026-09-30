export type FastHumanHandoffAuditEnv = Readonly<{
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type FastHumanHandoffAuditDependencies = Readonly<{
  fetcher?: FetchLike;
  waitUntil?: (promise: Promise<void>) => void;
  now?: () => Date;
  reportFailure?: (event: Readonly<Record<string, unknown>>) => void;
}>;

export type FastHumanHandoffAcceptedAudit = Readonly<{
  handoffId: string;
  tenantId: string;
  callId: string;
  callerPhone: string;
  reasonCode: string;
  reasonSummary: string | null;
  destinationLabel: string;
  destinationPhone: string;
}>;

export type FastHumanHandoffAuditPatch = Readonly<{
  status?: "REQUESTED" | "ANNOUNCING" | "DIALING" | "ANSWERED" | "TRANSFERRED" | "NO_ANSWER" | "BUSY" | "FAILED" | "CALLBACK_REQUIRED" | "TERMINATED";
  transfer_started_at?: string;
  answered_at?: string;
  transfer_ended_at?: string;
  call_terminated_at?: string;
  target_call_control_id?: string | null;
  callback_required?: boolean;
  callback_status?: "PENDING" | "CONTACTED" | "RESOLVED" | "UNREACHABLE" | "CANCELLED" | null;
  failure_reason?: string | null;
}>;

type AuditConfig = Readonly<{ baseUrl: string; serviceRoleKey: string }>;

function required(value: unknown, field: string, max = 16_384): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function auditConfig(env: FastHumanHandoffAuditEnv): AuditConfig | null {
  try {
    const parsed = new URL(required(env.SUPABASE_URL, "SUPABASE_URL", 2_048));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return Object.freeze({
      baseUrl: parsed.toString().replace(/\/$/, ""),
      serviceRoleKey: required(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"),
    });
  } catch {
    return null;
  }
}

function headers(config: AuditConfig, prefer: string): Record<string, string> {
  return {
    authorization: `Bearer ${config.serviceRoleKey}`,
    apikey: config.serviceRoleKey,
    "content-type": "application/json",
    accept: "application/json",
    prefer,
  };
}

function defaultFailureReporter(event: Readonly<Record<string, unknown>>): void {
  console.error(JSON.stringify(event));
}

/**
 * Request-local ordered audit queue. Every operation is attached to the Worker
 * lifetime, catches its own failures, and is never awaited by transfer policy
 * or Telnyx command execution.
 */
export class FastHumanHandoffAudit {
  private readonly config: AuditConfig | null;
  private readonly fetcher: FetchLike;
  private readonly waitUntil: ((promise: Promise<void>) => void) | null;
  private readonly now: () => Date;
  private readonly reportFailure: (event: Readonly<Record<string, unknown>>) => void;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    env: FastHumanHandoffAuditEnv,
    dependencies: FastHumanHandoffAuditDependencies = {},
  ) {
    this.config = auditConfig(env);
    const sourceFetch = dependencies.fetcher ?? fetch;
    this.fetcher = (...args) => sourceFetch(...args);
    this.waitUntil = dependencies.waitUntil ?? null;
    this.now = dependencies.now ?? (() => new Date());
    this.reportFailure = dependencies.reportFailure ?? defaultFailureReporter;
  }

  accepted(input: FastHumanHandoffAcceptedAudit): void {
    this.enqueue("human_handoff_fast_audit_insert_failed", input.handoffId, async (config) => {
      const response = await this.fetcher(`${config.baseUrl}/rest/v1/human_handoff_events?on_conflict=id`, {
        method: "POST",
        headers: headers(config, "resolution=ignore-duplicates,return=minimal"),
        body: JSON.stringify({
          id: input.handoffId,
          tenant_id: input.tenantId,
          call_id: input.callId,
          caller_phone: input.callerPhone,
          reason_code: input.reasonCode,
          reason_summary: input.reasonSummary,
          destination_type: "PHONE",
          destination_label: input.destinationLabel,
          destination_phone: input.destinationPhone,
          status: "REQUESTED",
          requested_at: this.now().toISOString(),
          callback_required: false,
          callback_status: null,
        }),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
    });
  }

  patch(handoffId: string, tenantId: string, patch: FastHumanHandoffAuditPatch): void {
    this.enqueue("human_handoff_fast_audit_update_failed", handoffId, async (config) => {
      const response = await this.fetcher(
        `${config.baseUrl}/rest/v1/human_handoff_events?id=eq.${encodeURIComponent(handoffId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
        {
          method: "PATCH",
          headers: headers(config, "return=minimal"),
          body: JSON.stringify({ ...patch, updated_at: this.now().toISOString() }),
        },
      );
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
    });
  }

  whenIdle(): Promise<void> {
    return this.tail;
  }

  private enqueue(
    event: string,
    handoffId: string,
    operation: (config: AuditConfig) => Promise<void>,
  ): void {
    if (!this.config) return;
    const execution = this.tail.then(() => operation(this.config as AuditConfig));
    const settled = execution.catch((error) => {
      try {
        this.reportFailure(Object.freeze({
          level: "error",
          event,
          handoff_id: handoffId,
          error_code: error instanceof Error ? error.message : "AUDIT_WRITE_FAILED",
          fail_open: true,
        }));
      } catch {}
    });
    this.tail = settled;
    try { this.waitUntil?.(settled); } catch {}
  }
}

export function createFastHumanHandoffAudit(
  env: FastHumanHandoffAuditEnv,
  dependencies: FastHumanHandoffAuditDependencies = {},
): FastHumanHandoffAudit {
  return new FastHumanHandoffAudit(env, dependencies);
}
