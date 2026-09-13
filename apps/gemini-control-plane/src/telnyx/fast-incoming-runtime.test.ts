import { describe, expect, it } from "vitest";
import { startSignedFastGeminiIncomingCall } from "./fast-incoming-runtime";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-08-26T13:10:00.000Z");

function incomingBody(eventType = "call.initiated"): string {
  return JSON.stringify({
    data: {
      id: "evt-fast-001",
      event_type: eventType,
      occurred_at: "2026-08-26T13:09:59.000Z",
      payload: {
        direction: "incoming",
        call_control_id: "v3:fast-incoming-call",
        call_session_id: "telnyx-session-1",
        from: "+34000000001",
        to: "+34000000002",
      },
    },
  });
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    nowEpochMs: NOW,
    signatureMaxAgeSeconds: 300,
    admissionTtlMs: 60_000,
    telnyxPublicKey: "test-public-key",
    admissionIdentitySecret: SECRET,
    mediaCredentialSecret: SECRET,
    mediaControlToken: SECRET,
    telnyxApiKey: "test-telnyx-api-key",
    edgeUrl: "wss://fast-canary.example/telnyx/gemini",
    resolveTenantId: async () => "tenant-fast",
    isCanaryAllowed: () => true,
    evaluateCallerSecurity: async () => ({ decision: "ALLOW" as const, reason: "OK" }),
    resolveSessionConfig: async () => ({
      systemInstruction: "Responde breve y naturalmente.",
      tools: [],
      voiceName: "Kore",
      languageCode: "es-ES",
    }),
    verifySignature: async () => true,
    ...overrides,
  };
}

