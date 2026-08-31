import { describe, expect, it, vi } from "vitest";
import { FastHumanHandoffAudit } from "./fast-human-handoff-audit";

const ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-for-tests-only",
};

const ACCEPTED = {
  handoffId: "00000000-0000-4000-8000-000000000001",
  tenantId: "tenant-fast",
  callId: "v3:fast-call",
  callerPhone: "+34600000002",
  reasonCode: "USER_REQUESTED_HUMAN",
  reasonSummary: "El caller pide hablar con recepción.",
  destinationLabel: "Recepción",
  destinationPhone: "+34600000003",
} as const;

describe("fast human handoff audit queue", () => {
  it("attaches a pending INSERT to waitUntil without waiting for Supabase", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      await gate;
      return new Response(null, { status: 201 });
    });
    const owned: Promise<void>[] = [];
    const audit = new FastHumanHandoffAudit(ENV, {
      fetcher,
      waitUntil: (promise) => owned.push(promise),
      now: () => new Date("2026-08-27T18:00:00.000Z"),
    });

    expect(audit.accepted(ACCEPTED)).toBeUndefined();
    expect(owned).toHaveLength(1);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("/rest/v1/human_handoff_events?on_conflict=id");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("prefer")).toBe("resolution=ignore-duplicates,return=minimal");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      id: ACCEPTED.handoffId,
      tenant_id: ACCEPTED.tenantId,
      call_id: ACCEPTED.callId,
      caller_phone: ACCEPTED.callerPhone,
      reason_code: ACCEPTED.reasonCode,
      status: "REQUESTED",
      requested_at: "2026-08-27T18:00:00.000Z",
    });

    release();
    await Promise.all(owned);
  });

  it("serializes idempotent creation before lifecycle patches", async () => {
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    const methods: string[] = [];
    const audit = new FastHumanHandoffAudit(ENV, {
      fetcher: async (_input, init) => {
        methods.push(String(init?.method));
        if (init?.method === "POST") await insertGate;
        return new Response(null, { status: init?.method === "POST" ? 201 : 204 });
      },
    });

    audit.accepted(ACCEPTED);
    audit.patch(ACCEPTED.handoffId, ACCEPTED.tenantId, {
      status: "DIALING",
      transfer_started_at: "2026-08-27T18:00:01.000Z",
    });
    await Promise.resolve();
    expect(methods).toEqual(["POST"]);

    releaseInsert();
    await audit.whenIdle();
    expect(methods).toEqual(["POST", "PATCH"]);
  });

  it("absorbs Supabase errors and keeps later audit events alive", async () => {
    const failures: Array<Record<string, unknown>> = [];
    let requests = 0;
    const audit = new FastHumanHandoffAudit(ENV, {
      fetcher: async () => {
        requests += 1;
        return new Response(null, { status: requests === 1 ? 503 : 204 });
      },
      reportFailure: (event) => failures.push({ ...event }),
    });

    audit.accepted(ACCEPTED);
    audit.patch(ACCEPTED.handoffId, ACCEPTED.tenantId, { status: "FAILED" });
    await audit.whenIdle();

    expect(requests).toBe(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      event: "human_handoff_fast_audit_insert_failed",
      handoff_id: ACCEPTED.handoffId,
      error_code: "HTTP_503",
      fail_open: true,
    });
  });
});
