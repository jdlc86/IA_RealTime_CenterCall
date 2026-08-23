import type { CallerTurnDispositionPort } from "./caller-turn-disposition-port.js";

const PORT_BY_HOST = new WeakMap<object, CallerTurnDispositionPort>();

export function installCallerTurnDispositionPort(host: object, port: CallerTurnDispositionPort): void {
  if (!host || typeof host !== "object") throw new Error("Caller turn disposition host is required");
  if (!port || typeof port.resolve !== "function") throw new Error("Caller turn disposition port is required");
  const existing = PORT_BY_HOST.get(host);
  if (existing && existing !== port) throw new Error("Caller turn disposition port is already installed");
  PORT_BY_HOST.set(host, port);
}

export function callerTurnDispositionPortFor(host: object): CallerTurnDispositionPort | null {
  return PORT_BY_HOST.get(host) ?? null;
}

export function removeCallerTurnDispositionPort(host: object, port?: CallerTurnDispositionPort): void {
  const existing = PORT_BY_HOST.get(host);
  if (!existing) return;
  if (port && existing !== port) throw new Error("Caller turn disposition port ownership mismatch");
  PORT_BY_HOST.delete(host);
}