describe("fast incoming Gemini runtime", () => {
  it("provisions Edge and answers in parallel, then starts authenticated streaming", async () => {
    const events: string[] = [];
    let releaseBootstrap!: () => void;
    let releaseAnswer!: () => void;
    const bootstrapPending = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
    const answerPending = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    let streamCalled = false;
    let bootstrapBody: Record<string, unknown> | null = null;
    let streamBody: Record<string, unknown> | null = null;

    const pending = startSignedFastGeminiIncomingCall({
      rawBody: incomingBody(), signatureBase64: "sig", timestamp: "1",
    }, baseOptions({
      mediaFetcher: async (_input: RequestInfo | URL, init?: RequestInit) => {
        events.push("bootstrap-start");
        bootstrapBody = JSON.parse(String(init?.body));
        await bootstrapPending;
        events.push("bootstrap-done");
        return Response.json({ ok: true, credentialId: bootstrapBody!.credentialId }, { status: 201 });
      },
      telnyxFetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/actions/answer")) {
          events.push("answer-start");
          await answerPending;
          events.push("answer-done");
          return Response.json({ data: { result: "ok" } });
        }
        if (url.endsWith("/actions/streaming_start")) {
          streamCalled = true;
          streamBody = JSON.parse(String(init?.body));
          events.push("stream");
          return Response.json({ data: { result: "ok" } });
        }
        throw new Error(`unexpected Telnyx URL ${url}`);
      },
    }));

    for (let index = 0; index < 20 && events.length < 2; index += 1) await Promise.resolve();
    expect(new Set(events)).toEqual(new Set(["bootstrap-start", "answer-start"]));
    expect(streamCalled).toBe(false);

    releaseAnswer();
    await Promise.resolve();
    expect(streamCalled).toBe(false);
    releaseBootstrap();

    const result = await pending;
    expect(result.status).toBe("STARTED");
    expect(events.at(-1)).toBe("stream");
    expect(streamBody).toMatchObject({
      stream_url: "wss://fast-canary.example/telnyx/gemini",
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_target_legs: "both",
      stream_bidirectional_sampling_rate: 16000,
    });
    expect(typeof streamBody!.stream_auth_token).toBe("string");
    expect(String(streamBody!.stream_auth_token).startsWith("v1.")).toBe(true);
    expect(bootstrapBody).toMatchObject({
      provider: "GEMINI",
      tenantId: "tenant-fast",
      callControlId: "v3:fast-incoming-call",
      tools: [],
      voiceName: "Kore",
      languageCode: "es-ES",
    });
  });

  it("keeps retry identity and Telnyx command ids stable", async () => {
    const runs: Array<{ credentialId: string; commandIds: string[] }> = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const commandIds: string[] = [];
      let credentialId = "";
      const result = await startSignedFastGeminiIncomingCall({
        rawBody: incomingBody(), signatureBase64: "sig", timestamp: "1",
      }, baseOptions({
        mediaFetcher: async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          credentialId = body.credentialId;
          return Response.json({ ok: true, credentialId }, { status: 201 });
        },
        telnyxFetcher: async (_input: RequestInfo | URL, init?: RequestInit) => {
          commandIds.push(JSON.parse(String(init?.body)).command_id);
          return Response.json({ data: { result: "ok" } });
        },
      }));
      expect(result.status).toBe("STARTED");
      runs.push({ credentialId, commandIds });
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0].commandIds).toHaveLength(2);
    expect(runs[0].commandIds[0]).not.toBe(runs[0].commandIds[1]);
  });

  it("does no side effects when signature, tenant or canary gate rejects", async () => {
    let effects = 0;
    const fetcher = async () => {
      effects += 1;
      return Response.json({ data: { result: "ok" } });
    };
    const signature = await startSignedFastGeminiIncomingCall({
      rawBody: incomingBody(), signatureBase64: null, timestamp: null,
    }, baseOptions({ verifySignature: async () => false, telnyxFetcher: fetcher, mediaFetcher: fetcher }));
    expect(signature.status).toBe("SIGNATURE_REJECTED");

    const tenant = await startSignedFastGeminiIncomingCall({
      rawBody: incomingBody(), signatureBase64: "sig", timestamp: "1",
    }, baseOptions({ resolveTenantId: async () => null, telnyxFetcher: fetcher, mediaFetcher: fetcher }));
    expect(tenant.status).toBe("TENANT_NOT_FOUND");

    const canary = await startSignedFastGeminiIncomingCall({
      rawBody: incomingBody(), signatureBase64: "sig", timestamp: "1",
    }, baseOptions({ isCanaryAllowed: () => false, telnyxFetcher: fetcher, mediaFetcher: fetcher }));
    expect(canary.status).toBe("CANARY_NOT_ALLOWED");
    expect(effects).toBe(0);
  });

  it("blocks before identity, config, media or Telnyx effects when caller security denies admission", async () => {
    let configReads = 0;
    let effects = 0;
    const result = await startSignedFastGeminiIncomingCall({
      rawBody: incomingBody(), signatureBase64: "sig", timestamp: "1",
    }, baseOptions({
      evaluateCallerSecurity: async (input: unknown) => {
        expect(input).toEqual({
          eventKey: "evt-fast-001",
          tenantId: "tenant-fast",
          callerPhone: "+34000000001",
        });
        return { decision: "BLOCK" as const, reason: "CALL_RATE_1M" };
      },
      resolveSessionConfig: async () => { configReads += 1; throw new Error("must not run"); },
      telnyxFetcher: async () => { effects += 1; return Response.json({ data: { result: "ok" } }); },
      mediaFetcher: async () => { effects += 1; return Response.json({ ok: true }); },
    }));
    expect(result.status).toBe("CALLER_SECURITY_BLOCKED");
    expect(configReads).toBe(0);
    expect(effects).toBe(0);
  });

  it("fails closed before all effects when admission is unavailable or caller identity is absent", async () => {
    let evaluations = 0;
    let effects = 0;
    const effect = async () => { effects += 1; return Response.json({ data: { result: "ok" } }); };
    await expect(startSignedFastGeminiIncomingCall({
      rawBody: incomingBody(), signatureBase64: "sig", timestamp: "1",
    }, baseOptions({
      evaluateCallerSecurity: async () => { evaluations += 1; throw new Error("security unavailable"); },
      telnyxFetcher: effect,
      mediaFetcher: effect,
    }))).rejects.toThrow("security unavailable");

    const withoutCaller = incomingBody().replace('"from":"+34000000001",', "");
    await expect(startSignedFastGeminiIncomingCall({
      rawBody: withoutCaller, signatureBase64: "sig", timestamp: "1",
    }, baseOptions({
      evaluateCallerSecurity: async () => { evaluations += 1; return { decision: "ALLOW" as const, reason: "OK" }; },
      telnyxFetcher: effect,
      mediaFetcher: effect,
    }))).rejects.toThrow("Telnyx caller number is required");
    expect(evaluations).toBe(1);
    expect(effects).toBe(0);
  });

  it("ignores signed non-initiation webhooks before tenant or network work", async () => {
    let tenantLookups = 0;
    let effects = 0;
    const result = await startSignedFastGeminiIncomingCall({
      rawBody: incomingBody("call.answered"), signatureBase64: "sig", timestamp: "1",
    }, baseOptions({
      resolveTenantId: async () => { tenantLookups += 1; return "tenant-fast"; },
      telnyxFetcher: async () => { effects += 1; return Response.json({ data: { result: "ok" } }); },
      mediaFetcher: async () => { effects += 1; return Response.json({ ok: true, credentialId: "x" }, { status: 201 }); },
    }));
    expect(result.status).toBe("IGNORED_EVENT");
    expect(tenantLookups).toBe(0);
    expect(effects).toBe(0);
  });
});
