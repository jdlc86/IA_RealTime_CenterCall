import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GEMINI_ADMISSION_VERSION_V1 } from "../src/admission/v1";
import { GEMINI_CONTROL_CAPABILITY_VERSION_V1 } from "../src/control-auth/capability-v1";
import { GEMINI_CONTROL_PROTOCOL_V1 } from "../src/control-contract/v1";

const TENANT_ID = "probe-lifecycle-tenant";
const CALL_CONTROL_ID = "probe-lifecycle-call-control";
const CALL_SESSION_ID = "probe-lifecycle-persistence";
const EDGE_SESSION_ID = "probe-lifecycle-edge";
const CREDENTIAL_ID = "probe-lifecycle-credential";
const ADMISSION_EXPIRY = Date.now() + 5 * 60_000;

function controlEnvelope(
  sequence: number,
  messageId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  return {
    protocol: GEMINI_CONTROL_PROTOCOL_V1,
    call_session_id: CALL_SESSION_ID,
    message_id: messageId,
    sequence,
    type,
    ack_required: true,
    payload,
  };
}

function verifiedControlHeaders(): HeadersInit {
  return {
    Upgrade: "websocket",
    "x-gemini-control-authenticated": GEMINI_CONTROL_CAPABILITY_VERSION_V1,
    "x-gemini-tenant-id": TENANT_ID,
    "x-gemini-call-control-id": CALL_CONTROL_ID,
    "x-gemini-call-session-id": CALL_SESSION_ID,
    "x-gemini-edge-session-id": EDGE_SESSION_ID,
    "x-gemini-credential-id": CREDENTIAL_ID,
    "x-gemini-capability-not-after": String(ADMISSION_EXPIRY),
  };
}

async function connect() {
  const stub = env.GEMINI_CALL_SESSIONS.getByName(CALL_SESSION_ID);
  await stub.registerAdmission({
    version: GEMINI_ADMISSION_VERSION_V1,
    provider: "GEMINI",
    tenantId: TENANT_ID,
    callControlId: CALL_CONTROL_ID,
    callSessionId: CALL_SESSION_ID,
    edgeSessionId: EDGE_SESSION_ID,
    credentialId: CREDENTIAL_ID,
    notAfterEpochMs: ADMISSION_EXPIRY,
  });
  const response = await stub.fetch(new Request(
    "https://do/internal/control",
    { headers: verifiedControlHeaders() },
  ));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  socket!.accept();
  return socket!;
}

function receiveJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("control response timeout")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(String(event.data)) as Record<string, unknown>); }
      catch (error) { reject(error); }
    }, { once: true });
  });
}

async function sendAndReceive(socket: WebSocket, envelope: Record<string, unknown>) {
  const reply = receiveJson(socket);
  socket.send(JSON.stringify(envelope));
  return reply;
}

describe("GeminiCallSession durable lifecycle", () => {
  it("preserves lifecycle and bidirectional sequence authority across reconnect", async () => {
    const first = await connect();

    const invalidMedia = await sendAndReceive(first, controlEnvelope(
      1,
      "media-before-ready",
      "MEDIA_STARTED",
      { stream_id: "stream-1" },
    ));
    expect(invalidMedia.type).toBe("NACK");
    expect(invalidMedia.sequence).toBe(1);
    expect((invalidMedia.payload as Record<string, unknown>).code).toBe("INVALID_STATE");
    expect((invalidMedia.payload as Record<string, unknown>).retryable).toBe(false);
    expect((invalidMedia.payload as Record<string, unknown>).terminal).toBe(false);

    const ready = await sendAndReceive(first, controlEnvelope(
      1,
      "edge-ready-1",
      "EDGE_READY",
      { edge_session_id: EDGE_SESSION_ID, provider_connection_epoch: 1 },
    ));
    expect(ready.type).toBe("ACK");
    expect(ready.sequence).toBe(2);
    expect((ready.payload as Record<string, unknown>).result).toBe("APPLIED");

    const media = await sendAndReceive(first, controlEnvelope(
      2,
      "media-started-1",
      "MEDIA_STARTED",
      { stream_id: "stream-1" },
    ));
    expect(media.type).toBe("ACK");
    expect(media.sequence).toBe(3);
    expect((media.payload as Record<string, unknown>).result).toBe("APPLIED");
    first.close(1000, "reconnect lifecycle probe");

    const second = await connect();
    const callerStart = await sendAndReceive(second, controlEnvelope(
      3,
      "caller-start-1",
      "CALLER_ACTIVITY_STARTED",
      { turn_id: "turn-1", generation_id_at_start: null },
    ));
    expect(callerStart.type).toBe("ACK");
    expect(callerStart.sequence).toBe(4);
    expect((callerStart.payload as Record<string, unknown>).result).toBe("APPLIED");

    const callerEnd = await sendAndReceive(second, controlEnvelope(
      4,
      "caller-end-1",
      "CALLER_ACTIVITY_ENDED",
      { turn_id: "turn-1" },
    ));
    expect(callerEnd.type).toBe("ACK");
    expect(callerEnd.sequence).toBe(5);
    expect((callerEnd.payload as Record<string, unknown>).result).toBe("APPLIED");
    second.close(1000, "done");
  });
});
