import { SupabaseAdapter, type CallDiagnosticEvent } from "./supabase-adapter.js";

export type { CallDiagnosticEvent } from "./supabase-adapter.js";

export type CallDiagnosticPersistencePort = Readonly<{
  write(event: CallDiagnosticEvent): Promise<void>;
}>;

type CallDiagnosticPersistenceHost = object;

function requiredConfig(host: CallDiagnosticPersistenceHost, name: "SUPABASE_URL" | "SUPABASE_SECRET_KEY"): string {
  const value = (host as { env?: Record<string, unknown> }).env?.[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

const ports = new WeakMap<object, CallDiagnosticPersistencePort>();

/** Provider composition edge for durable call diagnostics. */
export function callDiagnosticPersistencePortFor(host: CallDiagnosticPersistenceHost): CallDiagnosticPersistencePort {
  let port = ports.get(host);
  if (!port) {
    const adapter = new SupabaseAdapter({
      SUPABASE_URL: requiredConfig(host, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requiredConfig(host, "SUPABASE_SECRET_KEY"),
    });
    port = Object.freeze({ write: (event: CallDiagnosticEvent) => adapter.writeDiagnosticEvent(event) });
    ports.set(host, port);
  }
  return port;
}
