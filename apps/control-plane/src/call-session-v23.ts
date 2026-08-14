import { CallSession as CallSessionV22 } from "./call-session-v22";
import { SupabaseAdapter, type BookedReservationSummary } from "./supabase-adapter";

const BaseConstructor = CallSessionV22 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV22.prototype as any;

const QUERY = "restaurant_reservation_query";
const CANCEL = "restaurant_reservation_cancel";
const MODIFY = "restaurant_reservation_modify";
const BUSINESS_INFO = "restaurant_business_info";
const END_CALL = "restaurant_end_call";
const OUT_OF_SCOPE = "restaurant_out_of_scope";
const DIRECT_TOOLS = new Set([QUERY, CANCEL, MODIFY, BUSINESS_INFO, END_CALL, OUT_OF_SCOPE]);
const RESTAURANT_TIMEZONE = "Europe/Madrid";

type RealtimeEvent = { type?: string; name?: string; call_id?: string; arguments?: string };
type ModifyPatch = {
  party_size?: number;
  starts_at?: string;
  customer_name?: string;
  duration_minutes?: number;
  notes?: string;
  separate_tables_acceptable?: boolean;
  tables_must_be_close?: boolean;
};
type TablePlanRow = {
  allocation_mode: "SINGLE" | "MULTI_EXACT";
  plan_order: number;
  table_id: string;
  table_code: string;
  table_name: string;
  min_capacity: number;
  max_capacity: number;
  starts_at: string;
  ends_at: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}
