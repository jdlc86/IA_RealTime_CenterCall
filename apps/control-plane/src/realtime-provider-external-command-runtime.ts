import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port.js";
import type { RealtimeProviderName } from "./realtime-provider-selector.js";

type InstalledExternalCommandPort = Readonly<{
  provider: RealtimeProviderName;
  port: RealtimeProviderCommandPort;
}>;

const EXTERNAL_COMMAND_PORT_BY_HOST = new WeakMap<object, InstalledExternalCommandPort>();

function requireHost(host: object): object {
  if (!host || typeof host !== "object") throw new Error("Realtime provider command host is required");
  return host;
}

export function installExternalRealtimeProviderCommandPort(
  host: object,
  provider: RealtimeProviderName,
  port: RealtimeProviderCommandPort,
): void {
  requireHost(host);
  if (!port || typeof port.speak !== "function") throw new Error("External realtime provider command port is required");
  const existing = EXTERNAL_COMMAND_PORT_BY_HOST.get(host);
  if (existing && (existing.provider !== provider || existing.port !== port)) {
    throw new Error(`External realtime provider command port is already installed for ${existing.provider}`);
  }
  EXTERNAL_COMMAND_PORT_BY_HOST.set(host, Object.freeze({ provider, port }));
}

export function externalRealtimeProviderCommandPortFor(
  host: object,
  provider: RealtimeProviderName,
): RealtimeProviderCommandPort | null {
  requireHost(host);
  const installed = EXTERNAL_COMMAND_PORT_BY_HOST.get(host);
  if (!installed) return null;
  if (installed.provider !== provider) {
    throw new Error(`External realtime provider command port affinity mismatch: ${installed.provider}/${provider}`);
  }
  return installed.port;
}

export function removeExternalRealtimeProviderCommandPort(
  host: object,
  provider: RealtimeProviderName,
  port?: RealtimeProviderCommandPort,
): void {
  requireHost(host);
  const installed = EXTERNAL_COMMAND_PORT_BY_HOST.get(host);
  if (!installed) return;
  if (installed.provider !== provider) {
    throw new Error(`External realtime provider command port ownership mismatch: ${installed.provider}/${provider}`);
  }
  if (port && installed.port !== port) throw new Error("External realtime provider command port ownership mismatch");
  EXTERNAL_COMMAND_PORT_BY_HOST.delete(host);
}
