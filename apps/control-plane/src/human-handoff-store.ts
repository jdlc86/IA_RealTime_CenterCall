export type HumanHandoffStoreEnv = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
};

export type HumanHandoffCreate = {
  id: string;
  tenantId: string;
  callId: string;
  callerPhone: string;
  reasonCode: string;
  reasonSummary?: string;
  destinationType: "PHONE";
  destinationLabel: string;
  destinationPhone: string;
};

export type HumanHandoffPatch = {
  status?: string;
  transfer_started_at?: string;
  answered_at?: string;
  transfer_ended_at?: string;
  call_terminated_at?: string;
  callback_required?: boolean;
  callback_status?: string | null;
  callback_completed_at?: string | null;
  callback_notes?: string | null;
  failure_reason?: string | null;
  target_call_control_id?: string | null;
};

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}

export class HumanHandoffStore {
  constructor(private readonly env: HumanHandoffStoreEnv) {}

  private headers(prefer?: string): Record<string, string> {
    const key = requireString(this.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
    return {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    };
  }

  private baseUrl(): string {
    return requireString(this.env.SUPABASE_URL, "SUPABASE_URL").replace(/\/+$/, "");
  }

  async create(input: HumanHandoffCreate): Promise<void> {
    const response = await fetch(`${this.baseUrl()}/rest/v1/human_handoff_events`, {
      method: "POST",
      headers: this.headers("return=minimal"),
      body: JSON.stringify({
        id: input.id,
        tenant_id: input.tenantId,
        call_id: input.callId,
        caller_phone: input.callerPhone,
        reason_code: input.reasonCode,
        reason_summary: input.reasonSummary ?? null,
        destination_type: input.destinationType,
        destination_label: input.destinationLabel,
        destination_phone: input.destinationPhone,
        status: "REQUESTED",
        callback_required: false,
        callback_status: null,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`human_handoff_events insert failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
  }

  async update(id: string, tenantId: string, patch: HumanHandoffPatch): Promise<void> {
    const response = await fetch(
      `${this.baseUrl()}/rest/v1/human_handoff_events?id=eq.${encodeURIComponent(id)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
      {
        method: "PATCH",
        headers: this.headers("return=minimal"),
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`human_handoff_events update failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
  }
}
