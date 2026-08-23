import http from "node:http";
import { createGeminiMediaEdgeRuntime } from "./runtime.mjs";
import { createHmacCredentialVerifier, InMemoryOneShotCredentialConsumer } from "./credential.mjs";

const port = Number(process.env.PORT ?? "8080");
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid TCP port");

if (process.env.MEDIA_EDGE_SINGLE_INSTANCE !== "true") {
  throw new Error("MEDIA_EDGE_SINGLE_INSTANCE=true is required until a durable shared one-shot credential consumer is configured");
}

const credentialConsumer = new InMemoryOneShotCredentialConsumer();
const verifyCredential = createHmacCredentialVerifier(
  process.env.MEDIA_EDGE_CREDENTIAL_HMAC_SECRET,
  process.env.MEDIA_EDGE_PUBLIC_URL,
);

const runtime = createGeminiMediaEdgeRuntime({
  geminiApiKey: process.env.GEMINI_API_KEY,
  verifyCredential,
  consumeCredentialOnce: (credentialId, notAfterEpochMs, nowEpochMs) =>
    credentialConsumer.consume(credentialId, notAfterEpochMs, nowEpochMs),
  model: process.env.GEMINI_LIVE_MODEL,
  maxBufferedBytes: process.env.MEDIA_EDGE_MAX_BUFFERED_BYTES ? Number(process.env.MEDIA_EDGE_MAX_BUFFERED_BYTES) : undefined,
});

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, service: "gemini-media-edge", activeSessions: runtime.activeSessions() }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});
server.on("upgrade", (request, socket, head) => { void runtime.handleUpgrade(request, socket, head); });
server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ event: "gemini_media_edge_ready", port })));

async function shutdown() {
  server.close();
  await runtime.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
