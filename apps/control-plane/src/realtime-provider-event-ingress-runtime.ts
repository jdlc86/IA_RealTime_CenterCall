import type { RealtimeProviderEvent } from "./realtime-provider-event.js";

export type RealtimeProviderEventIngress = (
  events: readonly RealtimeProviderEvent[],
) => void | Promise<void>;

type TrustedRealtimeProviderEventBatch = Readonly<{
  events: readonly RealtimeProviderEvent[];
}>;

const INGRESS_BY_HOST = new WeakMap<object, RealtimeProviderEventIngress>();
const TRUSTED_BATCHES = new WeakSet<object>();

function requireHost(host: object): object {
  if (!host || typeof host !== "object") throw new Error("Realtime provider event ingress host is required");
  return host;
}

export function installRealtimeProviderEventIngress(host: object, ingress: RealtimeProviderEventIngress): void {
  requireHost(host);
  if (typeof ingress !== "function") throw new Error("Realtime provider event ingress is required");
  const existing = INGRESS_BY_HOST.get(host);
  if (existing && existing !== ingress) throw new Error("Realtime provider event ingress is already installed");
  INGRESS_BY_HOST.set(host, ingress);
}

export function requireRealtimeProviderEventIngress(host: object): RealtimeProviderEventIngress {
  requireHost(host);
  const ingress = INGRESS_BY_HOST.get(host);
  if (!ingress) throw new Error("Realtime provider event ingress is not installed");
  return ingress;
}

export function removeRealtimeProviderEventIngress(host: object, ingress?: RealtimeProviderEventIngress): void {
  requireHost(host);
  const existing = INGRESS_BY_HOST.get(host);
  if (!existing) return;
  if (ingress && existing !== ingress) throw new Error("Realtime provider event ingress ownership mismatch");
  INGRESS_BY_HOST.delete(host);
}

export async function deliverRealtimeProviderEvents(
  host: object,
  events: readonly RealtimeProviderEvent[],
): Promise<void> {
  const ingress = requireRealtimeProviderEventIngress(host);
  for (const event of events) await ingress(Object.freeze([event]));
}

export function trustedRealtimeProviderEventBatch(
  events: readonly RealtimeProviderEvent[],
): TrustedRealtimeProviderEventBatch {
  const batch = Object.freeze({ events: Object.freeze([...events]) });
  TRUSTED_BATCHES.add(batch);
  return batch;
}

export function realtimeProviderEventsFromTrustedBatch(value: unknown): RealtimeProviderEvent[] | null {
  if (!value || typeof value !== "object" || !TRUSTED_BATCHES.has(value as object)) return null;
  return [...(value as TrustedRealtimeProviderEventBatch).events];
}
