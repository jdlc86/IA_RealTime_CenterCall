import { CallSession as CallSessionV33 } from "./call-session-v33";
import { CallerSecurityService } from "./caller-security";
import { tenantConfigurationKeyV2 } from "./tenant-kv";
import { matchBlockedSecurityPhrase, parseTenantBlockedPhrases } from "./security-blocked-phrases";

const BaseConstructor = CallSessionV33 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV33.prototype as any;

type RealtimeEvent = { type?: string; transcript?: string };

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function parseEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

function usableTranscript(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 2000) : null;
}

/**
 * v34 adds a tenant-editable deterministic denylist on top of v33.
 * Policy remains code-owned: any exact normalized blocked phrase is HIGH risk,
 * is never forwarded to Lucia, records a security strike, and closes the call.
 * KV only controls additional phrases; a minimal built-in list always remains.
 */
export class CallSession extends BaseConstructor {
  private tenantBlockedPhrasesV34: string[] = [];

  async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    if (isStart && response.ok) await this.loadTenantSecurityPhrasesV34();
    return response;
  }

  private async loadTenantSecurityPhrasesV34(): Promise<void> {
    const tenantId = (this as any).tenantId;
    const kv = (this as any).env?.TENANT_CONFIG;
    if (typeof tenantId !== "string" || !tenantId.trim() || !kv || typeof kv.get !== "function") return;

    try {
      const raw = await kv.get(tenantConfigurationKeyV2(tenantId.trim()), { cacheTtl: 30 });
      if (!raw) {
        this.tenantBlockedPhrasesV34 = [];
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const security = parsed.security;
      if (security === undefined) {
        this.tenantBlockedPhrasesV34 = [];
      } else {
        if (!security || typeof security !== "object" || Array.isArray(security)) throw new Error("security must be an object");
        this.tenantBlockedPhrasesV34 = parseTenantBlockedPhrases((security as Record<string, unknown>).blockedPhrases);
      }
      (this as any).diagnostics?.checkpoint?.("TENANT_SECURITY_PHRASES_LOADED_V34", {
        tenant_phrase_count: this.tenantBlockedPhrasesV34.length,
        builtin_fallback_active: true,
      });
    } catch (error) {
      this.tenantBlockedPhrasesV34 = [];
      (this as any).diagnostics?.fail?.("TENANT_SECURITY_PHRASES_INVALID_V34", "TENANT_SECURITY_CONFIGURATION_INVALID", {
        builtin_fallback_active: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private securityServiceV34(): CallerSecurityService {
    const env = (this as any).env ?? {};
    return new CallerSecurityService({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY });
  }

  private async recordAndCloseV34(transcript: string, match: { phrase?: string; source?: string }): Promise<void> {
    const tenantId = (this as any).tenantId;
    const callerPhone = (this as any).callerPhone;
    if (typeof tenantId === "string" && tenantId.trim() && typeof callerPhone === "string" && callerPhone.trim()) {
      try {
        const decision = await this.securityServiceV34().recordSignal({
          tenantId: tenantId.trim(),
          callerPhone: callerPhone.trim(),
          eventType: "BLOCKED_PHRASE_HIGH",
          severity: "HIGH",
          riskDelta: 5,
          highConfidence: true,
          metadata: {
            matched_phrase: match.phrase ?? null,
            phrase_source: match.source ?? null,
            transcript_length: transcript.length,
            raw_transcript_stored: false,
          },
        });
        (this as any).diagnostics?.checkpoint?.("CALLER_BLOCKED_PHRASE_V34", {
          matched_phrase: match.phrase ?? null,
          phrase_source: match.source ?? null,
          action: decision.action,
          risk_score: decision.risk_score,
          security_strikes: decision.security_strikes,
          transcript_forwarded_to_lucia: false,
        });
      } catch (error) {
        (this as any).diagnostics?.fail?.("CALLER_BLOCKED_PHRASE_RECORD_FAILED_V34", "CYBERSECURITY_STORE_FAILED", {
          phrase_source: match.source ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if ((this as any).state !== "closing" && !(this as any).hangupStarted) {
      (this as any).beginClosing?.("blocked_security_phrase_v34", "deterministic_kv_security_monitor_v34");
    }
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);
    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = usableTranscript(event.transcript);
      if (transcript) {
        const match = matchBlockedSecurityPhrase(transcript, this.tenantBlockedPhrasesV34);
        if (match.matched) {
          await this.recordAndCloseV34(transcript, match);
          return;
        }
      }
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
