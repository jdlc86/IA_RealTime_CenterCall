import { DurableObject } from "cloudflare:workers";
import {
  applyInboundSequenceV1,
  buildAckV1,
  buildNackV1,
  parseEnvelopeV1,
  type GeminiControlEnvelopeV1,
} from "./control-contract/v1";

export type GeminiControlPlaneEnv = Readonly<{
  GEMINI_CALL_SESSIONS: DurableObjectNamespace<GeminiCallSession>;
}>;

type ConnectionAttachment = Readonly<{
  callSessionId: string;
  edgeSessionId: string;
}>;

type SequenceRow = Readonly<{ value: number }>;
type MessageRow = Readonly<{ message_id: string }>;

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim() ?? "";
  if (!value || value.length > 160 || /[\r\n\t]/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

export class GeminiCallSession extends DurableObject<GeminiControlPlaneEnv> {
  constructor(ctx: DurableObjectState, env: GeminiControlPlaneEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS control_counters (
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL CHECK(value >= 0)
        );
        CREATE TABLE IF NOT EXISTS applied_messages (
          message_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL CHECK(sequence > 0)
        );
        INSERT OR IGNORE INTO control_counters(name, value) VALUES ('inbound', 0);
        INSERT OR IGNORE INTO control_counters(name, value) VALUES ('outbound', 0);
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/internal/control" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket required", { status: 400 });
    }

    let callSessionId: string;
    let edgeSessionId: string;
    try {
      callSessionId = requiredQuery(url, "call_session_id");
      edgeSessionId = requiredQuery(url, "edge_session_id");
    } catch {
      return new Response("invalid control identity", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["gemini-control-v1"]);
    server.serializeAttachment(Object.freeze({ callSessionId, edgeSessionId } satisfies ConnectionAttachment));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment?.callSessionId || !attachment?.edgeSessionId) {
      ws.close(1008, "missing control attachment");
      return;
    }

    let envelope: GeminiControlEnvelopeV1;
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      envelope = parseEnvelopeV1(JSON.parse(raw), attachment.callSessionId);
    } catch {
      ws.close(1008, "invalid control envelope");
      return;
    }

    const lastAppliedSequence = this.counter("inbound");
    const appliedMessageIds = new Set<string>();
    if (this.wasApplied(envelope.message_id)) appliedMessageIds.add(envelope.message_id);
    const decision = applyInboundSequenceV1({ lastAppliedSequence, appliedMessageIds }, envelope);

    if (decision.action === "OUT_OF_ORDER") {
      const response = buildNackV1({
        callSessionId: attachment.callSessionId,
        messageId: crypto.randomUUID(),
        sequence: this.nextOutboundSequence(),
        rejectedMessageId: envelope.message_id,
        rejectedSequence: envelope.sequence,
        code: "OUT_OF_ORDER_SEQUENCE",
        retryable: true,
        terminal: false,
      });
      ws.send(JSON.stringify(response));
      return;
    }

    if (decision.action === "APPLY") {
      this.ctx.storage.sql.exec(
        "INSERT INTO applied_messages(message_id, sequence) VALUES (?, ?)",
        envelope.message_id,
        envelope.sequence,
      );
      this.setCounter("inbound", decision.nextLastAppliedSequence);
    }

    if (!envelope.ack_required) return;
    const response = buildAckV1({
      callSessionId: attachment.callSessionId,
      messageId: crypto.randomUUID(),
      sequence: this.nextOutboundSequence(),
      ackedMessageId: envelope.message_id,
      ackedSequence: envelope.sequence,
      result: decision.action === "DUPLICATE" ? "DUPLICATE_ALREADY_APPLIED" : "APPLIED",
    });
    ws.send(JSON.stringify(response));
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // No critical state is held in memory. SQLite remains authoritative.
  }

  private counter(name: "inbound" | "outbound"): number {
    const row = this.ctx.storage.sql.exec<SequenceRow>(
      "SELECT value FROM control_counters WHERE name = ?",
      name,
    ).one();
    return row.value;
  }

  private setCounter(name: "inbound" | "outbound", value: number): void {
    this.ctx.storage.sql.exec("UPDATE control_counters SET value = ? WHERE name = ?", value, name);
  }

  private nextOutboundSequence(): number {
    const next = this.counter("outbound") + 1;
    this.setCounter("outbound", next);
    return next;
  }

  private wasApplied(messageId: string): boolean {
    return this.ctx.storage.sql.exec<MessageRow>(
      "SELECT message_id FROM applied_messages WHERE message_id = ? LIMIT 1",
      messageId,
    ).toArray().length === 1;
  }
}
