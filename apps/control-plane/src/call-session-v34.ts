import { CallSession as CallSessionV33 } from "./call-session-v33";
import { callerSecurityPortFor } from "./caller-security-port.js";
import { KvTenantRepository } from "./tenant-kv";
import { matchBlockedSecurityPhrase } from "./security-blocked-phrases";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { adaptRealtimeProviderEvents } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV33 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV33.prototype as any;

function usableTranscript(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 2000) : null;
}

/**
 * v34 adds a tenant-editable deterministic denylist on top of v33.
 * Policy remains code-owned: any exact normalized blocked phrase is HIGH risk,
 * is never forwarded to Lucia, records a security strike, and closes the call
 * through the neutral conversation lifecycle authority.
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
      const config = await new KvTenantRepository(kv).getTenantConfiguration(tenantId.trim());
      this.tenantBlockedPhrasesV34 = config?.security?.blockedPhrases ?? [];
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

  private async recordAndCloseV34(transcript: string, match: { phrase?: string; source?: string }): Promise<void> {
    const tenantId = (this as any).tenantId;
    const callerPhone = (this as any).callerPhone;
    if (typeof tenantId === "string" && tenantId.trim() && typeof callerPhone === "string" && callerPhone.trim()) {
      try {
        const decision = await callerSecurityPortFor(this).recordSignal({
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

    conversationLifecyclePortFor(this).confirmEndCall(
      "blocked_security_phrase_v34",
      "deterministic_kv_security_monitor_v34",
    );
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    for (const event of adaptRealtimeProviderEvents(data)) {
      if (event.type !== "CALLER_TRANSCRIPT_COMPLETED") continue;
      const transcript = usableTranscript(event.transcript);
      if (!transcript) continue;

      const match = matchBlockedSecurityPhrase(transcript, this.tenantBlockedPhrasesV34);
      if (match.matched) {
        await this.recordAndCloseV34(transcript, match);
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
