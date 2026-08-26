import { DurableObject } from "cloudflare:workers";
import type { GeminiAdmissionV1 } from "./admission/v1";
import { reduceGeminiCallLifecycle, type GeminiCallLifecycleState, type GeminiCallPhase } from "./call-lifecycle/state";
import { GEMINI_CONTROL_CAPABILITY_VERSION_V1 } from "./control-auth/capability-v1";
import { assertEnvelopeDirectionV1 } from "./control-contract/direction-v1";
import {
  applyInboundSequenceV1,
  buildAckV1,
  buildNackV1,
  parseEnvelopeV1,
  type AckResultV1,
  type GeminiControlEnvelopeV1,
  type NackCodeV1,
} from "./control-contract/v1";

export type GeminiControlPlaneEnv = Readonly<{
  GEMINI_CALL_SESSIONS: DurableObjectNamespace<GeminiCallSession>;
}>;

export type GeminiAdmissionRegistrationResult =
  | "CREATED"
  | "IDEMPOTENT"
  | "REJECTED_EXPIRED"
  | "REJECTED_IMMUTABLE";

type ConnectionAttachment = Readonly<{
  callSessionId: string;
  edgeSessionId: string;
  credentialId: string;
}>;

type SequenceRow = Readonly<{ value: number }>;
type MessageRow = Readonly<{ message_id: string }>;
type LifecycleRow = Readonly<{
  phase: string;
  active_turn_id: string | null;
  provider_connection_epoch: number | null;
  media_started: number;
}>;
type AdmissionRow = Readonly<{
  tenant_id: string;
  call_control_id: string;
  call_session_id: string;
  edge_session_id: string;
  credential_id: string;
  not_after_epoch_ms: number;
}>;

const PHASES = new Set<GeminiCallPhase>([
  "CALL_BOOTSTRAP",
  "LISTENING",
  "CALLER_ACTIVE",
  "TURN_GATING",
  "RECOVERING",
  "CLOSING",
  "TERMINAL",
]);

function requiredInternalHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim() ?? "";
  if (!value || value.length > 256 || /[\r\n\t]/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function positiveSafeIntegerHeader(request: Request, name: string): number {
  const raw = requiredInternalHeader(request, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is invalid`);
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
        CREATE TABLE IF NOT EXISTS lifecycle_state (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          phase TEXT NOT NULL,
          active_turn_id TEXT,
          provider_connection_epoch INTEGER,
          media_started INTEGER NOT NULL CHECK(media_started IN (0, 1))
        );
        CREATE TABLE IF NOT EXISTS admission_state (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          tenant_id TEXT NOT NULL,
          call_control_id TEXT NOT NULL,
          call_session_id TEXT NOT NULL,
          edge_session_id TEXT NOT NULL,
          credential_id TEXT NOT NULL,
          not_after_epoch_ms INTEGER NOT NULL CHECK(not_after_epoch_ms > 0)
        );
        INSERT OR IGNORE INTO control_counters(name, value) VALUES ('inbound', 0);
        INSERT OR IGNORE INTO control_counters(name, value) VALUES ('outbound', 0);
        INSERT OR IGNORE INTO lifecycle_state(
          id, phase, active_turn_id, provider_connection_epoch, media_started
        ) VALUES (1, 'CALL_BOOTSTRAP', NULL, NULL, 0);
      `);
    });
  }

  async registerAdmission(admission: GeminiAdmissionV1): Promise<GeminiAdmissionRegistrationResult> {
    if (admission.version !== "gemini-admission.v1" || admission.provider !== "GEMINI") {
      return "REJECTED_IMMUTABLE";
    }
    if (!Number.isSafeInteger(admission.notAfterEpochMs) || admission.notAfterEpochMs <= Date.now()) {
      return "REJECTED_EXPIRED";
    }

    const existing = this.admissionState();
    if (existing) {
      if (
        existing.tenant_id === admission.tenantId
        && existing.call_control_id === admission.callControlId
        && existing.call_session_id === admission.callSessionId
        && existing.edge_session_id === admission.edgeSessionId
        && existing.credential_id === admission.credentialId
        && existing.not_after_epoch_ms === admission.notAfterEpochMs
      ) return "IDEMPOTENT";
      return "REJECTED_IMMUTABLE";
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO admission_state(
        id, tenant_id, call_control_id, call_session_id, edge_session_id, credential_id, not_after_epoch_ms
      ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      admission.tenantId,
      admission.callControlId,
      admission.callSessionId,
      admission.edgeSessionId,
      admission.credentialId,
      admission.notAfterEpochMs,
    );
    return "CREATED";
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/internal/control" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket required", { status: 400 });
    }
    if (request.headers.get("x-gemini-control-authenticated") !== GEMINI_CONTROL_CAPABILITY_VERSION_V1) {
      return new Response("verified control capability required", { status: 403 });
    }

    let tenantId: string;
    let callControlId: string;
    let callSessionId: string;
    let edgeSessionId: string;
    let credentialId: string;
    let capabilityNotAfterEpochMs: number;
    try {
      tenantId = requiredInternalHeader(request, "x-gemini-tenant-id");
      callControlId = requiredInternalHeader(request, "x-gemini-call-control-id");
      callSessionId = requiredInternalHeader(request, "x-gemini-call-session-id");
      edgeSessionId = requiredInternalHeader(request, "x-gemini-edge-session-id");
      credentialId = requiredInternalHeader(request, "x-gemini-credential-id");
      capabilityNotAfterEpochMs = positiveSafeIntegerHeader(request, "x-gemini-capability-not-after");
    } catch {
      return new Response("invalid verified control identity", { status: 400 });
    }

    const nowEpochMs = Date.now();
    const admission = this.admissionState();
    if (!admission) return new Response("call not admitted", { status: 403 });
    if (admission.not_after_epoch_ms <= nowEpochMs) return new Response("call admission expired", { status: 403 });
    if (capabilityNotAfterEpochMs <= nowEpochMs || capabilityNotAfterEpochMs > admission.not_after_epoch_ms) {
      return new Response("control capability lifetime mismatch", { status: 403 });
    }
    if (
      admission.tenant_id !== tenantId
      || admission.call_control_id !== callControlId
      || admission.call_session_id !== callSessionId
      || admission.edge_session_id !== edgeSessionId
      || admission.credential_id !== credentialId
    ) return new Response("call admission binding mismatch", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["gemini-control-v1"]);
    server.serializeAttachment(Object.freeze({ callSessionId, edgeSessionId, credentialId } satisfies ConnectionAttachment));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment?.callSessionId || !attachment?.edgeSessionId || !attachment?.credentialId) {
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

    try {
      assertEnvelopeDirectionV1(envelope, "EDGE_TO_WORKER");
    } catch {
      this.nack(ws, attachment.callSessionId, envelope, "PROTOCOL_VIOLATION", false, true);
      ws.close(1008, "invalid control direction");
      return;
    }

    const lastAppliedSequence = this.counter("inbound");
    const alreadyApplied = this.wasApplied(envelope.message_id);
    if (alreadyApplied && envelope.sequence > lastAppliedSequence) {
      this.nack(ws, attachment.callSessionId, envelope, "IDENTITY_MISMATCH", false, true);
      ws.close(1008, "reused control message identity");
      return;
    }

    const appliedMessageIds = new Set<string>();
    if (alreadyApplied) appliedMessageIds.add(envelope.message_id);
    const sequenceDecision = applyInboundSequenceV1({ lastAppliedSequence, appliedMessageIds }, envelope);

    if (sequenceDecision.action === "OUT_OF_ORDER") {
      this.nack(ws, attachment.callSessionId, envelope, "OUT_OF_ORDER_SEQUENCE", true, false);
      return;
    }

    if (sequenceDecision.action === "DUPLICATE") {
      if (envelope.ack_required) this.ack(ws, attachment.callSessionId, envelope, "DUPLICATE_ALREADY_APPLIED");
      return;
    }

    if (!this.edgeIdentityMatches(attachment, envelope)) {
      this.nack(ws, attachment.callSessionId, envelope, "IDENTITY_MISMATCH", false, true);
      ws.close(1008, "control edge identity mismatch");
      return;
    }

    const currentLifecycle = this.lifecycleState();
    const lifecycleDecision = reduceGeminiCallLifecycle(currentLifecycle, envelope);
    if (lifecycleDecision.action === "INVALID_STATE") {
      this.nack(ws, attachment.callSessionId, envelope, "INVALID_STATE", false, false);
      return;
    }

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO applied_messages(message_id, sequence) VALUES (?, ?)",
        envelope.message_id,
        envelope.sequence,
      );
      this.setCounter("inbound", sequenceDecision.nextLastAppliedSequence);
      if (lifecycleDecision.action === "APPLY") this.writeLifecycleState(lifecycleDecision.state);
    });

    if (!envelope.ack_required) return;
    this.ack(
      ws,
      attachment.callSessionId,
      envelope,
      lifecycleDecision.action === "ACCEPT_NO_EFFECT" ? "ACCEPTED_NO_EFFECT" : "APPLIED",
    );
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Critical state is persisted in SQLite and survives hibernation/restart.
  }

  private admissionState(): AdmissionRow | null {
    const rows = this.ctx.storage.sql.exec<AdmissionRow>(
      `SELECT tenant_id, call_control_id, call_session_id, edge_session_id, credential_id, not_after_epoch_ms
       FROM admission_state WHERE id = 1`,
    ).toArray();
    return rows.length === 1 ? rows[0] : null;
  }

  private edgeIdentityMatches(attachment: ConnectionAttachment, envelope: GeminiControlEnvelopeV1): boolean {
    if (envelope.type !== "EDGE_READY" && envelope.type !== "SYNC") return true;
    return envelope.payload.edge_session_id === attachment.edgeSessionId;
  }

  private lifecycleState(): GeminiCallLifecycleState {
    const row = this.ctx.storage.sql.exec<LifecycleRow>(
      "SELECT phase, active_turn_id, provider_connection_epoch, media_started FROM lifecycle_state WHERE id = 1",
    ).one();
    if (!PHASES.has(row.phase as GeminiCallPhase)) throw new Error("Persisted Gemini lifecycle phase is invalid");
    if (row.provider_connection_epoch !== null && (!Number.isSafeInteger(row.provider_connection_epoch) || row.provider_connection_epoch < 1)) {
      throw new Error("Persisted Gemini provider epoch is invalid");
    }
    return Object.freeze({
      phase: row.phase as GeminiCallPhase,
      activeTurnId: row.active_turn_id,
      providerConnectionEpoch: row.provider_connection_epoch,
      mediaStarted: row.media_started === 1,
    });
  }

  private writeLifecycleState(state: GeminiCallLifecycleState): void {
    this.ctx.storage.sql.exec(
      `UPDATE lifecycle_state
       SET phase = ?, active_turn_id = ?, provider_connection_epoch = ?, media_started = ?
       WHERE id = 1`,
      state.phase,
      state.activeTurnId,
      state.providerConnectionEpoch,
      state.mediaStarted ? 1 : 0,
    );
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

  private ack(
    ws: WebSocket,
    callSessionId: string,
    envelope: GeminiControlEnvelopeV1,
    result: AckResultV1,
  ): void {
    ws.send(JSON.stringify(buildAckV1({
      callSessionId,
      messageId: crypto.randomUUID(),
      sequence: this.nextOutboundSequence(),
      ackedMessageId: envelope.message_id,
      ackedSequence: envelope.sequence,
      result,
    })));
  }

  private nack(
    ws: WebSocket,
    callSessionId: string,
    envelope: GeminiControlEnvelopeV1,
    code: NackCodeV1,
    retryable: boolean,
    terminal: boolean,
  ): void {
    ws.send(JSON.stringify(buildNackV1({
      callSessionId,
      messageId: crypto.randomUUID(),
      sequence: this.nextOutboundSequence(),
      rejectedMessageId: envelope.message_id,
      rejectedSequence: envelope.sequence,
      code,
      retryable,
      terminal,
    })));
  }
}
