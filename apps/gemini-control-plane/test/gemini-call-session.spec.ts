import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GEMINI_CONTROL_PROTOCOL_V1 } from "../src/control-contract/v1";

const CALL_SESSION_ID = "probe-call-session";
const EDGE_SESSION_ID = "probe-edge-session";

function envelope(sequence: number, messageId: string) {
  return {
    protocol: GEMINI_CONTROL_PROTOCOL_V1,
    call_session_id: CALL_SESSION_ID,
    message_id: messageId,
    sequence,
    type: "EDGE_READY",
    ack_required: true,
    payload: {
      edge_session_id: EDGE_SESSION_ID,
      provider_connection_epoch: 1,
    },
  } as const;
}

function workerOnlyEnvelope(sequence: number, messageId: string) {
  return {
    protocol: GEMINI_CONTROL_PROTOCOL_V1,
    call_session_id: CALL_SESSION_ID,
    message_id: messageId,
    sequence,
    type: "TURN_AUTHORIZED",
    ack_required: true,
    payload: { command_id: "cmd-edge-forgery", turn_id: "turn-1" },
  } as const;
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

describe("GeminiCallSession durable control contract", () => {
  it("persists sequence authority across reconnect and rejects gaps", async () => {
    const first = await connect();
    const firstReply = receiveJson(first);
    first.send(JSON.stringify(envelope(1, "message-1")));
    const ack1 = await firstReply;
    expect(ack1.type).toBe("ACK");
    expect((ack1.payload as Record<string, unknown>).result).toBe("APPLIED");
    first.close(1000, "reconnect probe");

    const second = await connect();
    const duplicateReply = receiveJson(second);
    second.send(JSON.stringify(envelope(1, "message-1")));
    const duplicateAck = await duplicateReply;
    expect(duplicateAck.type).toBe("ACK");
    expect((duplicateAck.payload as Record<string, unknown>).result).toBe("DUPLICATE_ALREADY_APPLIED");

    const gapReply = receiveJson(second);
    second.send(JSON.stringify(envelope(3, "message-3")));
    const nack = await gapReply;
    expect(nack.type).toBe("NACK");
    expect((nack.payload as Record<string, unknown>).code).toBe("OUT_OF_ORDER_SEQUENCE");
    expect((nack.payload as Record<string, unknown>).retryable).toBe(true);
    second.close(1000, "done");
  });

  it("NACKs and closes when Edge sends a Worker-only command", async () => {
    const socket = await connect();
    const reply = receiveJson(socket);
    socket.send(JSON.stringify(workerOnlyEnvelope(1, "forged-worker-command")));
    const nack = await reply;
    expect(nack.type).toBe("NACK");
    expect((nack.payload as Record<string, unknown>).code).toBe("PROTOCOL_VIOLATION");
    expect((nack.payload as Record<string, unknown>).retryable).toBe(false);
    expect((nack.payload as Record<string, unknown>).terminal).toBe(true);
  });
});
