import { describe, expect, it } from "vitest";
import { buildFastGeminiMediaAdmission, provisionFastGeminiMediaAdmission } from "./fast-media";

function decodeBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function verifyToken(token: string, secret: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  expect(parts[0]).toBe("v1");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    asArrayBuffer(decodeBase64url(parts[2])),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  expect(verified).toBe(true);
  return JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1]))) as Record<string, unknown>;
}

const SECRET = "0123456789abcdef0123456789abcdef";

function securityContext(notAfterEpochMs: number) {
  return {
    securityVersion: 1 as const,
    sessionId: "cs_fast-call",
    tenantId: "tenant-fast",
    routeId: "default",
    callControlId: "v3:fast-call",
    callerPhoneE164: "+34647944762",
    calledPhoneE164: "+34910000001",
    provider: "TELNYX" as const,
    createdAtEpochMs: notAfterEpochMs - 60_000,
    notAfterEpochMs,
  };
}

it("builds the exact media credential and security-bound fast bootstrap for one call", async () => {
  const notAfterEpochMs = Date.now() + 60_000;
  const admission = await buildFastGeminiMediaAdmission({
    tenantId: "tenant-fast",
    callControlId: "v3:fast-call",
    credentialId: "cred-fast-call",
    notAfterEpochMs,
    edgeUrl: "wss://fast-example.a.run.app/telnyx/gemini",
    securityContext: securityContext(notAfterEpochMs),
    systemInstruction: "Responde de forma breve y natural.",
    tools: [],
    credentialSecret: SECRET,
  });

  expect(admission.edgeUrl).toBe("wss://fast-example.a.run.app/telnyx/gemini");
  expect(admission.bootstrapUrl).toBe("https://fast-example.a.run.app/internal/bootstrap");
  expect(admission.bootstrap.securityContext).toMatchObject({
    sessionId: "cs_fast-call",
    tenantId: "tenant-fast",
    routeId: "default",
    callerPhoneE164: "+34647944762",
    calledPhoneE164: "+34910000001",
  });
  expect(admission.bootstrap.tools).toEqual([]);
  expect(admission.bootstrap.voiceName).toBe("Kore");
  expect(admission.bootstrap.languageCode).toBe("es-ES");

  const claims = await verifyToken(admission.streamingAuthToken, SECRET);
  expect(claims).toEqual({
    credentialId: "cred-fast-call",
    provider: "GEMINI",
    tenantId: "tenant-fast",
    callControlId: "v3:fast-call",
    sessionId: "cs_fast-call",
    routeId: "default",
    callerPhoneE164: "+34647944762",
    calledPhoneE164: "+34910000001",
    securityVersion: 1,
    edgeUrl: "wss://fast-example.a.run.app/telnyx/gemini",
    targetLegs: "both",
    notAfterEpochMs,
  });
});

describe("fast media bootstrap provisioning", () => {
  it("posts bootstrap once with control auth and no streaming credential in body", async () => {
    const notAfterEpochMs = Date.now() + 60_000;
    const admission = await buildFastGeminiMediaAdmission({
      tenantId: "tenant-fast",
      callControlId: "v3:fast-call",
      credentialId: "cred-fast-call",
      notAfterEpochMs,
      edgeUrl: "wss://fast-example.a.run.app/telnyx/gemini",
      securityContext: securityContext(notAfterEpochMs),
      systemInstruction: "Responde brevemente.",
      credentialSecret: SECRET,
    });
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    await provisionFastGeminiMediaAdmission(admission, {
      controlToken: SECRET,
      fetcher: async (input, init) => {
        calls.push({ input: String(input), init });
        return Response.json({ ok: true, credentialId: "cred-fast-call" }, { status: 201 });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("https://fast-example.a.run.app/internal/bootstrap");
    expect(calls[0].init?.headers).toEqual({
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    });
    const body = String(calls[0].init?.body);
    expect(body).not.toContain(admission.streamingAuthToken);
    expect(JSON.parse(body)).toEqual(admission.bootstrap);
  });

  it("fails closed on a mismatched bootstrap acknowledgement", async () => {
    const notAfterEpochMs = Date.now() + 60_000;
    const admission = await buildFastGeminiMediaAdmission({
      tenantId: "tenant-fast",
      callControlId: "v3:fast-call",
      credentialId: "cred-fast-call",
      notAfterEpochMs,
      edgeUrl: "wss://fast-example.a.run.app/telnyx/gemini",
      securityContext: securityContext(notAfterEpochMs),
      systemInstruction: "Responde brevemente.",
      credentialSecret: SECRET,
    });
    await expect(provisionFastGeminiMediaAdmission(admission, {
      controlToken: SECRET,
      fetcher: async () => Response.json({ ok: true, credentialId: "other" }, { status: 201 }),
    })).rejects.toThrow("acknowledgement is invalid");
  });
});
