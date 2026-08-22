import {
  HumanHandoffStore,
  type HumanHandoffCreate,
  type HumanHandoffPatch,
  type HumanHandoffState,
} from "./human-handoff-store.js";

export type { HumanHandoffCreate, HumanHandoffPatch, HumanHandoffState } from "./human-handoff-store.js";

export type HumanHandoffPersistencePort = Readonly<{
  create(input: HumanHandoffCreate): Promise<void>;
  update(id: string, tenantId: string, patch: HumanHandoffPatch): Promise<void>;
  getState(id: string, tenantId: string): Promise<HumanHandoffState | null>;
}>;

type HumanHandoffPersistenceHost = object & {
  env?: Record<string, unknown>;
};

function requiredConfig(host: HumanHandoffPersistenceHost, name: "SUPABASE_URL" | "SUPABASE_SECRET_KEY"): string {
  const value = host.env?.[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

const ports = new WeakMap<object, HumanHandoffPersistencePort>();

/** Provider composition edge for durable human-handoff state. */
export function humanHandoffPersistencePortFor(host: HumanHandoffPersistenceHost): HumanHandoffPersistencePort {
  let port = ports.get(host);
  if (!port) {
    port = new HumanHandoffStore({
      SUPABASE_URL: requiredConfig(host, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requiredConfig(host, "SUPABASE_SECRET_KEY"),
    });
    ports.set(host, port);
  }
  return port;
}
