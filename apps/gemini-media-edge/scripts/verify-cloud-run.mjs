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
  const control = new URL(origin);
  control.protocol = "wss:";
  control.pathname = "/internal/control";
  control.searchParams.set("tenant_id", "cloud-run-preflight");
  control.searchParams.set("call_control_id", "cloud-run-preflight");
  return { edge, origin, control };
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

const { edge, origin, control } = edgeUrls(process.argv[2] ?? process.env.GEMINI_MEDIA_EDGE_URL);
const healthUrl = new URL("/ready", origin);
const healthResponse = await fetch(healthUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
if (!healthResponse.ok) throw new Error(`Cloud Run health check failed with HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
if (health?.ok !== true || health?.service !== "gemini-media-edge") {
  throw new Error("Cloud Run health response does not identify gemini-media-edge");
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
await expectUnauthorizedWebSocket(control, "control sideband");

console.log(JSON.stringify({
  ok: true,
  service: health.service,
  healthStatus: healthResponse.status,
  bootstrapUnauthenticatedStatus: bootstrapResponse.status,
  mediaIngressUnauthenticatedStatus: 401,
  controlSidebandUnauthenticatedStatus: 401,
  activeSessions: health.activeSessions,
  controlSessions: health.controlSessions,
}));
