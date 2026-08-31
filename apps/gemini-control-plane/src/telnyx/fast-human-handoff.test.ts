import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleVerifiedFastHumanHandoffEvent,
  routeFastTransferAuthorize,
  routeFastTransferStart,
  type FastHandoffEnv,
} from "./fast-human-handoff";

const CONTROL_TOKEN = "0123456789abcdef0123456789abcdef";
const HANDOFF_ID = "00000000-0000-4000-8000-000000000001";
const TENANT_ID = "tenant-fast";
const SOURCE_CALL_CONTROL_ID = "v3:fast-call";
const CALLER_PHONE = "+34600000002";
const CALLED_PHONE = "+34600000001";
const DESTINATION_PHONE = "+34600000003";

function tenantConfig() {
  return JSON.stringify({
    humanHandoff: {
      enabled: true,
      destination: { type: "PHONE", phone: DESTINATION_PHONE, label: "Recepción" },
      transfer: { mode: "BLIND", answerTimeoutSeconds: 25 },
      failurePolicy: { action: "TERMINATE_AND_CALLBACK", message: "No ha sido posible transferir." },
      successMessage: "Te paso con recepción. Un momento, por favor.",
    },
  });
}

function env(overrides: Partial<FastHandoffEnv> = {}): FastHandoffEnv {
  return {
    TELNYX_API_KEY: "telnyx-test-key",
    GEMINI_MEDIA_CONTROL_PLANE_TOKEN: CONTROL_TOKEN,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-for-tests-only",
    TENANT_ROUTING_KV: {
      async get(key: string) {
        if (key === `tenant_by_phone:${CALLED_PHONE}`) return JSON.stringify({ tenant_id: TENANT_ID, enabled: true });
        if (key === `tenant_config:${TENANT_ID}`) return tenantConfig();
        if (key === `tenant_capabilities:${TENANT_ID}`) return JSON.stringify({ tenant_id: TENANT_ID, "call.transfer": true });
        return null;
      },
      async put() {},
    },
    ...overrides,
  };
}

function controlRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function auditBody(call: readonly unknown[], index: number): Record<string, unknown> {
  const init = call[index] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function encodedState(): string {
  const json = JSON.stringify({
    kind: "gemini_handoff_v1",
    handoffId: HANDOFF_ID,
    tenantId: TENANT_ID,
    sourceCallControlId: SOURCE_CALL_CONTROL_ID,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function webhook(eventType: string, callControlId: string, hangupCause?: string): string {
  return JSON.stringify({
    data: {
      event_type: eventType,
      payload: {
        call_control_id: callControlId,
        client_state: encodedState(),
        ...(hangupCause ? { hangup_cause: hangupCause } : {}),
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fast human handoff persistence", () => {
  it("accepts transfer authorization while the Supabase INSERT remains pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const auditFetcher = vi.fn(async () => {
      await gate;
      return new Response(null, { status: 201 });
    });
    const owned: Promise<void>[] = [];

    const response = await routeFastTransferAuthorize(controlRequest("/internal/call-transfer/authorize", {
      tenantId: TENANT_ID,
      callControlId: SOURCE_CALL_CONTROL_ID,
      calledPhoneE164: CALLED_PHONE,
      callerPhoneE164: CALLER_PHONE,
      reason: "USER_REQUESTED_HUMAN",
      contextSummary: "El caller pide hablar con recepción.",
    }), env(), {
      fetcher: auditFetcher,
      waitUntil: (promise) => owned.push(promise),
      now: () => new Date("2026-08-27T18:00:00.000Z"),
    });

    expect(response.status).toBe(200);
    const result = await response.json() as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, status: "HUMAN_HANDOFF_ACCEPTED", terminal: true });
    expect(typeof result.handoffId).toBe("string");
    expect(owned).toHaveLength(1);
    await Promise.resolve();
    expect(auditFetcher).toHaveBeenCalledTimes(1);
    const inserted = auditBody(auditFetcher.mock.calls[0], 1);
    expect(inserted).toMatchObject({
      id: result.handoffId,
      tenant_id: TENANT_ID,
      call_id: SOURCE_CALL_CONTROL_ID,
      caller_phone: CALLER_PHONE,
      reason_code: "USER_REQUESTED_HUMAN",
      status: "REQUESTED",
    });

    release();
    await Promise.all(owned);
  });

  it("records the start attempt and successful Telnyx acknowledgement without delaying startTransfer", async () => {
    const telnyx = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", telnyx);
    let releaseAudit!: () => void;
    const auditGate = new Promise<void>((resolve) => { releaseAudit = resolve; });
    const auditFetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await auditGate;
      return new Response(null, { status: init?.method === "POST" ? 201 : 204 });
    });
    const owned: Promise<void>[] = [];

    const response = await routeFastTransferStart(controlRequest("/internal/call-transfer/start", {
      tenantId: TENANT_ID,
      callControlId: SOURCE_CALL_CONTROL_ID,
      calledPhoneE164: CALLED_PHONE,
      callerPhoneE164: CALLER_PHONE,
      handoffId: HANDOFF_ID,
      reason: "USER_REQUESTED_HUMAN",
      contextSummary: "El caller pide hablar con recepción.",
    }), env(), {
      fetcher: auditFetcher,
      waitUntil: (promise) => owned.push(promise),
      now: () => new Date("2026-08-27T18:00:01.000Z"),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, status: "DIALING", handoffId: HANDOFF_ID });
    expect(telnyx).toHaveBeenCalledTimes(1);
    expect(String(telnyx.mock.calls[0][0])).toBe(`https://api.telnyx.com/v2/calls/${encodeURIComponent(SOURCE_CALL_CONTROL_ID)}/actions/transfer`);
    expect(JSON.parse(String(telnyx.mock.calls[0][1]?.body))).toEqual({
      to: DESTINATION_PHONE,
      from: CALLED_PHONE,
      timeout_secs: 25,
      command_id: `gemini-handoff-transfer-${HANDOFF_ID}`,
      client_state: expect.any(String),
      target_leg_client_state: expect.any(String),
    });

    releaseAudit();
    await Promise.all(owned);
    expect(auditFetcher.mock.calls.map((call) => (call[1] as RequestInit).method)).toEqual(["POST", "PATCH", "PATCH"]);
    expect(auditBody(auditFetcher.mock.calls[1], 1)).toMatchObject({ transfer_started_at: "2026-08-27T18:00:01.000Z" });
    expect(auditBody(auditFetcher.mock.calls[2], 1)).toMatchObject({ status: "DIALING" });
  });

  it("records a failed transfer start and callback requirement before terminal failure speech", async () => {
    const telnyx = vi.fn(async (input: RequestInfo | URL) => new Response(null, {
      status: String(input).endsWith("/actions/transfer") ? 422 : 200,
    }));
    vi.stubGlobal("fetch", telnyx);
    const auditFetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(null, { status: init?.method === "POST" ? 201 : 204 }));
    const owned: Promise<void>[] = [];

    const response = await routeFastTransferStart(controlRequest("/internal/call-transfer/start", {
      tenantId: TENANT_ID,
      callControlId: SOURCE_CALL_CONTROL_ID,
      calledPhoneE164: CALLED_PHONE,
      callerPhoneE164: CALLER_PHONE,
      handoffId: HANDOFF_ID,
      reason: "USER_REQUESTED_HUMAN",
    }), env(), { fetcher: auditFetcher, waitUntil: (promise) => owned.push(promise) });

    expect(response.status).toBe(502);
    expect(telnyx).toHaveBeenCalledTimes(2);
    await Promise.all(owned);
    const failed = auditBody(auditFetcher.mock.calls.at(-1)!, 1);
    expect(failed).toMatchObject({
      status: "FAILED",
      callback_required: true,
      callback_status: "PENDING",
      failure_reason: "TELNYX_TRANSFER_START_HTTP_422",
    });
  });

  it("persists bridged success, no-answer failure and source terminal evidence", async () => {
    const telnyx = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", telnyx);
    const auditFetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const owned: Promise<void>[] = [];
    const writes: string[] = [];
    let bridged = false;
    const webhookEnv = env({
      TENANT_ROUTING_KV: {
        async get(key: string) {
          if (key === `handoff_bridged:${HANDOFF_ID}`) return bridged ? "1" : null;
          if (key === `tenant_config:${TENANT_ID}`) return tenantConfig();
          if (key === `tenant_capabilities:${TENANT_ID}`) return JSON.stringify({ tenant_id: TENANT_ID, "call.transfer": true });
          return null;
        },
        async put(key: string) {
          writes.push(key);
          bridged = true;
        },
      },
    });
    const dependencies = {
      fetcher: auditFetcher,
      waitUntil: (promise: Promise<void>) => owned.push(promise),
      now: () => new Date("2026-08-27T18:00:10.000Z"),
    };

    expect(await handleVerifiedFastHumanHandoffEvent(webhook("call.bridged", "target-call-1"), webhookEnv, dependencies)).toBe(true);
    await Promise.all(owned.splice(0));
    expect(writes).toEqual([`handoff_bridged:${HANDOFF_ID}`]);
    expect(auditBody(auditFetcher.mock.calls.at(-1)!, 1)).toMatchObject({
      status: "TRANSFERRED",
      answered_at: "2026-08-27T18:00:10.000Z",
      transfer_ended_at: "2026-08-27T18:00:10.000Z",
      target_call_control_id: "target-call-1",
      callback_required: false,
    });

    bridged = false;
    expect(await handleVerifiedFastHumanHandoffEvent(webhook("call.hangup", "target-call-2", "timeout"), webhookEnv, dependencies)).toBe(true);
    await Promise.all(owned.splice(0));
    expect(auditBody(auditFetcher.mock.calls.at(-1)!, 1)).toMatchObject({
      status: "NO_ANSWER",
      target_call_control_id: "target-call-2",
      callback_required: true,
      callback_status: "PENDING",
      failure_reason: "TARGET_CALL_HANGUP:timeout",
    });

    expect(await handleVerifiedFastHumanHandoffEvent(webhook("call.hangup", SOURCE_CALL_CONTROL_ID, "normal_clearing"), webhookEnv, dependencies)).toBe(true);
    await Promise.all(owned.splice(0));
    expect(auditBody(auditFetcher.mock.calls.at(-1)!, 1)).toMatchObject({
      status: "TERMINATED",
      call_terminated_at: "2026-08-27T18:00:10.000Z",
      callback_required: true,
      failure_reason: "SOURCE_CALL_HANGUP:normal_clearing",
    });
  });
});
