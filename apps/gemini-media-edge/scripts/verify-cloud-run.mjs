import process from "node:process";
import WebSocket from "ws";

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function edgeUrls(raw) {
  const edge = new URL(required(raw, "Gemini media edge URL"));
  if (edge.protocol !== "wss:") throw new Error("Gemini media edge URL must use wss://");
  const origin = new URL(edge);
  origin.protocol = "https:";
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  return { edge, origin };
}

async function expectUnauthorizedWebSocket(url, label) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${label} authorization check timed out`));
    }, 10_000);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      clearTimeout(timeout);
      if (response.statusCode === 401) resolve();
      else reject(new Error(`${label} admitted an unexpected HTTP ${response.statusCode}`));
    });
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error(`${label} accepted an unauthenticated WebSocket`));
    });
    socket.once("error", () => {});
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveReadiness(healthUrl) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(healthUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    let health = null;
    try { health = await response.json(); } catch {}
    if (response.ok) return { response, health };
    if (response.status === 503 && attempt < 19) {
      await delay(1_000);
      continue;
    }
    throw new Error(`Fast Cloud Run readiness failed with HTTP ${response.status}`);
  }
  throw new Error("Cloud Run readiness did not resolve");
}

const { edge, origin } = edgeUrls(process.argv[2] ?? process.env.GEMINI_MEDIA_EDGE_URL);
const healthUrl = new URL("/ready", origin);
const { response: healthResponse, health } = await resolveReadiness(healthUrl);
if (health?.ok !== true || health?.service !== "gemini-media-edge-fast") {
  throw new Error("Default Cloud Run URL does not identify gemini-media-edge-fast");
}
if (health?.model !== "gemini-3.1-flash-live-preview") {
  throw new Error("Default Cloud Run URL is not serving the expected Gemini Live model");
}
for (const field of ["setupMs", "firstAudioMs"]) {
  if (!Number.isInteger(health?.providerReadiness?.[field]) || health.providerReadiness[field] < 0) {
    throw new Error(`Fast Cloud Run readiness is missing providerReadiness.${field}`);
  }
}

const bootstrapResponse = await fetch(new URL("/internal/bootstrap", origin), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
if (bootstrapResponse.status !== 401) {
  throw new Error(`Bootstrap endpoint admitted unauthenticated HTTP ${bootstrapResponse.status}`);
}

await expectUnauthorizedWebSocket(edge, "media ingress");

const diagnosticsResponse = await fetch(new URL("/internal/diagnostics?call_control_id=cloud-run-preflight", origin));
if (diagnosticsResponse.status !== 401) {
  throw new Error(`Diagnostics endpoint admitted unauthenticated HTTP ${diagnosticsResponse.status}`);
}

console.log(JSON.stringify({
  ok: true,
  service: health.service,
  healthStatus: healthResponse.status,
  model: health.model,
  providerSetupMs: health.providerReadiness.setupMs,
  providerFirstAudioMs: health.providerReadiness.firstAudioMs,
  bootstrapUnauthenticatedStatus: bootstrapResponse.status,
  mediaIngressUnauthenticatedStatus: 401,
  diagnosticsUnauthenticatedStatus: diagnosticsResponse.status,
  activeSessions: health.activeSessions,
  registeredBootstraps: health.registeredBootstraps,
}));
