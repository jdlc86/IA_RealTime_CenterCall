import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GEMINI_ADMISSION_VERSION_V1 } from "../src/admission/v1";
import {
  GEMINI_CONTROL_CAPABILITY_VERSION_V1,
  issueGeminiControlCapabilityV1,
} from "../src/control-auth/capability-v1";
import { routeAuthenticatedGeminiControlV1 } from "../src/control-auth/route-v1";
import { GEMINI_CONTROL_PROTOCOL_V1 } from "../src/control-contract/v1";

const SECRET = "0123456789abcdef0123456789abcdef";

function receiveJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("edge control handshake response timeout")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(String(event.data)) as Record<string, unknown>); }
      catch (error) { reject(error); }
    }, { once: true });
  });
}

describe("Gemini edge control authenticated handshake", () => {
  it("routes verified bearer claims to the admitted DO and ACKs EDGE_READY", async () => {
    const nowEpochMs = Date.now();
    const notAfterEpochMs = nowEpochMs + 5 * 60_000;
    const admission = {
      version: GEMINI_ADMISSION_VERSION_V1,
      provider: "GEMINI" as const,
      tenantId: "tenant-handshake",
      callControlId: "call-control-handshake",
      callSessionId: "call-session-handshake",
      edgeSessionId: "edge-session-handshake",
      credentialId: "credential-handshake",
      notAfterEpochMs,
    };

    const stub = env.GEMINI_CALL_SESSIONS.getByName(admission.callSessionId);
    expect(await stub.registerAdmission(admission)).toBe("CREATED");

    const capability = await issueGeminiControlCapabilityV1({
      version: GEMINI_CONTROL_CAPABILITY_VERSION_V1,
      provider: "GEMINI",
      tenantId: admission.tenantId,
      callControlId: admission.callControlId,
      callSessionId: admission.callSessionId,
      edgeSessionId: admission.edgeSessionId,
      credentialId: admission.credentialId,
      notAfterEpochMs,
    }, SECRET);

    const response = await routeAuthenticatedGeminiControlV1(
      new Request("https://gemini-control.example.test/internal/control", {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${capability}`,
        },
      }),
      {
        GEMINI_CONTROL_CAPABILITY_SECRET: SECRET,
        GEMINI_CALL_SESSIONS: env.GEMINI_CALL_SESSIONS,
      },
      nowEpochMs,
    );

    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket!.accept();

    const reply = receiveJson(socket!);
    socket!.send(JSON.stringify({
      protocol: GEMINI_CONTROL_PROTOCOL_V1,
      call_session_id: admission.callSessionId,
      message_id: "msg-edge-ready-handshake",
      sequence: 1,
      type: "EDGE_READY",
      ack_required: true,
      payload: {
        edge_session_id: admission.edgeSessionId,
        provider_connection_epoch: 1,
      },
    }));

    const ack = await reply;
    expect(ack.type).toBe("ACK");
    expect((ack.payload as Record<string, unknown>).acked_message_id).toBe("msg-edge-ready-handshake");
    expect((ack.payload as Record<string, unknown>).result).toBe("APPLIED");
    socket!.close(1000, "handshake proved");
  });

  it("rejects an invalid bearer before opening the admitted DO control socket", async () => {
    const response = await routeAuthenticatedGeminiControlV1(
      new Request("https://gemini-control.example.test/internal/control", {
        headers: { Upgrade: "websocket", Authorization: "Bearer invalid" },
      }),
      {
        GEMINI_CONTROL_CAPABILITY_SECRET: SECRET,
        GEMINI_CALL_SESSIONS: env.GEMINI_CALL_SESSIONS,
      },
      Date.now(),
    );
    expect(response.status).toBe(403);
  });
});
