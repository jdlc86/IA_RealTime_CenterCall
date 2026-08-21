import { CallSession as CallSessionV32 } from "./call-session-v32";
import { inspectCallerTranscript } from "./caller-security";
import { callerSecurityPortFor } from "./caller-security-port.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { adaptRealtimeProviderEvents } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV32 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV32.prototype as any;

function usableTranscript(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 2000) : null;
}

/**
 * v33 is a deterministic cybersecurity boundary around Lucia.
 *
 * It deliberately does NOT classify restaurant intent. It only detects a small
 * set of high-confidence agent-manipulation/exfiltration patterns and records
 * weaker security indicators. High-confidence hostile transcripts are stopped
 * before older layers can pass them to Lucia, so malicious text cannot influence
 * model/tool selection before lifecycle authority commits the close.
 */
export class CallSession extends BaseConstructor {
  private async recordFindingV33(transcript: string, finding: ReturnType<typeof inspectCallerTranscript>): Promise<void> {
    if (finding.level === "NONE" || !finding.eventType) return;
    const tenantId = (this as any).tenantId;
    const callerPhone = (this as any).callerPhone;
    if (typeof tenantId !== "string" || !tenantId.trim() || typeof callerPhone !== "string" || !callerPhone.trim()) return;

    try {
      const decision = await callerSecurityPortFor(this).recordSignal({
        tenantId: tenantId.trim(),
        callerPhone: callerPhone.trim(),
        eventType: finding.eventType,
        severity: finding.level === "HIGH" ? "HIGH" : "LOW",
        riskDelta: finding.riskDelta,
        highConfidence: finding.level === "HIGH",
        metadata: {
          matched_rule: finding.matchedRule ?? null,
          transcript_length: transcript.length,
          transcript_sha256: await this.sha256V33(transcript),
          raw_transcript_stored: false,
        },
      });
      (this as any).diagnostics?.checkpoint?.("CALLER_CYBERSECURITY_SIGNAL_V33", {
        level: finding.level,
        event_type: finding.eventType,
        matched_rule: finding.matchedRule ?? null,
        action: decision.action,
        risk_score: decision.risk_score,
        security_strikes: decision.security_strikes,
        permanent_block: decision.permanent_block,
        blocked_until: decision.blocked_until,
        raw_transcript_stored: false,
      });
    } catch (error) {
      (this as any).diagnostics?.fail?.("CALLER_CYBERSECURITY_SIGNAL_RECORD_FAILED_V33", "CYBERSECURITY_STORE_FAILED", {
        level: finding.level,
        matched_rule: finding.matchedRule ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sha256V33(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private closeForCybersecurityV33(finding: ReturnType<typeof inspectCallerTranscript>): void {
    (this as any).diagnostics?.checkpoint?.("CALLER_CYBERSECURITY_CALL_TERMINATED_V33", {
      reason: finding.eventType ?? "CYBERSECURITY_HIGH_CONFIDENCE",
      matched_rule: finding.matchedRule ?? null,
      transcript_forwarded_to_lucia: false,
      lifecycle_authority: "conversation_lifecycle_port",
    });
    conversationLifecyclePortFor(this).confirmEndCall(
      "cybersecurity_high_confidence_v33",
      "deterministic_security_monitor_v33",
    );
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    for (const event of adaptRealtimeProviderEvents(data)) {
      if (event.type !== "CALLER_TRANSCRIPT_COMPLETED") continue;
      const transcript = usableTranscript(event.transcript);
      if (!transcript) continue;

      const finding = inspectCallerTranscript(transcript);
      if (finding.level !== "NONE") await this.recordFindingV33(transcript, finding);
      if (finding.terminateCurrentCall) {
        this.closeForCybersecurityV33(finding);
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