function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}
function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function optionalInteger(value: unknown): number | undefined { return Number.isInteger(value) ? value as number : undefined; }
function optionalBoolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function durationMinutes(row: BookedReservationSummary): number {
  return Math.max(15, Math.round((Date.parse(row.ends_at) - Date.parse(row.starts_at)) / 60000));
}
function publicReservation(row: BookedReservationSummary, index: number): Record<string, unknown> {
  return { option: index + 1, reservation_code: row.reservation_code, starts_at: row.starts_at, party_size: row.party_size, customer_name: row.customer_name };
}
function hasExplicitZone(value: string): boolean { return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()); }
function normalizeMadridLocalIso(value: string): string {
  const trimmed = value.trim();
  if (hasExplicitZone(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/);
  if (!match) return trimmed;
  const target = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? "0") };
  const targetEpoch = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  const partsAt = (epochMs: number) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: RESTAURANT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(epochMs));
    const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") };
  };
  const toEpoch = (p: typeof target) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  let candidateUtc = targetEpoch;
  for (let i = 0; i < 3; i += 1) {
    const delta = toEpoch(partsAt(candidateUtc)) - targetEpoch;
    if (delta === 0) break;
    candidateUtc -= delta;
  }
  if (toEpoch(partsAt(candidateUtc)) !== targetEpoch) throw new Error(`La hora local ${trimmed} no existe o es ambigua en ${RESTAURANT_TIMEZONE}`);
  const offsetMinutes = Math.round((targetEpoch - candidateUtc) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${target.year}-${pad(target.month)}-${pad(target.day)}T${pad(target.hour)}:${pad(target.minute)}:${pad(target.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * v23 removes the synthetic conversation_intent bridge for the core restaurant
 * operations that were still causing conversational workflow interference.
 * Lucia owns dialogue/tool selection; this class owns deterministic backend
 * execution and returns compact structured results.
 */
export class CallSession extends BaseConstructor {
  private cancelPendingIdsV23: string[] | null = null;
  private modifyCandidatesV23: BookedReservationSummary[] | null = null;
  private modifySelectedIdV23: string | null = null;
  private modifyPatchV23: ModifyPatch = {};
  private modifyProposalFingerprintV23: string | null = null;

  private adapterV23(): SupabaseAdapter {
    return new SupabaseAdapter({
      SUPABASE_URL: requireString((this as any).env?.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
  }

  private async rpcV23<T>(name: string, body: Record<string, unknown>): Promise<T[]> {
    const baseUrl = requireString((this as any).env?.SUPABASE_URL, "SUPABASE_URL").replace(/\/+$/, "");
    const key = requireString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
    const response = await fetch(`${baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Supabase RPC ${name} failed with HTTP ${response.status}: ${raw.slice(0, 250)}`);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`Supabase RPC ${name} returned invalid payload`);
    return parsed as T[];
  }

  private sendOutputV23(callId: string | undefined, output: Record<string, unknown>, createResponse = true): void {
    (this as any).send?.({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    if (createResponse) (this as any).send?.({ type: "response.create" });
  }

  private markDirectToolV23(tool: string): void {
    (this as any).validateUserTurnV18?.("agent_tool");
    (this as any).suspendForToolV18?.(tool);
    (this as any).diagnostics?.checkpoint?.("LUCIA_AGENT_TOOL_SELECTED", { tool, compatibility_executor: "direct_restaurant_controller_v23" });
  }

  private contextV23(): { tenantId: string; callerPhone: string; callId: string } {
    return {
      tenantId: requireString((this as any).tenantId, "tenant_id"),
      callerPhone: requireString((this as any).callerPhone, "caller_phone"),
      callId: requireString((this as any).callId, "call_id"),
    };
  }

  private async executeQueryV23(callId: string | undefined): Promise<void> {
    const { tenantId, callerPhone } = this.contextV23();
    const rows = await this.adapterV23().listBookedReservationsByPhone(tenantId, callerPhone);
    (this as any).diagnostics?.checkpoint?.("DIRECT_RESERVATION_QUERY_COMPLETED_V23", { result_count: rows.length, identity_source: "CALLER_ID" });
    this.sendOutputV23(callId, { ok: true, status: rows.length ? "FOUND" : "NONE", reservations: rows.map(publicReservation) });
  }

  private selectReservationsV23(rows: BookedReservationSummary[], args: Record<string, unknown>): BookedReservationSummary[] {
    if (args.select_all === true) return rows;
    const indexes = Array.isArray(args.selection_indexes) ? args.selection_indexes.filter(Number.isInteger) as number[] : [];
    const single = optionalInteger(args.selection_index);
    const requested = indexes.length ? indexes : single ? [single] : [];
    if (!requested.length) return [];
    const unique = [...new Set(requested)];
    if (unique.some((index) => index < 1 || index > rows.length)) throw new Error("selection_index is outside the available reservation list");
    return unique.map((index) => rows[index - 1]);
  }

  private async executeCancelV23(callId: string | undefined, args: Record<string, unknown>): Promise<void> {
    const { tenantId, callerPhone } = this.contextV23();
    const rows = await this.adapterV23().listBookedReservationsByPhone(tenantId, callerPhone);
    if (!rows.length) {
      this.cancelPendingIdsV23 = null;
      this.sendOutputV23(callId, { ok: true, status: "NO_RESERVATIONS" });
      return;
    }

    let selected = this.selectReservationsV23(rows, args);
    if (!selected.length && args.confirm === true && this.cancelPendingIdsV23?.length) {
      const wanted = new Set(this.cancelPendingIdsV23);
      selected = rows.filter((row) => wanted.has(row.id));
      if (selected.length !== wanted.size) {
        this.cancelPendingIdsV23 = null;
        this.sendOutputV23(callId, { ok: true, status: "STALE_SELECTION", instruction: "La lista cambió. Presenta de nuevo las reservas antes de cancelar." });
        return;
      }
    }
    if (!selected.length) {
      if (rows.length === 1) selected = [rows[0]];
      else {
        this.sendOutputV23(callId, { ok: true, status: "SELECTION_REQUIRED", reservations: rows.map(publicReservation) });
        return;
      }
    }

    const selectedIds = selected.map((row) => row.id).sort();
    const fingerprint = JSON.stringify(selectedIds);
    if (args.confirm !== true || JSON.stringify((this.cancelPendingIdsV23 ?? []).slice().sort()) !== fingerprint) {
      this.cancelPendingIdsV23 = selectedIds;
      this.sendOutputV23(callId, { ok: true, status: "CONFIRMATION_REQUIRED", reservations: selected.map((row, i) => publicReservation(row, i)), count: selected.length });
      return;
    }

    const cancelled: Record<string, unknown>[] = [];
    const failed: Record<string, unknown>[] = [];
    for (const row of selected) {
      try {
        const result = await this.adapterV23().cancelBookedReservation(tenantId, row.id, callerPhone);
        if (result) cancelled.push({ reservation_code: row.reservation_code, previous_status: "BOOKED", new_status: "CANCELLED" });
        else failed.push({ reservation_code: row.reservation_code, reason: "NOT_BOOKED_OR_NOT_OWNED" });
      } catch (error) {
        failed.push({ reservation_code: row.reservation_code, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    this.cancelPendingIdsV23 = null;
    (this as any).diagnostics?.checkpoint?.("DIRECT_RESERVATION_CANCEL_COMPLETED_V23", { selected_count: selected.length, cancelled_count: cancelled.length, failed_count: failed.length });
    this.sendOutputV23(callId, { ok: failed.length === 0, status: failed.length ? "PARTIAL_FAILURE" : "CANCELLED", cancelled, failed });
  }

  private mergeModifyPatchV23(args: Record<string, unknown>): void {
    const next: ModifyPatch = {
      party_size: optionalInteger(args.party_size),
      starts_at: optionalString(args.starts_at),
      customer_name: optionalString(args.customer_name),
      duration_minutes: optionalInteger(args.duration_minutes),
      notes: optionalString(args.notes),
      separate_tables_acceptable: optionalBoolean(args.separate_tables_acceptable),
      tables_must_be_close: optionalBoolean(args.tables_must_be_close),
    };
    if (next.starts_at) next.starts_at = normalizeMadridLocalIso(next.starts_at);
    for (const [key, value] of Object.entries(next)) if (value !== undefined) (this.modifyPatchV23 as Record<string, unknown>)[key] = value;
  }

  private resetModifyV23(): void {
    this.modifyCandidatesV23 = null;
    this.modifySelectedIdV23 = null;
    this.modifyPatchV23 = {};
    this.modifyProposalFingerprintV23 = null;
  }

  private async executeModifyV23(callId: string | undefined, args: Record<string, unknown>): Promise<void> {
    const { tenantId, callerPhone } = this.contextV23();
    const rows = await this.adapterV23().listBookedReservationsByPhone(tenantId, callerPhone);
    if (!rows.length) {
      this.resetModifyV23();
      this.sendOutputV23(callId, { ok: true, status: "NO_RESERVATIONS" });
      return;
    }
    this.modifyCandidatesV23 = rows;

    const selectionIndex = optionalInteger(args.selection_index);
    if (selectionIndex !== undefined) {
      if (selectionIndex < 1 || selectionIndex > rows.length) throw new Error("selection_index is outside the available reservation list");
      const chosen = rows[selectionIndex - 1];
      if (this.modifySelectedIdV23 && this.modifySelectedIdV23 !== chosen.id) {
        this.modifyPatchV23 = {};
        this.modifyProposalFingerprintV23 = null;
      }
      this.modifySelectedIdV23 = chosen.id;
    } else if (!this.modifySelectedIdV23 && rows.length === 1) {
      this.modifySelectedIdV23 = rows[0].id;
    }

    if (!this.modifySelectedIdV23) {
      this.sendOutputV23(callId, { ok: true, status: "SELECTION_REQUIRED", reservations: rows.map(publicReservation) });
      return;
    }
    const current = rows.find((row) => row.id === this.modifySelectedIdV23);
    if (!current) {
      this.resetModifyV23();
      this.sendOutputV23(callId, { ok: true, status: "STALE_SELECTION", reservations: rows.map(publicReservation) });
      return;
    }

    this.mergeModifyPatchV23(args);
    const hasBusinessChange = ["party_size", "starts_at", "customer_name", "duration_minutes", "notes"].some((key) => (this.modifyPatchV23 as Record<string, unknown>)[key] !== undefined);
    if (!hasBusinessChange) {
      this.sendOutputV23(callId, { ok: true, status: "CHANGE_REQUIRED", reservation: publicReservation(current, 0), changeable_fields: ["starts_at", "party_size", "customer_name", "duration_minutes", "notes"] });
      return;
    }

    const partySize = this.modifyPatchV23.party_size ?? current.party_size;
    const startsAt = this.modifyPatchV23.starts_at ?? current.starts_at;
    const duration = this.modifyPatchV23.duration_minutes ?? durationMinutes(current);
    const customerName = this.modifyPatchV23.customer_name ?? current.customer_name;
    const plan = await this.rpcV23<TablePlanRow>("check_restaurant_table_plan", {
      p_tenant_id: tenantId,
      p_starts_at: startsAt,
      p_party_size: partySize,
      p_duration_minutes: duration,
      p_exclude_reservation_id: current.id,
    });
    if (!plan.length) {
      this.modifyProposalFingerprintV23 = null;
      this.sendOutputV23(callId, { ok: true, status: "UNAVAILABLE", original_reservation_unchanged: true });
      return;
    }

    if (plan[0].allocation_mode === "MULTI_EXACT") {
      const capacities = plan.map((row) => row.max_capacity);
      if (this.modifyPatchV23.tables_must_be_close === true || this.modifyPatchV23.separate_tables_acceptable === false) {
        this.modifyProposalFingerprintV23 = null;
        this.sendOutputV23(callId, { ok: true, status: "HUMAN_ASSISTANCE_REQUIRED", reason: "MULTITABLE_PROXIMITY_NOT_GUARANTEED", allocation: capacities, original_reservation_unchanged: true });
        return;
      }
      if (this.modifyPatchV23.separate_tables_acceptable !== true) {
        this.modifyProposalFingerprintV23 = null;
        this.sendOutputV23(callId, { ok: true, status: "MULTITABLE_OPTION", allocation: capacities, exact_capacity: capacities.reduce((sum, value) => sum + value, 0), requires_separation_confirmation: true, original_reservation_unchanged: true });
        return;
      }
    }

    const proposal = {
      reservation_id: current.id,
      reservation_code: current.reservation_code,
      party_size: partySize,
      starts_at: startsAt,
      duration_minutes: duration,
      customer_name: customerName,
      notes: this.modifyPatchV23.notes ?? null,
      allocation_mode: plan[0].allocation_mode,
    };
    const fingerprint = JSON.stringify(proposal);
    if (args.confirm !== true || this.modifyProposalFingerprintV23 !== fingerprint) {
      this.modifyProposalFingerprintV23 = fingerprint;
      this.sendOutputV23(callId, { ok: true, status: "READY_TO_CONFIRM", reservation: proposal, tables: plan.map((row) => ({ table_name: row.table_name, capacity: row.max_capacity })), original_reservation_unchanged: true });
      return;
    }

    const modified = await this.rpcV23<Record<string, unknown>>("modify_restaurant_reservation", {
      p_tenant_id: tenantId,
      p_reservation_id: current.id,
      p_caller_phone: callerPhone,
      p_party_size: partySize,
      p_starts_at: startsAt,
      p_duration_minutes: duration,
      p_customer_name: customerName,
      p_notes: this.modifyPatchV23.notes ?? null,
    });
    if (!modified.length) throw new Error("modify_restaurant_reservation returned empty payload");
    (this as any).diagnostics?.checkpoint?.("DIRECT_RESERVATION_MODIFIED_V23", { reservation_code: current.reservation_code, table_count: modified.length, allocation_mode: modified[0]?.allocation_mode ?? null });
    this.resetModifyV23();
    this.sendOutputV23(callId, { ok: true, status: "MODIFIED", reservation_code: current.reservation_code, party_size: partySize, starts_at: startsAt, tables: modified.map((row) => row.table_name), allocation_mode: modified[0]?.allocation_mode ?? null });
  }

  private async executeBusinessInfoV23(callId: string | undefined, args: Record<string, unknown>): Promise<void> {
    const tenantId = requireString((this as any).tenantId, "tenant_id");
    const topics = Array.isArray(args.topics) ? args.topics.filter((value): value is string => typeof value === "string") : [];
    const adapter = this.adapterV23();
    const result: Record<string, unknown> = { official_facts: (this as any).businessFacts ?? {} };
    if (topics.includes("MENU")) result.menu_items = await adapter.listMenuItems(tenantId);
    if (topics.includes("HOURS")) result.business_hours = await adapter.listBusinessHours(tenantId);
    if (topics.includes("SERVICES")) result.services = await adapter.listServices(tenantId);
    (this as any).diagnostics?.checkpoint?.("DIRECT_BUSINESS_INFO_COMPLETED_V23", { topics });
    this.sendOutputV23(callId, { ok: true, status: "FOUND", topics, ...result });
  }

  private executeEndCallV23(callId: string | undefined, args: Record<string, unknown>): void {
    const confirmed = args.confirmed === true;
    if (!confirmed) {
      this.sendOutputV23(callId, { ok: true, status: "CONFIRMATION_REQUIRED", instruction: "Pregunta brevemente si desea finalizar la llamada y espera su respuesta." });
      return;
    }
    this.sendOutputV23(callId, { ok: true, status: "CLOSING" }, false);
    (this as any).diagnostics?.checkpoint?.("DIRECT_END_CALL_CONFIRMED_V23", { source: "lucia_agent_tool" });
    (this as any).beginClosing?.("agent_end_confirmed_v23", "lucia_agent_tool_v23");
  }

  private executeOutOfScopeV23(callId: string | undefined): void {
    this.sendOutputV23(callId, { ok: true, status: "OUT_OF_SCOPE", instruction: "Indica brevemente que solo puedes ayudar con cuestiones relacionadas con el restaurante y ofrece ayuda dentro de ese ámbito." });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) { try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; } }

    if (event?.type === "response.function_call_arguments.done" && event.name && DIRECT_TOOLS.has(event.name)) {
      let args: Record<string, unknown>;
      try { args = parseObject(event.arguments); }
      catch (error) {
        this.sendOutputV23(event.call_id, { ok: false, status: "ERROR", error: "INVALID_ARGUMENTS", message: error instanceof Error ? error.message : String(error) });
        return;
      }

      this.markDirectToolV23(event.name);
      try {
        if (event.name === QUERY) await this.executeQueryV23(event.call_id);
        else if (event.name === CANCEL) await this.executeCancelV23(event.call_id, args);
        else if (event.name === MODIFY) await this.executeModifyV23(event.call_id, args);
        else if (event.name === BUSINESS_INFO) await this.executeBusinessInfoV23(event.call_id, args);
        else if (event.name === END_CALL) this.executeEndCallV23(event.call_id, args);
        else if (event.name === OUT_OF_SCOPE) this.executeOutOfScopeV23(event.call_id);
      } catch (error) {
        (this as any).diagnostics?.fail?.("DIRECT_AGENT_TOOL_FAILED_V23", "DIRECT_AGENT_TOOL_EXECUTION_FAILED", { tool: event.name, error: error instanceof Error ? error.message : String(error) });
        this.sendOutputV23(event.call_id, { ok: false, status: "ERROR", error: "EXECUTION_FAILED", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
