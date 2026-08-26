import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GEMINI_CONTROL_PROTOCOL_V1 } from "../src/control-contract/v1";

const CALL_SESSION_ID = "probe-lifecycle-persistence";
const EDGE_SESSION_ID = "probe-lifecycle-edge";

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

async function connect() {
  const stub = env.GEMINI_CALL_SESSIONS.getByName(CALL_SESSION_ID);
  const response = await stub.fetch(new Request(
    `https://do/internal/control?call_session_id=${CALL_SESSION_ID}&edge_session_id=${EDGE_SESSION_ID}`,
    { headers: { Upgrade: "websocket" } },
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
  it("does not consume sequence on INVALID_STATE and persists lifecycle across reconnect", async () => {
    const first = await connect();

    const invalidMedia = await sendAndReceive(first, controlEnvelope(
      1,
      "media-before-ready",
      "MEDIA_STARTED",
      { stream_id: "stream-1" },
    ));
    expect(invalidMedia.type).toBe("NACK");
    expect((invalidMedia.payload as Record<string, unknown>).code).toBe("INVALID_STATE");
    // retryable=false means the same invalid envelope must not be retried. The
    // sequence slot remains unconsumed so the correct event can use seq=1.
    expect((invalidMedia.payload as Record<string, unknown>).retryable).toBe(false);
    expect((invalidMedia.payload as Record<string, unknown>).terminal).toBe(false);

    const ready = await sendAndReceive(first, controlEnvelope(
      1,
      "edge-ready-1",
      "EDGE_READY",
      { edge_session_id: EDGE_SESSION_ID, provider_connection_epoch: 1 },
    ));
    expect(ready.type).toBe("ACK");
    expect((ready.payload as Record<string, unknown>).result).toBe("APPLIED");

    const media = await sendAndReceive(first, controlEnvelope(
      2,
      "media-started-1",
      "MEDIA_STARTED",
      { stream_id: "stream-1" },
    ));
    expect(media.type).toBe("ACK");
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
    expect((callerStart.payload as Record<string, unknown>).result).toBe("APPLIED");

    const callerEnd = await sendAndReceive(second, controlEnvelope(
      4,
      "caller-end-1",
      "CALLER_ACTIVITY_ENDED",
      { turn_id: "turn-1" },
    ));
    expect(callerEnd.type).toBe("ACK");
    expect((callerEnd.payload as Record<string, unknown>).result).toBe("APPLIED");
    second.close(1000, "done");
  });
});
