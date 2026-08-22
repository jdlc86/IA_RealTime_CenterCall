import { CallerSecurityService } from "./caller-security.js";

export type CallerSecurityPort = Pick<CallerSecurityService, "evaluateInbound" | "callerKey" | "recordSignal" | "recordSignalByCallerKey">;

type CallerSecurityHost = object & {
  env?: Record<string, unknown>;
};

function requiredConfig(host: CallerSecurityHost, name: "SUPABASE_URL" | "SUPABASE_SECRET_KEY"): string {
  const value = host.env?.[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

const ports = new WeakMap<object, CallerSecurityPort>();

/** Provider composition edge for caller-risk persistence and evaluation. */
export function callerSecurityPortFor(host: CallerSecurityHost): CallerSecurityPort {
  let port = ports.get(host);
  if (!port) {
    port = new CallerSecurityService({
      SUPABASE_URL: requiredConfig(host, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requiredConfig(host, "SUPABASE_SECRET_KEY"),
    });
    ports.set(host, port);
  }
  return port;
}
