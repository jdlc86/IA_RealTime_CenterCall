import { createGeminiMediaEdgeBenchmarkServer } from "./relay.mjs";

const port = Number(process.env.PORT ?? "8080");
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid TCP port");

const runtime = createGeminiMediaEdgeBenchmarkServer({
  mode: process.env.BENCHMARK_MODE,
  authToken: process.env.BENCHMARK_AUTH_TOKEN,
  upstreamUrl: process.env.BENCHMARK_UPSTREAM_WSS ?? null,
  maxBufferedBytes: process.env.BENCHMARK_MAX_BUFFERED_BYTES
    ? Number(process.env.BENCHMARK_MAX_BUFFERED_BYTES)
    : 1_048_576,
});

runtime.server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "benchmark_server_ready", mode: runtime.mode, port }));
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    try { await runtime.close(); } finally { process.exit(0); }
  });
}
