import {
  recordCallerSecuritySignalDurably,
  type SecuritySignalDelivery,
} from "./caller-security-signal-delivery.js";
import type { QueuedCallerSecuritySignal } from "./caller-security.js";

type FastSemanticSecuritySignalHost = object & {
  env?: {
    MEDIA_EDGE_CONTROL_PLANE_TOKEN?: string;
    CALLER_SECURITY_SIGNALS?: Queue<QueuedCallerSecuritySignal>;
  };
};

type FastSemanticSecuritySignalDependencies = Readonly<{
  recordSignal?: typeof recordCallerSecuritySignalDurably;
  waitUntil?: (promise: Promise<void>) => void;
}>;

const CATEGORIES = new Set([
  "PROMPT_EXFILTRATION",
  "PROMPT_INJECTION",
  "ROLE_ESCALATION",
  "TOOL_MANIPULATION",
]);

function required(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function callerPhone(value: unknown): string {
  const normalized = required(value, "callerPhoneE164", 16);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("callerPhoneE164 is invalid");
  return normalized;
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let diff = aa.length ^ bb.length;
  for (let index = 0; index < Math.min(aa.length, bb.length); index += 1) diff |= aa[index] ^ bb[index];
  return diff === 0;
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  return Boolean(match && await secureEqual(match[1], expected));
}

function canonicalInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("security signal is invalid");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = ["callerPhoneE164", "category", "eventKey", "tenantId"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("security signal fields are invalid");
  }
  const category = required(input.category, "category", 64);
  if (!CATEGORIES.has(category)) throw new Error("category is invalid");
  const eventKey = required(input.eventKey, "eventKey", 128);
  if (!/^gemini-fast-semsec-v1:[a-f0-9]{64}$/.test(eventKey)) throw new Error("eventKey is invalid");
  return Object.freeze({
    tenantId: required(input.tenantId, "tenantId", 256),
    callerPhoneE164: callerPhone(input.callerPhoneE164),
    category,
    eventKey,
  });
}

function deliveryStatus(delivery: SecuritySignalDelivery): "SECURITY_SIGNAL_RECORDED" | "SECURITY_SIGNAL_QUEUED" {
  return delivery.delivery === "DIRECT" ? "SECURITY_SIGNAL_RECORDED" : "SECURITY_SIGNAL_QUEUED";
}

export async function routeFastSemanticSecuritySignal(
  request: Request,
  host: FastSemanticSecuritySignalHost,
  dependencies: FastSemanticSecuritySignalDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  let token: string;
  try { token = required(host.env?.MEDIA_EDGE_CONTROL_PLANE_TOKEN, "MEDIA_EDGE_CONTROL_PLANE_TOKEN", 8_192); }
  catch { return Response.json({ ok: false, status: "SECURITY_SIGNAL_UNAVAILABLE" }, { status: 503 }); }
  if (!await authorized(request, token)) return Response.json({ ok: false, status: "UNAUTHORIZED" }, { status: 401 });

  let input: ReturnType<typeof canonicalInput>;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 4_096) throw new Error("security signal payload too large");
    input = canonicalInput(JSON.parse(text));
  } catch {
    return Response.json({ ok: false, status: "INVALID_SECURITY_SIGNAL" }, { status: 400 });
  }

  const recordSignal = dependencies.recordSignal ?? recordCallerSecuritySignalDurably;
  const pending = recordSignal(host, {
    eventKey: input.eventKey,
    tenantId: input.tenantId,
    callerPhone: input.callerPhoneE164,
    eventType: `GEMINI_SEMANTIC_${input.category}`,
    severity: "MEDIUM",
    riskDelta: 1,
    highConfidence: false,
    metadata: {
      source: "GEMINI_FAST_SEMANTIC_BOUNDARY",
      category: input.category,
      raw_transcript_stored: false,
    },
  });

  if (dependencies.waitUntil) {
    const background = pending.then((delivery) => {
      console.log(JSON.stringify({
        level: "info",
        event: "fast_semantic_security_signal_delivered",
        event_key: input.eventKey,
        delivery: delivery.delivery,
      }));
    }).catch((error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "fast_semantic_security_signal_delivery_failed",
        event_key: input.eventKey,
        error_category: error instanceof Error ? error.name : "Error",
      }));
    });
    try {
      dependencies.waitUntil(background);
      return Response.json({ ok: true, status: "SECURITY_SIGNAL_ACCEPTED" }, { status: 202 });
    } catch {
      // If the host cannot own the background task, fall through and await the
      // same direct-or-queue delivery instead of silently dropping the signal.
    }
  }

  try {
    const delivery = await pending;
    return Response.json({ ok: true, status: deliveryStatus(delivery) }, { status: delivery.delivery === "DIRECT" ? 201 : 202 });
  } catch {
    return Response.json({ ok: false, status: "SECURITY_SIGNAL_PERSIST_FAILED" }, { status: 502 });
  }
}
